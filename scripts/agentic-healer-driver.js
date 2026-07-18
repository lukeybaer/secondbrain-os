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
// session.
//
// FAIR-SPLIT BUDGET (2026-07-18): the remaining agentic budget is split evenly
// across the rungs that can still run, instead of winner-take-all. On
// 2026-07-17 the claude rung consumed 38.9 of 39 minutes, was budget-killed,
// and the codex fallback (empirically the highest-yield minutes of the night)
// never got a turn; on 2026-07-18 claude happened to exit early and codex
// cleared 3/5 in 5.7 minutes. Same code, opposite outcomes, decided purely by
// when rung 1 stopped. Now each rung gets its slice, and the ladder stops
// early only when the REMAINING wall clock cannot fund an honest session
// (below MIN_SESSION_MS), never because one rung burned its own slice.
//
// WATCHDOG KILLS ARE EXECUTOR FAULTS, NOT CONSUMED TACTICS (2026-07-18): a
// session terminated by the executor watchdog (budget, hang, idle,
// nested-background-task, contract-miss) was interrupted, not refuted. Its
// tactic row is recorded as 'executor-fault' so the no-repeat guard leaves the
// tactic retryable; reporting stays honest (nothing cleared without proof).
//
// EVIDENCE-DRIVEN TRIAGE (2026-07-18): before any budget is spent, a defect
// whose OWN evidence names a missing credential, a different host, or a
// pending human decision is escalated to a human with a concrete action
// instead of burning the night on a session that cannot succeed. Shape
// classification over evidence text only: no defect ids, no per-defect rules.
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
const cardBlockerLessons = require('./self-heal/card-blocker-lessons.js');
const hardeningBacklogSync = require('./self-heal/hardening-backlog-sync.js');

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
// Durable escalation records: each row ExampleCos the exact action a human should
// take for a defect the triage gate classified as human-gated (2026-07-18).
const ESCALATIONS_REL = path.join('agent', 'self-heal-escalations.jsonl');

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

function escalationsPath(opts = {}) {
  return path.join(dataDir(opts), ESCALATIONS_REL);
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
    const outcome = String(row.outcome || '').toLowerCase();
    if (outcome === 'cleared') return false;
    // An 'executor-fault' row records a session the executor's own watchdog
    // killed (budget/hang/idle/etc). The tactic was interrupted, not refuted,
    // so it neither resets the memory nor consumes the tactic: it stays
    // retryable (2026-07-17/18: 10 of 29 ledger attempts ended in a SIGKILL,
    // and the no-repeat guard permanently barred approaches that were working
    // when they got shot).
    if (outcome === 'executor-fault') continue;
    if (
      String(row.tacticKey || ledger.tacticKey(row.tactic)) === tKey &&
      String(row.inputHash || '') === hash
    ) {
      return true;
    }
  }
  return false;
}

// The durable tactic-row outcome for one defect after one session. Live proof
// beats everything ('cleared' stays cleared even from a killed session). A
// non-cleared defect from a session the executor watchdog killed is an
// 'executor-fault' (interrupted, retryable), never a consumed 'failed' tactic.
function tacticRowOutcome(outcome, session) {
  if (outcome === 'cleared') return 'cleared';
  if (session && session.watchdog && session.watchdog.killed) return 'executor-fault';
  return 'failed';
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
// Evidence-driven triage: human-gated defects are routed, not retried
// ---------------------------------------------------------------------------

// 2026-07-17 incident: the entire night's budget went to a defect whose own
// evidence said it needed a credential on another host -- nothing an EC2
// session could ever clear -- while tractable defects starved. The gate below
// classifies each defect from its OWN evidence text BEFORE any session budget
// is spent: evidence naming a missing/expired credential, a different host, or
// a pending human decision means no agentic session can clear it tonight, so
// the defect is escalated to a human with the concrete action, and the budget
// goes to tractable work. SHAPE/KEYWORD classification over the evidence text
// only: no defect ids, no per-defect runbooks (capability, not prescription).
const HUMAN_GATE_CLASSIFIERS = [
  {
    kind: 'missing-credential',
    // A credential-shaped artifact the evidence says is absent, expired, or
    // refused (either word order).
    re: /(?:\b(?:missing|expired|invalid|revoked|absent|denied|unauthorized|forbidden|no)\b[^.\n]{0,80}\b(?:credential|token|api[\s-]?key|secret|password|passphrase|oauth|cookie|deploy key|ssh key)s?\b)|(?:\b(?:credential|token|api[\s-]?key|secret|password|passphrase|oauth|cookie|deploy key|ssh key)s?\b[^.\n]{0,80}\b(?:missing|expired|invalid|revoked|absent|denied|unauthorized|forbidden|not\s+(?:set|found|present|configured|available|provisioned)|needs?\s+(?:re-?provision|refresh|renew)\w*)\b)/i,
    action: (excerpt) =>
      `Provide or refresh the credential the evidence names, then let the next scheduled heal pass retry. Evidence: "${excerpt}"`,
  },
  {
    kind: 'different-host',
    // The fix lives on a host this healer is not running on.
    re: /\b(?:on|from|requires?|needs?)\s+(?:the\s+)?(?:desktop|laptop|another|other|a\s+different)\s+(?:host|machine|pc|box|computer)\b|\bnot\s+(?:available|present|installed|reachable|possible)\s+(?:on|from)\s+this\s+host\b|\bonly\s+(?:available|present|installed|runs?)\s+on\b[^.\n]{0,40}\b(?:host|machine|desktop|pc)\b/i,
    action: (excerpt) =>
      `Run the required step on the host the evidence names; this host cannot. Evidence: "${excerpt}"`,
  },
  {
    kind: 'human-decision',
    // The evidence names a person or a pending human decision (approval,
    // ratification, sign-off, a choice only an owner can make).
    re: /\b(?:needs?|requires?|awaiting|waiting\s+(?:on|for)|pending|blocked\s+on)\b[^.\n]{0,80}\b(?:ExampleCo|PRIVATE_NAME|human|owner)\b|\b(?:ExampleCo|PRIVATE_NAME|human|owner)(?:'s)?\b[^.\n]{0,80}\b(?:decision|approval|approve|ratif\w+|sign[\s-]?off|steer\w*|choose|choice|confirm\w*|nam(?:e|ing)\b)|\bhuman\s+decision\b|\bratif(?:y|ication)\b/i,
    action: (excerpt) =>
      `A human decision gates this defect; make the call the evidence names and record it, then the healer can act. Evidence: "${excerpt}"`,
  },
];

// The single evidence line containing the match, bounded, so the escalation
// record ExampleCos the exact text a human needs to act on.
function evidenceExcerpt(text, matchIndex, matchText) {
  const s = String(text || '');
  const lineStart = s.lastIndexOf('\n', matchIndex) + 1;
  let lineEnd = s.indexOf('\n', matchIndex + String(matchText || '').length);
  if (lineEnd === -1) lineEnd = s.length;
  return s.slice(lineStart, lineEnd).trim().slice(0, 240);
}

function classifyHumanGate(evidenceText) {
  const text = String(evidenceText || '');
  if (!text.trim()) return null;
  for (const classifier of HUMAN_GATE_CLASSIFIERS) {
    const m = text.match(classifier.re);
    if (!m) continue;
    const excerpt = evidenceExcerpt(text, m.index, m[0]);
    return { kind: classifier.kind, excerpt, action: classifier.action(excerpt) };
  }
  return null;
}

// The evidence text for one card: its own defect-kind labels plus every raw
// render-QC defect string that names the card (by id, id-with-spaces, or
// rendered title). No evidence, no escalation: a defect only routes to a human
// when its OWN text says a human is the gate.
function defectEvidenceText(card, artifact) {
  const id = String((card && card.id) || '').toLowerCase();
  const spacedId = id.replace(/_/g, ' ');
  const title = String((card && card.title) || '').toLowerCase();
  const names = [...new Set([id, spacedId, title])].filter((n) => n.trim());
  const raw = artifact && Array.isArray(artifact.defects) ? artifact.defects : [];
  const mine = raw.filter((d) => {
    const s = String(d).toLowerCase();
    return names.some((n) => s.includes(n));
  });
  return [...((card && card.defectKinds) || []).map(String), ...mine].join('\n');
}

function triageDefects({ date, defectiveCards, artifact }) {
  const escalations = [];
  const actionableCards = [];
  for (const card of defectiveCards) {
    const gate = classifyHumanGate(defectEvidenceText(card, artifact));
    if (gate) {
      escalations.push({
        card,
        defect: defectKeyForCard(card),
        inputHash: defectInputHash(date, card),
        kind: gate.kind,
        excerpt: gate.excerpt,
        action: gate.action,
      });
    } else {
      actionableCards.push(card);
    }
  }
  return { escalations, actionableCards };
}

function readEscalationRows(opts = {}) {
  return readJsonlRows(escalationsPath(opts));
}

function appendEscalationRow(row, opts = {}) {
  return appendJsonl(escalationsPath(opts), row);
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
  lessonsByCard = {},
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
  // STRUCTURED LESSON CAPTURE, item 2 (ExampleCo dispatch 2026-07-12 evening):
  // lessons feed the healer. The no-repeat-tactics ledger already blocks a
  // blind retry of a failed tactic; this adds the WHY -- the last (bounded 3)
  // durable lesson rows from data/agent/card-blocker-lessons.jsonl for each
  // target card, so the session starts from prior root-cause knowledge
  // instead of rediscovering it from scratch every night.
  const lessonBlocks = targets
    .map((t) => {
      const rows = lessonsByCard[t.card.id] || lessonsByCard[String(t.card.id).toLowerCase()] || [];
      if (!rows.length) return '';
      const body = rows
        .map(
          (r) =>
            `    - ${r.date} [${r.defectKind}] qc: "${String(r.qcMessage || '').slice(0, 160)}" rootCause: "${String(r.rootCauseHypothesis || '').slice(0, 160)}" tried: [${(r.tacticsTried || []).join(', ') || 'none'}] outcome: ${r.outcome}. Harden: ${String(r.hardeningItem || '').slice(0, 160)}`,
        )
        .join('\n');
      return `  card "${t.card.id}" prior lessons (newest first, from data/agent/card-blocker-lessons.jsonl):\n${body}`;
    })
    .filter(Boolean)
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
    `PRIOR LESSONS (what earlier runs already learned about these defects -- read this before re-deriving root cause; each row is a real past blocker with what was tried and its outcome. Rows are capped to the trailing 14 days and ranked by relevance to tonight's defect kinds, but a lesson can still describe a defect that was since fixed: VERIFY each one still applies to today's live board before acting on it):`,
    lessonBlocks || '  (none recorded yet for these cards)',
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
  // THREE-OUTCOME REPORTING (2026-07-18): cleared vs escalated_to_human vs
  // failed_to_fix. A human-gated defect routed with a concrete action is not a
  // healer failure; folding it into one "blocked" bucket is why the same
  // human-gated defect got re-attempted every night.
  const escalatedCount = perDefect.filter((o) => o.outcome === 'escalated_to_human').length;
  const failedToFixCount = perDefect.length - clearedCount - escalatedCount;
  const threeWaySplit = () =>
    `${clearedCount} cleared, ${escalatedCount} escalated_to_human, ${failedToFixCount} failed_to_fix (${survivedCount} survived, ${unverifiedCount} unverified)`;

  let verdict;
  let verdictReason;
  if (verdictOverride) {
    verdict = verdictOverride;
    verdictReason = verdictReasonOverride || '';
    // Even an override may never smuggle a cleared verdict past the proof rule.
    if (verdict === 'cleared' && clearedCount !== perDefect.length) {
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
    verdictReason = `some defects cleared with live proof: ${threeWaySplit()}`;
  } else if (escalatedCount > 0 && failedToFixCount === 0) {
    verdict = 'escalated';
    verdictReason = `every defect is human-gated with a concrete action recorded: ${threeWaySplit()}`;
  } else {
    verdict = 'blocked';
    verdictReason = `no defect cleared with live proof: ${threeWaySplit()}`;
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
      // The concrete human action rides on escalated_to_human outcomes.
      ...(o.action ? { action: o.action } : {}),
    })),
    cleared: clearedCount,
    survived: survivedCount,
    unverified: unverifiedCount,
    escalatedToHuman: escalatedCount,
    failedToFix: failedToFixCount,
    // The three-outcome night summary every consumer reads (2026-07-18).
    outcomeSummary: {
      cleared: clearedCount,
      escalated_to_human: escalatedCount,
      failed_to_fix: failedToFixCount,
    },
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

function feedSelfHealHealth({ receipt, opts, artifact = null }) {
  // Per-defect attempt rows in the same repair ledger the SELF-HEAL HEALTH card
  // already reads (defectCounts). A cleared row requires the receipt's live
  // proof, which buildReceipt already enforced.
  for (const d of receipt.perDefect) {
    // escalated_to_human never attempted a tactic: no attempt row, so the
    // repair ledger stays honest and the no-repeat guard is untouched.
    if (
      d.outcome === 'skipped-no-repeat' ||
      d.outcome === 'not-attempted' ||
      d.outcome === 'escalated_to_human'
    )
      continue;
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
      // Three-outcome night summary (2026-07-18): cleared vs escalated vs
      // failed, so a human-gated defect stops reading as a nightly failure.
      escalatedToHuman: receipt.escalatedToHuman || 0,
      failedToFix: receipt.failedToFix || 0,
      verdict: receipt.verdict,
      blockers: receipt.perDefect.map((d) => ({
        title: d.defect,
        cleared: d.outcome === 'cleared',
        escalatedToHuman: d.outcome === 'escalated_to_human',
        ...(d.action ? { action: d.action } : {}),
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

  // STRUCTURED LESSON CAPTURE (ExampleCo dispatch 2026-07-12 evening): every card
  // still blocked at the end of this run gets one durable lesson row, so the
  // engineered workflow learns instead of forgetting overnight. This is the
  // SINGLE chokepoint both scripts/ec2-morning-briefing-run.sh paths (legacy
  // full-build and card-controller authority) share, since both run this
  // driver as their last step. Never allowed to crash the healer itself.
  try {
    const tacticRows = readTacticRows(opts);
    cardBlockerLessons.recordFromAgenticHealerReceipt({ receipt, artifact, tacticRows, opts });
  } catch {
    // lesson capture is durable evidence, not a healer crash path
  }
  // HARDENING BACKLOG (item 3): promote a defect recurring 2+ distinct dates
  // in 14 days into a scored FEATURE BACKLOG entry so it becomes visible work
  // instead of ambient pain. Best-effort, never blocks the healer.
  try {
    hardeningBacklogSync.syncHardeningBacklog({ opts });
  } catch {
    // backlog sync is best-effort; a failure here must never fail the healer
  }
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

  // Hoisted OUTSIDE the try block (Codex review 2026-07-12) so a crash AFTER
  // a fresh defective-card artifact was read still lets the catch block
  // record a lesson for those known-defective cards instead of losing the
  // signal entirely to `defectsBefore: null`.
  let artifact = null;

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
    artifact = envelope && envelope.artifact;
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
      feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
      return receipt;
    }

    // TRIAGE GATE (2026-07-18): before any budget is spent, route defects
    // whose OWN evidence says the fix is outside this healer's reach (a
    // missing credential, a different host, a human decision) to a human with
    // the concrete action, instead of burning the night's budget on a session
    // that cannot succeed. The escalation record is durable; no tactic is
    // consumed for an escalated defect.
    const triage = (opts.triageDefects || triageDefects)({ date, defectiveCards, artifact });
    for (const esc of triage.escalations) {
      appendEscalationRow(
        {
          ts: new Date(now()).toISOString(),
          date,
          runId,
          defect: esc.defect,
          cardId: esc.card.id,
          kind: esc.kind,
          action: esc.action,
          evidence: esc.excerpt,
        },
        ledgerOpts,
      );
      log(
        `[agentic-healer] escalated to human, no budget spent (${esc.kind}): ${esc.card.id} -> ${esc.action}`,
      );
    }
    const escalatedOutcomes = triage.escalations.map((esc) => ({
      card: esc.card,
      defect: esc.defect,
      inputHash: esc.inputHash,
      tactic: null,
      outcome: 'escalated_to_human',
      proof: null,
      action: esc.action,
      reason: `human-gated (${esc.kind}): ${esc.excerpt}`,
    }));
    if (!triage.actionableCards.length) {
      log('[agentic-healer] every live defect is human-gated; no session spawned.');
      const receipt = finishReceipt({
        defectsBefore,
        tactic: null,
        outcomes: escalatedOutcomes,
      });
      completeCheckpoint('green', {
        attempted: 0,
        cleared: 0,
        escalatedToHuman: escalatedOutcomes.length,
        verdict: receipt.verdict,
      });
      feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
      return receipt;
    }

    // RAIL 2: no-repeat tactics gate (over the tractable defects only).
    const ladder = opts.tactics || TACTIC_LADDER;
    const tacticRows = readTacticRows(ledgerOpts);
    const plan = planTactics({
      date,
      defectiveCards: triage.actionableCards,
      tacticRows,
      tactics: ladder,
    });
    if (!plan.tactic) {
      log(
        '[agentic-healer] every ladder tactic already failed with unchanged input; honest blocked verdict.',
      );
      const receipt = finishReceipt({
        defectsBefore,
        tactic: null,
        skippedTactics: plan.skipped,
        outcomes: [
          ...plan.skipped.map((s) => ({
            ...s,
            outcome: 'skipped-no-repeat',
            proof: null,
            reason: s.reason,
          })),
          ...escalatedOutcomes,
        ],
        verdictOverride: 'blocked',
        verdictReasonOverride:
          'tactics exhausted: every ladder tactic already failed for these defects with unchanged input; needs changed input or ExampleCo steering',
      });
      completeCheckpoint('green', { blocked: 'tactics-exhausted' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
      return receipt;
    }

    // Budget check before spawning anything (RAIL 4).
    if (deadlineMs - now() - VERIFY_RESERVE_MS < MIN_SESSION_MS) {
      const receipt = finishReceipt({
        defectsBefore,
        tactic: plan.tactic,
        skippedTactics: plan.skipped,
        outcomes: [
          ...plan.targets.map((t) => ({
            ...t,
            outcome: 'not-attempted',
            proof: null,
            reason: 'budget exhausted before a session could start',
          })),
          ...escalatedOutcomes,
        ],
        verdictOverride: 'blocked',
        verdictReasonOverride:
          'budget-exhausted: not enough wall clock left to run an honest dev session',
      });
      completeCheckpoint('green', { blocked: 'budget-exhausted' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
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
        outcomes: [
          ...plan.targets.map((t) => ({
            ...t,
            outcome: 'not-attempted',
            proof: null,
            reason: `isolated worktree unavailable: ${worktree.error || 'ExampleCo'}`,
          })),
          ...escalatedOutcomes,
        ],
        verdictOverride: 'blocked',
        verdictReasonOverride: `worktree-unavailable: refusing to run a full-access session in a shared checkout (${worktree.error || 'ExampleCo'})`,
      });
      completeCheckpoint('green', { blocked: 'worktree-unavailable' });
      feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
      return receipt;
    }

    // THE LADDER LOOP (Codex review 2026-07-12, both passes): each viable rung
    // runs a full session, then the driver independently re-verifies the live
    // board. A rung that leaves defects surviving is a failed tactic; the next
    // viable rung runs while budget remains, INCLUDING after a self-reported
    // genuine wall (a wall claim is the child's own text and must not starve
    // the other rung; the wall reasons are recorded per rung) and INCLUDING
    // after a watchdog kill of an earlier rung (2026-07-18: the kill only
    // consumed that rung's own slice, never the whole night). The ladder stops
    // early only when the remaining wall clock cannot fund an honest session.
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
    // True only when the loop stopped because the REMAINING wall clock could
    // not fund an honest session (fair-split semantics, 2026-07-18), never
    // merely because one rung's watchdog killed that rung's own slice.
    let budgetExhaustedBreak = false;
    const wallReasons = [];

    // STRUCTURED LESSON CAPTURE, item 2: fetch each target card's last (bounded
    // 3) durable lesson rows ONCE before the ladder so every rung's mission
    // prompt starts from prior root-cause knowledge instead of rediscovering
    // it (data/agent/card-blocker-lessons.jsonl, fed by feedSelfHealHealth at
    // the end of every prior run).
    // Staleness + relevance guard (Codex review 2026-07-15): the feed is
    // capped to the trailing 14 days and, per card, prefers lessons whose
    // defectKind matches a defect actually on the board TONIGHT, so an old
    // lesson about an already-fixed defect cannot masquerade as guidance for
    // a different current one.
    const kindsByCard = {};
    for (const d of plan.perDefect) {
      const id = d.card.id;
      const kinds = Array.isArray(d.card.defectKinds) ? d.card.defectKinds : [];
      kindsByCard[id] = [...new Set([...(kindsByCard[id] || []), ...kinds])];
    }
    const lessonsByCard = cardBlockerLessons.lastLessonsByCard(
      [...new Set(plan.perDefect.map((d) => d.card.id))],
      ledgerOpts,
      3,
      { nowDate: date, kindsByCard },
    );

    for (let rungIndex = 0; rungIndex < ladder.length; rungIndex += 1) {
      const tactic = ladder[rungIndex];
      if (!pending.length) break;
      const viable = pending.filter(
        (t) => !tacticAlreadyFailed(tacticRows, t.defect, tactic, t.inputHash),
      );
      if (!viable.length) continue;
      const availableMs = deadlineMs - now() - VERIFY_RESERVE_MS;
      if (availableMs < MIN_SESSION_MS) {
        budgetExhaustedBreak = true;
        break;
      }
      // FAIR-SPLIT BUDGET (2026-07-18): split the remaining budget evenly
      // across the rungs that can still run instead of handing the first rung
      // every remaining minute. The fallback rung is empirically the
      // highest-yield minute of the night; it must never be starved by rung 1
      // happening to run long (2026-07-17: claude took 38.9 of 39 minutes,
      // codex never got a turn, night cleared 0/4).
      const remainingRungs = Math.max(1, ladder.length - rungIndex);
      const sessionBudgetMs = Math.max(MIN_SESSION_MS, Math.floor(availableMs / remainingRungs));

      const prompt = buildMissionPrompt({
        date,
        targets: viable,
        artifact,
        repoRoot,
        dataDirPath,
        budgetMinutes: Math.round(sessionBudgetMs / 60000),
        worktree,
        lessonsByCard,
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
      // A watchdog-killed session writes 'executor-fault' rows (interrupted,
      // not refuted): the no-repeat guard leaves the tactic retryable while
      // the receipt still reports honestly that nothing cleared (2026-07-18).
      for (const o of outcomes) {
        appendTacticRow(
          {
            ts: new Date(now()).toISOString(),
            date,
            defect: o.defect,
            tactic,
            tacticKey: ledger.tacticKey(tactic),
            inputHash: o.inputHash,
            outcome: tacticRowOutcome(o.outcome, session),
            reason: String(o.reason || session.escalationReason || '').slice(0, 300),
            ...(session.watchdog ? { watchdog: String(session.watchdog.kind || '') } : {}),
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
      // NOTE (2026-07-18): a budget-killed rung no longer stops the ladder.
      // Under the fair split the kill only consumed that rung's own slice;
      // the top-of-loop check decides whether the next rung still has an
      // honest slice, so the fallback rung is never starved by rung 1.
    }

    // The night is budget-exhausted when the loop stopped for lack of usable
    // clock, or the LAST rung was budget-killed with no honest session's
    // worth of clock left behind it.
    const budgetExhausted =
      budgetExhaustedBreak ||
      (!!(lastSession && lastSession.watchdog && lastSession.watchdog.kind === 'budget') &&
        deadlineMs - now() - VERIFY_RESERVE_MS < MIN_SESSION_MS);

    // Assemble final per-defect outcomes: verified outcomes first, then the
    // never-attempted (exhausted or out-of-budget/walled) defects, honestly,
    // then the human-gated defects the triage gate escalated before any spend.
    const finalOutcomes = [
      ...plan.perDefect.map((d) => {
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
          reason: budgetExhausted
            ? 'budget exhausted before this defect could be attempted'
            : 'no viable rung remained for this defect within budget',
        };
      }),
      ...escalatedOutcomes,
    ];

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
      ...(budgetExhausted && !anyCleared
        ? {
            verdictOverride: 'blocked',
            verdictReasonOverride: `budget-exhausted: the night's wall clock ran out (last rung ${usedTactic}) and the live board shows no cleared defect; honest blocked, never a false clear`,
          }
        : {}),
    });

    feedSelfHealHealth({ receipt, opts: ledgerOpts, artifact });
    completeCheckpoint('green', {
      attempted: receipt.perDefect.length,
      cleared: receipt.cleared,
      escalatedToHuman: receipt.escalatedToHuman,
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
    // STRUCTURED LESSON CAPTURE (Codex review 2026-07-12): if the crash
    // happened AFTER a fresh, non-stale defective-card artifact was read
    // (artifact is only ever assigned past that point, see the hoisted
    // declaration above), still record a lesson for those known-defective
    // cards instead of silently losing the signal to `defectsBefore: null`.
    if (artifact && Array.isArray(artifact.cards)) {
      try {
        const tacticRows = readTacticRows(ledgerOpts);
        cardBlockerLessons.recordFromLiveBoardArtifact({
          date,
          artifact,
          tacticRows,
          reasonNote: `healer driver crashed mid-run: ${String((e && e.message) || e).slice(0, 300)}`,
          opts: ledgerOpts,
        });
      } catch {
        // lesson capture must never compound a crash
      }
    }
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
  escalationsPath,
  readTacticRows,
  appendTacticRow,
  tacticAlreadyFailed,
  tacticRowOutcome,
  defectInputHash,
  defectKeyForCard,
  planTactics,
  classifyHumanGate,
  defectEvidenceText,
  triageDefects,
  readEscalationRows,
  appendEscalationRow,
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
