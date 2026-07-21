#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

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
// (Codex CLI primary, Claude CLI fallback) with the refreshed briefing, one
// red card or metric identity, and only the same-night attempts for that exact
// defect. The standing mission is to fix it exactly like an interactive
// session ExampleCo dispatched would. The coordinator, not the model prompt, owns
// the raw QC artifact, pipeline internals, full ledger, refresh, and publish.
// Root-cause, code fix in an isolated worktree, and tests with every change.
// The session stops there. The coordinator alone commits, lands through
// `node scripts/land.js --apply`, deploys through
// `scripts/deploy-ec2-server.sh`, refreshes, and verifies the live board.
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
//   5. COORDINATOR-ONLY INTEGRATION. The worker never commits, lands, deploys,
//      refreshes, publishes, or calls a verdict. The coordinator serializes
//      those operations and deploys only through deploy-ec2-server.sh.
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
// across the rungs that can still run, instead of winner-take-all. Historical
// runs showed that one first rung could consume the whole budget and starve
// the next viable executor. Codex is now the first judgment rung and Claude
// the fallback, but the same budget rule applies: each viable rung gets its
// slice, and the ladder stops
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
const { affectedTestScope } = require('./lib/land-gate.js');
const { controllerPaths } = require('./lib/briefing-card-controller.js');

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
const PROMPT_ENVELOPES_REL = path.join('agent', 'self-heal-prompt-envelopes.jsonl');
const TACTIC_POLICY_VERSION = 'exact-defect-v1';
const PROMPT_ENVELOPE_SCHEMA = 1;

// The tactic ladder. Each rung is one full-dev-session executor. The no-repeat
// gate is per (defect, tactic, inputHash): if the Codex session already failed
// on this exact defect with unchanged input, the next run skips to Claude; when
// every rung has failed unchanged, the verdict is an honest blocked.
const TACTIC_LADDER = ['agentic-dev-session:codex', 'agentic-dev-session:claude'];

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

function promptEnvelopesPath(opts = {}) {
  return path.join(dataDir(opts), PROMPT_ENVELOPES_REL);
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

function sessionAttemptForDefect(session, outcome) {
  const identities = new Set(
    [
      outcome && outcome.defect,
      outcome && outcome.card && outcome.card.id,
      outcome && outcome.card && outcome.card.workUnitId,
    ]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase()),
  );
  const row = Array.isArray(session && session.defects)
    ? session.defects.find((entry) => {
        const id = String((entry && entry.defect) || '').trim().toLowerCase();
        return identities.has(id);
      })
    : null;
  return {
    hypothesis: safeAttemptText(
      (row && row.hypothesis) || 'per-defect hypothesis not stated',
      240,
    ),
    action: safeAttemptText((row && row.action) || 'per-defect action not stated', 240),
    result: safeAttemptText((row && row.result) || 'per-defect result not stated', 120),
    whyNotClosed: safeAttemptText(
      (row && (row.why_not_closed || row.whyNotClosed)) ||
        (outcome && outcome.outcome === 'cleared' ? '' : 'per-defect reason not stated'),
      300,
    ),
  };
}

const PROMPT_SAFE_ATTEMPT_SOURCE = 'agentic-healer-driver';
const PROMPT_SAFE_ATTEMPT_SCHEMA = 2;
const FORBIDDEN_ATTEMPT_DETAIL =
  /failed\s*predicate|candidate\s*well|source\s*candidate|rejection\s*ident|batch\s*id|ledger\s*total|producer\s*guess|pipeline\s*explanation|raw\s*(?:qc|defect)|dashboard-qc-result|briefing-repair-ledger/i;

function safeAttemptText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  return FORBIDDEN_ATTEMPT_DETAIL.test(text) ? '[internal detail withheld]' : text;
}

function promptSafeAttemptFromTacticRow(row) {
  if (
    !row ||
    row.source !== PROMPT_SAFE_ATTEMPT_SOURCE ||
    Number(row.schemaVersion) !== PROMPT_SAFE_ATTEMPT_SCHEMA ||
    !row.promptSafeAttempt ||
    typeof row.promptSafeAttempt !== 'object' ||
    Array.isArray(row.promptSafeAttempt)
  ) {
    return null;
  }
  const allowed = [
    ['tactic', 120],
    ['hypothesis', 240],
    ['action', 240],
    ['result', 120],
    ['liveOutcome', 120],
    ['whyNotClosed', 300],
  ];
  const out = {};
  for (const [key, max] of allowed) {
    const value = row.promptSafeAttempt[key];
    if (value != null && typeof value !== 'string') return null;
    out[key] = safeAttemptText(value, max);
  }
  return out;
}

function sameNightAttemptMemory({ date, targets, tacticRows = [] }) {
  const out = {};
  for (const target of targets || []) {
    const defect = target.defect || defectKeyForCard(target.card || target);
    const defectNorm = ledger.normDefectKey(defect);
    const rows = [];
    for (const row of tacticRows || []) {
      if (!row || row.date !== date || ledger.normDefectKey(row.defect) !== defectNorm) continue;
      const safe = promptSafeAttemptFromTacticRow(row);
      if (safe) rows.push(safe);
    }
    const seen = new Set();
    out[defect] = rows
      .filter((row) => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-6);
  }
  return out;
}

// The tactic input hash covers exactly what the tactic acts on: briefing date,
// card id, live status, and the defect-kind signature. No volatile timestamps,
// no commit hashes (feedback_no_repeat_failed_tactics_without_changed_input:
// changed error wording must not unlock the same tactic; a new briefing date is
// a changed input by definition, so history from another date never suppresses
// today's repair pass).
function exactDefectEvidence(card, artifact = null) {
  const cardId = String((card && card.id) || '');
  return {
    cardId,
    cardStatus: String((card && card.status) || ''),
    defectKinds: [...((card && card.defectKinds) || [])].map(String).sort(),
    cardDetail: String((card && (card.detail || card.reason || card.message)) || ''),
    workUnitId: String((card && card.workUnitId) || ''),
    workUnitStatus: String((card && card.workUnitStatus) || ''),
    workUnitDetail: String((card && card.workUnitDetail) || ''),
    defectEvidenceHash: String((card && card.defectEvidenceHash) || ''),
    tacticPolicyVersion: TACTIC_POLICY_VERSION,
  };
}

function defectInputHash(date, card, artifact = null) {
  return ledger.hashTacticInput({
    date: ledger.safeDate(date),
    exactDefectEvidence: exactDefectEvidence(card, artifact),
  });
}

function defectKeyForCard(card, artifact = null) {
  const evidence = exactDefectEvidence(card, artifact);
  const signature = crypto
    .createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex')
    .slice(0, 16);
  const prefix = card && card.workUnitId ? 'METRIC' : 'LIVE-BOARD';
  return ledger.defectKey({ card_id: card.id, defect_type: `${prefix}-${signature}` });
}

function expandDefectiveWorkUnits(defectiveCards, artifact) {
  const measurements = Array.isArray(artifact && artifact.systemHealthMeasurements)
    ? artifact.systemHealthMeasurements
    : [];
  const failedMeasurements = measurements.filter(
    (unit) => unit && unit.actionable && unit.status !== 'green',
  );
  const out = [];
  for (const card of defectiveCards || []) {
    if (card && card.id === 'system_health' && failedMeasurements.length) {
      for (const unit of failedMeasurements) {
        out.push({
          ...card,
          workUnitId: unit.id,
          workUnitName: unit.name,
          workUnitStatus: unit.status,
          workUnitDetail: unit.detail || '',
        });
      }
    } else {
      out.push(card);
    }
  }
  return out;
}

// Pick the first ladder rung with at least one defect the no-repeat gate lets
// through. Defects blocked on EVERY rung are 'exhausted' (honest blocked
// verdict, never a silent drop).
function planTactics({ date, defectiveCards, artifact = null, tacticRows, tactics = TACTIC_LADDER }) {
  const perDefect = defectiveCards.map((card) => ({
    card,
    defect: defectKeyForCard(card, artifact),
    inputHash: defectInputHash(date, card, artifact),
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
        defect: defectKeyForCard(card, artifact),
        inputHash: defectInputHash(date, card, artifact),
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

// A judgment worker must NEVER get a shared checkout as its cwd: one bad first
// action could mutate the shared tree before the coordinator's land gate ever
// runs, which is exactly the healer-reverted-prod class. The driver therefore
// cuts its own worktree off origin/master, links node_modules, and hands the
// session THAT cwd. If the worktree cannot be created, the run is an honest
// blocked verdict, never a repair session in the shared tree. The
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
    const baseProbe = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const baseSha = baseProbe.status === 0 ? String(baseProbe.stdout || '').trim() : '';
    return { ok: true, cwd: worktree, branch, baseSha, created: true };
  } catch (e) {
    return { ok: false, cwd: null, error: String((e && e.message) || e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Mission prompt (the standing mission ExampleCo dispatched)
// ---------------------------------------------------------------------------

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const ExampleCo = Object.keys(value).filter((key) => !allowed.includes(key));
  if (ExampleCo.length) throw new Error(`${label} contains ExampleCo field(s): ${ExampleCo.join(', ')}`);
}

function validatePromptEnvelope(envelope) {
  assertExactKeys(
    envelope,
    ['schemaVersion', 'date', 'briefingReference', 'targets', 'attempts'],
    'prompt envelope',
  );
  if (Number(envelope.schemaVersion) !== PROMPT_ENVELOPE_SCHEMA)
    throw new Error('unsupported prompt envelope schema');
  if (!Array.isArray(envelope.targets) || !Array.isArray(envelope.attempts))
    throw new Error('prompt envelope targets and attempts must be arrays');
  for (const target of envelope.targets) {
    assertExactKeys(
      target,
      ['defect', 'cardId', 'workUnitId', 'workUnitName', 'verdict'],
      'prompt target',
    );
    if (!target.defect || !target.cardId || target.verdict !== 'defective')
      throw new Error('prompt target requires exact defect, card identity, and defective verdict');
  }
  for (const group of envelope.attempts) {
    assertExactKeys(group, ['defect', 'rows'], 'prompt attempt group');
    if (!Array.isArray(group.rows)) throw new Error('prompt attempt rows must be an array');
    for (const row of group.rows) {
      assertExactKeys(
        row,
        ['tactic', 'hypothesis', 'action', 'result', 'liveOutcome', 'whyNotClosed'],
        'prompt attempt',
      );
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') throw new Error('prompt attempt fields must be strings');
      }
    }
  }
  return envelope;
}

function buildPromptEnvelope({ date, targets, dataDirPath, attemptMemoryByDefect = {} }) {
  const envelope = {
    schemaVersion: PROMPT_ENVELOPE_SCHEMA,
    date: ledger.safeDate(date),
    briefingReference: path.join(
      dataDirPath,
      'briefings',
      `briefing-${ledger.safeDate(date)}.md`,
    ),
    targets: (targets || []).map((target) => ({
      defect: String(target.defect || defectKeyForCard(target.card)),
      cardId: String((target.card && target.card.id) || ''),
      workUnitId: String((target.card && target.card.workUnitId) || ''),
      workUnitName: String((target.card && target.card.workUnitName) || ''),
      verdict: 'defective',
    })),
    attempts: (targets || []).map((target) => {
      const defect = String(target.defect || defectKeyForCard(target.card));
      return {
        defect,
        rows: (attemptMemoryByDefect[defect] || []).map((row) => ({
          tactic: safeAttemptText(row.tactic, 120),
          hypothesis: safeAttemptText(row.hypothesis, 240),
          action: safeAttemptText(row.action, 240),
          result: safeAttemptText(row.result, 120),
          liveOutcome: safeAttemptText(row.liveOutcome, 120),
          whyNotClosed: safeAttemptText(row.whyNotClosed, 300),
        })),
      };
    }),
  };
  return validatePromptEnvelope(envelope);
}

function promptEnvelopeHash(envelope) {
  validatePromptEnvelope(envelope);
  return crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function recordPromptEnvelope({ envelope, runId, tactic, dataDir: dataDirPath, now = Date.now() }) {
  const hash = promptEnvelopeHash(envelope);
  appendJsonl(promptEnvelopesPath({ dataDir: dataDirPath }), {
    ts: new Date(now).toISOString(),
    runId,
    tactic,
    schemaVersion: PROMPT_ENVELOPE_SCHEMA,
    envelopeHash: hash,
    targetDefects: envelope.targets.map((target) => target.defect),
    attemptCounts: envelope.attempts.map((group) => ({
      defect: group.defect,
      count: group.rows.length,
    })),
    envelope,
  });
  return hash;
}

function buildMissionPrompt({
  date,
  targets,
  repoRoot,
  dataDirPath,
  budgetMinutes,
  worktree,
  attemptMemoryByDefect = {},
  envelope = null,
}) {
  const safeEnvelope = validatePromptEnvelope(
    envelope || buildPromptEnvelope({ date, targets, dataDirPath, attemptMemoryByDefect }),
  );
  const defectLines = safeEnvelope.targets
    .map((target, i) => {
      const identity = target.workUnitName
        ? `System Health measurement "${target.workUnitName}"`
        : `card "${target.cardId}"`;
      return `${i + 1}. ${identity}: RED`;
    })
    .join('\n');
  const attemptBlocks = safeEnvelope.attempts
    .map((group) => {
      const rows = group.rows;
      if (!rows.length) return '';
      const body = rows
        .map((row, index) =>
          [
            `    ${index + 1}. tactic: ${safeAttemptText(row.tactic || 'ExampleCo', 120)}`,
            row.hypothesis ? `hypothesis: ${safeAttemptText(row.hypothesis, 240)}` : '',
            row.action ? `action: ${safeAttemptText(row.action, 240)}` : '',
            `result: ${safeAttemptText(row.result || 'ExampleCo', 120)}`,
            `live outcome: ${safeAttemptText(row.liveOutcome || 'ExampleCo', 120)}`,
            row.whyNotClosed
              ? `why it did not close: ${safeAttemptText(row.whyNotClosed, 300)}`
              : '',
          ]
            .filter(Boolean)
            .join('; '),
        )
        .join('\n');
      const target = safeEnvelope.targets.find((row) => row.defect === group.defect);
      const identity = (target && (target.workUnitName || target.cardId)) || group.defect;
      return `  ${identity}:\n${body}`;
    })
    .filter(Boolean)
    .join('\n');
  const wtCwd = (worktree && worktree.cwd) || repoRoot;
  const wtBranch = (worktree && worktree.branch) || '(current branch)';
  return [
    `You are the overnight agentic healer for the SecondBrain daily briefing, a FULL dev session dispatched exactly as if ExampleCo said: "this is broken, fix it." Work autonomously to completion.`,
    ``,
    `Briefing date: ${safeEnvelope.date}. You are ALREADY working in an ISOLATED worktree at ${wtCwd} on branch ${wtBranch}, cut fresh from origin/master. Never mutate any other checkout.`,
    ``,
    `The refreshed briefing ExampleCo would inspect is ${safeEnvelope.briefingReference}. Inspect that product yourself.`,
    `ExampleCo identified only these user-visible failures:`,
    defectLines || '(none)',
    ``,
    `What has already been tried tonight for the same failure:`,
    attemptBlocks || '  (nothing yet tonight)',
    ``,
    `MISSION:`,
    `1. Read dev-plans/core/briefing.md and dev-plans/core/self-heal.md first. Before editing ANY card, read its skill page: node scripts/card-skill.js <card_id>.`,
    `2. Diagnose from the refreshed briefing and your normal inspection tools, as you would in an interactive session.`,
    `3. Fix the responsible code, configuration, dependency, or machine condition. Never hand-author or directly edit a generated briefing/card artifact to make the symptom disappear.`,
    `4. Add a regression test for every code change and run the focused tests.`,
    `5. Stop after editing the isolated worktree and running focused tests. Do not commit, land, push, deploy, refresh, publish, or call the card clean.`,
    `6. The coordinator alone reviews the diff, commits, lands, deploys, reruns the deterministic card refresh, and performs scoped live QC.`,
    ``,
    `HARD CONSTRAINTS:`,
    `- You have ${budgetMinutes} minutes of wall clock. Leave the last 3 minutes to emit your final JSON contract. Prioritize the highest-impact defects first.`,
    `- Do not repeat an attempt listed in the same-night memory. Change the hypothesis or approach.`,
    `- Honesty over optimism: report what was repaired or the concrete wall. The coordinator independently decides whether the red verdict cleared.`,
    `- Do the work INLINE in this session: no background tasks, no detached sub-agents.`,
    `- The never-list stands: never contact a human, never send anything outbound, never delete raw archives, never stop the Amy/ExampleCo/Snack Dude services, never move money.`,
    `- No em dashes in any output or file. Tests ship with every code change.`,
    ``,
    `FINAL OUTPUT CONTRACT: end with a single JSON object on its own line:`,
    `{"status":"repaired"|"escalated","commit_sha":"","pushed":false,"summary":"<what you changed in the worktree>","tests":"<focused test proof>","reflection":"<what you learned / why blocked>","escalation_reason":"<only when escalated>","defects":[{"defect":"<card_id or metric_id>","outcome":"repaired"|"survived"|"blocked","hypothesis":"<what you believed>","action":"<what you tried>","result":"<local result>","why_not_closed":"<empty only when repaired>","evidence":"<worktree evidence or honest reason>"}]}`,
    `Your self-report is advisory: the coordinator independently refreshes and grades the affected work after you finish.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Full-dev-session spawn adapters (Codex primary, Claude fallback)
// ---------------------------------------------------------------------------

// Unlike the constrained isolated-worker adapters in heal-executor.js (worker
// guard settings, workspace-write sandbox), these run a FULL dev session: the
// same diagnostic/editing latitude as an interactive session ExampleCo dispatches.
// The worktree is its complete mutation boundary; integration and production
// access stay coordinator-only.
function buildFullSessionClaudeArgs(prompt, opts = {}) {
  const args = [
    '--print',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--setting-sources',
    '',
    '--settings',
    healExecutor.buildSelfHealWorkerSettings({ cwd: opts.cwd || REPO }),
  ];
  args.push('--dangerously-skip-permissions', '-p', prompt);
  return args;
}

function buildFullSessionCodexArgs(prompt, opts = {}) {
  // Codex may inspect and edit only its isolated worktree. It does not need
  // shared-git or deploy authority because the coordinator owns integration.
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--cd',
    opts.cwd || REPO,
    prompt,
  ];
}

function spawnFullClaude(prompt, opts = {}) {
  const { spawn } = require('node:child_process');
  const args = buildFullSessionClaudeArgs(prompt, opts);
  const env = healExecutor.workerEnv({
    tokenPath: opts.tokenPath,
    cwd: opts.cwd,
    coordinatorRoot: opts.coordinatorRoot,
    protectedRoots: opts.protectedRoots,
  });
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
  const env = healExecutor.workerEnv({
    tokenPath: opts.tokenPath,
    cwd: opts.cwd,
    coordinatorRoot: opts.coordinatorRoot,
    protectedRoots: opts.protectedRoots,
  });
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
async function defaultSpawnSession({
  tactic,
  prompt,
  budgetMs,
  cwd,
  tokenPath,
  coordinatorRoot,
  protectedRoots,
  onStream,
}) {
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
    coordinatorRoot,
    protectedRoots,
    onStream,
  });
}

function coordinatorDeploymentRequired(paths) {
  return (paths || []).some(
    (file) =>
      file === 'ec2-server.js' ||
      file === 'package.json' ||
      file === 'package-lock.json' ||
      file.startsWith('scripts/') ||
      file.startsWith('config/') ||
      file.startsWith('infra/') ||
      file.startsWith('docker-compose'),
  );
}

function runSyncStep(spawnSyncFn, command, args, options = {}) {
  const run = spawnSyncFn(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    cwd: options.cwd,
    env: options.env || process.env,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: !run.error && run.status === 0,
    exitCode: run.status,
    error: run.error ? String(run.error.message || run.error) : '',
    stdout: String(run.stdout || '').slice(-12000),
    stderr: String(run.stderr || '').slice(-12000),
  };
}

// The healer edits and tests. This coordinator is the only layer allowed to
// turn that judgment into shared state: validate the worktree boundary,
// commit, land, deploy, then hand the deployed runtime to the card pipeline.
function defaultIntegrateRepair({
  worktree,
  runId,
  session,
  spawnSyncFn = spawnSync,
  bashBin = process.env.BASH_BIN || (IS_WIN ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'),
} = {}) {
  if (!worktree || !worktree.cwd) {
    return { ok: false, changed: false, error: 'missing coordinator-owned worktree' };
  }
  const head = runSyncStep(spawnSyncFn, 'git', ['rev-parse', 'HEAD'], {
    cwd: worktree.cwd,
    timeoutMs: 30_000,
  });
  const headSha = head.ok ? head.stdout.trim().split(/\s+/).pop() : '';
  if (!head.ok) return { ok: false, changed: false, error: 'could not inspect worker HEAD', head };
  if (worktree.baseSha && headSha !== worktree.baseSha) {
    return {
      ok: false,
      changed: true,
      scopeViolation: 'worker-committed',
      error: 'worker changed git HEAD; workers may edit and test but never commit or land',
      headSha,
      baseSha: worktree.baseSha,
    };
  }
  if (!session || session.status !== 'repaired') {
    return {
      ok: false,
      changed: false,
      error: 'worker did not return a repaired completion; refusing dirty-output integration',
    };
  }
  if (
    session.category === healExecutor.FAULT ||
    (session.watchdog && (session.watchdog.killed || session.watchdog.kind))
  ) {
    return {
      ok: false,
      changed: false,
      error: 'worker ended in an executor fault or watchdog stop; refusing partial integration',
    };
  }
  if (session.commit_sha || session.pushed) {
    return {
      ok: false,
      changed: false,
      scopeViolation: 'worker-integrated',
      error: 'worker reported commit or push activity; coordinator cannot trust the output',
    };
  }
  if (!String(session.summary || '').trim() || !String(session.tests || '').trim()) {
    return {
      ok: false,
      changed: false,
      error: 'worker repaired completion omitted summary or focused test proof',
    };
  }
  if (!Array.isArray(session.defects) || !session.defects.length) {
    return {
      ok: false,
      changed: false,
      error: 'worker repaired completion omitted the per-defect completion contract',
    };
  }
  const status = runSyncStep(
    spawnSyncFn,
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: worktree.cwd, timeoutMs: 30_000 },
  );
  if (!status.ok) return { ok: false, changed: false, error: 'could not inspect worker diff', status };
  const changedPaths = status.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim().replace(/^.* -> /, ''))
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
  if (!changedPaths.length) {
    return { ok: true, changed: false, changedPaths: [], deployed: false, landedSha: '' };
  }
  const forbidden = changedPaths.filter(
    (file) => file.startsWith('data/agent/') || file.startsWith('data/briefings/'),
  );
  if (forbidden.length) {
    return {
      ok: false,
      changed: true,
      changedPaths,
      scopeViolation: 'generated-runtime-data-edited',
      error: `worker edited generated runtime data: ${forbidden.join(', ')}`,
    };
  }
  const codeChanged = changedPaths.some((file) =>
    /\.(?:c?js|mjs|ts|tsx|jsx|sh|py)$/i.test(file),
  );
  const changedTests = changedPaths.filter((file) =>
    /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file),
  );
  if (codeChanged && !changedTests.length) {
    return {
      ok: false,
      changed: true,
      changedPaths,
      error: 'code changed without a changed regression test; refusing integration',
    };
  }
  const coordinatorTestFiles = [
    ...new Set([...affectedTestScope(changedPaths), ...changedTests]),
  ].filter((file) => fs.existsSync(path.join(worktree.cwd, file)));
  if (!coordinatorTestFiles.length) {
    return {
      ok: false,
      changed: true,
      changedPaths,
      error: 'coordinator found no runnable affected tests; refusing integration',
    };
  }
  const coordinatorTests = runSyncStep(
    spawnSyncFn,
    IS_WIN ? 'npx.cmd' : 'npx',
    ['vitest', 'run', ...coordinatorTestFiles],
    { cwd: worktree.cwd, timeoutMs: 15 * 60 * 1000 },
  );
  if (!coordinatorTests.ok) {
    return {
      ok: false,
      changed: true,
      changedPaths,
      error: 'coordinator affected tests failed; refusing integration',
      coordinatorTests,
    };
  }
  const add = runSyncStep(spawnSyncFn, 'git', ['add', '--all'], {
    cwd: worktree.cwd,
    timeoutMs: 60_000,
  });
  if (!add.ok) return { ok: false, changed: true, changedPaths, error: 'git add failed', add };
  const message = `fix(self-heal): ${String((session && session.summary) || runId || 'repair')}`
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  const commit = runSyncStep(spawnSyncFn, 'git', ['commit', '-m', message], {
    cwd: worktree.cwd,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!commit.ok) {
    return { ok: false, changed: true, changedPaths, error: 'coordinator commit failed', commit };
  }
  const land = runSyncStep(spawnSyncFn, process.execPath, ['scripts/land.js', '--apply'], {
    cwd: worktree.cwd,
    timeoutMs: 15 * 60 * 1000,
  });
  if (!land.ok) {
    return { ok: false, changed: true, changedPaths, error: 'coordinator land failed', land };
  }
  const landed = runSyncStep(spawnSyncFn, 'git', ['rev-parse', 'origin/master'], {
    cwd: worktree.cwd,
    timeoutMs: 30_000,
  });
  const landedSha = landed.ok ? landed.stdout.trim().split(/\s+/).pop() : '';
  const deployRequired = coordinatorDeploymentRequired(changedPaths);
  let deploy = null;
  if (deployRequired) {
    deploy = runSyncStep(spawnSyncFn, bashBin, ['scripts/deploy-ec2-server.sh'], {
      cwd: worktree.cwd,
      timeoutMs: 20 * 60 * 1000,
    });
    if (!deploy.ok) {
      return {
        ok: false,
        changed: true,
        changedPaths,
        landedSha,
        deployRequired,
        deployed: false,
        error: 'coordinator deploy failed',
        deploy,
      };
    }
  }
  return {
    ok: true,
    changed: true,
    changedPaths,
    landedSha,
    deployRequired,
    deployed: deployRequired,
    commit,
    land,
    deploy,
    coordinatorTests,
  };
}

// ---------------------------------------------------------------------------
// Live-board re-verification (rail 3: the only source of a "cleared" claim)
// ---------------------------------------------------------------------------

// The healer never refreshes a card itself. After its judgment/code session,
// the coordinator reruns the deterministic card controller for the affected
// card identities. That controller owns source refresh, scoped live QC, atomic
// publication, and the canonical artifact update.
function defaultReverify({
  date,
  repoRoot,
  dataDirPath,
  timeoutMs,
  targets = [],
  runtimeRoot: explicitRuntimeRoot = '',
  expectedDeployedSha = '',
  spawnSyncFn = spawnSync,
}) {
  const productionDefault = '/opt/secondbrain';
  const allowedRoot = path.resolve(process.env.SECONDBRAIN_CONTROLLER_ROOT || productionDefault);
  const requestedRoot = path.resolve(explicitRuntimeRoot || allowedRoot);
  // Live proof must come from the deployed controller. Never silently grade a
  // just-built worktree when the production root is absent, because that can
  // clear a repair that ExampleCo still cannot see.
  const runtimeRoot = requestedRoot;
  const script = path.join(runtimeRoot, 'scripts', 'card-controller.js');
  const cardIds = [
    ...new Set((targets || []).map((target) => String(target.card && target.card.id)).filter(Boolean)),
  ];
  const startedMs = Date.now();
  let exitCode = null;
  let error = '';
  let stdout = '';
  if (runtimeRoot !== allowedRoot) {
    return {
      ran: false,
      exitCode: null,
      error: `untrusted controller root ${runtimeRoot}; expected ${allowedRoot}`,
      stdout: '',
      startedMs,
      artifact: null,
      artifactPath: pinnedArtifactPath({ dataDir: dataDirPath }),
      refreshedCardIds: cardIds,
      coordinator: 'card-controller',
      runtimeRoot,
      controllerReceiptMatched: false,
      deployedReleaseSha: '',
    };
  }
  let deployedReleaseSha = '';
  try {
    const realRoot = fs.realpathSync(runtimeRoot);
    const releaseName = path.basename(realRoot);
    if (/^[0-9a-f]{40}$/i.test(releaseName)) deployedReleaseSha = releaseName.toLowerCase();
  } catch {
    deployedReleaseSha = '';
  }
  if (!deployedReleaseSha || (expectedDeployedSha && deployedReleaseSha !== expectedDeployedSha)) {
    return {
      ran: false,
      exitCode: null,
      error: expectedDeployedSha
        ? `deployed release identity mismatch: expected ${expectedDeployedSha}, saw ${deployedReleaseSha || 'ExampleCo'}`
        : 'deployed controller root does not resolve to an immutable release SHA',
      stdout: '',
      startedMs,
      artifact: null,
      artifactPath: pinnedArtifactPath({ dataDir: dataDirPath }),
      refreshedCardIds: cardIds,
      coordinator: 'card-controller',
      runtimeRoot,
      controllerReceiptMatched: false,
      deployedReleaseSha,
      expectedDeployedSha,
    };
  }
  if (!fs.existsSync(script)) {
    return {
      ran: false,
      exitCode: null,
      error: `deployed card controller missing at ${script}; refusing build-root fallback`,
      stdout: '',
      startedMs,
      artifact: null,
      artifactPath: pinnedArtifactPath({ dataDir: dataDirPath }),
      refreshedCardIds: cardIds,
      coordinator: 'card-controller',
      runtimeRoot,
      controllerReceiptMatched: false,
      deployedReleaseSha,
      expectedDeployedSha,
    };
  }
  try {
    const args = [
      script,
      '--mode',
      'overnight',
      '--date',
      ledger.safeDate(date),
      '--cards',
      cardIds.join(','),
      '--max-seconds',
      String(Math.max(60, Math.floor((timeoutMs || 5 * 60 * 1000) / 1000))),
    ];
    const run = spawnSyncFn(
      process.execPath,
      args,
      {
        cwd: runtimeRoot,
        timeout: Math.max(60_000, timeoutMs || 5 * 60 * 1000),
        encoding: 'utf8',
        env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDirPath },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    exitCode = run.status;
    stdout = String(run.stdout || '').slice(-20000);
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
  const parseLastJsonObject = (text) => {
    const source = String(text || '');
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    let last = null;
    for (let index = 0; index < source.length; index += 1) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (ch === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            last = JSON.parse(source.slice(start, index + 1));
          } catch {
            // Keep the last valid controller object only.
          }
          start = -1;
        }
      }
    }
    return last;
  };
  const stdoutReceipt = parseLastJsonObject(stdout);
  let controllerReceipt = null;
  let controllerReceiptPath = '';
  if (stdoutReceipt && stdoutReceipt.runId) {
    controllerReceiptPath = controllerPaths({
      dataDir: dataDirPath,
      date: ledger.safeDate(date),
      runId: String(stdoutReceipt.runId),
    }).receipt;
    try {
      controllerReceipt = JSON.parse(fs.readFileSync(controllerReceiptPath, 'utf8'));
    } catch {
      controllerReceipt = null;
    }
  }
  const planned = new Set((controllerReceipt && controllerReceipt.plannedCards) || []);
  const completed = new Map(
    ((controllerReceipt && controllerReceipt.cards) || []).map((row) => [String(row.cardId), row]),
  );
  const controllerReceiptMatched = !!(
    exitCode === 0 &&
    !error &&
    stdoutReceipt &&
    controllerReceipt &&
    JSON.stringify(stdoutReceipt) === JSON.stringify(controllerReceipt) &&
    controllerReceipt.date === ledger.safeDate(date) &&
    controllerReceipt.outcome === 'clean' &&
    cardIds.every(
      (cardId) =>
        planned.has(cardId) && completed.has(cardId) && completed.get(cardId).outcome === 'cleared',
    )
  );
  return {
    ran: exitCode === 0 && !error && controllerReceiptMatched,
    exitCode,
    error,
    stdout,
    startedMs,
    artifact,
    artifactPath,
    refreshedCardIds: cardIds,
    coordinator: 'card-controller',
    runtimeRoot,
    controllerRunId: (controllerReceipt && controllerReceipt.runId) || '',
    controllerReceiptPath,
    controllerReceiptMatched,
    deployedReleaseSha,
    expectedDeployedSha,
  };
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
  const ran = !!(
    verification &&
    verification.ran &&
    verification.exitCode === 0 &&
    verification.controllerReceiptMatched &&
    verification.deployedReleaseSha
  );
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
    if (t.card && t.card.workUnitId) {
      const unit = (artifact.systemHealthMeasurements || []).find(
        (entry) => entry && String(entry.id) === String(t.card.workUnitId),
      );
      if (!unit || unit.status !== 'green') {
        return {
          ...t,
          outcome: 'survived',
          proof: { artifactTs: artifact.ts, status: unit ? unit.status : 'missing' },
          reason: `System Health measurement still reports ${unit ? unit.status : 'missing'}`,
        };
      }
      return {
        ...t,
        outcome: 'cleared',
        proof: {
          artifactTs: artifact.ts,
          verifiedAfterSessionStart: true,
          verifiedByDriverRun: true,
          status: unit.status,
          workUnitId: unit.id,
        },
        reason: 'coordinator-run scoped refresh shows the System Health measurement green',
      };
    }
    const card = (artifact.cards || []).find((c) => String(c.id) === String(t.card.id));
    if (!card) {
      return {
        ...t,
        outcome: 'unverified',
        proof: null,
        reason: 'target card is absent from the correlated live-board artifact',
      };
    }
    const stillDefective = card.status !== 'clean';
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
        status: card.status,
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
    integration = null,
    integrations = [],
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
          promptEnvelopeHash: s.promptEnvelopeHash || '',
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
    integration,
    integrations,
    promptEnvelopeHashes: sessions.map((row) => row && row.promptEnvelopeHash).filter(Boolean),
    // Only coordinator-owned land receipts enter this field. Worker-reported
    // commit shas are retained only inside the advisory session envelope.
    lands: integrations.map((row) => row && row.landedSha).filter(Boolean),
    git,
    verification: verification
      ? {
          ran: !!verification.ran,
          exitCode: verification.exitCode,
          error: String(verification.error || '').slice(0, 500),
          startedMs: verification.startedMs || null,
          artifactPath: verification.artifactPath || null,
          artifactTs: (verification.artifact && verification.artifact.ts) || null,
          controllerRunId: verification.controllerRunId || '',
          controllerReceiptPath: verification.controllerReceiptPath || '',
          controllerReceiptMatched: !!verification.controllerReceiptMatched,
          deployedReleaseSha: verification.deployedReleaseSha || '',
          expectedDeployedSha: verification.expectedDeployedSha || '',
          defectiveCardCountAfter: verification.artifact
            ? verification.artifact.defectiveCardCount
            : null,
        }
      : null,
    perDefect: perDefect.map((o) => ({
      defect: o.defect,
      cardId: o.card ? o.card.id : '',
      ...(o.card && o.card.workUnitId
        ? { workUnitId: o.card.workUnitId, workUnitName: o.card.workUnitName }
        : {}),
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
          deployedHash:
            receipt.integration && receipt.integration.deployed
              ? receipt.integration.landedSha || ''
              : '',
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

    const visualDefectiveCards = artifact.cards.filter((c) => c && c.status !== 'clean');
    const allDefectiveCards = expandDefectiveWorkUnits(visualDefectiveCards, artifact);
    const defectiveCards = scopeDefectiveCards(allDefectiveCards, opts.cards);
    if (opts.cards && opts.cards.length) {
      log(
        `[agentic-healer] card subset requested (${opts.cards.join(',')}): healing ` +
          `${defectiveCards.length} of ${allDefectiveCards.length} defective card(s).`,
      );
    }
    const defectsBefore = {
      count: defectiveCards.length,
      visualCardCount: new Set(defectiveCards.map((card) => card.id)).size,
      artifactTs: artifact.ts,
      cards: defectiveCards.map((c) => ({
        id: c.id,
        status: c.status,
        defectKinds: c.defectKinds || [],
        ...(c.workUnitId
          ? {
              workUnitId: c.workUnitId,
              workUnitName: c.workUnitName,
              workUnitStatus: c.workUnitStatus,
            }
          : {}),
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
      artifact,
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
    const integrateRepair = opts.integrateRepair || defaultIntegrateRepair;
    const reverify = opts.reverify || defaultReverify;

    // Defects blocked on EVERY rung never enter the loop; they surface as
    // skipped-no-repeat in the receipt (honest, never silently dropped).
    const exhaustedKeys = new Set(plan.exhausted.map((d) => ledger.normDefectKey(d.defect)));
    let pending = plan.perDefect.filter((d) => !exhaustedKeys.has(ledger.normDefectKey(d.defect)));
    const outcomesByDefect = new Map();
    const sessions = [];
    const integrations = [];
    const tacticsTried = [];
    let lastSession = null;
    let lastVerification = null;
    let usedTactic = plan.tactic;
    // True only when the loop stopped because the REMAINING wall clock could
    // not fund an honest session (fair-split semantics, 2026-07-18), never
    // merely because one rung's watchdog killed that rung's own slice.
    let budgetExhaustedBreak = false;
    const wallReasons = [];

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
      // every remaining minute. Neither executor may starve the other by
      // consuming the entire night.
      const remainingRungs = Math.max(1, ladder.length - rungIndex);
      const sessionBudgetMs = Math.max(MIN_SESSION_MS, Math.floor(availableMs / remainingRungs));

      const attemptMemoryByDefect = sameNightAttemptMemory({
        date,
        targets: viable,
        tacticRows: readTacticRows(ledgerOpts),
        dataDir: dataDirPath,
      });
      const promptEnvelope = buildPromptEnvelope({
        date,
        targets: viable,
        dataDirPath,
        attemptMemoryByDefect,
      });
      const envelopeHash = recordPromptEnvelope({
        envelope: promptEnvelope,
        runId,
        tactic,
        dataDir: dataDirPath,
        now: now(),
      });
      const prompt = buildMissionPrompt({
        date,
        targets: viable,
        repoRoot,
        dataDirPath,
        budgetMinutes: Math.round(sessionBudgetMs / 60000),
        worktree,
        attemptMemoryByDefect,
        envelope: promptEnvelope,
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
        coordinatorRoot: process.env.SECONDBRAIN_CONTROLLER_ROOT || '/opt/secondbrain',
        protectedRoots: [
          repoRoot,
          dataDirPath,
          '/opt/secondbrain-shared',
          '/opt/secondbrain-releases',
        ],
        onStream: opts.onStream,
      });
      session = { ...session, tactic, promptEnvelopeHash: envelopeHash };
      sessions.push(session);
      lastSession = session;
      usedTactic = tactic;
      tacticsTried.push(tactic);

      const integration = integrateRepair({
        worktree,
        repoRoot,
        runId,
        session,
      });
      integrations.push(integration);
      session.coordinatorIntegration = integration;
      if (integration.ok && integration.landedSha) worktree.baseSha = integration.landedSha;
      if (!integration.ok) {
        session = {
          ...session,
          category: healExecutor.FAULT,
          escalationReason: `coordinator integration failed: ${integration.error || 'ExampleCo'}`,
          coordinatorIntegration: integration,
        };
        sessions[sessions.length - 1] = session;
        lastSession = session;
      }

      // RAIL 3: independent live re-verification after coordinator integration.
      // A worker never refreshes or grades its own output.
      const verifyBudget = Math.max(60_000, Math.min(VERIFY_RESERVE_MS, deadlineMs - now()));
      const verification = integration.ok
        ? reverify({
            date,
            repoRoot,
            dataDirPath,
            timeoutMs: verifyBudget,
            targets: viable.map((target) => ({ ...target, tactic })),
            runtimeRoot: process.env.SECONDBRAIN_CONTROLLER_ROOT || '',
            expectedDeployedSha: integration.deployed ? integration.landedSha || '' : '',
          })
        : {
            ran: false,
            exitCode: null,
            error: integration.error || 'coordinator integration failed',
            startedMs: now(),
            artifact: null,
            artifactPath: pinnedArtifactPath({ dataDir: dataDirPath }),
            refreshedCardIds: [],
            coordinator: 'card-controller',
            controllerReceiptMatched: false,
            deployedReleaseSha: '',
          };
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
        const defectAttempt = sessionAttemptForDefect(session, o);
        appendTacticRow(
          {
            schemaVersion: PROMPT_SAFE_ATTEMPT_SCHEMA,
            source: PROMPT_SAFE_ATTEMPT_SOURCE,
            ts: new Date(now()).toISOString(),
            date,
            defect: o.defect,
            tactic,
            tacticKey: ledger.tacticKey(tactic),
            inputHash: o.inputHash,
            outcome: tacticRowOutcome(o.outcome, session),
            hypothesis: defectAttempt.hypothesis,
            action: defectAttempt.action,
            result: defectAttempt.result,
            liveOutcome: String(o.outcome || '').slice(0, 120),
            whyNotClosed: o.outcome === 'cleared' ? '' : String(o.reason || '').slice(0, 300),
            reason: String(o.reason || session.escalationReason || '').slice(0, 300),
            promptSafeAttempt: {
              tactic: safeAttemptText(tactic, 120),
              hypothesis: defectAttempt.hypothesis,
              action: defectAttempt.action,
              result: integration.ok
                ? defectAttempt.result
                : safeAttemptText('integration failed', 120),
              liveOutcome: safeAttemptText(o.outcome || '', 120),
              whyNotClosed: safeAttemptText(
                o.outcome === 'cleared'
                  ? ''
                  : defectAttempt.whyNotClosed || o.reason || integration.error || '',
                300,
              ),
            },
            promptEnvelopeHash: session.promptEnvelopeHash || '',
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
      integration: integrations[integrations.length - 1] || null,
      integrations,
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
    else if (a === '--cards' || a === '--only')
      opts.cards = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return opts;
}

// Scope the healer to a subset of cards (ExampleCo 2026-07-20): a single, possibly
// overloaded, box should not be asked to heal the whole board at once. An empty
// or absent subset means "all defective cards" (the prior whole-board default).
function scopeDefectiveCards(defectiveCards, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return defectiveCards;
  const only = new Set(cards.map(String));
  return (defectiveCards || []).filter((c) => c && only.has(String(c.id)));
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
    const allDefective =
      artifact && artifact.cards ? artifact.cards.filter((c) => c.status !== 'clean') : [];
    const defective = scopeDefectiveCards(allDefective, opts.cards);
    const scopeNote =
      opts.cards && opts.cards.length
        ? ` [subset ${opts.cards.join(',')}: ${defective.length} of ${allDefective.length}]`
        : '';
    process.stdout.write(
      `[agentic-healer] DRY-RUN: would heal ${defective.length} defective card(s)${scopeNote} ` +
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
  promptEnvelopesPath,
  readTacticRows,
  appendTacticRow,
  tacticAlreadyFailed,
  tacticRowOutcome,
  sameNightAttemptMemory,
  promptSafeAttemptFromTacticRow,
  sessionAttemptForDefect,
  exactDefectEvidence,
  defectInputHash,
  defectKeyForCard,
  expandDefectiveWorkUnits,
  planTactics,
  classifyHumanGate,
  defectEvidenceText,
  triageDefects,
  readEscalationRows,
  appendEscalationRow,
  briefingLockHeld,
  ensureSessionWorktree,
  validatePromptEnvelope,
  buildPromptEnvelope,
  promptEnvelopeHash,
  recordPromptEnvelope,
  buildMissionPrompt,
  buildFullSessionClaudeArgs,
  buildFullSessionCodexArgs,
  defaultSpawnSession,
  coordinatorDeploymentRequired,
  defaultIntegrateRepair,
  defaultReverify,
  probeOriginMaster,
  outcomesFromVerification,
  buildReceipt,
  feedSelfHealHealth,
  runAgenticHealer,
  parseCliArgs,
  scopeDefectiveCards,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[agentic-healer] fatal: ${String((e && e.stack) || e)}\n`);
    process.exit(1);
  });
}
