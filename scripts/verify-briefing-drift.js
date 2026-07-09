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
// The doc's own LESSONS section (5) names the component LESSONS file as
// scheduled-tasks/daily-briefing/LESSONS.md, NOT a co-located
// dev-plans/core/briefing.LESSONS.md (unlike some other core components).
// We check whichever the doc currently claims, so a future move to the
// dev-plans/core/*.LESSONS.md convention is not itself flagged as drift.
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
  'scripts/verify-shared-checkout-clean.js',
  'scripts/collect-daily-token-usage.js',
  'scripts/collect-claude-plan-usage.js',
  'scripts/collect-codex-token-usage.js',
  'scripts/verify-dashboard-cards-live.js',
  'scripts/verify-briefing-cards-live.js',
  'scripts/refresh-card.js',
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
    'single-card refresh pre-write gate must be scoped to the target plus companion labels',
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
      'doc no longer states that briefing, briefing QC, and self-heal are one parent briefing reliability loop',
    );
  }
  if (doc && !/scopedRefreshFailures/.test(doc)) {
    failures.push('doc no longer names scopedRefreshFailures as the refresh-card gate');
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

  // LESSONS content check (only when the fallback LESSONS file is the one in
  // play): it must still describe itself as a self-refining, append-only log,
  // per the doc's "read last 10 entries... append after" contract.
  const fallbackLessons = read(LESSONS_FALLBACK);
  if (fallbackLessons !== null && !/self-refining/i.test(fallbackLessons)) {
    failures.push(`${LESSONS_FALLBACK} no longer describes itself as self-refining`);
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
