#!/usr/bin/env node
/**
 * Drift-lint for the Spine / Task Store core component.
 *
 * Keeps dev-plans/core/spine.md equal to the code: every load-bearing file the
 * doc names must still exist, and the design invariants the doc asserts (spine
 * boot wiring, rescan-on-read listTasks, the explicit-request gate, the
 * callback-lease concurrency guard, isolated coding worktrees) must still hold.
 * If the code moves and the doc does not, this fails loud so the doc gets
 * fixed instead of rotting into fiction.
 *
 * Scoped per review: the store's boot wiring, read semantics, explicit-request
 * gate, and callback-lease guard -- NOT every Task field or every intake
 * surface. spine.LESSONS.md does not exist yet (per spine.md section 5, it is
 * created on the first lesson learned here); this lint only requires it if the
 * doc itself claims it exists.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-spine-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/spine.md';
const LESSONS = 'dev-plans/core/spine.LESSONS.md';

// Load-bearing git-tracked files the doc names in its "Key files" section.
// Each must exist.
const KEY_FILES = [
  'src/main/task-store.ts',
  'src/main/index.ts',
  'scripts/claude-hooks/spine-session-task.mjs',
  'scripts/lib/spine-ingress.js',
  'src/main/task-intake.ts',
  'scripts/process-dispatches.js',
  'scripts/lib/voice-cloud-runtime.js',
  'scripts/callback-watchdog.js',
  'src/main/task-service.ts',
  'memory/feedback_spine_central_execution_frame.md',
  'dev-plans/one-amy-unified-architecture-2026-06-14.html',
];

// Runtime artifacts: present on a live desktop/EC2 box, not git-tracked in
// this repo -> warn, never fail.
const RUNTIME_FILES = [
  ['data/tasks', 'local/test/mirror Task store, only live when env points there'],
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'src/main/index.ts',
    "setTasksDir(join(spineDataDir, 'tasks'))",
    'boot wiring points the store at the real data dir before any poller/worker can create spine records',
  ],
  [
    'src/main/task-store.ts',
    '_index = null',
    'listTasks() rescans disk on every call instead of trusting a stale in-memory index, which is what lets out-of-process scripts write Task JSON straight into the dir and have it appear',
  ],
  [
    'src/main/task-store.ts',
    'export type TaskOrigin',
    'the TaskOrigin union is the single place new surfaces register, never a second store',
  ],
  [
    'scripts/lib/spine-ingress.js',
    'explicitRequest',
    'passive Gmail/Otter/LinkedIn/briefing/Vapi records stay ingest/history unless they carry an explicit-request signal',
  ],
  [
    'src/main/task-intake.ts',
    'explicitRequest',
    'the explicit-request gate is enforced in intake, not left to each surface to reinvent',
  ],
  [
    'scripts/process-dispatches.js',
    'explicitRequest',
    'the dispatch processor honors the same explicit-request gate before treating a record as runnable',
  ],
  [
    'scripts/lib/voice-cloud-runtime.js',
    'callback-leases',
    'callback concurrency is guarded by lease files so overlapping watchdog ticks cannot double-fire an owner callback',
  ],
  [
    'scripts/lib/voice-cloud-runtime.js',
    'leaseUntil',
    'the callback lease has an expiry, so a crashed holder cannot permanently block the callback',
  ],
  [
    'src/main/task-service.ts',
    'codex/task-',
    'approved coding Tasks get an isolated short-lived worktree/branch before execution, never running against the shared checkout',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary). No
// pattern here was removed for a documented reason yet (spine.LESSONS.md does
// not exist -- see thinLayers in the review notes), so this stays empty rather
// than inventing a ban with no lesson behind it.
const MUST_NOT_CONTAIN = [];

// Files deleted for a documented reason that must stay deleted. No such
// removal is documented for spine yet, so this stays empty rather than
// fabricating one.
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

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  // spine.LESSONS.md is documented as not-yet-created (spine.md section 5).
  // Only fail if the doc has since started claiming it exists/is populated;
  // otherwise its absence is expected and must not be flagged.
  const lessons = read(LESSONS);
  const docClaimsLessonsExists =
    doc && /spine\.LESSONS\.md/.test(doc) && !/must be created|does not exist/i.test(doc);
  if (lessons === null && docClaimsLessonsExists) {
    failures.push(
      `${DOC} now implies ${LESSONS} exists, but it is missing. Create it or restore the "must be created" language.`,
    );
  }

  for (const rel of KEY_FILES) {
    if (!exists(rel)) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const [rel, note] of RUNTIME_FILES) {
    if (!exists(rel))
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
  for (const rel of MUST_NOT_EXIST) {
    if (exists(rel))
      failures.push(
        `file should stay deleted but exists again: ${rel} -- update the doc if intentional`,
      );
  }

  // The doc must keep stating the load-bearing rule that a ledger row is not
  // "in the spine" until a matching Task JSON exists (section 1's core claim).
  if (
    doc &&
    !/not "in the spine" until a matching Task JSON exists|is not it: a row in an intake or receipt ledger/i.test(
      doc,
    )
  ) {
    failures.push(
      `${DOC} no longer states that ledgers are not the spine until a matching Task JSON exists`,
    );
  }

  // The doc must keep naming the explicit-request gate so passive records
  // never get treated as autonomous Amy action.
  if (doc && !/explicit-request gate|explicit.*Amy.*trigger|#Amy.*#amy.*#AMY/i.test(doc)) {
    failures.push(`${DOC} no longer documents the explicit-request gate for passive records`);
  }

  // If spine.LESSONS.md exists, it must record at least one dated lesson
  // entry (## YYYY-MM-DD -- ...), the same shape every other core LESSONS
  // file uses, so a lesson cannot be silently emptied out.
  if (lessons !== null && !/^##\s+\d{4}-\d{2}-\d{2}/m.test(lessons)) {
    failures.push(`${LESSONS} exists but has no dated lesson entry (## YYYY-MM-DD -- ...)`);
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: spine doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/spine.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: spine doc is in sync with the code.');
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
