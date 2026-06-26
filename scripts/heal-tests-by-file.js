#!/usr/bin/env node
/**
 * heal-tests-by-file.js
 *
 * Test-failure-targeted self-heal with a RETRY LADDER, not a single shot.
 *
 * History: the original driver spawned ONE codex session per failing test
 * file, an 8-minute budget, attempted each file exactly once, and trusted
 * the model's self-reported {status:"cleared"}. A single transient hang or a
 * model that lied about clearing left the file failing with no second try.
 *
 * The rebuild:
 *   - Each failing file is healed by healFileUntilGreen(), which loops up to
 *     MAX_ATTEMPTS (default 4) on a ladder that ALTERNATES executors and
 *     FEEDS FORWARD prior failures so attempt N is better-informed than N-1:
 *       attempt 1: claude
 *       attempt 2: codex
 *       attempt 3: claude, with prior-failure context appended
 *       attempt 4: codex,  with prior-failure context appended
 *     Each session call goes through scripts/lib/heal-executor.js
 *     (runHealSession), which owns the per-executor CLI shape, parser, and
 *     hang detection, plus the --setting-sources '' fix that stops the
 *     Windows claude-plugin deadlock.
 *   - VERIFICATION IS AUTHORITATIVE. The model's self-report is advisory.
 *     After every attempt we re-run vitest on JUST that file and parse the
 *     real result. Zero failures => CLEARED. Anything else => keep climbing.
 *   - Per-attempt budget is generous (heal-executor DEFAULT_BUDGET_MS, ~30
 *     min). The only hard bound is the global deadline (deadlineMs) so the
 *     overnight run finishes before 05:15 CT.
 *   - PARALLELISM: distinct failing files touch disjoint code, so up to
 *     MAX_CONCURRENCY (default 3) files heal at once via a small promise
 *     pool. COMMIT POLICY (simplest correct option): the heal sessions make
 *     and VERIFY the fix but DO NOT commit. A file that verifies green is
 *     marked cleared with its working-tree edits in place; the MAIN THREAD
 *     commits all healed files together at the end. This removes any git
 *     race entirely, since no session ever runs git commit/push.
 *   - LOUD FAILURE: a file that exhausts the ladder or hits the deadline is
 *     recorded honestly: "blocked on ExampleCo: <X>" when any attempt returned a
 *     genuine-wall escalation, otherwise "Amy defect: <file>, all repair
 *     paths exhausted: [claude->reason, codex->reason, ...], last verify: N
 *     failing". The full ladder is written to
 *     data/agent/heal-tests-by-file-runs.jsonl. A file is NEVER reported
 *     cleared without a passing vitest re-run.
 *
 * Source of truth for failures: data/agent/vitest-probe-output.json (the
 * pre-briefing diagnostic writes this).
 *
 * Run:
 *   node scripts/heal-tests-by-file.js [--max-files 8] [--max-attempts 4]
 *        [--concurrency 3] [--budget-ms 1800000] [--deadline-ct 05:15]
 *        [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const executor = require('./lib/heal-executor.js');
const { runWithFallback, runHealSession, WALL, FAULT, DEFAULT_BUDGET_MS } = executor;

const REPO = path.resolve(__dirname, '..');
const VITEST_PROBE = path.join(REPO, 'data', 'agent', 'vitest-probe-output.json');
const RUNS_LOG = path.join(REPO, 'data', 'agent', 'heal-tests-by-file-runs.jsonl');
const SESSION_LOG_DIR = path.join(REPO, 'logs', 'heal-sessions');
const TESTS_BLOCKED = path.join(REPO, 'data', 'agent', 'tests-blocked.json');

// After a file is verified green, the nightly cache must stop reporting its
// failures. 2026-06-11 incident: tests-blocked.json was written at 23:04, this
// driver cleared the only failure at 23:32, nothing rewrote the cache, and the
// 5:30 AM briefing (which trusts the cache for 14h) shipped the dead failure
// as a live RED hard blocker. Rewrite the cache minus the cleared files and
// stamp a heal receipt so the briefing can show the fix instead of the
// pre-fix snapshot.
function writeBackClearedToTestsBlocked(
  testsBlockedPath,
  clearedRelPaths,
  now = new Date(),
  testDirs = ['src/main/__tests__', 'tests', 'scripts/__tests__'],
) {
  try {
    const tb = JSON.parse(fs.readFileSync(testsBlockedPath, 'utf8'));
    // The cache keys failures by basename only. A basename that exists in
    // MORE than one test dir is ambiguous: clearing its rows could hide a
    // same-named file that is still failing (Codex review of 8c262ab6). Skip
    // ambiguous basenames; the publish-time re-verify resolves them instead.
    const clearedBases = new Set(
      (clearedRelPaths || [])
        .map((p) => String(p).split(/[\\/]/).pop())
        .filter(Boolean)
        .filter((base) => {
          const matches = testDirs.filter((d) => {
            try {
              return fs.existsSync(path.join(REPO, d, base));
            } catch {
              return false;
            }
          });
          return matches.length <= 1;
        }),
    );
    const items = Array.isArray(tb.items) ? tb.items : [];
    const remaining = items.filter(
      (it) =>
        !clearedBases.has(
          String((it && it.file) || '')
            .split(/[\\/]/)
            .pop(),
        ),
    );
    const removed = items.length - remaining.length;
    if (removed === 0) return { updated: false, removed: 0 };
    tb.items = remaining;
    // items may be a truncated view of the failures (heal-tests caps the
    // list), so never recount from items alone: subtract what was actually
    // removed from the recorded failed count, flooring at the rows listed.
    const failedBefore = Number.isFinite(Number(tb.failed)) ? Number(tb.failed) : items.length;
    tb.failed = Math.max(remaining.length, failedBefore - removed);
    if (Number.isFinite(tb.total)) tb.passed = tb.total - tb.failed;
    tb.healedAt = now.toISOString();
    tb.healedFiles = [...new Set([...(tb.healedFiles || []), ...clearedBases])];
    // Atomic replace: the nightly loop and this driver can both touch the
    // cache; a torn write must never leave half a JSON for the briefing.
    const tmpPath = `${testsBlockedPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(tb, null, 2));
    fs.renameSync(tmpPath, testsBlockedPath);
    return { updated: true, removed };
  } catch (e) {
    return { updated: false, error: (e && e.message) || String(e) };
  }
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_DEADLINE_CT = '05:15';

// The ladder: which executor runs on attempt i (1-indexed) and whether that
// attempt should receive the accumulated prior-failure context. Alternating
// executors gives each model two cracks; appending context from attempt 2
// onward means later attempts are strictly better-informed.
function executorForAttempt(attempt) {
  // 1->claude, 2->codex, 3->claude, 4->codex, ...
  return attempt % 2 === 1 ? 'claude' : 'codex';
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* */
  }
}

function appendRunLog(row) {
  ensureDir(path.dirname(RUNS_LOG));
  fs.appendFileSync(RUNS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function readFailedFiles() {
  if (!fs.existsSync(VITEST_PROBE)) {
    return {
      ok: false,
      error: 'vitest-probe-output.json not found; run pre-briefing-diagnostic first',
    };
  }
  const raw = JSON.parse(fs.readFileSync(VITEST_PROBE, 'utf8'));
  const files = (raw.testResults || []).filter((f) => f.status === 'failed');
  return {
    ok: true,
    files: files.map((f) => ({
      path: f.name,
      relPath: path.relative(REPO, f.name).replace(/\\/g, '/'),
      failures: (f.assertionResults || [])
        .filter((a) => a.status === 'failed')
        .map((a) => ({
          title: a.title,
          firstMessageLine: (a.failureMessages || [''])[0].split(/\r?\n/)[0].slice(0, 400),
        })),
    })),
  };
}

// Compose the per-attempt prompt. priorAttempts feeds every earlier failure
// (executor + escalation reason + the verifier's failing count/sample) into
// the next attempt so the model is not blind to what already did not work.
function buildPrompt(file, opts = {}) {
  const deadlineIso = opts.deadlineIso || new Date(Date.now() + DEFAULT_BUDGET_MS).toISOString();
  const priorAttempts = opts.priorAttempts || [];
  const failureLines = file.failures
    .map((f, i) => `  ${i + 1}. ${f.title}\n     ${f.firstMessageLine}`)
    .join('\n');
  const fileId = slug(path.basename(file.relPath));

  const lines = [
    `You are Amy doing self-heal. ONE failing test file to clear.`,
    ``,
    `FILE: ${file.relPath}`,
    `FAILING ASSERTIONS (${file.failures.length}):`,
    failureLines,
    ``,
    `REPO: ${REPO}`,
    `HARD DEADLINE: ${deadlineIso} UTC. Escalate cleanly if you would push past it.`,
    ``,
  ];

  if (priorAttempts.length) {
    lines.push(`PRIOR ATTEMPTS ON THIS FILE FAILED, do NOT repeat them:`);
    priorAttempts.forEach((p, i) => {
      lines.push(
        `  attempt ${i + 1} (${p.executor}): ${p.escalationReason || p.statusNote || 'still failing'}`,
      );
      if (p.verifySample) lines.push(`    verify after that attempt: ${p.verifySample}`);
    });
    lines.push(`Pick a DIFFERENT root cause or a different fix shape than the attempts above.`);
    lines.push(``);
  }

  lines.push(
    `WORKFLOW:`,
    `  1. Read ${file.relPath}. Read the production code it tests. Decide whether the TEST is stale (expectations drifted) or the CODE is wrong.`,
    `  2. Make the smallest surgical fix that makes the failing assertions pass without breaking adjacent assertions. Keep it minimal.`,
    `  3. Run: npx vitest run ${file.relPath} --reporter=default and confirm zero failures.`,
    `  4. DO NOT commit or push. Leave the fix in the working tree. The orchestrator commits all healed files together after verifying each independently.`,
    ``,
    `OUTPUT CONTRACT (final assistant message MUST be a single JSON object on its own line):`,
    `  {"status":"cleared"|"escalated","file":"${file.relPath}","summary":"<one sentence>","escalation_reason":"<empty if cleared, one sentence if escalated>"}`,
    ``,
    `Escalate cleanly if: the fix requires a decision only ExampleCo can make, the fix would touch >5 files, the failing assertion encodes a behavior whose intent you cannot determine. The orchestrator re-runs vitest itself, so a false "cleared" is caught; report honestly.`,
    ``,
    `blocker_id: tests-${fileId}`,
  );
  return lines.join('\n');
}

// ── Real verifier: re-run vitest on just this file and parse the result ──────
//
// Authoritative truth. Uses the same node-direct-on-vitest.mjs invocation
// shape proven in heal-tests.js (the npx.cmd shim silently swallows stdio on
// Windows under spawnSync), and the forward-slash --outputFile fix.
function vitestSafeOutputFile(p) {
  return String(p).replace(/\\/g, '/');
}

function realVerify(file, opts = {}) {
  const relPath = file.relPath || file;
  const tmp = path.join(
    os.tmpdir(),
    `sb-heal-verify-${slug(path.basename(relPath))}-${process.pid}.json`,
  );
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* */
  }
  const spawnArgs = [
    'node_modules/vitest/vitest.mjs',
    'run',
    relPath,
    '--reporter=json',
    `--outputFile=${vitestSafeOutputFile(tmp)}`,
  ];
  const res = spawnSync(process.execPath, spawnArgs, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let j = null;
  if (fs.existsSync(tmp)) {
    try {
      j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    } catch {
      /* */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
  }
  if (!j) {
    const m = String(res.stdout || '').match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        j = JSON.parse(m[0]);
      } catch {
        /* */
      }
    }
  }
  if (!j) {
    // Could not parse vitest output: treat as still-failing, NEVER as green.
    return {
      ok: false,
      failing: -1,
      sample: 'verify could not parse vitest output (timeout or crash)',
    };
  }
  let failing = 0;
  let sample = '';
  for (const r of j.testResults || []) {
    for (const a of r.assertionResults || []) {
      if (a.status === 'failed') {
        failing++;
        if (!sample)
          sample = `${a.title}: ${(a.failureMessages || [''])[0].split(/\r?\n/)[0].slice(0, 200)}`;
      }
    }
  }
  return { ok: failing === 0, failing, sample };
}

/**
 * Heal a single failing test file via the retry ladder.
 *
 * Dependency-injectable so unit tests never spawn a real CLI or run real
 * vitest. Inject opts.runSession and opts.verify.
 *
 * @param {object} file  {relPath, failures:[{title, firstMessageLine}]}
 * @param {object} opts
 *   - runSession(prompt, {executor, budgetMs, cwd}) -> Promise<sessionResult>
 *       sessionResult: {status:'cleared'|'escalated', executor, category?,
 *                       escalationReason?, summary?}  (heal-executor shape)
 *       Default: runHealSession from heal-executor.
 *   - verify(file, {timeoutMs}) -> {ok:boolean, failing:number, sample:string}
 *       Default: realVerify (re-runs vitest on this file).
 *   - maxAttempts   (default 4)
 *   - budgetMs      (default DEFAULT_BUDGET_MS, ~30 min per attempt)
 *   - deadlineMs    (absolute epoch ms; once passed, stop the ladder)
 *   - cwd
 *   - onAttempt(info)  optional progress hook
 * @returns {Promise<object>}
 *   {file, cleared:boolean, attempts:[...], finalFailing:number,
 *    resolution:'cleared'|'exhausted'|'deadline'|'wall',
 *    blockedOnExampleCo?:string, defectSummary?:string}
 */
async function healFileUntilGreen(file, opts = {}) {
  const runSession = opts.runSession || ((prompt, o) => runHealSession(prompt, o));
  const verify = opts.verify || ((f, o) => realVerify(f, o));
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const budgetMs = opts.budgetMs || DEFAULT_BUDGET_MS;
  const deadlineMs = opts.deadlineMs;
  const cwd = opts.cwd || REPO;

  const relPath = file.relPath || file.path || String(file);
  const attempts = [];
  const priorAttempts = [];
  let lastFailing = file.failures ? file.failures.length : -1;
  let lastSample = '';
  let hitWall = false;
  let wallReason = '';

  // Pre-check: is this a CREDENTIAL / DATA-FRESHNESS wall, not a code bug?
  // Some tests assert that an externally-refreshed artifact is fresh (e.g. the
  // LinkedIn DM crawl is < 36h old). When the underlying session/credential has
  // expired (PC was off, login lapsed), the ONLY fix is ExampleCo re-authenticating
  // or a data refresh he must enable. The code-edit ladder would "fix" it by
  // gaming the assertion (loosening the threshold / skipping), which is exactly
  // the fake-clean ExampleCo bans. Classify it as a ExampleCo-wall and skip the ladder.
  // 2026-06-07: LinkedIn DM crawl stale -> li_at cookie missing -> needs ExampleCo.
  const wallText = (file.failures || []).map((f) => `${f.title} ${f.firstMessageLine}`).join(' ');
  const wallM = wallText.match(
    /\b(not logged in|log ?in|sign[- ]?in|re-?auth\w*|credential|password|2fa|mfa|captcha|persistent chromium profile|li_at|cookie|run `[^`]*-(?:scan|login)[^`]*`|must be logged in)\b/i,
  );
  if (wallM) {
    hitWall = true;
    wallReason =
      `${relPath} is a credential/data-freshness wall, not a code bug: ${(file.failures[0] && file.failures[0].firstMessageLine) || wallM[0]}`.slice(
        0,
        400,
      );
    return finalize('wall');
  }

  // Pre-check: maybe the file already passes (a sibling healed shared code).
  // This is cheap insurance and makes attempt accounting honest.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
      return finalize('deadline');
    }
    const exec = executorForAttempt(attempt);
    const deadlineIso = new Date(
      Math.min(deadlineMs || Date.now() + budgetMs, Date.now() + budgetMs),
    ).toISOString();
    const prompt = buildPrompt(file, { deadlineIso, priorAttempts });

    if (opts.onAttempt) opts.onAttempt({ file: relPath, attempt, executor: exec });

    const perAttemptBudget = Number.isFinite(deadlineMs)
      ? Math.max(1, Math.min(budgetMs, deadlineMs - Date.now()))
      : budgetMs;

    const session = await runSession(prompt, { executor: exec, budgetMs: perAttemptBudget, cwd });

    // VERIFICATION IS AUTHORITATIVE. Re-run vitest on this file regardless of
    // what the model claimed. The session self-report is advisory only.
    const v = await verify(file, { timeoutMs: opts.verifyTimeoutMs });
    lastFailing = v.failing;
    lastSample = v.sample || lastSample;

    const attemptRec = {
      attempt,
      executor: session.executor || exec,
      sessionStatus: session.status,
      category: session.category,
      escalationReason: session.escalationReason || '',
      summary: session.summary || '',
      verifyFailing: v.failing,
      verifyOk: v.ok,
      verifySample: v.sample || '',
    };
    attempts.push(attemptRec);

    if (v.ok) {
      // Real green from a real vitest re-run. Done, regardless of what the
      // session said. Edits stay in the working tree for the main thread to
      // commit.
      return { file: relPath, cleared: true, attempts, finalFailing: 0, resolution: 'cleared' };
    }

    // Not green. Record this attempt as prior context for the next rung so the
    // model is better-informed, then decide whether to keep climbing.
    priorAttempts.push({
      executor: attemptRec.executor,
      escalationReason:
        attemptRec.escalationReason ||
        (session.status === 'cleared'
          ? 'model claimed cleared but vitest still failing'
          : 'still failing'),
      statusNote: session.status,
      verifySample: v.sample || `${v.failing} failing`,
    });

    // A genuine wall (needs ExampleCo) means neither executor will clear it. We
    // record it but DO NOT short-circuit the ladder for executor-fault, since
    // the alternate executor may still succeed. Only a WALL escalation that
    // also leaves it failing is a true block.
    if (session.category === WALL) {
      hitWall = true;
      wallReason = session.escalationReason || 'session reported a genuine wall (needs ExampleCo)';
      // The other executor hits the same wall, so stop climbing this file.
      return finalize('wall');
    }
  }

  return finalize('exhausted');

  function finalize(resolution) {
    const out = { file: relPath, cleared: false, attempts, finalFailing: lastFailing, resolution };
    if (resolution === 'wall' || hitWall) {
      out.resolution = 'wall';
      out.blockedOnExampleCo = wallReason || 'a prior attempt hit a genuine wall that needs ExampleCo';
    } else {
      const ladder = attempts
        .map(
          (a) =>
            `${a.executor}->${a.escalationReason || (a.verifyOk ? 'green-but-unconfirmed' : a.verifyFailing + ' failing')}`,
        )
        .join(', ');
      const failingStr =
        lastFailing < 0 ? 'ExampleCo (verify could not parse)' : `${lastFailing} failing`;
      out.defectSummary = `Amy defect: ${relPath}, all repair paths exhausted: [${ladder}], last verify: ${failingStr}`;
    }
    return out;
  }
}

// Small promise pool: run worker(item) over items with at most `limit` in
// flight. Distinct failing files touch disjoint code so concurrency is safe;
// no session commits, so there is no git race to serialize.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function drain() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = [];
  for (let k = 0; k < Math.max(1, Math.min(limit, items.length)); k++) runners.push(drain());
  await Promise.all(runners);
  return results;
}

function parseDeadlineToTodayCt(spec) {
  const m = String(spec || DEFAULT_DEADLINE_CT).match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const now = new Date();
  const dl = new Date(now);
  dl.setHours(hh, mm, 0, 0);
  if (dl.getTime() < now.getTime()) dl.setDate(dl.getDate() + 1);
  return dl.getTime();
}

function parseArgs(argv) {
  const out = {
    maxFiles: DEFAULT_MAX_FILES,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    concurrency: DEFAULT_MAX_CONCURRENCY,
    budgetMs: DEFAULT_BUDGET_MS,
    deadlineCt: DEFAULT_DEADLINE_CT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-files') out.maxFiles = parseInt(argv[++i], 10);
    else if (a === '--max-attempts') out.maxAttempts = parseInt(argv[++i], 10);
    else if (a === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (a === '--budget-ms') out.budgetMs = parseInt(argv[++i], 10);
    else if (a === '--deadline-ct') out.deadlineCt = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const probe = readFailedFiles();
  if (!probe.ok) {
    console.error('[heal-tests-by-file] error:', probe.error);
    appendRunLog({ stage: 'startup', error: probe.error });
    process.exit(2);
  }
  const files = probe.files.slice(0, opts.maxFiles);
  const deadlineMs = parseDeadlineToTodayCt(opts.deadlineCt);
  console.error(
    `[heal-tests-by-file] failing files=${probe.files.length}, attempting=${files.length}, max-attempts=${opts.maxAttempts}, concurrency=${opts.concurrency}, budget/attempt=${Math.round(opts.budgetMs / 1000)}s, deadline=${opts.deadlineCt} CT`,
  );
  appendRunLog({
    stage: 'startup',
    failed_files: probe.files.length,
    attempting: files.length,
    max_attempts: opts.maxAttempts,
    concurrency: opts.concurrency,
    budget_ms: opts.budgetMs,
    deadline_ct: opts.deadlineCt,
  });
  if (opts.dryRun) {
    for (const f of files)
      console.error(`[dry] ${f.relPath} (${f.failures.length} failing assertions)`);
    process.exit(0);
  }
  if (files.length === 0) {
    console.error('[heal-tests-by-file] no failing files, nothing to heal');
    process.exit(0);
  }
  ensureDir(SESSION_LOG_DIR);

  const results = await runPool(files, opts.concurrency, async (file) => {
    console.error(`[heal-tests-by-file] -> ${file.relPath} (${file.failures.length} failures)`);
    const r = await healFileUntilGreen(file, {
      maxAttempts: opts.maxAttempts,
      budgetMs: opts.budgetMs,
      deadlineMs,
      onAttempt: ({ attempt, executor: exec }) =>
        console.error(`  [${file.relPath}] attempt ${attempt} via ${exec}`),
    });
    appendRunLog({
      stage: 'file-complete',
      file: file.relPath,
      failures: file.failures.length,
      cleared: r.cleared,
      resolution: r.resolution,
      final_failing: r.finalFailing,
      attempts: r.attempts,
      blocked_on_ExampleCo: r.blockedOnExampleCo || '',
      defect_summary: r.defectSummary || '',
    });
    const headline = r.cleared
      ? 'CLEARED (verified green, uncommitted, main thread to commit)'
      : r.blockedOnExampleCo
        ? `BLOCKED ON ExampleCo: ${r.blockedOnExampleCo}`
        : r.defectSummary;
    console.error(`[heal-tests-by-file] ${file.relPath}: ${headline}`);
    return r;
  });

  const cleared = results.filter((r) => r.cleared);
  const blocked = results.filter((r) => !r.cleared && r.blockedOnExampleCo);
  const defect = results.filter((r) => !r.cleared && !r.blockedOnExampleCo);
  appendRunLog({
    stage: 'driver-complete',
    cleared: cleared.length,
    blocked_on_ExampleCo: blocked.length,
    defect: defect.length,
    attempted: files.length,
    total_failed: probe.files.length,
    cleared_files: cleared.map((r) => r.file),
  });
  console.error(
    `\n[heal-tests-by-file] done: cleared=${cleared.length} blocked-on-ExampleCo=${blocked.length} defect=${defect.length} (of ${files.length} attempted, ${probe.files.length} total failed)`,
  );
  if (cleared.length) {
    console.error(`[heal-tests-by-file] verified-green files awaiting commit by main thread:`);
    cleared.forEach((r) => console.error(`  - ${r.file}`));
    // Stale-cache fix (2026-06-11): the briefing reads tests-blocked.json for
    // up to 14h. A clear that never writes back leaves the briefing reporting
    // a failure that no longer exists. Receipt lands in the same cache.
    const wb = writeBackClearedToTestsBlocked(
      TESTS_BLOCKED,
      cleared.map((r) => r.file),
    );
    appendRunLog({ stage: 'tests-blocked-writeback', ...wb });
    if (wb.updated) {
      console.error(
        `[heal-tests-by-file] tests-blocked.json updated: ${wb.removed} cleared failure(s) removed`,
      );
    }
  }
  process.exit(blocked.length + defect.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[heal-tests-by-file] fatal:', e);
    appendRunLog({ stage: 'fatal', error: String(e.message || e) });
    process.exit(2);
  });
}

module.exports = {
  readFailedFiles,
  buildPrompt,
  healFileUntilGreen,
  executorForAttempt,
  realVerify,
  runPool,
  parseDeadlineToTodayCt,
  vitestSafeOutputFile,
  writeBackClearedToTestsBlocked,
};
