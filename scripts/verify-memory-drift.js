#!/usr/bin/env node
/**
 * Drift-lint for the Memory core component (Amy's durable, git-tracked,
 * 3-tier written memory: MEMORY.md pointers, Tier 2 topic files, Tier 3
 * archive).
 *
 * Keeps dev-plans/core/memory.md equal to the code: every load-bearing file
 * the doc names must still exist, and the design invariants the doc asserts
 * (the privacy backstop fires before any write, the Graphiti cascade rides
 * the same write path, the Tier-1 byte cap, the write-path canonical
 * function) must still hold. If the code moves and the doc does not, this
 * fails loud so the doc gets fixed instead of rotting into fiction.
 *
 * Scoped per review: the flat-file store's load-bearing wiring -- NOT the
 * Graphiti graph itself (graphiti.md owns that) and NOT per-skill LESSONS
 * (skill-management.md owns that).
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-memory-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/memory.md';
const LESSONS = 'dev-plans/core/memory.LESSONS.md';

// Load-bearing files the doc names in "Key files". Each must exist
// (git-tracked, not runtime-only).
const KEY_FILES = [
  'memory/MEMORY.md',
  'src/main/memory-index.ts',
  'scripts/claude-hooks/session-start-inject.sh',
  'scripts/claude-hooks/learn-and-usage.js',
  'scripts/claude-peer-review.js',
  'scripts/codex-peer-review.js',
  'memory/archive',
  'scripts/__tests__/memory-md-size.test.js',
  'scripts/__tests__/memory-self-heal-pointer.test.js',
  'src/main/__tests__/learn-hook-canonical-workflow.test.ts',
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'src/main/memory-index.ts',
    'export function upsertMemory',
    'the doc names upsertMemory as the Tier 2 write path',
  ],
  [
    'src/main/memory-index.ts',
    'function assertNoForbiddenPeople',
    'the privacy guard the doc says throws before any write must still exist',
  ],
  [
    'src/main/memory-index.ts',
    'assertNoForbiddenPeople(topic, content)',
    'upsertMemory must call the privacy guard before writing, not just define it',
  ],
  [
    'src/main/memory-index.ts',
    'graphitiAddEpisode',
    'the doc says every Tier 2 write cascades into Graphiti in the same transaction',
  ],
  [
    'src/main/memory-index.ts',
    'export function runNightlyDecay',
    'the doc names runNightlyDecay as the mechanism that ages unused entries down',
  ],
  [
    'scripts/__tests__/memory-md-size.test.js',
    '23000',
    'the doc says Tier 1 MEMORY.md is hard-capped at 23000 bytes',
  ],
  [
    'scripts/claude-hooks/session-start-inject.sh',
    'MEMORY.md',
    'the doc says this hook auto-injects Tier 1 (MEMORY.md) every session',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary).
// No removed-for-a-reason pattern is documented yet in memory.LESSONS.md
// (the file does not exist as of this writing -- see checkDrift below).
// Leaving this empty rather than inventing a ban: a fabricated
// MUST_NOT_CONTAIN entry would create false drift with no corresponding
// lesson to point to.
const MUST_NOT_CONTAIN = [];

// Files removed for a documented reason that must stay deleted. None
// documented yet for this component (see MUST_NOT_CONTAIN comment above).
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
      fs.statSync(path.join(repoRoot, rel));
      return true;
    } catch {
      return false;
    }
  };

  if (read(DOC) === null) failures.push(`missing core doc: ${DOC}`);

  const doc = read(DOC) || '';
  const lessonsExists = exists(LESSONS);
  // The doc itself says to create memory.LESSONS.md "on the first lesson".
  // As long as the doc still frames LESSONS as not-yet-created, a missing
  // LESSONS file is not drift. It only becomes drift if the doc references
  // the path while no longer admitting the file has not been created yet
  // (i.e. it now claims a LESSONS file that in fact does not exist).
  if (!lessonsExists && doc && !/LESSONS\.md`? on the first lesson/i.test(doc)) {
    if (/dev-plans\/core\/memory\.LESSONS\.md/.test(doc)) {
      failures.push(
        `doc references ${LESSONS} as if it exists, but it is missing -- create it or fix the doc`,
      );
    }
  }

  for (const rel of KEY_FILES) {
    if (!exists(rel)) failures.push(`missing load-bearing file: ${rel}`);
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

  // The doc must still state the privacy backstop is mechanical (throws
  // before write), not just a memory-file convention. Losing this line is
  // how a "no ex-wife tracking" bypass would silently ship.
  if (doc && !/privacy guard[\s\S]{0,80}throws before any write|throws before any write/i.test(doc)) {
    failures.push(
      'doc no longer states the privacy guard throws before any write (mechanical backstop, not a convention)',
    );
  }

  // The doc must still state MEMORY.md is an index, not a container --
  // the standing anti-pattern this component exists to prevent.
  if (doc && !/INDEX, not a container/i.test(doc)) {
    failures.push('doc no longer states MEMORY.md is an INDEX, not a container');
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: memory doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/memory.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: memory doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
  DOC,
  LESSONS,
};
