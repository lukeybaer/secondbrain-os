#!/usr/bin/env node
/**
 * Drift-lint for the Session Isolation and Mutation Control core component.
 *
 * Keeps dev-plans/core/session-isolation.md equal to the code: every
 * load-bearing file the doc names must still exist, and the design invariants
 * the doc asserts (write-blocked-by-target-path, the audited integration
 * lease gate, LANDED/PARKED/STRAY branch classification, and the mutation
 * surface matrix) must still hold. If the code moves and the doc does not,
 * this fails loud so the doc gets fixed instead of rotting into fiction.
 *
 * Scoped per review: the load-bearing libraries, hooks, and the invariants
 * they encode -- NOT every generated runtime receipt or quarantine artifact.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-session-isolation-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/session-isolation.md';
const LESSONS = 'dev-plans/core/session-isolation.LESSONS.md';

// Load-bearing files the doc names (section 2 "Load-bearing source" and
// section 6 "Key files"). Each must exist (these are git-tracked).
const KEY_FILES = [
  'scripts/lib/shared-tree-guard.js',
  'scripts/claude-hooks/shared-tree-guard.mjs',
  'scripts/lib/shared-tree-write-guard.js',
  'scripts/claude-hooks/shared-tree-write-guard.mjs',
  'scripts/lib/integration-session.js',
  'scripts/integration-session.js',
  'scripts/lib/session-isolation.js',
  'scripts/lib/land-gate.js',
  'scripts/land.js',
  'scripts/git-janitor.js',
  'scripts/lib/memory-write.js',
  'scripts/lib/codex-worktree.js',
  'scripts/lib/mutation-surface-matrix.js',
  'scripts/lib/devops-health.js',
  'scripts/verify-shared-checkout-clean.js',
  'scripts/shared-checkout-quarantine.js',
  'scripts/health-self-heal.js',
  'scripts/manual-briefing-v3.js',
  'scripts/cloud-morning-briefing.js',
  '.claude/settings.json',
  'claude-config/settings.json',
];

// [file, token, why] -- the token must be present (an invariant the doc's
// claims depend on). Every token here was grep/read-verified against the
// real file before being added.
const MUST_CONTAIN = [
  [
    'scripts/lib/shared-tree-write-guard.js',
    'evaluateSharedTreeWrite',
    'the write-blocked-by-target-path function the SessionStart/PreToolUse hook calls; the doc\'s "writes blocked before modification" claim (section 1, item 2) depends on this existing',
  ],
  [
    'scripts/lib/integration-session.js',
    'SB_INTEGRATION_SESSION',
    'the env var gate name the doc calls out by name (section 1, item 3: "SB_INTEGRATION_SESSION=1 is not authority by itself")',
  ],
  [
    'scripts/lib/integration-session.js',
    'validateIntegrationSession',
    'the function that turns the bare env flag into an audited, expiring lock check (owner/reason/pid/TTL); loss of this collapses the lease gate back to a bare bypass flag',
  ],
  [
    'scripts/lib/session-isolation.js',
    'isIsolatedWorktree',
    'the detector that tells a session shared-checkout vs isolated-worktree; the doc\'s whole "no agent may mutate the shared checkout directly" claim rests on this classification existing',
  ],
  [
    'scripts/lib/mutation-surface-matrix.js',
    'validateMutationSurfaceMatrix',
    'the doc\'s section 1 item 6 ("every write-capable runner has a mutation-surface matrix row") is only true while this validator exists to enforce row shape',
  ],
  [
    'scripts/lib/devops-health.js',
    'checkGuardPolicy',
    'the probe that checks repo/user/canonical settings.json for the three hook wirings the doc\'s section 2 last ExampleCoraph requires',
  ],
  [
    'scripts/lib/devops-health.js',
    'session-isolation-guard.mjs',
    'devops-health asserts the SessionStart isolation guard hook is wired; the doc\'s "Every write-capable runner ... regression coverage" claim depends on this wiring check naming the actual hook file',
  ],
  [
    'scripts/git-janitor.js',
    "'parked'",
    'the doc names LANDED/PARKED/STRAY branch classification (section 2, git-janitor.js bullet) as load-bearing; this is the literal category token the classifier and janitor both key off',
  ],
  [
    'scripts/git-janitor.js',
    "'stray'",
    'same LANDED/PARKED/STRAY classification invariant, the second category token',
  ],
  [
    '.gitignore',
    '*-uid-watermark.json',
    'the 2026-06-27 LESSON ("runtime watermarks can re-dirty a clean checkout within seconds") is only fixed while this ignore pattern stays; removing it silently reopens that incident',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary the
// LESSONS file documents as removed-for-a-reason). Kept empty: this
// component's LESSONS are almost all "add a new guard" entries, not "remove
// this pattern" entries, so there is no genuine removed-for-a-reason pattern
// to assert yet. See thinLayers in the review notes -- do not invent one.
const MUST_NOT_CONTAIN = [];

// Files deleted for a documented reason that must stay deleted. None are
// documented in session-isolation.LESSONS.md as of this writing (every entry
// there is "a new guard was added", not "a file was removed"), so this stays
// empty rather than inventing a ban with no LESSONS citation.
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

  if (read(DOC) === null) failures.push(`missing core doc: ${DOC}`);
  const lessonsSrc = read(LESSONS);
  const docSrc = read(DOC) || '';
  if (lessonsSrc === null) {
    // Only a failure if the doc itself promises the LESSONS file exists.
    if (/LESSONS\.md/.test(docSrc)) {
      failures.push(
        `missing LESSONS: ${LESSONS} (the doc references it by name in its "LESSONS" section)`,
      );
    } else {
      warnings.push(`LESSONS file absent and not referenced by the doc: ${LESSONS}`);
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
    if (read(rel) !== null)
      failures.push(`file should stay deleted but exists again: ${rel} (see ${LESSONS})`);
  }

  // The doc's core claim (section 1): the shared checkout is mutation-control,
  // not just branch-cleanliness. If this framing is edited away, the doc has
  // drifted back to the pre-2026-06-27 (incomplete) version of the component.
  if (docSrc && !/mutation control|mutation capability/i.test(docSrc)) {
    failures.push(
      'doc no longer states the mutation-control invariant (section 1: "This component is now about mutation capability control, not only branch cleanliness")',
    );
  }

  // The doc's section 1 item 3 must still name the bare-env-var boundary, not
  // just "an integration lease" in the abstract -- SB_INTEGRATION_SESSION is
  // the literal flag every runner and hook checks.
  if (docSrc && !/SB_INTEGRATION_SESSION/.test(docSrc)) {
    failures.push(
      'doc no longer names SB_INTEGRATION_SESSION as the (insufficient-alone) integration flag',
    );
  }

  // LESSONS content check: the highest-impact recorded lesson (frozen-fleet,
  // 2026-06-15 node_modules junction wipe) must stay recorded so the
  // mechanical prevention it documents (safe-worktree-remove, no junction
  // rm -rf) is never "cleaned up" out of institutional memory.
  if (lessonsSrc && !/frozen-fleet/i.test(lessonsSrc)) {
    failures.push(
      `${LESSONS} no longer records a frozen-fleet-impact lesson (the 2026-06-15 node_modules junction incident); do not edit away the highest-severity lesson`,
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: session-isolation doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(`\nFix the code or update ${DOC}, then re-run.`);
    process.exit(1);
  }
  console.log('OK: session-isolation doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = { checkDrift, KEY_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN, MUST_NOT_EXIST };
