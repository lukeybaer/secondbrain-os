#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE = '4d1e224ffcc0d73fe6844cfe7e1ca7c48d610e0f^';
const REVIEW_FILES = Object.freeze([
  'scripts/lib/briefing-card-progress.js',
  'scripts/night-supervisor.js',
  'scripts/briefing-card-controller.js',
  'scripts/watcher-checkpoint.js',
  'scripts/watcher-arm.js',
  'scripts/lib/briefing-watcher-control.js',
  'scripts/briefing-repair-freeze.js',
  'scripts/ec2-morning-report-prep-run.sh',
  'scripts/ec2-morning-briefing-run.sh',
  'scripts/install-briefing-cron.sh',
  'memory/AMY_REQUIREMENTS.md',
  'memory/feedback_bounded_helper_context.md',
]);

function parseArgs(argv) {
  const options = { date: '', dryRun: false, baseline: DEFAULT_BASELINE, label: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--date') options.date = argv[++index] || '';
    else if (value === '--baseline') options.baseline = argv[++index] || DEFAULT_BASELINE;
    else if (value === '--label') options.label = argv[++index] || '';
    else if (value === '--dry-run') options.dryRun = true;
  }
  if (options.label && !/^[a-z0-9][a-z0-9-]{0,31}$/i.test(options.label)) {
    throw new Error('Fable briefing readiness audit label must be 1-32 letters, numbers, or hyphens');
  }
  return options;
}

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Fable briefing readiness audit requires --date YYYY-MM-DD');
  }
}

function dataDir(env = process.env) {
  return env.SECONDBRAIN_DATA_DIR || path.join(
    env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'secondbrain',
    'data',
  );
}

function readIfPresent(file, maxChars = 40_000) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function run(command, args, { cwd = REPO_ROOT, timeout = 90_000, maxBuffer = 8 * 1024 * 1024, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

function clip(value, maxChars) {
  const text = String(value || '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated at ${maxChars} characters]`;
}

function priorDates(date, count = 5) {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(anchor);
    value.setUTCDate(value.getUTCDate() - (count - index));
    return value.toISOString().slice(0, 10);
  });
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

function parseJsonLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseJson)
    .filter(Boolean);
}

function summarizeHistoricalObservation(raw, error = '') {
  const receipt = parseJson(raw);
  if (!receipt) return { available: false, error: error || clip(raw, 1_000) || 'missing' };
  const snapshot = receipt.snapshot || {};
  return {
    available: true,
    checkedAt: receipt.checkedAt || null,
    classification: receipt.classification || null,
    action: receipt.action || null,
    observer: snapshot.observer || null,
    report: snapshot.report || null,
    delivery: snapshot.delivery || null,
    namedProgress: snapshot.namedProgress || null,
    findings: Array.isArray(snapshot.findings)
      ? snapshot.findings.map((finding) => ({
        class: finding.class,
        evaluated: finding.evaluated,
        triggered: finding.triggered,
        reason: finding.reason,
      }))
      : [],
  };
}

function gatherHistoricalEvidence({ date, runtimeData, env = process.env, runFn = run } = {}) {
  const dates = priorDates(date, 5);
  const nights = dates.map((historicalDate) => {
    const acquisitionFile = path.join(runtimeData, 'agent', 'watcher-acquisition', `${historicalDate}.json`);
    const firesFile = path.join(runtimeData, 'agent', 'watcher-acquisition', `${historicalDate}-scheduled-fires.jsonl`);
    const reportEventsFile = path.join(runtimeData, 'agent', 'overnight-report-events', `${historicalDate}.jsonl`);
    const acquisition = parseJson(readIfPresent(acquisitionFile, 50_000));
    const fires = parseJsonLines(readIfPresent(firesFile, 80_000));
    const reportEvents = parseJsonLines(readIfPresent(reportEventsFile, 80_000));
    const observation = runFn(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'watcher-checkpoint.js'), '--observe-only', '--date', historicalDate],
      { cwd: REPO_ROOT, timeout: 90_000, env },
    );
    return {
      date: historicalDate,
      acquisition: acquisition ? {
        status: acquisition.status || null,
        preparedAt: acquisition.preparedAt || null,
        confirmedAt: acquisition.confirmedAt || null,
        cloudPreflight: acquisition.cloudPreflight?.classification || null,
        verificationOk: acquisition.verification?.ok ?? null,
        schedulerProof: acquisition.schedulerProof || null,
        realFireCanary: acquisition.realFireCanary || null,
        pauseRequestedAt: acquisition.pauseRequestedAt || null,
        expirationDefects: acquisition.expirationDefects || [],
      } : { status: 'missing' },
      scheduledFires: {
        count: fires.length,
        first: fires[0] || null,
        last: fires.at(-1) || null,
      },
      reportEvents: {
        count: reportEvents.length,
        first: reportEvents[0] || null,
        last: reportEvents.at(-1) || null,
      },
      postHocObservation: summarizeHistoricalObservation(
        observation.stdout,
        observation.stderr || observation.error || `exit ${observation.status}`,
      ),
    };
  });
  const changeHistory = runFn(
    'git',
    [
      'log',
      `--since=${dates[0]}T00:00:00Z`,
      '--date=iso-strict',
      '--format=%h %ad %s',
      '--',
      ...REVIEW_FILES,
    ],
    { cwd: REPO_ROOT, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return {
    premise: 'ExampleCo reports that neither watcher has reliably produced an on-time complete briefing despite daily attempts, daily fixes, and daily retries.',
    evidenceWarning: 'The owner premise is important empirical testimony, but the universal word never must be tested against receipts. Missing or contradictory receipts are evidence of observability weakness, not proof of success.',
    nights,
    relevantChangeHistory: changeHistory.ok
      ? clip(changeHistory.stdout, 30_000)
      : `unavailable: ${changeHistory.stderr || changeHistory.error || `exit ${changeHistory.status}`}`,
  };
}

function gatherEvidence({ date, baseline = DEFAULT_BASELINE, env = process.env, runFn = run } = {}) {
  assertDate(date);
  const runtimeData = dataDir(env);
  const acquisitionFile = path.join(runtimeData, 'agent', 'watcher-acquisition', `${date}.json`);
  const automationFile = path.join(
    env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'automations',
    'overnight-briefing-watcher',
    'automation.toml',
  );
  const head = runFn('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, timeout: 15_000 });
  const status = runFn('git', ['status', '--short'], { cwd: REPO_ROOT, timeout: 15_000 });
  const checkpoint = runFn(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'watcher-checkpoint.js'), '--observe-only', '--date', date],
    { cwd: REPO_ROOT, timeout: 90_000, env },
  );
  const diff = runFn(
    'git',
    ['diff', '--no-ext-diff', '--no-color', baseline, 'HEAD', '--', ...REVIEW_FILES],
    { cwd: REPO_ROOT, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const historicalEvidence = gatherHistoricalEvidence({ date, runtimeData, env, runFn });
  return {
    capturedAt: new Date().toISOString(),
    date,
    localHead: head.stdout || `unavailable: ${head.stderr || head.error}`,
    localStatus: status.stdout || '(clean or unavailable)',
    acquisition: readIfPresent(acquisitionFile, 50_000) || 'missing',
    automation: readIfPresent(automationFile, 50_000) || 'missing',
    cloudCheckpoint: checkpoint.ok
      ? checkpoint.stdout
      : `unavailable: ${checkpoint.stderr || checkpoint.error || `exit ${checkpoint.status}`}`,
    implementationDiff: diff.ok
      ? clip(diff.stdout, 120_000)
      : `unavailable: ${diff.stderr || diff.error || `exit ${diff.status}`}`,
    historicalEvidence,
    baseline,
    acquisitionFile,
    automationFile,
  };
}

function buildAuditArtifact(evidence) {
  return `# Fable audit: Daily Briefing on-time delivery and safeguard independence

You are Fable 5 acting as an independent reliability engineer and probabilistic red-team reviewer. Do not edit anything. Do not accept Amy's claims merely because they are stated. Use only the bounded evidence below, distinguish proof from assertion, and penalize every untested or correlated dependency.

## Owner outcome

By 5:30 AM CT on ${evidence.date}, ExampleCo must receive both channels of the Daily Briefing and a fully completed, truthful Overnight report. The goal is not merely that processes ran. The report must be finalized, hash-audited, and complete; Telegram and Gmail must both have same-date on-time receipts.

Two safeguards are intended to be independently useful:

1. The EC2 cloud supervisor watches semantic per-red-unit progress, requests cooperative handoff, becomes the sole controller owner when dissatisfied, and hands back only after proof.
2. The attended Codex watcher in the current task reads the same bounded evidence on twelve scheduled wakes and can recover exact card, report, or delivery stages through lease-protected takeover.

The attended watcher is intentionally PAUSED until ExampleCo explicitly designates a task as the watcher for one exact briefing date. A paused automation during design review is compliant state. Assess reliability conditional on a valid same-date acquisition, and separately identify any activation-policy risk without changing that owner constraint.

The short-context cloud model observer is diagnostic, not production authority. EC2 remains the autonomous production owner. Do not assume the two safeguards are statistically independent: identify shared code, EC2, data, credential, scheduler, lease, notification, model-quota, and operator assumptions.

## Required answer

Immediately after VERDICT, add these lines:

OVERALL_PROBABILITY_ON_TIME_COMPLETE: NN%
CONFIDENCE_IN_ESTIMATE: low | medium | high
PROBABILITY_BOTH_SAFEGUARDS_HEALTHY: NN%
PROBABILITY_CLOUD_SUPERVISOR_DOWN_ATTENDED_HEALTHY: NN%
PROBABILITY_ATTENDED_DOWN_CLOUD_HEALTHY: NN%
PROBABILITY_ONE_DIAGNOSTIC_MODEL_OR_QUOTA_LANE_DOWN: NN%
PROBABILITY_SHARED_EC2_OR_COMMON_CODE_FAILURE: NN%

Define the denominator and explain why these conditional probabilities differ. Do not manufacture precision: give a point estimate plus a defensible range in the narrative.

Then provide:

FIRST_AUDIT_CHALLENGE:
- The prior Fable audit correctly identified shared sensors, process-state substitution, late rescue, report-capacity risk, a possible stale flock token, the repair-freeze race, and a hung-send blind window.
- Review whether its top recommendation to re-arm immediately conflicts with the stated activation policy; score conditional acquisition risk separately from pre-designation state.
- Separate a failed cloud-supervisor process on a healthy EC2 host from a shared EC2/data/credential failure.
- Re-audit whether CARD-PROGRESS receipts are immutable, exact-unit bound, predecessor-linked, and resistant to both breadth-first false alarms and sibling false credit.
- Re-audit whether report work begins early enough for 04:00 to be an audit/convergence stage instead of the first substantive draft.
- Re-audit whether rescue acquisition is atomic and every intervention records the named outcome, not only that a child process launched.
- Re-audit whether attended sensing has a materially independent classifier or merely repeats the cloud classifier's blind spots.

WHY_WE_KEEP_MISSING_IT:
- Start with the strongest defensible theory for why both watchers and the healer repeatedly look healthy yet fail ExampleCo's actual morning outcome.
- Build a dated table for each evidenced night: what the system claimed, what actually happened, what the watcher/healer failed to perceive or act on, and whether the next day's change attacked the causal mechanism or only the visible symptom.
- Identify the three recurring epistemic failure loops. Examples to test, not assume: shared sensors masquerading as independent safeguards; process/marker success substituted for user-outcome success; post-deadline states classified as healthy; retries that repeat a tactic without new evidence; tests proving code paths but never killing one safeguard during a full night.
- Explain why the healer did not heal the healer. Distinguish inability to detect, inability to acquire authority, inability to execute, and insufficient remaining time.
- Audit whether every surviving red and every watcher intervention received a fully evidenced causal root cause. Treat symptom closure or an unexplained intervention as a mechanism that permits the next night's recurrence.
- State bluntly where the team has been blind, why daily reviews did not correct it, and what evidence would falsify your theory.
- Treat a contradiction such as PROGRESSING plus onTime=false/status=red after the deadline as a critical classifier defect, not a cosmetic inconsistency.

FINDINGS:
- Findings first, ordered by expected reduction in the probability of an on-time complete delivery.
- Identify whether each failure is independent, correlated, or a single point of failure.
- Explicitly test whether either safeguard can actually finish cards, finish the report, and trigger delivery when the other safeguard is absent.
- Separate "wakes and notices" from "has sufficient authority, time, and a working execution path to recover."

MAXIMIZE_SUCCESS:
- Rank the five highest-value changes by estimated probability-point gain, implementation time, token cost, and regression risk.
- Split changes into before-tonight and later hardening.
- State the minimum useful validation that should be run before 11:00 PM CT.

TOKEN_STRATEGY:
- Design the lowest-token policy that preserves delivery reliability.
- Compare the current deterministic/change-triggered watcher design with the old all-night live session.
- Decide whether a sleeping, bounded all-night session should be retained as a tertiary fail-safe. If yes, specify exact activation and termination conditions so it does not spin or duplicate owners. If no, explain why.
- Use smaller models for unchanged observations and mechanical checks; reserve Fable/top reasoning for materially changed evidence or hard recovery decisions.

FAILURE_TIMELINE:
- Walk a worst-case night from 11:00 PM through 5:31 AM. Name the latest point at which each safeguard can fail while the other still recovers on time.

TESTS/RISK:
- List missing fault-injection tests and the smallest decisive end-to-end rehearsal.
- Treat the first real attended scheduled-fire canary as pending unless the evidence proves it.
- Treat prior late delivery as empirical evidence, not as a prediction that the new controls work.

OPEN QUESTIONS:
- Include only questions whose answers materially move the probability estimate.

## Known historical evidence to challenge

- ExampleCo's direct empirical assessment is that neither watcher has reliably delivered the required complete, on-time morning outcome, despite trying, fixing, and retrying every day. Do not soften this into a one-night incident.
- The 2026-08-29 briefing was delivered at 10:19:16 AM CT, well after the 5:30 AM deadline.
- The prior design woke and emitted activity but accepted aggregate movement, heartbeats, timestamp churn, and repeated tactics too readily.
- The new design claims semantic exact-unit gates at 00:00, 01:00, 02:00, 03:00, 03:30, 04:00, and 04:30 CT.
- Report milestones claim start at 04:00, accepted at 04:05, evidence-ready at 04:15, valid draft at 04:35, repair freeze at 05:00, final audited bytes at 05:15, sends at 05:20, and both receipts by 05:30:59.
- The main watcher implementation previously passed 553 tests; the date-pinning follow-up passed 113 scoped tests. These are code tests, not a successful PC-off night.
- Several acquisition receipts prove that scheduled fires occurred, yet scheduled-fire proof is not recovery proof and recovery proof is not delivery proof.
- The current post-hoc 2026-08-29 observer can classify the night as PROGRESSING/card-board-complete while the same snapshot says delivery onTime=false and status=red. Audit this contradiction as a candidate explanation for repeated blindness.

## Evidence captured at ${evidence.capturedAt}

### Local release

\`\`\`
HEAD: ${evidence.localHead}
STATUS: ${evidence.localStatus}
BASELINE FOR BOUNDED DIFF: ${evidence.baseline}
\`\`\`

### Attended acquisition receipt

\`\`\`json
${evidence.acquisition}
\`\`\`

### Persisted Codex automation

\`\`\`toml
${evidence.automation}
\`\`\`

### Live EC2 watcher observation

\`\`\`json
${evidence.cloudCheckpoint}
\`\`\`

### Five-night history, retries, and post-hoc outcomes

The post-hoc observations use today's watcher code against historical dated artifacts. They are not a replay of the historical binary, but they expose what today's classifier can and cannot infer from retained evidence.

\`\`\`json
${JSON.stringify(evidence.historicalEvidence, null, 2)}
\`\`\`

### Bounded implementation diff

\`\`\`diff
${evidence.implementationDiff}
\`\`\`
`;
}

function extractProbability(review) {
  const match = String(review || '').match(/OVERALL_PROBABILITY_ON_TIME_COMPLETE\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function extractVerdict(review) {
  const match = String(review || '').match(/VERDICT\s*:\s*([^\r\n]+)/i);
  return match ? match[1].trim() : 'unavailable';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHtml({ date, review = '', row = null, error = '', evidence = null } = {}) {
  const probability = extractProbability(review);
  const verdict = extractVerdict(review);
  const status = error ? 'Fable unavailable' : 'Fable completed';
  const model = row?.inference?.resolved_model || row?.requested_model || 'unavailable';
  const provider = row?.inference?.provider || 'unavailable';
  const outputTokens = Number(row?.inference?.selected_output_tokens || 0);
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fable briefing readiness audit ${escapeHtml(date)}</title>
<style>
body{margin:0;background:#f4f1ea;color:#211f1b;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1050px;margin:0 auto;padding:40px 22px 72px}h1{font-size:2rem;margin:.15em 0}.eyebrow{letter-spacing:.08em;text-transform:uppercase;color:#78523b;font-weight:750}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:24px 0}.card,.review{background:#fff;border:1px solid #ddd4c7;border-radius:16px;padding:20px;box-shadow:0 8px 24px #5a463012}.big{font-size:2.25rem;font-weight:800;color:#9b3f2b}.ok{color:#2f6d43}.meta{color:#6f685f;font-size:.93rem}.review{margin-top:20px}.review pre{white-space:pre-wrap;word-break:break-word;font:14px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.warn{border-left:5px solid #b34b34}.footer{margin-top:24px;color:#756d63;font-size:.86rem}
</style></head><body><main class="wrap">
<div class="eyebrow">Independent reliability review</div><h1>Daily Briefing readiness for ${escapeHtml(date)}</h1>
<p>${escapeHtml(status)}. This report preserves Fable's complete response and model provenance.</p>
<section class="grid">
<div class="card"><div class="meta">Overall probability</div><div class="big">${probability === null ? 'Not provided' : `${probability}%`}</div></div>
<div class="card"><div class="meta">Verdict</div><div class="big ${error ? '' : 'ok'}">${escapeHtml(verdict)}</div></div>
<div class="card"><div class="meta">Model proof</div><strong>${escapeHtml(model)}</strong><br><span class="meta">${escapeHtml(provider)}, ${outputTokens} output tokens</span></div>
</section>
${error ? `<section class="review warn"><h2>Invocation failure</h2><pre>${escapeHtml(error)}</pre></section>` : ''}
<section class="review"><h2>Fable's complete assessment</h2><pre>${escapeHtml(review || 'No review text was returned.')}</pre></section>
<section class="review"><h2>Evidence boundary</h2><p>The review used a bounded packet captured at ${escapeHtml(evidence?.capturedAt || generatedAt)}, the acquired watcher receipt, persisted automation, live EC2 observation, and the relevant implementation diff. It is an estimate, not an on-time-delivery receipt.</p></section>
<div class="footer">Generated ${escapeHtml(generatedAt)}. Artifact SHA-256: ${crypto.createHash('sha256').update(String(review || error)).digest('hex')}</div>
</main></body></html>`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  assertDate(options.date);
  const runtimeData = dataDir(env);
  const outputDir = path.join(runtimeData, 'agent', 'fable-briefing-readiness');
  const suffix = options.label ? `-${options.label}` : '';
  const evidence = gatherEvidence({ date: options.date, baseline: options.baseline, env });
  const artifact = buildAuditArtifact(evidence);
  const artifactFile = path.join(outputDir, `${options.date}${suffix}-evidence.md`);
  const htmlFile = path.join(runtimeData, 'briefings', `fable-briefing-readiness-${options.date}${suffix}.html`);
  const receiptFile = path.join(outputDir, `${options.date}${suffix}-receipt.json`);
  writeAtomic(artifactFile, artifact);

  if (options.dryRun) {
    const result = { ok: true, dryRun: true, date: options.date, artifactFile, htmlFile };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  // The historical Fable audit name describes the report, not a permitted
  // provider. Run the review through the pinned subscription Codex boundary.
  const peer = run(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts', 'codex-peer-review.js'),
      '--artifact-file', artifactFile,
      '--title', `Fable Daily Briefing delivery-readiness audit ${options.date}`,
      '--focus', 'Estimate the probability of a fully completed report and both briefing deliveries by 5:30 AM CT.',
      '--focus', 'Test each safeguard-loss scenario independently and expose correlated single points of failure.',
      '--focus', 'Rank probability gain per token and decide whether a sleeping bounded all-night session should remain as a tertiary fail-safe.',
      '--timeout-min', '30',
      '--no-diff',
      // Fable is part of briefing execution. If both Codex paths fail, remain
      // honestly blocked instead of entering codex-peer-review's general-purpose
      // degraded Claude self-pass.
      '--no-self-pass',
    ],
    {
      cwd: REPO_ROOT,
      timeout: 35 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...env, SECONDBRAIN_BRIEFING_CODEX_CEILING: 'gpt-5.6-sol:medium' },
    },
  );

  let row = null;
  let error = '';
  if (peer.ok) {
    try {
      row = JSON.parse(peer.stdout);
    } catch (parseError) {
      error = `Fable result was not auditable JSON: ${parseError.message}`;
    }
  } else {
    error = peer.stderr || peer.error || `Fable peer review exited ${peer.status}`;
  }
  const review = row?.review || '';
  if (!error && extractProbability(review) === null) {
    error = 'Fable completed but omitted OVERALL_PROBABILITY_ON_TIME_COMPLETE.';
  }
  const receipt = {
    schema: 'fable-briefing-readiness-audit@1',
    date: options.date,
    completedAt: new Date().toISOString(),
    ok: !error,
    probability: extractProbability(review),
    verdict: extractVerdict(review),
    artifactFile,
    htmlFile,
    model: row?.inference || null,
    reviewId: row?.id || null,
    error: error || null,
  };
  writeAtomic(htmlFile, renderHtml({ date: options.date, review, row, error, evidence }));
  writeAtomic(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (error) process.exitCode = 1;
  return receipt;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[fable-briefing-readiness-audit] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REVIEW_FILES,
  buildAuditArtifact,
  extractProbability,
  extractVerdict,
  gatherEvidence,
  gatherHistoricalEvidence,
  parseArgs,
  priorDates,
  renderHtml,
};
