#!/usr/bin/env node
'use strict';

// scripts/agentic-healer-driver.js
//
// WAVE 4 (Amy overhaul): the AGENTIC OVERNIGHT HEALER, rung 2 of the morning
// self-heal ladder. ExampleCo's charge (2026-07-12): "I wanted an actual healer,
// like me telling you hey, this is broken, fix it, right here in a dev session
// with bypass permissions and everything. I don't understand why overnight
// healers won't have full access/permissions."
//
// DESIGN: after the mechanical pass (rung 1, --mechanical-only) and the
// briefing build have finished, this driver spawns a full agentic dev session
// (claude CLI primary, codex CLI fallback per the LLM ladder) with the fresh
// dashboard-qc-result.json defect list and the standing mission: fix these
// defects exactly like an interactive session ExampleCo dispatched would.
// Root-cause, code fix in an isolated worktree, tests with every change, land
// via `node scripts/land.js --apply`, deploy via `bash
// scripts/deploy-ec2-server.sh` when EC2-affecting (NEVER a raw copy), then
// verify per-card on the live board. Bypass permissions INSIDE rails: the
// session runs with the same guard set as any session (shared-tree guard, land
// gate, never-list constitution in memory), not the constrained isolated
// worker contract.
//
// HARD SAFETY RAILS (the LESSONS this driver exists to make impossible):
//   1. NEVER runs while the briefing lock is held by an active generation
//      (the healer-reverted-prod incident class, 2026-07-05: a healer racing
//      the live build). briefingLockHeld() gates before anything spawns.
//   2. NO-REPEAT TACTICS ledger (data/agent/self-heal-tactics.jsonl): before
//      attempting a fix tactic, the driver checks whether the same
//      defect+tactic pair already FAILED without changed input, and skips to
//      a new tactic or an honest blocked verdict
//      (feedback_no_repeat_failed_tactics_without_changed_input.md).
//   3. HONESTY OVER OPTIMISM (the false-clear thrash of 2026-06-25/26): a
//      receipt may claim a defect "cleared" ONLY with live-board
//      re-verification proof: the pinned dashboard-qc-result.json under the
//      driver's data dir, written by the driver's OWN verifier run after the
//      session started, showing that card clean. Budget expiry produces an
//      honest blocked receipt, never a false clear. buildReceipt mechanically
//      downgrades any cleared claim without proof (2026-07-12 Codex review:
//      the proof is pinned to the driver's verification run + data path, so a
//      session or stale repo stub can never satisfy it).
//   4. HARD WALL-CLOCK BUDGET (default 45 min) owned by this driver, with a
//      verification reserve so the receipt and live re-check always happen
//      even when a session eats its whole session budget.
//   5. DEPLOY ONLY THROUGH scripts/deploy-ec2-server.sh. This file and the
//      shell wrapper contain no raw remote-copy path; a regression test
//      asserts that stays true.
//   6. THE SESSION RUNS IN A DRIVER-OWNED ISOLATED WORKTREE cut from
//      origin/master (2026-07-12 Codex review: full-access sessions never get
//      a shared checkout as cwd; if the worktree cannot be created the run is
//      an honest blocked, never a full-access session in the shared tree).
//
// LADDER FALLTHROUGH (2026-07-12 Codex review, both passes): ANY rung that
// leaves defects SURVIVING on live re-verification is a failed tactic, and the
// next viable rung runs while budget remains. That includes a rung that
// self-reports a GENUINE-WALL: the wall category is inferred from the child's
// own escalation text, so trusting it to stop the whole ladder would let one
// model starve the other by claiming a wall (the input hash includes the
// briefing date, so the next day re-unlocks the first rung forever). The
// ladder is 2 rungs, so proving a wall costs at most one bounded extra
// session. Only a budget kill stops the ladder early (no second doomed
// session).
//
// RECEIPTS: one 'started' row at launch (so a backstop kill still leaves
// durable evidence) and one 'final' row per run appended to
// data/agent/overnight-agentic-healer-runs.jsonl (defects before/after,
// tactics, lands, verdict). The run also feeds the SELF-HEAL HEALTH card
// through the existing channels it already reads: per-defect attempt rows in
// the briefing repair ledger (scripts/self-heal/briefing-repair-ledger.js) and
// checkpoint + orchestrator-complete rows in
// data/agent/overnight-self-heal-runs.jsonl, so the card goes green again when
// the healer materially heals and stays honest when it does not.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ledger = require('./self-heal/briefing-repair-ledger.js');
const { readLiveBoardArtifact } = require('./lib/live-board-truth.js');
const healExecutor = require('./lib/heal-executor.js');

const REPO = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const DEFAULT_BUDGET_MINUTES = 45;
// Reserve at the tail of the budget for live re-verification + receipt writes,
// so a session that consumes its whole session budget still gets an honest,
// live-verified receipt instead of a silent kill.
const VERIFY_RESERVE_MS = 6 * 60 * 1000;
// Below this remaining budget it is dishonest to claim a "dev session" ran:
// record budget-exhausted instead of spawning a doomed 2-minute session.
const MIN_SESSION_MS = 5 * 60 * 1000;
// A full dev session may run long quiet test suites; give it a longer idle
// window than the 8-minute worker default, still bounded.
const FULL_SESSION_IDLE_MS = 10 * 60 * 1000;

const RECEIPTS_REL = path.join('agent', 'overnight-agentic-healer-runs.jsonl');
const TACTICS_REL = path.join('agent', 'self-heal-tactics.jsonl');
const RUN_LOG_REL = path.join('agent', 'overnight-self-heal-runs.jsonl');
const ARTIFACT_REL = path.join('agent', 'dashboard-qc-result.json');

// The tactic ladder. Each rung is one full-dev-session executor. The no-repeat
// gate is per (defect, tactic, inputHash): if the claude session already failed
// on this exact defect with unchanged input, the next run skips to codex; when
// every rung has failed unchanged, the verdict is an honest blocked.
const TACTIC_LADDER = ['agentic-dev-session:claude', 'agentic-dev-session:codex'];

const BRIEFING_LOCK_DEFAULT = '/tmp/secondbrain-morning-briefing-run.lock';

// ---------------------------------------------------------------------------
// Paths + small IO (all injectable via opts.dataDir for tests)
// ---------------------------------------------------------------------------

function dataDir(opts = {}) {
  return opts.dataDir || ledger.defaultDataDir();
}

function receiptsPath(opts = {}) {
  return path.join(dataDir(opts), RECEIPTS_REL);
}

function tacticsPath(opts = {}) {
  return path.join(dataDir(opts), TACTICS_REL);
}

function runLogPath(opts = {}) {
  return path.join(dataDir(opts), RUN_LOG_REL);
}

function pinnedArtifactPath(opts = {}) {
  return path.join(dataDir(opts), ARTIFACT_REL);
}

function appendJsonl(absPath, row) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.appendFileSync(absPath, JSON.stringify(row) + '\n');
  return row;
}

function readJsonlRows(absPath) {
  if (!fs.existsSync(absPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(absPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a corrupt line is skipped, never fatal: the ledger must never wedge the healer
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// No-repeat tactics ledger (data/agent/self-heal-tactics.jsonl)
// ---------------------------------------------------------------------------

// Row shape: { ts, date, defect, tactic, tacticKey, inputHash, outcome, runId }
// outcome: 'cleared' | 'failed'. Semantics mirror the briefing repair ledger's
// tacticAlreadyFailed: walking newest-first for the defect, a cleared row
// resets the memory; the exact same tacticKey+inputHash having FAILED since the
// last clear blocks a blind re-run.
function readTacticRows(opts = {}) {
  return readJsonlRows(tacticsPath(opts));
}

function appendTacticRow(row, opts = {}) {
  return appendJsonl(tacticsPath(opts), row);
}

function tacticAlreadyFailed(rows, defect, tactic, inputHash) {
  const defectKey = ledger.normDefectKey(defect);
  const tKey = ledger.tacticKey(tactic);
  const hash = String(inputHash || '');
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || ledger.normDefectKey(row.defect) !== defectKey) continue;
    if (String(row.outcome || '').toLowerCase() === 'cleared') return false;
    if (
      String(row.tacticKey || ledger.tacticKey(row.tactic)) === tKey &&
      String(row.inputHash || '') === hash
    ) {
      return true;
    }
  }
  return false;
}

// The tactic input hash covers exactly what the tactic acts on: briefing date,
// card id, live status, and the defect-kind signature. No volatile timestamps,
// no commit hashes (feedback_no_repeat_failed_tactics_without_changed_input:
// changed error wording must not unlock the same tactic; a new briefing date is
// a changed input by definition, so history from another date never suppresses
// today's repair pass).
function defectInputHash(date, card) {
  return ledger.hashTacticInput({
    date: ledger.safeDate(date),
    cardId: String(card.id || ''),
    status: String(card.status || ''),
    defectKinds: [...(card.defectKinds || [])].map(String).sort(),
  });
}

function defectKeyForCard(card) {
  return ledger.defectKey({ card_id: card.id, defect_type: 'LIVE-BOARD-DEFECT' });
}

// Pick the first ladder rung with at least one defect the no-repeat gate lets
// through. Defects blocked on EVERY rung are 'exhausted' (honest blocked
// verdict, never a silent drop).
function planTactics({ date, defectiveCards, tacticRows, tactics = TACTIC_LADDER }) {
  const perDefect = defectiveCards.map((card) => ({
    card,
    defect: defectKeyForCard(card),
    inputHash: defectInputHash(date, card),
  }));
  for (const tactic of tactics) {
    const targets = [];
    const skipped = [];
    for (const d of perDefect) {
      if (tacticAlreadyFailed(tacticRows, d.defect, tactic, d.inputHash)) {
        skipped.push({
          ...d,
          tactic,
          reason: 'no-repeat: same tactic + same input already failed',
        });
      } else {
        targets.push({ ...d, tactic });
      }
    }
    if (targets.length) {
      const exhausted = skipped.filter((s) =>
        tactics.every((t) => tacticAlreadyFailed(tacticRows, s.defect, t, s.inputHash)),
      );
      return { tactic, targets, skipped, exhausted, perDefect };
    }
  }
  return {
    tactic: null,
    targets: [],
    skipped: perDefect.map((d) => ({
      ...d,
      tactic: null,
      reason: 'no-repeat: every ladder tactic already failed with unchanged input',
    })),
    exhausted: perDefect,
    perDefect,
  };
}

// ---------------------------------------------------------------------------
// Briefing-lock gate (rail 1)
// ---------------------------------------------------------------------------

// True when the morning briefing lock is currently HELD by an active
// generation. On Linux we probe with a non-blocking flock attempt: if we can
// take the lock momentarily, nobody holds it. Injectable (opts.probe) so tests
// never shell out; on platforms without flock the probe honestly reports
// checked:false and the caller treats "cannot check" as its own decision.
function briefingLockHeld(opts = {}) {
  const lockPath = opts.lockPath || process.env.BRIEFING_LOCK_PATH || BRIEFING_LOCK_DEFAULT;
  if (typeof opts.probe === 'function') {
    const res = opts.probe(lockPath);
    if (res && typeof res === 'object') {
      return { held: !!res.held, checked: res.checked !== false, lockPath };
    }
    return { held: !!res, checked: true, lockPath };
  }
  if (IS_WIN) return { held: false, checked: false, lockPath };
  if (!fs.existsSync(lockPath)) return { held: false, checked: true, lockPath };
  try {
    const probe = spawnSync('flock', ['-n', lockPath, 'true'], { timeout: 10_000 });
    return { held: probe.status !== 0, checked: true, lockPath };
  } catch {
    // Cannot probe: be conservative, treat as held so we never race a build.
    return { held: true, checked: false, lockPath };
  }
}

// ---------------------------------------------------------------------------
// Driver-owned isolated worktree (rail 6, Codex review 2026-07-12)
// ---------------------------------------------------------------------------

// A full-access session (claude --dangerously-skip-permissions, codex
// danger-full-access) must NEVER get a shared checkout as its cwd: one bad
// first action could mutate the shared tree before land.js's gate ever runs,
// which is exactly the healer-reverted-prod class. The driver therefore cuts
// its own worktree off origin/master, links node_modules, and hands the
// session THAT cwd. If the worktree cannot be created, the run is an honest
// blocked verdict, never a full-access session in the shared tree. The
// worktree is left in place after the run (evidence preservation, same rule as
// preserved heal worktrees).
function ensureSessionWorktree({ repoRoot, runId }) {
  const sessionsRoot =
    process.env.SB_SESSIONS_ROOT || path.join(path.dirname(repoRoot), 'sb-sessions');
  const worktree = path.join(sessionsRoot, runId);
  const branch = `agentic-heal/${runId}`;
  try {
    fs.mkdirSync(sessionsRoot, { recursive: true });
    spawnSync('git', ['-C', repoRoot, 'fetch', 'origin', 'master'], {
      timeout: 120_000,
      stdio: 'ignore',
    });
    const add = spawnSync(
      'git',
      ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktree, 'origin/master'],
      { encoding: 'utf8', timeout: 180_000 },
    );
    if (add.status !== 0) {
      return {
        ok: false,
        cwd: null,
        error: String(add.stderr || add.stdout || 'git worktree add failed').slice(0, 300),
      };
    }
    const target = path.join(repoRoot, 'node_modules');
    const link = path.join(worktree, 'node_modules');
    if (fs.existsSync(target) && !fs.existsSync(link)) {
      try {
        fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
      } catch {
        // best effort; the session can npm install --ignore-scripts if it must
      }
    }
    return { ok: true, cwd: worktree, branch, created: true };
  } catch (e) {
    return { ok: false, cwd: null, error: String((e && e.message) || e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Mission prompt (the standing mission ExampleCo dispatched)
// ---------------------------------------------------------------------------

function buildMissionPrompt({
  date,
  targets,
  artifact,
  repoRoot,
  dataDirPath,
  budgetMinutes,
  worktree,
}) {
  const defectLines = targets
    .map(
      (t, i) =>
        `${i + 1}. card "${t.card.id}" (status ${t.card.status}; kinds: ${(t.card.defectKinds || []).join(', ') || 'unspecified'})`,
    )
    .join('\n');
  const rawDefects = (artifact && Array.isArray(artifact.defects) ? artifact.defects : [])
    .slice(0, 60)
    .map((d) => `  - ${String(d).slice(0, 300)}`)
    .join('\n');
  const wtCwd = (worktree && worktree.cwd) || repoRoot;
  const wtBranch = (worktree && worktree.branch) || '(current branch)';
  return [
    `You are the overnight agentic healer for the SecondBrain daily briefing, a FULL dev session dispatched exactly as if ExampleCo said: "this is broken, fix it." Work autonomously to completion.`,
    ``,
    `Briefing date: ${date}. You are ALREADY working in an ISOLATED worktree at ${wtCwd} on branch ${wtBranch}, cut fresh from origin/master. The main checkout is ${repoRoot}; never mutate it. Live data dir: ${dataDirPath}.`,
    ``,
    `LIVE DEFECTS to fix (from the canonical live board artifact agent/dashboard-qc-result.json):`,
    defectLines || '(none)',
    ``,
    `Raw render-QC defect evidence:`,
    rawDefects || '  (no raw defect strings recorded)',
    ``,
    `MISSION, per defect:`,
    `1. Read dev-plans/core/briefing.md and dev-plans/core/self-heal.md first. Before editing ANY card, read its skill page: node scripts/card-skill.js <card_id>.`,
    `2. Root-cause the defect from the live rendered board and the generator/parser/render trio, never from assumptions.`,
    `3. If the fix is data/artifact-mechanical (stale artifact, orphaned lock, generator that needs a rerun), run the real generator and verify through the same reader path a live card uses.`,
    `4. If the fix needs code: make the surgical fix IN THIS WORKTREE with a regression test in the same change, then land via: node scripts/land.js --apply (run from this worktree). Never commit in the main checkout, never push directly to master outside land.js.`,
    `5. If the landed change affects the EC2 runtime (ec2-server.js or any deployed script), deploy ONLY via: bash scripts/deploy-ec2-server.sh. Never hand-copy files to /opt/secondbrain, never use a raw remote-copy command. If that deploy script cannot run from this host (its SSH deploy key is absent on EC2), record the affected defect as blocked with the honest reason "deploy requires the desktop deploy key"; do not improvise a copy path.`,
    `5b. After landing, when running on the EC2 build-path host, sync the build path so the next cron run uses the landed fix: bash scripts/ec2-sync-build-path.sh (it runs locally, no SSH needed).`,
    `6. Verify per-card on the LIVE board: node scripts/refresh-card.js <card_id> --publish --verify for a card rebuild, and finally node scripts/verify-dashboard-cards-live.js --date ${date} --write-artifact so the canonical artifact reflects the healed state. A fix is not done until the live artifact says the card is clean.`,
    ``,
    `HARD CONSTRAINTS:`,
    `- You have ${budgetMinutes} minutes of wall clock. Leave the last 3 minutes to emit your final JSON contract. Prioritize the highest-impact defects first.`,
    `- Honesty over optimism: never claim a defect cleared without fresh live-board proof. "I don't know" or an honest blocked verdict beats invention.`,
    `- Never repeat a tactic recorded as failed for the same defect with unchanged input in ${dataDirPath}/agent/self-heal-tactics.jsonl; choose a different approach or declare the defect blocked with the reason.`,
    `- Do the work INLINE in this session: no background tasks, no detached sub-agents.`,
    `- The never-list stands: never contact a human, never send anything outbound, never delete raw archives, never stop the Amy/ExampleCo/Snack Dude services, never move money.`,
    `- No em dashes in any output or file. Tests ship with every code change.`,
    ``,
    `FINAL OUTPUT CONTRACT: end with a single JSON object on its own line:`,
    `{"status":"cleared"|"escalated","commit_sha":"<last landed sha or empty>","pushed":true|false,"summary":"<what you did>","tests":"<test proof>","reflection":"<what you learned / why blocked>","escalation_reason":"<only when escalated>","defects":[{"defect":"<card_id>","outcome":"cleared"|"survived"|"blocked","evidence":"<live proof or honest reason>"}]}`,
    `Your self-report is advisory: the driver independently re-verifies the live board after you finish.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Full-dev-session spawn adapters (claude primary, codex fallback)
// ---------------------------------------------------------------------------

// Unlike the constrained isolated-worker adapters in heal-executor.js (worker
// guard settings, workspace-write sandbox), these run a FULL dev session: the
// same rails as an interactive session ExampleCo dispatches. Bypass permissions is
// deliberate and ExampleCo-directed (Wave 4 charge); the rails are the driver-owned
// isolated worktree, the land gate, and the never-list in the prompt, not a
// permission prompt nobody is awake to answer.
function buildFullSessionClaudeArgs(prompt) {
  const args = [
    '--print',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (IS_WIN) {
    // Windows-only: the user-scope codex plugin's blocking-stdin hook deadlocks
    // spawned claude children (heal-executor.js 2026-06-01 root cause). EC2 has
    // no such plugin, and dropping setting sources there would drop real rails.
    args.push('--setting-sources', '');
  }
  args.push('--dangerously-skip-permissions', '-p', prompt);
  return args;
}

function buildFullSessionCodexArgs(prompt, opts = {}) {
  // The full-session codex rung needs the land lock in the shared git dir and
  // an SSH deploy, which do not fit workspace-write. danger-full-access mirrors
  // an attended codex session; the rails are the driver-owned isolated
  // worktree passed as --cd (never a shared checkout), the land gate, the
  // never-list, and this driver's independent live re-verification.
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'danger-full-access',
    '--cd',
    opts.cwd || REPO,
    prompt,
  ];
}

function spawnFullClaude(prompt, opts = {}) {
  const { spawn } = require('node:child_process');
  const args = buildFullSessionClaudeArgs(prompt);
  const env = healExecutor.workerEnv({ tokenPath: opts.tokenPath });
  if (IS_WIN) {
    const claudeBin = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'claude.cmd')
      : 'claude.cmd';
    return spawn('cmd.exe', ['/c', claudeBin, ...args], {
      cwd: opts.cwd || REPO,
      shell: false,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('claude', args, {
    cwd: opts.cwd || REPO,
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnFullCodex(prompt, opts = {}) {
  const { spawn } = require('node:child_process');
  const args = buildFullSessionCodexArgs(prompt, opts);
  const env = healExecutor.workerEnv({ tokenPath: opts.tokenPath });
  if (IS_WIN) {
    return spawn('cmd.exe', ['/c', 'codex', ...args], {
      cwd: opts.cwd || REPO,
      shell: false,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('codex', args, {
    cwd: opts.cwd || REPO,
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const FULL_SESSION_ADAPTERS = {
  'agentic-dev-session:claude': {
    executor: 'claude',
    adapter: {
      spawn: spawnFullClaude,
      parse: (stderr, stdout) => healExecutor.parseClaudeResult(stdout),
    },
  },
  'agentic-dev-session:codex': {
    executor: 'codex',
    adapter: {
      spawn: spawnFullCodex,
      parse: (stderr, stdout) => healExecutor.parseCodexResult(stderr, stdout),
    },
  },
};

// Default session runner: one heal-executor run with the full-session adapter
// for the given tactic. Streams to the caller's onStream for live tailing.
async function defaultSpawnSession({ tactic, prompt, budgetMs, cwd, tokenPath, onStream }) {
  const rung = FULL_SESSION_ADAPTERS[tactic];
  if (!rung) {
    return {
      status: 'escalated',
      escalationReason: `ExampleCo tactic ${tactic}`,
      category: healExecutor.FAULT,
    };
  }
  return healExecutor.runHealSession(prompt, {
    executor: rung.executor,
    adapter: rung.adapter,
    budgetMs,
    idleMs: FULL_SESSION_IDLE_MS,
    cwd,
    tokenPath,
    onStream,
  });
}

// ---------------------------------------------------------------------------
// Live-board re-verification (rail 3: the only source of a "cleared" claim)
// ---------------------------------------------------------------------------

// Runs the ONE render-QC tool with --write-artifact, then reads the artifact
// PINNED to the driver's own data dir (never the two-root substance resolver,
// which could prefer a stale repo stub; 2026-07-12 Codex review). Returns
// { ran, exitCode, error, startedMs, artifact, artifactPath } where startedMs
// is captured BEFORE the verifier spawns so proof freshness can be anchored to
// the driver's own verification run, not merely the session window.
function defaultReverify({ date, repoRoot, dataDirPath, timeoutMs }) {
  const script = path.join(repoRoot, 'scripts', 'verify-dashboard-cards-live.js');
  const startedMs = Date.now();
  let exitCode = null;
  let error = '';
  try {
    const run = spawnSync(
      process.execPath,
      [script, '--date', ledger.safeDate(date), '--write-artifact'],
      {
        cwd: repoRoot,
        timeout: Math.max(60_000, timeoutMs || 5 * 60 * 1000),
        encoding: 'utf8',
        env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDirPath },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    exitCode = run.status;
    if (run.error) error = String(run.error.message || run.error);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const artifactPath = pinnedArtifactPath({ dataDir: dataDirPath });
  let artifact = null;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch {
    artifact = null;
  }
  return { ran: exitCode !== null, exitCode, error, startedMs, artifact, artifactPath };
}

// Independent land evidence: the session's self-reported commit_sha is
// advisory, so the receipt also records origin/master before and after the
// session (best-effort; a probe failure is recorded as null, never a crash).
function probeOriginMaster(repoRoot) {
  try {
    const run = spawnSync('git', ['-C', repoRoot, 'ls-remote', 'origin', 'refs/heads/master'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (run.status !== 0) return null;
    const sha = String(run.stdout || '')
      .trim()
      .split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// Per-defect outcomes from the post-session verification. A defect is
// 'cleared' ONLY when (a) the driver's own verifier RAN, (b) the pinned
// artifact was written at/after that verifier started AND after the session
// started, and (c) that card is clean (or no longer present as defective).
// Anything else is 'survived' (still defective on fresh proof) or 'unverified'
// (no fresh driver-owned proof). A session cannot manufacture this proof: the
// artifact must postdate the DRIVER's verification start, not merely the
// session window (2026-07-12 Codex review).
function outcomesFromVerification({ targets, verification, sessionStartMs }) {
  const ran = !!(verification && verification.ran);
  const artifact = verification && verification.artifact;
  const artifactTs = artifact && artifact.ts ? Date.parse(artifact.ts) : NaN;
  const verifyStartMs = verification && Number(verification.startedMs);
  const fresh =
    ran &&
    Number.isFinite(artifactTs) &&
    artifactTs > sessionStartMs &&
    Number.isFinite(verifyStartMs) &&
    artifactTs >= verifyStartMs;
  return targets.map((t) => {
    if (!fresh) {
      return {
        ...t,
        outcome: 'unverified',
        proof: null,
        reason: ran
          ? 'no pinned live-board artifact written by the driver verification run'
          : 'driver live re-verification did not run',
      };
    }
    const card = (artifact.cards || []).find((c) => String(c.id) === String(t.card.id));
    const stillDefective = card && card.status !== 'clean';
    if (stillDefective) {
      return {
        ...t,
        outcome: 'survived',
        proof: { artifactTs: artifact.ts, status: card.status },
        reason: `live board still reports ${card.status}`,
      };
    }
    return {
      ...t,
      outcome: 'cleared',
      proof: {
        artifactTs: artifact.ts,
        verifiedAfterSessionStart: true,
        verifiedByDriverRun: true,
        status: card ? card.status : 'absent',
      },
      reason: 'driver-run authenticated live-board verification shows the card clean',
    };
  });
}

// ---------------------------------------------------------------------------
// Receipt (schema-enforced honesty)
// ---------------------------------------------------------------------------

// Receipt schema rule (rail 3, feedback_self_heal_health_checkpoint_score): a
// 'cleared' outcome REQUIRES liveProof with verifiedAfterSessionStart AND
// verifiedByDriverRun. This function mechanically downgrades any cleared claim
// without proof to 'unverified' and records the violation, so no caller bug
// can ever emit a false clear.
function buildReceipt(input) {
  const {
    runId,
    date,
    startedTs,
    endedTs,
    budgetMs,
    defectsBefore,
    tactic,
    tacticsTried = [],
    skippedTactics = [],
    session = null,
    sessions = [],
    worktree = null,
    verification = null,
    outcomes = [],
    git = null,
    wallReasons = [],
    verdictOverride = null,
    verdictReasonOverride = null,
  } = input;
  const schemaViolations = [];
  const perDefect = outcomes.map((o) => {
    if (
      o.outcome === 'cleared' &&
      !(o.proof && o.proof.verifiedAfterSessionStart && o.proof.verifiedByDriverRun)
    ) {
      schemaViolations.push(
        `cleared claim for ${o.defect} had no driver-run live-board re-verification proof; downgraded to unverified`,
      );
      return { ...o, outcome: 'unverified', proof: null };
    }
    return o;
  });
  const clearedCount = perDefect.filter((o) => o.outcome === 'cleared').length;
  const survivedCount = perDefect.filter((o) => o.outcome === 'survived').length;
  const unverifiedCount = perDefect.filter((o) => o.outcome === 'unverified').length;

  let verdict;
  let verdictReason;
  if (verdictOverride) {
    verdict = verdictOverride;
    verdictReason = verdictReasonOverride || '';
    // Even an override may never smuggle a cleared verdict past the proof rule.
    if (verdict === 'cleared' && (clearedCount === 0 || survivedCount + unverifiedCount > 0)) {
      verdict = clearedCount > 0 ? 'partial' : 'blocked';
      verdictReason = `override rejected: cleared verdict requires every defect cleared with live proof. ${verdictReason}`;
      schemaViolations.push('cleared verdict override without full live proof was rejected');
    }
  } else if (!perDefect.length) {
    verdict = 'clean';
    verdictReason = 'no defects to heal';
  } else if (clearedCount === perDefect.length) {
    verdict = 'cleared';
    verdictReason = 'every target defect verified clean on the fresh live board artifact';
  } else if (clearedCount > 0) {
    verdict = 'partial';
    verdictReason = `${clearedCount} cleared with live proof, ${survivedCount} survived, ${unverifiedCount} unverified`;
  } else {
    verdict = 'blocked';
    verdictReason = `no defect cleared with live proof (${survivedCount} survived, ${unverifiedCount} unverified)`;
  }

  const sessionSummary = (s) =>
    s
      ? {
          tactic: s.tactic || tactic,
          executor: s.executor || '',
          status: s.status || '',
          escalationReason: s.escalationReason || '',
          watchdog: s.watchdog || null,
          durationMs: s.durationMs || 0,
          commit_sha: s.commit_sha || '',
          pushed: !!s.pushed,
          summary: String(s.summary || '').slice(0, 2000),
          tests: String(s.tests || '').slice(0, 1000),
          reflection: String(s.reflection || '').slice(0, 2000),
        }
      : null;

  return {
    ts: endedTs,
    phase: 'final',
    runId,
    date: ledger.safeDate(date),
    host: os.hostname(),
    pid: process.pid,
    budgetMs,
    startedTs,
    endedTs,
    defectsBefore,
    tactic,
    tacticsTried,
    worktree,
    skippedTactics: skippedTactics.map((s) => ({
      defect: s.defect,
      tactic: s.tactic,
      reason: s.reason,
    })),
    session: sessionSummary(session),
    sessions: sessions.map(sessionSummary),
    // ADVISORY: the session's own self-reported landed sha(s). The verified
    // signal is `git` below (origin/master before vs after), never this field.
    lands: session && session.commit_sha ? [session.commit_sha] : [],
    git,
    verification: verification
      ? {
          ran: !!verification.ran,
          exitCode: verification.exitCode,
          error: String(verification.error || '').slice(0, 500),
          startedMs: verification.startedMs || null,
          artifactPath: verification.artifactPath || null,
          artifactTs: (verification.artifact && verification.artifact.ts) || null,
          defectiveCardCountAfter: verification.artifact
            ? verification.artifact.defectiveCardCount
            : null,
        }
      : null,
    perDefect: perDefect.map((o) => ({
      defect: o.defect,
      cardId: o.card ? o.card.id : '',
      tactic: o.tactic || tactic,
      inputHash: o.inputHash,
      outcome: o.outcome,
      proof: o.proof || null,
      reason: o.reason || '',
    })),
    cleared: clearedCount,
    survived: survivedCount,
    unverified: unverifiedCount,
    // Self-reported genuine-wall reasons per rung: recorded evidence, never a
    // ladder stop condition (Codex review 2026-07-12, pass 2).
    wallReasons,
    verdict,
    verdictReason,
    schemaViolations,
  };
}

// ---------------------------------------------------------------------------
// SELF-HEAL HEALTH feed (checkpoints + orchestrator-complete + repair ledger)
// ---------------------------------------------------------------------------

function appendRunLogRow(row, opts = {}) {
  return appendJsonl(runLogPath(opts), { ts: new Date().toISOString(), ...row });
}

function feedSelfHealHealth({ receipt, opts }) {
  // Per-defect attempt rows in the same repair ledger the SELF-HEAL HEALTH card
  // already reads (defectCounts). A cleared row requires the receipt's live
  // proof, which buildReceipt already enforced.
  for (const d of receipt.perDefect) {
    if (d.outcome === 'skipped-no-repeat' || d.outcome === 'not-attempted') continue;
    try {
      ledger.recordAttempt(
        receipt.date,
        {
          defect: d.defect,
          tactic: d.tactic,
          tacticInputHash: d.inputHash,
          ownerCardId: d.cardId,
          affectedCardIds: [d.cardId],
          fix: receipt.session ? receipt.session.summary : '',
          qcResult: d.outcome === 'cleared' ? 'cleared' : 'failed',
          reflection:
            d.outcome === 'cleared'
              ? `agentic healer cleared with live proof (${d.proof && d.proof.artifactTs})`
              : `agentic healer: ${d.reason || 'defect survived'}${
                  receipt.session && receipt.session.escalationReason
                    ? `; session: ${receipt.session.escalationReason}`
                    : ''
                }`,
          deployedHash: receipt.session ? receipt.session.commit_sha : '',
        },
        opts,
      );
    } catch {
      // ledger writes are evidence, never a crash path for the healer itself
    }
  }
  // orchestrator-complete row so latestRunAttemptSummary sees the pass even on
  // a day with no per-defect ledger rows (e.g. clean run).
  appendRunLogRow(
    {
      date: receipt.date,
      stage: 'orchestrator-complete',
      agenticHealer: true,
      attempted: receipt.perDefect.length,
      cleared: receipt.cleared,
      verdict: receipt.verdict,
      blockers: receipt.perDefect.map((d) => ({
        title: d.defect,
        cleared: d.outcome === 'cleared',
        timedOut: !!(
          receipt.session &&
          receipt.session.watchdog &&
          receipt.session.watchdog.kind === 'budget'
        ),
        stage: 'agentic-dev-session',
      })),
    },
    opts,
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function newRunId() {
  return `agentic-heal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runAgenticHealer(opts = {}) {
  const now = opts.now || (() => Date.now());
  const startedMs = now();
  const startedTs = new Date(startedMs).toISOString();
  const date = ledger.safeDate(opts.date);
  const dataDirPath = dataDir(opts);
  const repoRoot = opts.repoRoot || REPO;
  const budgetMs =
    Number(opts.budgetMs) || Number(opts.budgetMinutes || DEFAULT_BUDGET_MINUTES) * 60 * 1000;
  const deadlineMs = startedMs + budgetMs;
  const runId = opts.runId || newRunId();
  const log = opts.log || ((line) => process.stdout.write(line + '\n'));
  const ledgerOpts = { dataDir: dataDirPath };

  const finishReceipt = (input) => {
    const receipt = buildReceipt({
      runId,
      date,
      startedTs,
      endedTs: new Date(now()).toISOString(),
      budgetMs,
      ...input,
    });
    appendJsonl(receiptsPath(ledgerOpts), receipt);
    return receipt;
  };

  // STARTED receipt (Codex review 2026-07-12): if the wrapper's backstop kills
  // a wedged driver before any final receipt, this row is the durable evidence
  // that a run began and never finished, instead of an empty receipt log.
  appendJsonl(receiptsPath(ledgerOpts), {
    ts: startedTs,
    phase: 'started',
    runId,
    date,
    host: os.hostname(),
    pid: process.pid,
    budgetMs,
    verdict: 'running',
  });

  appendRunLogRow(
    { date, stage: 'self-heal-checkpoint', phase: 'started', agenticHealer: true, pass: 1, runId },
    ledgerOpts,
  );
  const completeCheckpoint = (status, extra = {}) =>
    appendRunLogRow(
      {
        date,
        stage: 'self-heal-checkpoint',
        phase: 'completed',
        status,
        agenticHealer: true,
        pass: 1,
        runId,
        ...extra,
      },
      ledgerOpts,
    );

  try {
    // RAIL 1: never run while the briefing lock is held by an active
    // generation. An UNVERIFIABLE lock state (no probe available on this host)
    // is treated as blocked too, unless explicitly overridden: a full-access
    // healer must never run on "probably fine" (Codex review 2026-07-12).
    const lock = briefingLockHeld({
      lockPath: opts.briefingLockPath,
      probe: opts.briefingLockProbe,
    });
    const allowUnchecked =
      opts.allowUncheckedBriefingLock === true ||
      process.env.AGENTIC_HEALER_ALLOW_UNPROBED_LOCK === '1';
    if (lock.held || (!lock.checked && !allowUnchecked)) {
      const why = lock.held
        ? `briefing lock held at ${lock.lockPath}; the healer never races an active generation`
        : `briefing lock state at ${lock.lockPath} is unverifiable on this host; refusing to run a full-access healer on "probably fine" (set AGENTIC_HEALER_ALLOW_UNPROBED_LOCK=1 only when this host provably cannot race the producer)`;
      log(`[agentic-healer] ${why}`);
      const receipt = finishReceipt({
        defectsBefore: null,
        tactic: null,
        outcomes: [],
        verdictOverride: 'skipped',
        verdictReasonOverride: why,
      });
      completeCheckpoint('green', {
        skipped: lock.held ? 'briefing-lock-held' : 'briefing-lock-unverifiable',
      });
      return receipt;
    }

    // Fresh defect list from the canonical live board artifact.
    const envelope = (opts.readLiveBoard || readLiveBoardArtifact)({ dataDir: dataDirPath });
    const artifact = envelope && envelope.artifact;
    if (!artifact || !Array.isArray(artifact.cards)) {
      const receipt = finishReceipt({
        defectsBefore: null,
        tactic: null,
        outcomes: [],
        verdictOverride: 'blocked',
        verdictReasonOverride:
          'no dashboard-qc-result.json artifact to read; cannot name defects honestly, so nothing was attempted',
      });
      completeCheckpoint('green', { blocked: 'no-defect-list' });
      return receipt;
    }
    if (envelope.stale) {
      const receipt = finishReceipt({
        defectsBefore: { count: null, artifactTs: artifact.ts || null, stale: true },
        tactic: null,
        outcomes: [],
        verdictOverride: 'blocked',
        verdictReasonOverride: `live board artifact is stale (ts ${artifact.ts}); refusing to heal against a stale defect list`,
      });
      completeCheckpoint('green', { blocked: 'stale-defect-list' });
      return receipt;
    }

    const defectiveCards = artifact.cards.filter((c) => c && c.status !== 'clean');
    const defectsBefore = {
      count: defectiveCards.length,
      artifactTs: artifact.ts,
      cards: defectiveCards.map((c) => ({
        id: c.id,
        status: c.status,
        defectKinds: c.defectKinds || [],
      })),
    };
    if (!defectiveCards.length) {
      log('[agentic-healer] live board is clean; nothing to heal.');
      const receipt = finishReceipt({
        defectsBefore,
        tactic: null,
        outcomes: [],
        verdictOverride: 'clean',
        verdictReasonOverride: 'live board artifact reports zero defective cards',
      });
      completeCheckpoint('green', { attempted: 0, cleared: 0 });
      feedSelfHealHealth({ receipt, opts: ledgerOpts });
      return receipt;
    }

    // RAIL 2: no-repeat tactics gate.
    const ladder = opts.tactics || TACTIC_LADDER;
    const tacticRows = readTacticRows(ledgerOpts);
    const plan = planTactics({ date, defectiveCards, tacticRows, tactics: ladder });
    if (!plan.tactic) {
      log(
        '[agentic-healer] every ladder tactic already failed with unchanged input; honest blocked verdict.',
      );
      const receipt = finishReceipt({
        defectsBefore,
        tactic: null,
        skippedTactics: plan.skipped,
        outcomes: plan.skipped.map((s) => ({
          ...s,
          outcome: 'skipped-no-repeat',
          proof: null,
          reason: s.reason,
        })),
        verdictOverride: 'blocked',
        verdictReasonOverride:
          'tactics exhausted: every ladder tactic already failed for these defects with unchanged input; needs changed input or ExampleCo steering',
      });
      completeCheckpoint('green', { blocked: 'tactics-exhausted' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts });
      return receipt;
    }

    // Budget check before spawning anything (RAIL 4).
    if (deadlineMs - now() - VERIFY_RESERVE_MS < MIN_SESSION_MS) {
      const receipt = finishReceipt({
        defectsBefore,
        tactic: plan.tactic,
        skippedTactics: plan.skipped,
        outcomes: plan.targets.map((t) => ({
          ...t,
          outcome: 'not-attempted',
          proof: null,
          reason: 'budget exhausted before a session could start',
        })),
        verdictOverride: 'blocked',
        verdictReasonOverride:
          'budget-exhausted: not enough wall clock left to run an honest dev session',
      });
      completeCheckpoint('green', { blocked: 'budget-exhausted' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts });
      return receipt;
    }

    // RAIL 6: driver-owned isolated worktree. A full-access session never gets
    // a shared checkout as cwd; no worktree, no session (honest blocked).
    const worktree = (opts.ensureWorktree || ensureSessionWorktree)({ repoRoot, runId });
    if (!worktree.ok) {
      const receipt = finishReceipt({
        defectsBefore,
        tactic: plan.tactic,
        skippedTactics: plan.skipped,
        worktree,
        outcomes: plan.targets.map((t) => ({
          ...t,
          outcome: 'not-attempted',
          proof: null,
          reason: `isolated worktree unavailable: ${worktree.error || 'ExampleCo'}`,
        })),
        verdictOverride: 'blocked',
        verdictReasonOverride: `worktree-unavailable: refusing to run a full-access session in a shared checkout (${worktree.error || 'ExampleCo'})`,
      });
      completeCheckpoint('green', { blocked: 'worktree-unavailable' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts });
      return receipt;
    }

    // THE LADDER LOOP (Codex review 2026-07-12, both passes): each viable rung
    // runs a full session, then the driver independently re-verifies the live
    // board. A rung that leaves defects surviving is a failed tactic; the next
    // viable rung runs while budget remains, INCLUDING after a self-reported
    // genuine wall (a wall claim is the child's own text and must not starve
    // the other rung; the wall reasons are recorded per rung). Only a budget
    // kill stops the ladder early (no second doomed session).
    const gitProbe = opts.gitProbe || probeOriginMaster;
    const originMasterBefore = gitProbe(repoRoot);
    const spawnSession = opts.spawnSession || defaultSpawnSession;
    const reverify = opts.reverify || defaultReverify;

    // Defects blocked on EVERY rung never enter the loop; they surface as
    // skipped-no-repeat in the receipt (honest, never silently dropped).
    const exhaustedKeys = new Set(plan.exhausted.map((d) => ledger.normDefectKey(d.defect)));
    let pending = plan.perDefect.filter((d) => !exhaustedKeys.has(ledger.normDefectKey(d.defect)));
    const outcomesByDefect = new Map();
    const sessions = [];
    const tacticsTried = [];
    let lastSession = null;
    let lastVerification = null;
    let usedTactic = plan.tactic;
    let budgetKilled = false;
    const wallReasons = [];

    for (const tactic of ladder) {
      if (!pending.length) break;
      const viable = pending.filter(
        (t) => !tacticAlreadyFailed(tacticRows, t.defect, tactic, t.inputHash),
      );
      if (!viable.length) continue;
      const sessionBudgetMs = deadlineMs - now() - VERIFY_RESERVE_MS;
      if (sessionBudgetMs < MIN_SESSION_MS) break;

      const prompt = buildMissionPrompt({
        date,
        targets: viable,
        artifact,
        repoRoot,
        dataDirPath,
        budgetMinutes: Math.round(sessionBudgetMs / 60000),
        worktree,
      });
      log(
        `[agentic-healer] spawning ${tactic} for ${viable.length} defect(s), budget ${Math.round(sessionBudgetMs / 60000)}m, worktree ${worktree.cwd}.`,
      );
      const sessionStartMs = now();
      let session = await spawnSession({
        tactic,
        prompt,
        budgetMs: sessionBudgetMs,
        cwd: worktree.cwd,
        tokenPath: opts.tokenPath,
        onStream: opts.onStream,
      });
      session = { ...session, tactic };
      sessions.push(session);
      lastSession = session;
      usedTactic = tactic;
      tacticsTried.push(tactic);

      // RAIL 3: independent live re-verification after EVERY rung, even a
      // budget-killed one (it may have landed something before the kill).
      const verifyBudget = Math.max(60_000, Math.min(VERIFY_RESERVE_MS, deadlineMs - now()));
      const verification = reverify({ date, repoRoot, dataDirPath, timeoutMs: verifyBudget });
      lastVerification = verification;
      const outcomes = outcomesFromVerification({
        targets: viable.map((t) => ({ ...t, tactic })),
        verification,
        sessionStartMs,
      });

      // Durable tactic rows for this rung, per defect, before any next rung.
      for (const o of outcomes) {
        appendTacticRow(
          {
            ts: new Date(now()).toISOString(),
            date,
            defect: o.defect,
            tactic,
            tacticKey: ledger.tacticKey(tactic),
            inputHash: o.inputHash,
            outcome: o.outcome === 'cleared' ? 'cleared' : 'failed',
            reason: String(o.reason || session.escalationReason || '').slice(0, 300),
            runId,
          },
          ledgerOpts,
        );
        outcomesByDefect.set(ledger.normDefectKey(o.defect), o);
      }
      pending = pending.filter((t) => {
        const o = outcomesByDefect.get(ledger.normDefectKey(t.defect));
        return !o || o.outcome !== 'cleared';
      });

      if (session.category === healExecutor.WALL) {
        // Recorded, never trusted to stop the ladder: a wall claim is the
        // child's own escalation text (Codex review 2026-07-12, pass 2).
        wallReasons.push(`${tactic}: ${String(session.escalationReason || 'wall').slice(0, 200)}`);
      }
      if (session.watchdog && session.watchdog.kind === 'budget') {
        budgetKilled = true;
        break;
      }
    }

    // Assemble final per-defect outcomes: verified outcomes first, then the
    // never-attempted (exhausted or out-of-budget/walled) defects, honestly.
    const finalOutcomes = plan.perDefect.map((d) => {
      const o = outcomesByDefect.get(ledger.normDefectKey(d.defect));
      if (o) return o;
      if (exhaustedKeys.has(ledger.normDefectKey(d.defect))) {
        return {
          ...d,
          tactic: null,
          outcome: 'skipped-no-repeat',
          proof: null,
          reason: 'no-repeat: every ladder tactic already failed with unchanged input',
        };
      }
      return {
        ...d,
        tactic: null,
        outcome: 'not-attempted',
        proof: null,
        reason: budgetKilled
          ? 'budget exhausted before this defect could be attempted'
          : 'no viable rung remained for this defect within budget',
      };
    });

    const originMasterAfter = gitProbe(repoRoot);
    const anyCleared = finalOutcomes.some((o) => o.outcome === 'cleared');
    const receipt = finishReceipt({
      defectsBefore,
      tactic: usedTactic,
      tacticsTried,
      skippedTactics: plan.exhausted.map((s) => ({
        defect: s.defect,
        tactic: null,
        reason: 'no-repeat: every ladder tactic already failed with unchanged input',
      })),
      session: lastSession,
      sessions,
      worktree,
      verification: lastVerification,
      git: {
        originMasterBefore,
        originMasterAfter,
        remoteAdvanced:
          !!originMasterBefore && !!originMasterAfter && originMasterBefore !== originMasterAfter,
      },
      wallReasons,
      outcomes: finalOutcomes,
      ...(budgetKilled && !anyCleared
        ? {
            verdictOverride: 'blocked',
            verdictReasonOverride: `budget-exhausted: the ${usedTactic} session hit its wall-clock budget and the live board shows no cleared defect; honest blocked, never a false clear`,
          }
        : {}),
    });

    feedSelfHealHealth({ receipt, opts: ledgerOpts });
    completeCheckpoint('green', {
      attempted: receipt.perDefect.length,
      cleared: receipt.cleared,
      verdict: receipt.verdict,
      tacticsTried,
    });
    log(
      `[agentic-healer] done: verdict=${receipt.verdict} cleared=${receipt.cleared}/${defectsBefore.count} (${receipt.verdictReason})`,
    );
    return receipt;
  } catch (e) {
    const crash = String((e && e.stack) || e).slice(0, 1000);
    completeCheckpoint('red', { crash });
    const receipt = finishReceipt({
      defectsBefore: null,
      tactic: null,
      outcomes: [],
      verdictOverride: 'blocked',
      verdictReasonOverride: `healer driver crashed: ${String((e && e.message) || e).slice(0, 300)}`,
    });
    return receipt;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--budget-minutes') opts.budgetMinutes = Number(argv[++i]);
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--repo-root') opts.repoRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv);
  if (
    opts.dryRun ||
    process.env.BRIEFING_DRY_RUN === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  ) {
    const envelope = readLiveBoardArtifact({ dataDir: opts.dataDir || dataDir(opts) });
    const artifact = envelope && envelope.artifact;
    const defective =
      artifact && artifact.cards ? artifact.cards.filter((c) => c.status !== 'clean') : [];
    process.stdout.write(
      `[agentic-healer] DRY-RUN: would heal ${defective.length} defective card(s) ` +
        `(artifact ts ${artifact ? artifact.ts : 'missing'}, stale=${envelope ? envelope.stale : 'n/a'}) ` +
        `via ladder ${TACTIC_LADDER.join(' -> ')} with a ${opts.budgetMinutes || DEFAULT_BUDGET_MINUTES}m budget. No session spawned.\n`,
    );
    return;
  }
  const receipt = await runAgenticHealer(opts);
  // Exit 0 for every honest verdict; the receipt is the record. A nonzero exit
  // is reserved for a crash so the wrapper's log line names it.
  process.exitCode = 0;
  process.stdout.write(JSON.stringify({ verdict: receipt.verdict, runId: receipt.runId }) + '\n');
}

module.exports = {
  DEFAULT_BUDGET_MINUTES,
  VERIFY_RESERVE_MS,
  MIN_SESSION_MS,
  TACTIC_LADDER,
  BRIEFING_LOCK_DEFAULT,
  receiptsPath,
  tacticsPath,
  runLogPath,
  pinnedArtifactPath,
  readTacticRows,
  appendTacticRow,
  tacticAlreadyFailed,
  defectInputHash,
  defectKeyForCard,
  planTactics,
  briefingLockHeld,
  ensureSessionWorktree,
  buildMissionPrompt,
  buildFullSessionClaudeArgs,
  buildFullSessionCodexArgs,
  defaultSpawnSession,
  defaultReverify,
  probeOriginMaster,
  outcomesFromVerification,
  buildReceipt,
  feedSelfHealHealth,
  runAgenticHealer,
  parseCliArgs,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[agentic-healer] fatal: ${String((e && e.stack) || e)}\n`);
    process.exit(1);
  });
}
