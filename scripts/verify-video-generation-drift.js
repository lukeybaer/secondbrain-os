#!/usr/bin/env node
/**
 * Drift-lint for the Video Generation core component.
 *
 * Keeps dev-plans/core/video-generation.md equal to the code: the load-bearing
 * files of both pipelines (Pipeline A scoring, Pipeline B building) must still
 * exist, the five-knob legacy feedback seam and the OFF-by-default planner gate
 * the doc's diagnosis depends on must still hold, and the "one fix killed the
 * history" gitignore trap on the run ledger must not silently reappear untracked.
 * If the code moves and the doc does not, this fails loud so the doc gets fixed
 * instead of rotting into fiction.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-video-generation-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/video-generation.md';
const LESSONS = 'dev-plans/core/video-generation.LESSONS.md';

// Load-bearing files the doc's "Key files" section names, plus the adjacent
// guard scripts it implicitly depends on (rubric integrity, saturation audit).
// Each must exist. rejection-reflections/ and build-receipts/ are intentionally
// NOT here: the doc documents them as designed-but-not-yet-created (Current
// state), so their absence is the documented state, not drift.
const KEY_FILES = [
  'data/agent/video-quality-rubric.json',
  'src/main/empire/video-quality-tools/run-quality-check.py',
  'src/main/empire/video-quality-tools/predict-virality.py',
  'src/main/empire/video-quality-tools/verify-rubric-integrity.py',
  'src/main/empire/video-quality-tools/audit-tool-sprawl.py',
  'data/agent/nightly-enhancements.jsonl',
  'scripts/ec2-build-from-queue.py',
  'scripts/lib/plan-video-build.js',
  'data/agent/build-plan-schema.json',
  'scripts/build-from-plan.py',
  'scripts/lib/validate-plan.js',
  'scripts/lib/rejection-reflections.js',
  'scripts/lib/compile-channel-memory.js',
  'scripts/auto-regen-rejected-videos.js',
  'scheduled-tasks/craft-short-video/SKILL.md',
  'memory/project_AIDailyLifeHacks.md',
];

// [file, token, why] -- the token must be PRESENT (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'scripts/ec2-build-from-queue.py',
    'def apply_regen_overrides(spec):',
    'the legacy 5-knob feedback seam the doc names as the anti-pattern to not extend (doc section 3)',
  ],
  [
    'scripts/auto-regen-rejected-videos.js',
    "process.env.USE_PLANNER_PIPELINE === '1'",
    'the planner-pipeline gate the doc says defaults OFF (doc section 2, Current state)',
  ],
  [
    'scripts/lib/rejection-reflections.js',
    'rejection-reflections',
    'the durable per-channel JSONL lesson store the doc names as the load-bearing fix (doc section 3, LESSONS)',
  ],
  [
    'scripts/lib/plan-video-build.js',
    'async function buildPlan(',
    'planner pipeline entry point the rebuild routes through (doc section 2)',
  ],
  [
    'scripts/lib/validate-plan.js',
    'function validatePlan(',
    'plan validator the planner pipeline depends on (doc section "How to extend")',
  ],
  [
    'scripts/lib/compile-channel-memory.js',
    'compileChannelMemory',
    'compiles rejection reflections into planner-ready memory (doc section 3)',
  ],
  [
    'scheduled-tasks/craft-short-video/SKILL.md',
    'reflexion',
    'the Reflexion verbal-critique pattern the doc cites as the intended learning loop (doc section 3)',
  ],
  [
    '.gitignore',
    'data/agent/nightly-enhancements.jsonl',
    'the gitignore trap that keeps un-tracking the only durable run ledger (doc LESSONS, commits 711d3e9c/eb2760d1/cbeaf797)',
  ],
];

// No patterns have been removed-for-a-documented-reason for this component yet
// (unlike voice-call-stack's server-side transcript classifier). The doc's pain
// history is about a knob NEVER being added (the 5-knob ceiling) and a ledger
// NEVER staying untracked, not about code that was deleted. Fabricating a
// MUST_NOT_CONTAIN entry here would be an invented ban with no LESSONS citation,
// so this stays empty on purpose.
const MUST_NOT_CONTAIN = [];

// No files have been deleted-for-a-documented-reason for this component yet.
// Left empty on purpose rather than inventing one -- see MUST_NOT_CONTAIN note.
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
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  // The doc itself (section 5) says no LESSONS file exists yet and tells the
  // next contributor to create one on the first lesson. Only fail on a missing
  // LESSONS file once the doc stops admitting that -- otherwise this lint would
  // permanently red until someone creates the file, which is not drift.
  const lessons = read(LESSONS);
  const docAdmitsNoLessonsYet = doc && /no per-component LESSONS file exists yet/i.test(doc);
  if (lessons === null && !docAdmitsNoLessonsYet) {
    failures.push(`missing LESSONS: ${LESSONS} (doc no longer admits it is absent -- create it)`);
  }

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

  // The doc must keep stating the core diagnosis: four non-sharing generations
  // optimizing a proxy (rubric coverage) instead of the product (accept/reject).
  if (doc && !/four parallel generations|FOUR parallel generations/i.test(doc)) {
    failures.push(
      'doc no longer states the four-parallel-generations diagnosis (the reason this is a core component)',
    );
  }
  if (doc && !/proxy/i.test(doc)) {
    failures.push(
      'doc no longer states the proxy-vs-product framing (rubric coverage is not the success metric)',
    );
  }
  if (lessons === null) {
    // Nothing further to check against a LESSONS file that legitimately does
    // not exist yet.
  } else if (!/apply_regen_overrides|5-knob|five.knob/i.test(lessons)) {
    failures.push(
      'LESSONS no longer records the 5-knob apply_regen_overrides ceiling that must not be extended',
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: video-generation doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/video-generation.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: video-generation doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = { checkDrift, KEY_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN, MUST_NOT_EXIST };
