#!/usr/bin/env node
/**
 * Drift-lint for the Self-heal core component.
 *
 * Keeps dev-plans/core/self-heal.md equal to the code: every load-bearing
 * entry point the doc names must still exist, and the design invariants the
 * doc asserts (worktree isolation, the worker-guard boundary, the
 * per-defect repair ledger, the no-repeat-tactic gate, and the run-mode
 * announce guard) must still hold. If the code moves and the doc does not,
 * this fails loud so the doc gets fixed instead of rotting into fiction.
 *
 * Scoped per review: the orchestrator/scheduler/isolation/ledger/executor
 * entry points and their stated invariants -- NOT every probe/heal function
 * in health-self-heal.js or every channel def in channel-health-monitor.js
 * (those are hand-maintained lists the doc explicitly says are NOT yet the
 * load-bearing source of truth; verify:heal-ladder-refs already covers
 * _domains.json manifest-vs-code drift and is not duplicated here).
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-self-heal-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/self-heal.md';
const LESSONS = 'dev-plans/core/self-heal.LESSONS.md';

// Load-bearing entry points the doc names in "6. Key files". Each must exist
// (these are git-tracked source, not runtime artifacts).
const KEY_FILES = [
  'scripts/overnight-self-heal-orchestrator.js',
  'scripts/lib/heal-scheduler.js',
  'scripts/lib/isolated-heal-session.js',
  'scripts/lib/self-heal-worker-guard.js',
  'scripts/claude-hooks/self-heal-worker-guard.mjs',
  'scripts/lib/codex-worktree.js',
  'scripts/health-self-heal.js',
  'scripts/lib/channel-health-monitor.js',
  'scripts/lib/heal-executor.js',
  'dev-plans/_domains.json',
  'scripts/overnight-briefing-orchestrator.js',
  'scripts/self-heal/verdict.js',
  'scripts/self-heal/attempt-ledger.js',
  'scripts/self-heal/heal-decision.js',
  'scripts/self-heal/heal-loop.js',
  'scripts/lib/briefing-clean-contract.js',
  'scripts/self-heal/briefing-repair-ledger.js',
  'scripts/lib/executor-health-row.js',
  'scripts/lib/briefing-heal-run-graph.json',
  'scripts/lib/briefing-heal-run-graph.js',
  'scripts/lib/heal-error-budget.js',
  // ITEM W2a (C1 mechanical-first heal tier): the defect-class -> mechanical-
  // action registry + the 3-day recurrence masking guard.
  'scripts/self-heal/mechanical-runbook.js',
  'scripts/self-heal/mechanical-recurrence.js',
  'scripts/self-heal/self-heal-health-card.js',
];

// Runtime artifacts: present on a live box / generated per run, not asserted
// as git-tracked source -> warn if absent, never fail the lint.
const RUNTIME_FILES = [
  ['data/agent/overnight-self-heal-runs.jsonl', 'per-run session-complete + self-heal-health log'],
];

// [file, token, why] -- the token must be present (an invariant the doc
// relies on). Kept frugal: only symbols whose silent loss would break a
// claim the doc makes about the design, not an inventory of every export.
const MUST_CONTAIN = [
  [
    'scripts/overnight-self-heal-orchestrator.js',
    'function parseRunMode',
    'doc 4: run modes (--parallel/--midday/--observe) are parsed, not hardcoded to legacy sequential/overnight/act',
  ],
  [
    'scripts/overnight-self-heal-orchestrator.js',
    'function announceMode',
    'doc 4: the fix-the-fix guard -- a run must announce its real mode on startup so it can never be mislabeled',
  ],
  [
    'scripts/lib/heal-scheduler.js',
    'function runHeals',
    'doc 4/6: bounded-concurrency fan-out is the parallel engine phase-2 dispatches through',
  ],
  [
    'scripts/lib/heal-scheduler.js',
    'function createSerializer',
    'doc 4/6: the git-landing mutex that keeps concurrent heals from colliding on the shared checkout',
  ],
  [
    'scripts/lib/isolated-heal-session.js',
    'origin/master',
    'doc 4/6: each parallel session runs in its own worktree cut from origin/master, not the shared checkout',
  ],
  [
    'scripts/lib/self-heal-worker-guard.js',
    'function evaluateSelfHealWorkerTool',
    'doc worker power boundary: the minimal Bash/Write guard loaded even while normal hooks are disabled',
  ],
  [
    'scripts/overnight-briefing-orchestrator.js',
    'function finalizeCard',
    'doc 4 (PR3): per-card QC -> heal -> re-QC -> publish-only-when-clean-or-honest-hard-block gate',
  ],
  [
    'scripts/self-heal/briefing-repair-ledger.js',
    'function tacticAlreadyFailed',
    'doc 4d (Phase 4a): no-repeat-tactic gate -- the same tactic + same input hash must not be re-dispatched',
  ],
  [
    'scripts/self-heal/briefing-repair-ledger.js',
    'function blockersFromLedger',
    'doc 4d (Phase 4a): the Blockers card is generated from OPEN ledger rows, not a hand-authored list',
  ],
  [
    'scripts/lib/briefing-heal-run-graph.js',
    'function assertModeEquivalence',
    'doc 4d (Phase 4a): mode-equivalence preflight -- overnight and attended paths must read the same run graph before any spawn',
  ],
  [
    'scripts/self-heal/mechanical-runbook.js',
    'function resolveMechanicalAction',
    'doc 4e (ITEM W2a): the defect-class -> mechanical-action registry, resolved manifest heal entry > _domains.json healLadder first rung > generic class action, BEFORE any LLM worker',
  ],
  [
    'scripts/self-heal/mechanical-runbook.js',
    'same-reader postcondition',
    'doc 4e (ITEM W2a): a mechanical action exit code is never trusted alone -- the card artifact is re-resolved through the same reader path and must show a changed sha or in-window freshness, then pass a card-level re-QC, before counting as cleared',
  ],
  [
    'scripts/overnight-self-heal-orchestrator.js',
    'function tryMechanicalRunbookRepair',
    'doc 4e (ITEM W2a): the orchestrator phase-1 loop runs the mechanical-runbook tier per raw defect BEFORE a blocker survives to the LLM worker wave',
  ],
  [
    'scripts/self-heal/mechanical-recurrence.js',
    'function recurrenceEscalation',
    'doc 4e (ITEM W2a): the masking guard -- a defect mechanically cleared 3 consecutive days still escalates to the interactive SELF-HEAL card session',
  ],
  [
    'scripts/self-heal/self-heal-health-card.js',
    'function maskingGuardDefects',
    'doc 4e (ITEM W2a): the SELF-HEAL card itself surfaces the masking-guard recurrence, not just an orchestrator log row',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary the
// LESSONS file records as removed-for-a-reason). Kept to the one boundary the
// LESSONS file actually documents; see notes for anything deliberately left
// out (no fabricated invariants).
const MUST_NOT_CONTAIN = [
  [
    'scripts/lib/isolated-heal-session.js',
    'pushed: true',
    'LESSONS 2026-06-25/06-26: isolated workers must self-report pushed:false, commit_sha:"" -- the coordinator is the only layer allowed to land and call a live briefing clean',
  ],
];

// Files deleted for a documented reason that must stay deleted. None
// documented in self-heal.LESSONS.md yet (the component has been additive --
// every dated entry describes a new rule or a widened contract, not a
// removed file). Left empty rather than fabricated; revisit if a future
// LESSONS entry documents a deletion.
const MUST_NOT_EXIST = [];

function checkDrift(repoRoot) {
  const failures = [];
  const warnings = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const exists = (rel) => {
    try {
      fs.accessSync(path.join(repoRoot, rel));
      return true;
    } catch {
      return false;
    }
  };

  const docSrc = read(DOC);
  if (docSrc === null) failures.push(`missing core doc: ${DOC}`);

  const lessonsSrc = read(LESSONS);
  if (lessonsSrc === null) {
    // Only a failure if the doc itself claims the LESSONS file is where
    // component lessons live -- otherwise the doc/LESSONS pairing is not
    // yet established and there is nothing to check content-wise.
    if (docSrc && docSrc.includes(LESSONS)) {
      failures.push(`doc names ${LESSONS} as the lessons file, but it is missing`);
    } else {
      warnings.push(`no LESSONS file found at ${LESSONS}; skipping lessons content checks`);
    }
  }

  for (const rel of KEY_FILES) {
    if (!exists(rel)) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const [rel, note] of RUNTIME_FILES) {
    if (!exists(rel))
      warnings.push(`runtime artifact absent (ok pre-first-run): ${rel} -- ${note}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }
  for (const rel of MUST_NOT_EXIST) {
    if (exists(rel))
      failures.push(`file was removed for a documented reason but has returned: ${rel}`);
  }

  // Doc content checks: the load-bearing rules the doc must keep stating so
  // a rewrite cannot silently drop them.
  if (docSrc) {
    if (!/worktree/i.test(docSrc)) {
      failures.push(
        'doc no longer mentions worktree isolation (doc 4/6: parallel heal sessions run worktree-isolated, cut from origin/master)',
      );
    }
    if (!/no-repeat|no repeat|tactic exhausted|NO-REPEAT TACTIC/i.test(docSrc)) {
      failures.push(
        'doc no longer states the no-repeat-tactic gate (doc 4d: same tactic + same input hash must not be re-dispatched)',
      );
    }
    if (!/announceMode|ANNOUNCES its real mode/i.test(docSrc)) {
      failures.push(
        'doc no longer states the run announces its real mode on startup (the fix-the-fix guard)',
      );
    }
    if (!/scoped live card QC/i.test(docSrc)) {
      failures.push(
        'doc no longer states scoped live card QC for one-card healer closure',
      );
    }
  }

  // LESSONS content checks: hard-won lessons that must not be edited away.
  if (lessonsSrc) {
    if (!/false.clear/i.test(lessonsSrc)) {
      failures.push(
        `${LESSONS} no longer records the false-clear lesson (a cleared worker plus unchanged live QC is a self-healer defect, not just "still blocked")`,
      );
    }
    if (!/no-fruit|no.live.reduction/i.test(lessonsSrc)) {
      failures.push(
        `${LESSONS} no longer records the repair-loop judgment-stop lesson (10 no-fruit attempts / 20 no-live-reduction attempts, not infinite optimism)`,
      );
    }
    if (!/worktree/i.test(lessonsSrc)) {
      failures.push(
        `${LESSONS} no longer mentions worktree-isolated landing (the landing-conflict-is-a-healer-defect lesson)`,
      );
    }
    if (!/scoped live card QC|One-card healer closure must stay scoped/i.test(lessonsSrc)) {
      failures.push(`${LESSONS} no longer records the scoped one-card healer closure lesson`);
    }
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: self-heal doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/self-heal.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: self-heal doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  RUNTIME_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
};
