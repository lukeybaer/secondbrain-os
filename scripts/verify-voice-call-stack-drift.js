#!/usr/bin/env node
/**
 * Drift-lint for the Voice / Call Stack core component.
 *
 * Keeps dev-plans/core/voice-call-stack.md equal to the code: every load-bearing
 * entry point the doc names must still exist, the design invariants the doc
 * asserts must still hold, and the hard-won 2026-07-01 boundary (news is
 * MODEL-spoken; the server never classifies transcript text into skip/next) must
 * not silently regress. If the code moves and the doc does not, this fails loud
 * so the doc gets fixed instead of rotting into fiction.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-voice-call-stack-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/voice-call-stack.md';
const LESSONS = 'dev-plans/core/voice-call-stack.LESSONS.md';

// Load-bearing files the doc's "Key files" section names. Each must exist.
const KEY_FILES = [
  'ec2-server.js',
  'scripts/vapi-end-of-call.js',
  'scripts/OUTBOUND_CALL_SKILL.md',
  'scripts/lib/redial-guard.js',
  'scripts/lib/vapi-tool-contract.js',
  'scripts/lib/briefing-news-reader.js',
  'scripts/lib/news-reader-model-playback.js',
  'scripts/lib/dispatch-delivery.js',
  'scripts/push-amy-vapi-config.js',
  'memory/reference_voice_stack_landscape.md',
];

// [file, token, why] -- the token must be PRESENT (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'ec2-server.js',
    "urlPath === '/vapi/webhook'",
    'the single load-bearing webhook (doc section 2)',
  ],
  [
    'ec2-server.js',
    'buildCallerSystemPromptSection',
    'inbound caller-aware prompt seam (doc section 3)',
  ],
  [
    'ec2-server.js',
    'prepareNewsReaderToolCall',
    'news navigation is deduped server-side, not classified (2026-07-01)',
  ],
  [
    'ec2-server.js',
    'handleNewsReaderPlaybackMessage',
    'server observes model speech boundaries for auto-continue, does not classify transcript',
  ],
  ['scripts/lib/redial-guard.js', 'assertNoRecentCall', 'outbound redial guard exists'],
  [
    'scripts/lib/news-reader-model-playback.js',
    'AUTO_CONTINUE',
    'clean article endings inject a hidden auto-continue model prompt (auto-play)',
  ],
  [
    'scripts/lib/news-reader-model-playback.js',
    'prepareNewsReaderToolCall',
    'idempotency gate: one advance per user turn or per auto-continue token (no storm)',
  ],
  ['scripts/lib/briefing-news-reader.js', 'handleBriefingNewsReader', 'news cursor engine exists'],
];

// [file, token, why] -- the token must be ABSENT (a design boundary).
const MUST_NOT_CONTAIN = [
  [
    'ec2-server.js',
    'classifyNewsReaderControl',
    'the server transcript classifier was the skip-storm source; news control is model-driven now (2026-07-01)',
  ],
  [
    'ec2-server.js',
    'handleNewsReaderControlMessage',
    'the server-owned news control handler was removed; do not reintroduce it (2026-07-01)',
  ],
];

// Files that must STAY DELETED. Reintroducing them is drift back toward the
// server-owned design that broke interruption and stormed (2026-07-01 lesson).
const MUST_NOT_EXIST = [
  ['scripts/lib/vapi-news-control.js', 'the removed server-side skip/next transcript classifier'],
  ['scripts/lib/news-reader-playback.js', 'the removed server-owned news playback state machine'],
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
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  if (read(DOC) === null) failures.push(`missing core doc: ${DOC}`);
  if (read(LESSONS) === null) failures.push(`missing LESSONS: ${LESSONS}`);

  for (const rel of KEY_FILES) {
    if (!exists(rel)) failures.push(`missing load-bearing file the doc names: ${rel}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src !== null && src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }
  for (const [rel, why] of MUST_NOT_EXIST) {
    if (exists(rel))
      failures.push(
        `file reappeared: ${rel} (${why}) -- update the doc if this revival is intentional`,
      );
  }

  // The doc and LESSONS must not silently drop the 2026-07-01 correction that
  // news is MODEL-spoken (control-URL `say` cannot be interrupted).
  const doc = read(DOC) || '';
  if (
    doc &&
    !/model to speak verbatim|model-spoken|speak it verbatim|for the model to speak/i.test(doc)
  ) {
    failures.push(
      'doc no longer states that news is model-spoken (the 2026-07-01 interruption fix)',
    );
  }
  const lessons = read(LESSONS) || '';
  if (lessons && !/control-url `?say`?|model-spoken/i.test(lessons)) {
    failures.push(
      'LESSONS no longer records why control-URL say fails (the news-reader interruption lesson)',
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: voice-call-stack doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/voice-call-stack.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: voice-call-stack doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = { checkDrift, KEY_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN, MUST_NOT_EXIST };
