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
  'scripts/card-controller.js',
  'scripts/lib/briefing-card-controller.js',
  'scripts/lib/healer-deploy-executor.js',
  'scripts/lib/healer-deploy-coordinator.js',
  'scripts/lib/atomic-release-transaction.js',
  'scripts/agentic-healer-driver.js',
  'scripts/ec2-morning-briefing-run.sh',
  // ITEM W2a (C1 mechanical-first heal tier): the defect-class -> mechanical-
  // action registry + the 3-day recurrence masking guard.
  'scripts/self-heal/mechanical-runbook.js',
  'scripts/self-heal/mechanical-recurrence.js',
  'scripts/self-heal/self-heal-health-card.js',
  // Section 4h (structured lesson capture, 2026-07-12 evening): the
  // defect-to-lesson-to-hardening loop.
  'scripts/self-heal/card-blocker-lessons.js',
  'scripts/self-heal/hardening-backlog-sync.js',
  'scripts/self-heal/card-blocker-lessons-rollup.js',
  'scripts/self-heal/card-blocker-lessons-fallback-capture.js',
];

// Runtime artifacts: present on a live box / generated per run, not asserted
// as git-tracked source -> warn if absent, never fail the lint.
const RUNTIME_FILES = [
  [
    'data/agent/overnight-self-heal-runs.jsonl',
    'frozen pre-split legacy log (per-run session-complete + self-heal-health rows written before the fix-round split)',
  ],
  // PACKET C (item 2, 2026-09-01): overnight-agentic-healer-runs.jsonl split
  // into a per-briefing-date directory (scripts/lib/dated-jsonl-ledger.js).
  [
    'data/agent/overnight-agentic-healer-runs',
    'per-briefing-date agentic healer receipts (dated-jsonl-ledger split)',
  ],
  // PACKET C (item 2, fix round 2026-09-01): overnight-self-heal-runs.jsonl
  // split into a per-briefing-date directory the same way.
  [
    'data/agent/overnight-self-heal-runs',
    'per-briefing-date self-heal run log (dated-jsonl-ledger split)',
  ],
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
  [
    'scripts/self-heal/card-blocker-lessons.js',
    'function recordFromAgenticHealerReceipt',
    'doc 4h: every card still blocked at the end of a run writes a durable lesson row (data/agent/card-blocker-lessons.jsonl)',
  ],
  [
    'scripts/self-heal/card-blocker-lessons.js',
    'function findRecurringDefects',
    'doc 4h: same card+defectKind on 2+ distinct dates in 14 days is recurring -- the hardening-backlog trigger',
  ],
  [
    'scripts/self-heal/hardening-backlog-sync.js',
    'function syncHardeningBacklog',
    'doc 4h: recurring lessons become a scored, idempotent FEATURE BACKLOG entry (category hardening), never ambient pain',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'cardBlockerLessons.recordFromAgenticHealerReceipt',
    'doc 4h: feedSelfHealHealth is the single chokepoint that fires lesson capture on every morning/healer run',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'createCrossProcessHealerDeployExecutor',
    'independent controllers share one durable deploy and per-waiter proof coordinator',
  ],
  [
    'scripts/lib/healer-deploy-coordinator.js',
    'coordinator.lock',
    'one cross-process lease elects each compatible batch deploy owner',
  ],
  [
    'scripts/lib/atomic-release-transaction.js',
    'recoverProductionAtomicRelease',
    'crash recovery precedes deployed-batch proof or redeploy classification',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'sameNightAttemptMemory',
    'ExampleCo correction 2026-07-21: the healer receives bounded same-night/same-defect attempts, never prior-night or cross-night lessons',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'Hoisted OUTSIDE the try block',
    'doc 4h (Codex pass 2): artifact is hoisted outside the try block so a mid-run crash can still record a lesson for known-defective cards',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'launchCardHealer',
    'a failed scoped live card QC immediately launches that card own asynchronous healer job',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'agenticWorkerLane',
    'all per-card healer jobs share the bounded judgment pool rather than opening unbounded dev sessions',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'agenticIntegrationLane',
    'per-card healers share one tested-land lane before the deploy/proof executor',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'concurrency: 1',
    'per-card inner concurrency is one so the outer two-job pool is a global exact-defect limit',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'healTheHealerConcurrency.effective',
    'the controller exact-defect pool widens only through the hardware-bounded attended daytime path',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'healerJobsByCard',
    'multiple origins for one sibling regression join one tracked per-card healer promise',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'resultSettled',
    'completed red per-card jobs relaunch instead of accepting a dependent on a finished promise',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'nestedRegressions',
    'new sibling regressions discovered during delegated re-QC enter independent healer jobs',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'withAgenticIntegrationLock',
    'separate agentic driver processes share one integration closure mutex',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'supervisorLockPath',
    'controller delegation is bound to the exact live supervisor lock',
  ],
  [
    'scripts/agentic-healer-driver.js',
    '.owner-token',
    'delegation proves the live same-path supervisor owner token and not merely the lock pathname',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'currentIntegrationAuthority',
    'stale controller authority is rejected before integration and before live reverify',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'directController',
    'direct button and midday controller repair can delegate nested live proof without a wrapper flock',
  ],
  [
    'scripts/ec2-morning-briefing-run.sh',
    'delivery-only checkpoint',
    'the 5:30 process reads and delivers card-owned state without starting repair',
  ],
  [
    'scripts/self-heal/hardening-backlog-sync.js',
    'collision-safe by construction',
    'doc 4h (Codex pass 2): the hardening-backlog id hash covers the full untruncated card+defectKind identity, never just the truncated slug',
  ],
  [
    'scripts/self-heal/card-blocker-lessons-rollup.js',
    'function commitAndPushLessonsDoc',
    'doc 4h (Codex pass 2): briefing.LESSONS.md is git-tracked curated state, so the weekly rollup commits and pushes it, not just a local file write',
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
      failures.push('doc no longer states scoped live card QC for one-card healer closure');
    }
    if (
      !/(?:failed eligible live card QC is a launch event[\s\S]{0,260}own async healer job immediately|failed eligible live QC immediately launches its card healer)/i.test(
        docSrc,
      )
    ) {
      failures.push(
        'doc no longer states that failed live card QC immediately launches an independent asynchronous per-card healer',
      );
    }
    if (!/one active exact-defect worker(?: globally)?/i.test(docSrc)) {
      failures.push(
        'doc no longer bounds the shared per-card healer pool at one exact-defect worker globally',
      );
    }
    if (!/non-overrideable shared pool/i.test(docSrc)) {
      failures.push('doc no longer makes the one-worker controller ceiling non-overrideable');
    }
    // ExampleCo, 2026-09-28: attended daytime runs use the hardware-bounded pool;
    // heal-the-healer additionally sets its count.
    if (
      !/attended daytime runs use the pool below/i.test(docSrc) ||
      !/Supervised daytime `--heal-the-healer`/i.test(docSrc)
    ) {
      failures.push('doc no longer states the bounded attended daytime worker pool');
    }
    if (
      !/owner(?:-| )token sidecar/i.test(docSrc) ||
      !/supervisor PID\/parent relationship/i.test(docSrc)
    ) {
      failures.push('doc no longer requires live same-path flock ownership proof for delegation');
    }
    if (
      !/(?:originating receipts attach as dependents|dependent originating receipts reconcile)/i.test(
        docSrc,
      )
    ) {
      failures.push(
        'doc no longer requires shared sibling-job dependents to reconcile after descendants settle',
      );
    }
    if (
      !/Authority is revalidated before integration and (?:again before )?live reverify/i.test(
        docSrc,
      ) ||
      !/before tested land and inside coordinator proof/i.test(docSrc)
    ) {
      failures.push('doc no longer revalidates repair authority at both side-effect boundaries');
    }
    if (!/direct button\/midday delegation/i.test(docSrc)) {
      failures.push(
        'doc no longer defines direct-controller delegation for button and midday repair',
      );
    }
    if (
      !/(?:result handler marks a job settled before dependent callbacks|Result-settled jobs are no longer joinable)/i.test(
        docSrc,
      )
    ) {
      failures.push('doc no longer requires completed-red per-card jobs to relaunch');
    }
    if (!/There is no end-of-run or 5:30 healer/i.test(docSrc)) {
      failures.push('doc no longer prohibits end-of-run and 5:30 healer exceptions');
    }
    if (!/5:30 delivery.*never starts card refresh, QC, or healing/i.test(docSrc)) {
      failures.push('doc no longer keeps the 5:30 checkpoint delivery-only');
    }
    if (!/cross-process integration mutex/i.test(docSrc)) {
      failures.push('doc no longer states the cross-process integration closure mutex');
    }
    if (!/reverify-created sibling regressions/i.test(docSrc)) {
      failures.push(
        'doc no longer states that reverify-created sibling regressions become independent jobs',
      );
    }
    if (!/card-blocker-lessons|structured lesson capture/i.test(docSrc)) {
      failures.push(
        'doc no longer states the structured lesson-capture loop (doc 4h: every card still blocked writes a durable lesson row that feeds the next healer run and recurrence into the hardening backlog)',
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
    if (!/eight total cycles|hard maximum of eight/i.test(lessonsSrc)) {
      failures.push(
        `${LESSONS} no longer records the repair-loop judgment-stop lesson (hard maximum of eight total cycles per card or exact metric)`,
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
