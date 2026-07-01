#!/usr/bin/env node
/**
 * Drift-lint for the Otter Transcript Pipeline core component.
 *
 * Keeps dev-plans/core/otter-transcript-pipeline.md equal to the code: every
 * load-bearing entry point the doc names must still exist, and the design
 * invariants the doc asserts (the gates, the transcript-only ingest) must still
 * hold. If the code moves and the doc does not, this fails loud so the doc gets
 * fixed instead of rotting into fiction.
 *
 * Scoped per review: stage entrypoints, env gates, and the transcript-only
 * invariant -- NOT every generated voiceprint artifact.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-otter-transcript-pipeline-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/otter-transcript-pipeline.md';
const LESSONS = 'dev-plans/core/otter-transcript-pipeline.LESSONS.md';

// Stage entry points the doc names. Each must exist (these are git-tracked).
const STAGE_FILES = [
  'scripts/otter-ingest-watch.js',
  'scripts/lib/voice-fargate-trigger.js',
  'scripts/otter-full-audio-backfill.js',
  'scripts/otter-post-ingest-voice-intelligence.js',
  'scripts/otter-diarized-segment-backfill.js',
  'scripts/otter-wavlm-speaker-resolver.js',
  'scripts/otter-life-relevance-enricher.js',
  'deploy/voice-fargate/taskdef.json',
];

// Runtime artifacts: present on a live box, gitignored in the repo -> warn, never fail.
const RUNTIME_FILES = [
  ['data/life-archive/voice-identity-registry.json', '64 enrolled voiceprints'],
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'scripts/lib/voice-fargate-trigger.js',
    'VOICE_FARGATE_ENABLED',
    'fargate path is gated default-off',
  ],
  ['scripts/otter-full-audio-backfill.js', "'--write'", 'audio download is gated behind --write'],
  [
    'scripts/otter-full-audio-backfill.js',
    'process.env.SECONDBRAIN_DATA_DIR',
    'backfill resolves audio/raw/enriched from SECONDBRAIN_DATA_DIR (the same dir the coverage report counts), not a bare REPO join -- the 2026-07-01 path split',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'full_audio',
    'orchestrator runs the full_audio step',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'diarized',
    'orchestrator runs the diarized step',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary).
const MUST_NOT_CONTAIN = [
  ['scripts/otter-ingest-watch.js', 'audio-full', 'ingest is transcript-only by design'],
];

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
  if (read(LESSONS) === null) failures.push(`missing LESSONS: ${LESSONS}`);

  for (const rel of STAGE_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const [rel, note] of RUNTIME_FILES) {
    if (read(rel) === null)
      warnings.push(`runtime artifact absent (ok in git, must exist live): ${rel} -- ${note}`);
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

  // The doc must not silently drop the correction that action items are Gmail, not Otter.
  const doc = read(DOC) || '';
  if (doc && !/NOT from Otter|Gmail-derived|not a wired output/i.test(doc)) {
    failures.push('doc no longer states that action items are Gmail-derived, not an Otter stage');
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(
      `\nDRIFT: otter-transcript-pipeline doc is out of sync with code (${failures.length}):`,
    );
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      '\nFix the code or update dev-plans/core/otter-transcript-pipeline.md, then re-run.',
    );
    process.exit(1);
  }
  console.log('OK: otter-transcript-pipeline doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = { checkDrift, STAGE_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN };
