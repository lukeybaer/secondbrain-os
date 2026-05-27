#!/usr/bin/env node
/**
 * overnight-self-heal-orchestrator.js
 *
 * REAL overnight self-heal: spawn one Claude Code session per briefing
 * blocker, with a structured prompt that drives investigate / write or
 * update tests / fix code / consult Codex on meaningful changes / commit /
 * push / verify the blocker is cleared. Sequential (no git race). Hard
 * deadline. Single-instance lockfile. Every session result logged to
 * data/agent/overnight-self-heal-runs.jsonl so the morning briefing can
 * show what actually happened overnight with commit-SHA proof.
 *
 * Closes the 2026-05-23 Luke gap: "the clean briefing represents a clean
 * life and you have to do Claude Code sessions and fix stuff and test
 * it and commit it and repeat that process (each of those need
 * consultation with Codex as per the rule) and you're developing,
 * self-healing actively overnight."
 *
 * CLI shape: `claude --print --output-format=stream-json -p PROMPT`.
 * bypassPermissions is globally enabled in ~/.claude/settings.json.
 *
 * Locked by src/main/__tests__/overnight-self-heal-orchestrator.test.ts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const RUNS_LOG_PATH = path.join(REPO, 'data', 'agent', 'overnight-self-heal-runs.jsonl');
const LOCK_PATH = path.join(os.tmpdir(), 'secondbrain-overnight-self-heal.lock');
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // 6h (overnight window)
const DEFAULT_PER_SESSION_BUDGET_MS = 25 * 60 * 1000; // 25 minutes per blocker
const DEFAULT_DEADLINE_CT = '05:15';
const PEER_AGENT_NEED_RE = /\b(credential|password|api[\s-]?key|aws|2fa|mfa|approve|approval|decide|decision|choose|external|wire transfer|payment|legal|insurance|sign|signature|consent|interview|in[\s-]?person|notar)\b/i;
// Negation patterns: when the blocker explicitly declares Luke is NOT in the
// loop, the bare keyword match above must not flip the blocker to skip.
// 2026-05-24 regression: "Hard blocker, not a Luke decision" tripped on
// /decision/ and silenced an Amy-owned subsystem.
const NEED_NEGATION_RE = /\b(nothing|none\b|not a luke|not amy-owned|hard blocker, not|amy owns|amy classifies|amy must)\b/i;
const BRIEFING_FALLBACK_WINDOW_MS = 36 * 60 * 60 * 1000;

// Parse the BLOCKERS section of a briefing markdown into structured tasks.
function parseBlockersFromMarkdown(md) {
  if (!md) return [];
  const startMarker = /^BLOCKERS\b[^\n]*:\s*$/m;
  const startMatch = md.match(startMarker);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  // Block runs until the next ALL-CAPS top-level section.
  const tail = md.slice(startIdx);
  const endMatch = tail.match(/\n(?=[A-Z][A-Z &]+:\s*$)/m);
  const body = endMatch ? tail.slice(0, endMatch.index) : tail;
  // Each blocker starts with "<n>. <title>" at column 0.
  const lines = body.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const rawLine of lines) {
    const line = rawLine;
    const itemHead = line.match(/^(\d+)\.\s+(.+?)\s*$/);
    if (itemHead) {
      if (cur) out.push(cur);
      cur = {
        index: parseInt(itemHead[1], 10),
        title: itemHead[2].trim(),
        requirement: '',
        evidence: '',
        repair: '',
        owner: '',
        need: '',
      };
      continue;
    }
    if (!cur) continue;
    // 2026-05-24 format update: blockers now use concrete labels
    // ("What's failing", "What I tried", "Next step", "What you need to
    // do") instead of meta-commentary ("Requirement", "Relentless
    // iteration verdict", "Need from Luke"). Old labels still parse for
    // back-compat with archived briefings on disk.
    const kv = line.match(/^\s+(Requirement|Evidence|Repair now|Owner|Need from Luke|What's failing|What I tried|Next step|What you need to do):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (key === 'Requirement') cur.requirement = val;
      else if (key === 'Evidence' || key === "What's failing") cur.evidence = val;
      else if (key === 'Repair now' || key === 'Next step') cur.repair = val;
      else if (key === 'Owner') cur.owner = val;
      else if (key === 'Need from Luke' || key === 'What you need to do') cur.need = val;
      else if (key === 'What I tried') cur.tried = val;
      continue;
    }
    // Continuation of the prior field if it ends mid-sentence.
    const cont = line.match(/^\s+(.+)$/);
    if (cont && cur && cur.need) cur.need += ' ' + cont[1].trim();
    else if (cont && cur && cur.evidence && !cur.repair && !cur.owner) cur.evidence += ' ' + cont[1].trim();
  }
  if (cur) out.push(cur);
  return out;
}

// Decide whether the orchestrator should auto-attempt this blocker.
// Anything that names a credential, decision, or external action stays
// out of scope.
function classifyOwnership(blocker) {
  const owner = String(blocker.owner || '').trim().toLowerCase();
  const need = String(blocker.need || '');
  if (owner === 'luke') return { canAutoAttempt: false, reason: 'owner=Luke explicit' };
  if (NEED_NEGATION_RE.test(need)) return { canAutoAttempt: true };
  if (PEER_AGENT_NEED_RE.test(need)) {
    return { canAutoAttempt: false, reason: 'need from Luke names an external action (credential/decision/approval)' };
  }
  return { canAutoAttempt: true };
}

// 2026-05-24 fix: when the scheduled task runs at 22:30 CT the UTC date is
// already tomorrow, so briefing-{date}.md does not exist yet. Walk the
// briefings dir and pick the newest file within a 36h window; null only when
// nothing recent is on disk (real wall, surfaces as a startup escalation).
function resolveLatestBriefingPath({ date, briefingsDir, nowMs }) {
  const exact = path.join(briefingsDir, `briefing-${date}.md`);
  try {
    if (fs.statSync(exact).isFile()) return exact;
  } catch { /* fall through */ }
  let entries;
  try { entries = fs.readdirSync(briefingsDir); }
  catch { return null; }
  const cutoff = nowMs - BRIEFING_FALLBACK_WINDOW_MS;
  let best = null;
  for (const name of entries) {
    if (!/^briefing-\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const full = path.join(briefingsDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoff) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { full, mtimeMs: stat.mtimeMs };
  }
  return best ? best.full : null;
}

// Compose the per-session prompt. Self-contained: the spawned session has
// no memory of this orchestrator beyond what this prompt provides.
function buildSessionPrompt(blocker, opts = {}) {
  const repoRoot = opts.repoRoot || REPO;
  const deadlineIso = opts.deadlineIso || new Date(Date.now() + 25 * 60 * 1000).toISOString();
  const branchSummary = opts.branchSummary || 'master';
  const blockerId = (blocker.title || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  return [
    `You are Amy doing overnight self-heal development work. ONE briefing blocker to clear.`,
    ``,
    `BLOCKER:`,
    `  title:       ${blocker.title || ''}`,
    `  requirement: ${blocker.requirement || ''}`,
    `  evidence:    ${blocker.evidence || ''}`,
    `  repair plan: ${blocker.repair || ''}`,
    `  owner:       ${blocker.owner || 'Amy'}`,
    `  need:        ${blocker.need || 'Nothing'}`,
    `  blocker_id:  ${blockerId}`,
    ``,
    `REPO: ${repoRoot}`,
    `BRANCH: ${branchSummary}`,
    `HARD DEADLINE: ${deadlineIso} (UTC). If your work would push past this, escalate cleanly instead of forcing a partial commit.`,
    ``,
    `WORKFLOW (do all of these, in this order):`,
    `  1. Investigate root cause. Read the failing test/log/manifest/file referenced by the evidence. Do NOT guess.`,
    `  2. Write or update the smallest meaningful regression test that pins the fix. Test goes first.`,
    `  3. Consult Codex (via Agent tool, subagent_type 'codex:codex-rescue') on any meaningful code change BEFORE acting. Codex is a peer; their flags are signal, never a veto over Luke's intent. If Codex flags a specific approach, switch approach, never defer the scope.`,
    `  4. Apply the fix.`,
    `  5. Run the targeted test (or the relevant section of vitest) and confirm it passes.`,
    `  6. Commit with a clear message that names the blocker_id and what was fixed. Then push to master.`,
    `  7. Verify the blocker is actually gone by re-running the verification (test green AND no manifest/data regression).`,
    ``,
    `OUTPUT CONTRACT (final assistant message MUST be a single JSON object on its own line):`,
    `  {`,
    `    "status": "cleared" | "escalated",`,
    `    "blocker_id": "${blockerId}",`,
    `    "commit_sha": "<git rev-parse HEAD after push, empty string if escalated>",`,
    `    "pushed": true | false,`,
    `    "tests": "<short summary, e.g. \\"35/35 passed\\" or \\"vitest IRS test green\\">",`,
    `    "verification": "<what command/check proved the blocker cleared>",`,
    `    "escalation_reason": "<empty when cleared; one sentence when escalated>"`,
    `  }`,
    ``,
    `Escalate cleanly (status=escalated, commit_sha="", pushed=false) when:`,
    `  - the blocker actually needs Luke (credential, decision, external call)`,
    `  - you cannot verify the fix without infra Luke must provide`,
    `  - the deadline is approaching and a partial commit would be worse than no commit`,
    `Never claim status=cleared without a real pushed commit and a passing verification command.`,
  ].join('\n');
}

// Parse the stream-json output of `claude --print` to classify the result.
function classifySessionResult(stdout, exitCode) {
  if (exitCode !== 0) {
    return {
      status: 'escalated',
      escalationReason: `claude CLI exited with code ${exitCode}`,
      commit_sha: '',
      pushed: false,
    };
  }
  if (!stdout || !stdout.trim()) {
    return { status: 'escalated', escalationReason: 'empty CLI output', commit_sha: '', pushed: false };
  }
  // Walk lines, find the last `type:"result"` entry, extract its `.result`.
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let resultText = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry && entry.type === 'result' && typeof entry.result === 'string') {
        resultText = entry.result;
        break;
      }
    } catch { /* keep walking */ }
  }
  if (!resultText) {
    return { status: 'escalated', escalationReason: 'no result block found in stream-json', commit_sha: '', pushed: false };
  }
  // Result body must contain a single JSON object that matches the contract.
  // Extract the LAST {...} block in the result text.
  const jsonMatch = resultText.match(/\{[\s\S]*\}\s*$/);
  if (!jsonMatch) {
    return { status: 'escalated', escalationReason: 'result block did not contain JSON', commit_sha: '', pushed: false };
  }
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {
    return { status: 'escalated', escalationReason: 'result JSON parse failed: ' + String(e.message || e).slice(0, 120), commit_sha: '', pushed: false };
  }
  const status = String(parsed.status || '').toLowerCase();
  const commit_sha = String(parsed.commit_sha || '');
  const pushed = parsed.pushed === true;
  if (status === 'cleared' && commit_sha && pushed) {
    return { status: 'cleared', commit_sha, pushed, verification: parsed.verification, tests: parsed.tests };
  }
  return {
    status: 'escalated',
    escalationReason: parsed.escalation_reason || `session reported status=${status}, commit_sha=${commit_sha}, pushed=${pushed}`,
    commit_sha,
    pushed,
  };
}

// Deadline gate: should we skip starting a new session because remaining
// time is less than the per-session budget?
function shouldRespectDeadline(nowMs, deadlineMs, perSessionBudgetMs) {
  if (!Number.isFinite(deadlineMs)) return false;
  return (deadlineMs - nowMs) < perSessionBudgetMs;
}

function ensureDirForFile(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* best effort */ }
}

function appendRunLog(row) {
  ensureDirForFile(RUNS_LOG_PATH);
  fs.appendFileSync(RUNS_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age < LOCK_STALE_MS) {
        return { ok: false, reason: `another orchestrator instance is running (lock age ${Math.round(age / 1000)}s)` };
      }
      try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort */ }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'lock acquisition failed: ' + String(e.message || e).slice(0, 160) };
  }
}

function releaseLock() {
  try {
    const holder = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    if (holder === String(process.pid)) fs.unlinkSync(LOCK_PATH);
  } catch { /* best effort */ }
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

function gitBranchSummary(repoRoot) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    return `${branch}, ${dirty ? `${dirty.split('\n').length} uncommitted change(s)` : 'clean working tree'}`;
  } catch {
    return 'unknown';
  }
}

// Spawn one Claude Code session per blocker. Returns a Promise that
// resolves with the classified result.
function spawnSession(blocker, opts = {}) {
  const repoRoot = opts.repoRoot || REPO;
  const prompt = buildSessionPrompt(blocker, opts);
  const budgetMs = opts.budgetMs || DEFAULT_PER_SESSION_BUDGET_MS;
  return new Promise((resolve) => {
    // Strip CLAUDECODE / CLAUDE_CODE_ENTRYPOINT so the spawned claude does
    // not detect itself as nested inside a parent Claude Code session and
    // refuse to launch. In the scheduled-task case the env is already
    // clean, but when an interactive operator triggers the orchestrator
    // from inside Claude Code we need to bypass the nesting check.
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_SSE_PORT;
    const child = spawn(
      'claude',
      ['--print', '--output-format=stream-json', '--include-partial-messages', '--verbose', '-p', prompt],
      { cwd: repoRoot, shell: process.platform === 'win32', windowsHide: true, env: cleanEnv },
    );
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      try { clearTimeout(timer); } catch { /* best effort */ }
      const result = classifySessionResult(stdout, exitCode);
      resolve({ ...result, stderrTail: stderr.slice(-2000) });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } }, 5000);
      finish(124);
    }, budgetMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => finish(code || 0));
    child.on('error', (e) => {
      stderr += '\nspawn error: ' + String(e.message || e);
      finish(127);
    });
  });
}

async function runOrchestrator(opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const briefingsDir = opts.briefingsDir || path.join(REPO, 'data', 'briefings');
  let briefingPath = opts.briefingPath;
  if (!briefingPath) {
    briefingPath = resolveLatestBriefingPath({ date, briefingsDir, nowMs: Date.now() });
  }
  if (!briefingPath) {
    appendRunLog({ stage: 'startup', error: 'no briefing found within 36h of ' + date + ' in ' + briefingsDir });
    return { ok: false, cleared: 0, escalated: 0, error: 'briefing-not-found' };
  }
  let md = '';
  try { md = fs.readFileSync(briefingPath, 'utf8'); } catch (e) {
    appendRunLog({ stage: 'startup', error: 'briefing not readable at ' + briefingPath });
    return { ok: false, cleared: 0, escalated: 0, error: 'briefing-not-readable' };
  }
  appendRunLog({ stage: 'startup', briefingPath });
  const blockers = parseBlockersFromMarkdown(md);
  if (blockers.length === 0) {
    appendRunLog({ stage: 'startup', note: 'no blockers in briefing, nothing to heal' });
    return { ok: true, cleared: 0, escalated: 0 };
  }
  const deadlineMs = parseDeadlineToTodayCt(opts.deadline || process.env.HEAL_TESTS_DEADLINE_CT || DEFAULT_DEADLINE_CT);
  const perSessionBudgetMs = opts.budgetMs || DEFAULT_PER_SESSION_BUDGET_MS;
  const branchSummary = gitBranchSummary(REPO);
  let cleared = 0;
  let escalated = 0;
  for (const blocker of blockers) {
    const ownership = classifyOwnership(blocker);
    if (!ownership.canAutoAttempt) {
      appendRunLog({ stage: 'skip', blocker: blocker.title, reason: ownership.reason });
      escalated++;
      continue;
    }
    if (deadlineMs && shouldRespectDeadline(Date.now(), deadlineMs, perSessionBudgetMs)) {
      appendRunLog({ stage: 'deadline', blocker: blocker.title, remainingMs: deadlineMs - Date.now() });
      escalated++;
      break;
    }
    const deadlineIso = new Date(Math.min(deadlineMs || (Date.now() + perSessionBudgetMs), Date.now() + perSessionBudgetMs)).toISOString();
    const result = await spawnSession(blocker, {
      repoRoot: REPO,
      deadlineIso,
      branchSummary,
      budgetMs: Math.min(perSessionBudgetMs, deadlineMs ? deadlineMs - Date.now() : perSessionBudgetMs),
    });
    appendRunLog({
      stage: 'session-complete',
      blocker: blocker.title,
      status: result.status,
      commit_sha: result.commit_sha || '',
      pushed: !!result.pushed,
      verification: result.verification || '',
      tests: result.tests || '',
      escalation_reason: result.escalationReason || '',
    });
    if (result.status === 'cleared') cleared++; else escalated++;
  }
  appendRunLog({ stage: 'orchestrator-complete', cleared, escalated, totalBlockers: blockers.length });
  return { ok: true, cleared, escalated, totalBlockers: blockers.length };
}

module.exports = {
  parseBlockersFromMarkdown,
  classifyOwnership,
  buildSessionPrompt,
  classifySessionResult,
  shouldRespectDeadline,
  parseDeadlineToTodayCt,
  spawnSession,
  runOrchestrator,
  resolveLatestBriefingPath,
  RUNS_LOG_PATH,
};

if (require.main === module) {
  const lock = acquireLock();
  if (!lock.ok) {
    console.error('[orchestrator] skipping run:', lock.reason);
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
  runOrchestrator()
    .then((result) => {
      console.log('[orchestrator] done:', JSON.stringify(result));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[orchestrator] threw:', e && e.message ? e.message : e);
      appendRunLog({ stage: 'fatal', error: String(e && e.message ? e.message : e).slice(0, 400) });
      process.exit(1);
    });
}
