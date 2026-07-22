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
  'scripts/otter-speaker-pareto-report.js',
  'scripts/voice-sample-sequence-review-html.js',
  'scripts/voice-confirmation-queue-build.js',
  'scripts/otter-life-relevance-enricher.js',
  'deploy/voice-fargate/taskdef.json',
];

// Runtime artifacts: present on a live box, gitignored in the repo -> warn, never fail.
const RUNTIME_FILES = [
  ['data/life-archive/voice-identity-registry.json', '64 enrolled voiceprints'],
];

const FARGATE_VOICE_STANDARD_ENV = Object.freeze({
  VOICE_SPEAKER_BACKEND: 'ecapa',
  SPEAKER_MATCH_SCORE: '0.56',
  SPEAKER_MATCH_MARGIN: '0.06',
});

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
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    "SPEAKER_MATCH_SCORE: process.env.SPEAKER_MATCH_SCORE || '0.56'",
    'live post-ingest voice matching defaults to the calibrated 0.56 acoustic threshold',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    'VOICE_TASK_STANDARD_ENV',
    'Fargate voice launches use one pinned acoustic standard object instead of inheriting a stale image default',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'This page is voice-only',
    'voice review clip membership is acoustic, not text/context alias expansion',
  ],
  [
    'scripts/otter-speaker-pareto-report.js',
    'speaker-pareto-latest.json',
    'Pareto report writes the recurring acoustic voice rows consumed by the review surface',
  ],
  [
    'scripts/otter-speaker-pareto-report.js',
    'voice_cluster_ids: row.voice_cluster_ids || []',
    'Pareto rows carry their member acoustic speaker clusters for review expansion',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'speaker-pareto-latest.json',
    'voice review can resolve a Pareto acoustic arc to its member acoustic ids',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'row?.voice_cluster_ids',
    'voice review expands Pareto arcs only through acoustic member ids',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'briefing-voice-queue-latest.json',
    'voice review can rebuild links emitted by the current briefing ExampleCo-voice queue',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'recluster-latest.json',
    'voice review resolves recluster-backed ExampleCo_voice_ecapa ids to member probe clips',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'targetIsAcousticExampleCo',
    'ExampleCo_voice_ecapa review expansion matches direct recluster ids instead of leaking sibling clusters through shared member aliases',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'distinct_calls_found',
    'recurring ExampleCo review can prove consistency across multiple calls',
  ],
  [
    'ec2-server.js',
    'const matchedPeople = actionPerson;',
    'Pareto fallback must not fuzzy-select people files from heard-name/context artifacts',
  ],
  [
    'ec2-server.js',
    'function concretePeopleFileSuggestionFromHypothesis',
    'recluster modal suggestions pass through the concrete people-file gate',
  ],
  [
    'ec2-server.js',
    'ambiguous|no_people_file_match|low_margin|needs_ExampleCo|person_guess|unconfirmed|strictly_rejected',
    'concrete people-file suggestion gate rejects ambiguous or low-margin identity guesses',
  ],
  [
    'ec2-server.js',
    '(?:people_file_match|confirmed|strict)',
    'concrete people-file suggestion gate uses bounded non-transcript positive evidence tokens',
  ],
  [
    'ec2-server.js',
    'hypothesis.is_provisional',
    'provisional transcript clues never preselect a people file',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'otter-speaker-intelligence-latest.json',
    'voice confirmation queue sources recurring ExampleCo acoustic voices from fresh speaker intelligence',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'recurring_unresolved_acoustic_voice',
    'recurring acoustic ExampleCos are surfaced as their own review lane by default',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'non_speech_audio_artifact',
    'non-speech acoustic artifacts are suppressed from ExampleCo review queue',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary).
const MUST_NOT_CONTAIN = [
  ['scripts/otter-ingest-watch.js', 'audio-full', 'ingest is transcript-only by design'],
];

function jsObjectValue(src, name) {
  const re = new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`);
  return src.match(re)?.[1] || null;
}

function taskdefEnvironment(src) {
  try {
    const parsed = JSON.parse(src);
    const containers = parsed.containerDefinitions || [parsed];
    const voice = containers.find((container) => container.name === 'voice') || containers[0] || {};
    return Object.fromEntries((voice.environment || parsed.environment || []).map((item) => [item.name, item.value]));
  } catch (err) {
    return { __parse_error: err.message };
  }
}

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

  const triggerSrc = read('scripts/lib/voice-fargate-trigger.js');
  const taskdefSrc = read('deploy/voice-fargate/taskdef.json');
  if (triggerSrc && taskdefSrc) {
    const taskEnv = taskdefEnvironment(taskdefSrc);
    if (taskEnv.__parse_error) {
      failures.push(`invalid deploy/voice-fargate/taskdef.json: ${taskEnv.__parse_error}`);
    }
    for (const [name, expected] of Object.entries(FARGATE_VOICE_STANDARD_ENV)) {
      const triggerValue = jsObjectValue(triggerSrc, name);
      const taskValue = taskEnv[name] || null;
      if (triggerValue !== expected) {
        failures.push(
          `Fargate launch standard drifted: scripts/lib/voice-fargate-trigger.js ${name}=${triggerValue || '<missing>'}, expected ${expected}`,
        );
      }
      if (taskValue !== expected) {
        failures.push(
          `Fargate task definition standard drifted: deploy/voice-fargate/taskdef.json ${name}=${taskValue || '<missing>'}, expected ${expected}`,
        );
      }
      if (triggerValue && taskValue && triggerValue !== taskValue) {
        failures.push(
          `Fargate launch/taskdef mismatch: ${name} launch=${triggerValue}, taskdef=${taskValue}`,
        );
      }
    }
  }

  // The doc must not silently drop the correction that action items are Gmail, not Otter.
  const doc = read(DOC) || '';
  if (doc && !/NOT from Otter|Gmail-derived|not a wired output/i.test(doc)) {
    failures.push('doc no longer states that action items are Gmail-derived, not an Otter stage');
  }
  if (
    doc &&
    !/SPEAKER_MATCH_SCORE=0\.56|voice-only review page|distinct calls|voice_cluster_ids|briefing-voice-queue-latest\.json|recluster-latest\.json/i.test(
      doc,
    )
  ) {
    failures.push('doc no longer states the voice-only review, Pareto/recluster acoustic expansion, and 0.56 acoustic matching standard');
  }
  if (
    doc
    && !/voice-confirmation-queue-build\.js|otter-speaker-intelligence-latest\.json|non_speech_audio_artifact/i.test(doc)
  ) {
    failures.push('doc no longer states the fresh speaker-intelligence queue source and non-speech suppression standard');
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
