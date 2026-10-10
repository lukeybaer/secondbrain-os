#!/usr/bin/env node
/**
 * Drift-lint for the Briefing core component.
 *
 * Keeps dev-plans/core/briefing.md equal to the code: every load-bearing entry
 * point the doc names must still exist, and the design invariants the doc
 * asserts (the single render gate, the honest-hard-block-never-self-talk
 * publish contract, the Otter card-identity boundary) must still hold. If the
 * code moves and the doc does not, this fails loud so the doc gets fixed
 * instead of rotting into fiction.
 *
 * Scoped per review: the generator/parser/gate trio and the self-feed-break
 * contract named in the doc -- NOT every card parser or every helper symbol.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-briefing-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/briefing.md';
// The unified briefing core doc uses the co-located core-component lessons file.
// The older scheduled-task LESSONS file remains a run log for the daily skill,
// not the core component lesson source.
const LESSONS_FALLBACK = 'scheduled-tasks/daily-briefing/LESSONS.md';
const LESSONS_COLOCATED = 'dev-plans/core/briefing.LESSONS.md';

// Load-bearing files the doc names in its "Key files" section. Each must exist
// (these are git-tracked).
const KEY_FILES = [
  'memory/project_briefing_spec.md',
  'ec2-server.js',
  'scripts/manual-briefing-v3.js',
  'scripts/cloud-morning-briefing.js',
  'scripts/refresh-news-only.js',
  'scripts/lib/briefing-news-reader.js',
  'scripts/refresh-briefing-generated-sections.js',
  'scripts/lib/devops-health.js',
  'scripts/lib/session-cloud-health.js',
  'scripts/lib/session-cloud-plane.js',
  'scripts/verify-shared-checkout-clean.js',
  'scripts/collect-daily-token-usage.js',
  'scripts/collect-claude-plan-usage.js',
  'scripts/collect-codex-token-usage.js',
  'scripts/verify-dashboard-cards-live.js',
  'scripts/verify-briefing-cards-live.js',
  'scripts/refresh-card.js',
  'scripts/card-controller.js',
  'scripts/lib/briefing-card-controller.js',
  'scripts/lib/healer-deploy-executor.js',
  'scripts/lib/healer-deploy-coordinator.js',
  'scripts/lib/atomic-release-transaction.js',
  'scripts/agentic-healer-driver.js',
  'scripts/lib/briefing-source-contracts.js',
  'scripts/ec2-card-controller-run.sh',
  'scripts/ec2-morning-briefing-run.sh',
  'scripts/install-ec2-card-controller-cron.sh',
  'scripts/overnight-self-heal-orchestrator.js',
  'scripts/health-self-heal.js',
  'scripts/overnight-briefing-orchestrator.js',
  'scripts/BRIEFING_BABYSITTER_SKILL.md',
  'scripts/lib/briefing-clean-contract.js',
  'scripts/lib/live-board-truth.js',
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'ec2-server.js',
    'async function sendDailyBriefing()',
    'the 5:30 AM build entry point the doc names as the load-bearing source',
  ],
  ['ec2-server.js', 'function parseNewsBody', 'per-card news parser the doc names'],
  [
    'ec2-server.js',
    'function buildDashboardSyntheticBlockers',
    'per-card blockers parser the doc names',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'function buildRequiredCloudCards',
    'cloud heal/fallback card builder the doc names',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'function cloudHealAllowed',
    'cloud path is gated, not the primary read path, per the doc',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'devops-health-latest.json',
    'cloud path reads the Dev Ops health snapshot because /opt/secondbrain is a file-deployed copy, not the shared git checkout',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'formatSessionCloudHealthRows',
    'System Health renders the exact three cloud session receipt measurements',
  ],
  [
    'scripts/lib/session-cloud-health.js',
    "['transcript_freshness', 'Session transcript freshness']",
    'session transcript freshness is one stable independently rendered measurement',
  ],
  [
    'scripts/manual-briefing-v3.js',
    'async function getLinkedInIntel',
    'PC builder does real LinkedIn draft enrichment per the doc',
  ],
  [
    'scripts/verify-briefing-cards-live.js',
    "require('./verify-dashboard-cards-live.js')",
    're-exports the single render gate rather than duplicating it',
  ],
  [
    'scripts/overnight-briefing-orchestrator.js',
    'DEFAULT_MAX_HEAL_CYCLES',
    'the per-card QC -> heal -> re-QC gate is hard-bounded, never an infinite loop',
  ],
  [
    'scripts/overnight-briefing-orchestrator.js',
    'safeBuildBlockedCardOutput',
    'a card at true exhaustion is published as a guaranteed cardOutputQc-clean hard-block, never an exception',
  ],
  [
    'scripts/refresh-briefing-generated-sections.js',
    'function resolveOffCycleFallback',
    'the self-feed-break fix: off-cycle fallback decisions run through one function, not ad hoc retention',
  ],
  [
    'scripts/refresh-briefing-generated-sections.js',
    'function renderHonestBlockSection',
    'an invalid off-cycle section is replaced with an honest hard-block, never silently retained verbatim',
  ],
  [
    'ec2-server.js',
    'cardDefectBadge',
    'the per-card defect badge (ExampleCo 2026-07-06 shared-paradigm fix) reads its decision from the shared live-board-truth library, not a locally re-derived check',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'function writeDashboardQcArtifact',
    'the canonical live-board artifact writer the doc names as the source every count consumer reads',
  ],
  [
    'scripts/lib/live-board-truth.js',
    'defectiveCardCount',
    'the single accessor for the canonical defect count every consumer must call',
  ],
  [
    'scripts/refresh-card.js',
    'function scopedRefreshFailures',
    'single-card refresh pre-write gate must be scoped to the named target only',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'function runCardController',
    'one controller entrypoint drives scoped card repairs across overnight, midday, and ExampleCo-action modes',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'unrelatedGreenRegressions',
    'a scoped repair must detect any unrelated formerly-green card regression before launching that card own repair loop',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'launchCardHealer',
    'every surviving red card must launch its own asynchronous agentic healer immediately',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'agenticIntegrationLane',
    'parallel card healers must share one serialized land, deploy, and scoped live-reverify closure lane',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'agenticWorkerLane',
    'all card healer jobs launch independently but active dev sessions remain bounded by one shared worker pool',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'concurrency: 1',
    'each admitted per-card driver must run exact defects serially so the global two-worker limit is real',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'healTheHealerConcurrency.effective',
    'the outer exact-defect pool may widen only through the explicit hardware-bounded attended heal-the-healer path',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'healerJobsByCard',
    'origins that discover the same sibling regression must join one per-card job promise',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'resultSettled',
    'a completed red job must relaunch rather than accepting dependents on an already-finished promise',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'nestedRegressions',
    'a sibling broken by healer re-verification must become its own async job and block target clear',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'while (settledHealerJobCount < healerJobs.length)',
    'the controller must drain descendant healer jobs spawned by earlier healer completions',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'receipt.final.nonCleanCards.length > 0',
    'the canonical final live artifact can downgrade an earlier clean summary',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'withAgenticIntegrationLock',
    'tested land must serialize across driver processes before deploy/proof enters the controller executor',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'createCrossProcessHealerDeployExecutor',
    'independent controller processes must share one durable deploy coordinator',
  ],
  [
    'scripts/lib/healer-deploy-coordinator.js',
    'coordinator.lock',
    'one cross-process lease elects the deploy owner for each compatible batch',
  ],
  [
    'scripts/lib/atomic-release-transaction.js',
    'recoverProductionAtomicRelease',
    'coordinator startup must recover an interrupted atomic release before classification',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'controllerCards',
    'delegated live re-verification must return correlated card receipts and sibling regression evidence',
  ],
  [
    'scripts/ec2-card-controller-run.sh',
    'CARD_CONTROLLER_SUPERVISOR_LOCK_PATH="$LOCK"',
    'controller delegation must be bound to the exact outer supervisor lock',
  ],
  [
    'scripts/ec2-card-controller-run.sh',
    'CARD_CONTROLLER_SUPERVISOR_LOCK_TOKEN="$SUPERVISOR_TOKEN"',
    'controller delegation must carry the live wrapper-owned flock token',
  ],
  [
    'scripts/agentic-healer-driver.js',
    '.owner-token',
    'same-path delegation must prove the live supervisor owner token rather than path coincidence',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'currentIntegrationAuthority',
    'controller or lock authority must be revalidated before integration and delegated live proof',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'directController',
    'button and direct midday controllers retain a proven nested reverify delegation mode',
  ],
  [
    'scripts/ec2-morning-briefing-run.sh',
    'delivery-only checkpoint',
    'the 5:30 process must read and deliver card-owned state without starting repair',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'recoverIncompleteTransaction',
    'an interrupted scoped write must be restored before another card is planned',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'hasVerifiedScopedLiveResult',
    'a target write must have fresh scoped live-QC proof or rollback before it can remain published',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'controllerImplementationDigest',
    'a real code repair is material input and may retry once without reviving unchanged spins',
  ],
  [
    'scripts/lib/briefing-card-controller.js',
    'mapWithConcurrency',
    'source producers run through bounded parallel lanes rather than unbounded fan-out',
  ],
  [
    'scripts/lib/briefing-source-contracts.js',
    "VOICE_SKIP_BRIEFING_REFRESH: '1'",
    'Otter source repair may not invoke the broad generated-section briefing writer inside a card controller lane',
  ],
  [
    'scripts/lib/briefing-source-contracts.js',
    'controllerSourceEnv',
    'controller source producers must strip direct paid API credentials before running',
  ],
  [
    'scripts/lib/briefing-source-contracts.js',
    "'scripts/content-heal.js'",
    'content source refresh must be an explicit data producer, not the retired generic scheduled-skill fleet',
  ],
  [
    'scripts/refresh-card.js',
    "gate: 'scoped-card'",
    'refresh-card receipts must identify the scoped card gate, not the retired whole-doc gate',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary from a
// documented lesson). Empty on purpose beyond this one: the 2026-06-20 (PR3b)
// self-feed-break fix is the only removed-for-a-reason pattern the doc
// documents in enough detail to assert mechanically (retaining a section's
// prior body verbatim on an empty-looking off-cycle result). We do not invent
// additional bans that have no corresponding LESSONS/doc citation.
const MUST_NOT_CONTAIN = [];

// Files deleted for a documented reason that must stay deleted. None named in
// the doc or LESSONS for this component today -- left empty rather than
// fabricated.
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

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  // LESSONS: check whichever file the doc currently names. If the doc names
  // neither (a future rewrite), that omission itself is the failure -- a
  // core component doc must always point at its lessons.
  if (doc !== null) {
    const colocated = read(LESSONS_COLOCATED);
    const fallback = read(LESSONS_FALLBACK);
    const docNamesColocated = doc.includes(LESSONS_COLOCATED);
    const docNamesFallback = doc.includes(LESSONS_FALLBACK);
    if (docNamesColocated && colocated === null) {
      failures.push(`doc names ${LESSONS_COLOCATED} as its LESSONS file but it does not exist`);
    } else if (docNamesFallback && fallback === null) {
      failures.push(`doc names ${LESSONS_FALLBACK} as its LESSONS file but it does not exist`);
    } else if (!docNamesColocated && !docNamesFallback) {
      failures.push(
        `doc no longer names a LESSONS file (expected ${LESSONS_COLOCATED} or ${LESSONS_FALLBACK})`,
      );
    }
    if (!docNamesColocated) {
      failures.push(`doc must name ${LESSONS_COLOCATED} as the unified briefing core LESSONS file`);
    }
  }

  for (const rel of KEY_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
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
    if (read(rel) !== null) failures.push(`file should stay deleted but exists: ${rel}`);
  }

  // The doc must still state the single-render-gate contract: exactly one
  // gate script (verify-dashboard-cards-live.js), with the legacy name
  // re-exporting it rather than duplicating it.
  if (doc && !/verify-dashboard-cards-live\.js/.test(doc)) {
    failures.push('doc no longer names verify-dashboard-cards-live.js as the single render gate');
  }
  if (doc && !/verify-briefing-cards-live\.js/.test(doc)) {
    failures.push(
      'doc no longer mentions that verify-briefing-cards-live.js re-exports the render gate',
    );
  }

  // The doc must still state the babysitter contract: fix the self-healer,
  // never the card content.
  if (doc && !/fix the self-healer/i.test(doc)) {
    failures.push(
      'doc no longer states the babysitter rule (fix the self-healer, never the card content)',
    );
  }

  if (doc && !/briefing reliability loop/i.test(doc)) {
    failures.push(
      'doc no longer states that briefing generation, render-QC, targeted refresh, and briefing-specific self-heal are one briefing reliability loop',
    );
  }
  if (doc && !/any task that mentions or touches the briefing/i.test(doc)) {
    failures.push('doc no longer states the mandatory load rule for briefing-touching work');
  }
  if (doc && !/scopedRefreshFailures/.test(doc)) {
    failures.push('doc no longer names scopedRefreshFailures as the refresh-card gate');
  }
  if (doc && !/scripts\/card-controller\.js/.test(doc)) {
    failures.push(
      'doc no longer names scripts/card-controller.js as the unified overnight/midday/button card controller',
    );
  }
  if (
    doc &&
    !/(?:red result launches that card's own asynchronous agentic healer immediately[\s\S]{0,180}sibling cards never wait|Eligible red results queue their exact-defect healer)/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer states that every red card launches its own asynchronous healer immediately while sibling cards continue',
    );
  }
  if (doc && !/non-overrideable shared pool[^.]*ordinary scheduled run one worker/i.test(doc)) {
    failures.push('doc no longer states the global one exact-defect worker limit');
  }
  if (doc && !/bare callers and environment cannot widen it/i.test(doc)) {
    failures.push(
      'doc no longer states that caller or environment cannot raise the one-worker safety cap',
    );
  }
  // ExampleCo, 2026-09-28: operator-authorized attended daytime runs use the
  // hardware pool; heal-the-healer may request 1-20 isolated workers.
  if (
    doc &&
    (!/operator-authorized attended daytime runs the hardware pool/i.test(doc) ||
      !/`--heal-the-healer` 1-20 isolated workers/i.test(doc))
  ) {
    failures.push('doc no longer states the bounded attended daytime worker pool');
  }
  if (
    doc &&
    (!/(?:owner token|owner-token sidecar)/i.test(doc) ||
      !/supervisor PID\/parent (?:proof|relationship)/i.test(doc))
  ) {
    failures.push(
      'doc no longer requires live same-path flock ownership proof for controller delegation',
    );
  }
  if (doc && !/dependent originating receipts/i.test(doc)) {
    failures.push(
      'doc no longer requires shared sibling-job dependents to reconcile after descendants settle',
    );
  }
  if (
    doc &&
    !/revalidated before tested land and inside the deploy coordinator proof callback/i.test(doc)
  ) {
    failures.push(
      'doc no longer requires delegation authority revalidation at both side-effect boundaries',
    );
  }
  if (doc && !/Direct button and midday controllers/i.test(doc)) {
    failures.push('doc no longer defines direct button/midday controller delegation');
  }
  if (doc && !/result-settled job is no longer joinable/i.test(doc)) {
    failures.push('doc no longer requires completed-red per-card jobs to relaunch');
  }
  if (doc && !/land\/deploy integration (?:are|is) serialized/i.test(doc)) {
    failures.push('doc no longer states serialized land/deploy integration');
  }
  if (doc && !/cross-process integration mutex/i.test(doc)) {
    failures.push('doc no longer states the cross-process tested-land mutex');
  }
  if (
    doc &&
    !/cross-process coordinator owns coalesced deploy and exact per-card proof/i.test(doc)
  ) {
    failures.push('doc no longer states that deploy and exact proof belong to the shared executor');
  }
  if (doc && !/reverify[\s\S]{0,180}sibling/i.test(doc)) {
    failures.push(
      'doc no longer states that reverify-created sibling regressions get independent jobs',
    );
  }
  if (doc && !/5:30[\s\S]{0,180}delivery-only/i.test(doc)) {
    failures.push('doc no longer keeps the 5:30 checkpoint delivery-only');
  }
  if (doc && !/never starts refresh, QC, or healing/i.test(doc)) {
    failures.push('doc no longer prohibits delivery-phase card repair');
  }
  if (
    doc &&
    !/(?:Only those two atomic gates and land\/deploy integration are serialized|Only atomic gates, live writes, and tested land\/deploy integration serialize)/i.test(doc)
  ) {
    failures.push(
      'doc no longer limits card publication serialization to Gate A, Gate B, and land/deploy integration',
    );
  }
  if (
    doc &&
    !/Only atomic live writes and tested land use the cross-process integration mutex/i.test(doc)
  ) {
    failures.push(
      'doc no longer limits integration serialization to atomic live writes and tested land',
    );
  }
  if (
    doc &&
    !/Gate-A-started crash resumes from current lineage[\s\S]{0,180}Recovery never blind-restores board-wide snapshots/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer states fenced per-generation crash recovery without blind shared restores',
    );
  }

  // The doc must still state the Otter card-identity boundary: the call-history
  // surface extends otter_speaker_pareto and must not merge with
  // voice_confirmation.
  if (doc && !/otter_speaker_pareto/.test(doc)) {
    failures.push('doc no longer names otter_speaker_pareto as the Otter call-history card');
  }
  if (doc && !/voice_confirmation/.test(doc)) {
    failures.push('doc no longer states the boundary with voice_confirmation');
  }

  const coreLessons = read(LESSONS_COLOCATED);
  if (coreLessons !== null && !/self-refining/i.test(coreLessons)) {
    failures.push(`${LESSONS_COLOCATED} no longer describes itself as self-refining`);
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: briefing doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/briefing.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: briefing doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
  DOC,
  LESSONS_FALLBACK,
  LESSONS_COLOCATED,
};
