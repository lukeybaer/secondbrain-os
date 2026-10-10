#!/usr/bin/env node
/**
 * Drift-lint for the Skill Management core component.
 *
 * Keeps dev-plans/core/skill-management.md equal to the code: every load-bearing
 * file the doc names as the wired learning loop (per-skill LESSONS injection +
 * append, the scheduled runner, the worktree-isolation gate around it, and the
 * built-but-idle rollup/coverage libs) must still exist, and the design
 * invariants the doc asserts (lesson primitives exported, direct-config skills
 * logging outcomes too, the amy-research-skill autonomy gate, and the
 * shared-checkout isolation preceding any LESSONS write) must still hold. If the
 * code moves and the doc does not, this fails loud so the doc gets fixed instead
 * of rotting into fiction.
 *
 * Scoped per review: the wired learning-loop primitives and the isolation
 * boundary that protects LESSONS.md from shared-checkout writes -- NOT the
 * skill-registry/CARD_MANIFEST work that dev-plans/core/skill-management.md
 * itself says is still design-only (nothing to drift-check until it is built).
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-skill-management-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/skill-management.md';
const LESSONS = 'dev-plans/core/skill-management.LESSONS.md';

// Load-bearing files the doc names as the wired learning loop, plus the
// built-but-idle rollup/coverage libs it names as the next layer up. Each must
// exist (these are git-tracked source, not runtime artifacts).
const KEY_FILES = [
  'scripts/skill-lessons.js',
  'scripts/skill-runner-hooks.js',
  'scripts/run-scheduled-skill.js',
  'scripts/lib/cloud-scheduled-fleet.js',
  'scripts/lib/codex-worktree.js',
  'scripts/lessons-aggregator.js',
  'scripts/lib/manifest-coverage.js',
  'scripts/lib/skill-lesson-coverage.js',
  'scripts/lib/core-doc-diff.js',
  'skills/memory/graphiti-consult-for-prompts/SKILL.md',
  'skills/memory/graphiti-consult-for-prompts/LEARNINGS.md',
  'scripts/lib/graphiti-brain-advisor.js',
  'scheduled-tasks',
  'scripts/__tests__/lessons-aggregator.test.js',
  'scripts/__tests__/manifest-coverage-drift.test.js',
];

// Runtime artifacts: change constantly as skills are added/run, never git-frozen
// invariants -> warn if missing, never fail the lint on their absence.
const RUNTIME_FILES = [];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  ['scripts/skill-lessons.js', 'appendLesson', 'per-skill lesson primitive the runner hooks call'],
  ['scripts/skill-lessons.js', 'readRecentLessons', 'pre-run injection reads the last N lessons'],
  [
    'scripts/skill-runner-hooks.js',
    'buildPromptWithLessons',
    'pre-run hook that injects recent lessons into the skill prompt',
  ],
  [
    'scripts/skill-runner-hooks.js',
    'recordSkillOutcome',
    'post-run hook that appends the outcome to the skill LESSONS.md',
  ],
  [
    'scripts/run-scheduled-skill.js',
    'isSharedCheckout',
    'scheduled runner must detect the shared checkout before touching LESSONS.md',
  ],
  [
    'scripts/run-scheduled-skill.js',
    'ensureCodexWorktree',
    'scheduled runner bootstraps into an isolated worktree before firing lesson hooks',
  ],
  [
    'scripts/run-scheduled-skill.js',
    'runDirectConfigIfPresent',
    'direct.json skills (no Claude/Codex rung) still funnel through the outcome logger',
  ],
  [
    'scripts/lib/cloud-scheduled-fleet.js',
    'AMY_ENABLE_AUTONOMOUS_RESEARCH',
    'amy-research-skill stays disabled by default so passive schedules cannot trigger autonomous research',
  ],
  [
    'scripts/lessons-aggregator.js',
    'buildBriefingDigest',
    'cross-skill rollup the doc says is built-and-idle; must still exist to be wired later',
  ],
  [
    'scripts/lib/graphiti-brain-advisor.js',
    'readRecentLearnings({ limit: 10 })',
    'the prompt-time advisor mechanically loads a bounded final-ten learning window',
  ],
  [
    'skills/memory/graphiti-consult-for-prompts/SKILL.md',
    'Query adjustment:',
    'the prompt-time skill defines the explicit adjustment contract consumed by runtime',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary from LESSONS).
const MUST_NOT_CONTAIN = [];
// No MUST_NOT_CONTAIN entries: the one dated lesson in skill-management.LESSONS.md
// (2026-06-18, LESSONS.md appends must obey session isolation) is enforced
// structurally -- the isolation bootstrap must run and exit BEFORE the runner
// ever requires skill-runner-hooks -- not by forbidding a literal token that was
// once present. That structural check lives in checkIsolationPrecedesHooks()
// below. Inventing a banned string here would be a fabricated invariant.

// Files deleted for a documented reason that must stay deleted. No such deletion
// is recorded in skill-management.LESSONS.md yet, so this stays empty rather
// than inventing one.
const MUST_NOT_EXIST = [];

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// The 2026-06-18 LESSONS rule: the shared-checkout isolation bootstrap must run
// (and, on the shared-checkout path, terminate the process) BEFORE
// skill-runner-hooks is ever required. Otherwise a Codex-isolation failure could
// fall through into hook code that appends to tracked scheduled-tasks/*/LESSONS.md
// in the shared checkout, exactly the regression the lesson recorded. We check
// this structurally (source order of the two require sites) so a refactor that
// reorders them is caught even if the exact isolation helper names change name.
function checkIsolationPrecedesHooks(repoRoot, failures) {
  const rel = 'scripts/run-scheduled-skill.js';
  const file = path.join(repoRoot, rel);
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    failures.push(`cannot check isolation ordering, file missing: ${rel}`);
    return;
  }
  const code = stripComments(src);
  const worktreeRequireIdx = code.search(/require\(\s*['"`][^'"`]*codex-worktree(?:\.js)?['"`]/);
  const hooksRequireIdx = code.search(/require\(\s*['"`][^'"`]*skill-runner-hooks(?:\.js)?['"`]/);
  if (worktreeRequireIdx === -1) {
    failures.push(
      `${rel} no longer requires lib/codex-worktree.js -- the shared-checkout isolation guard (2026-06-18 lesson) may have been dropped`,
    );
    return;
  }
  if (hooksRequireIdx === -1) {
    failures.push(`${rel} no longer requires skill-runner-hooks -- lesson hooks may be unwired`);
    return;
  }
  if (worktreeRequireIdx >= hooksRequireIdx) {
    failures.push(
      `${rel} requires skill-runner-hooks before (or at the same point as) lib/codex-worktree.js -- the isolation bootstrap must run before any lesson hook can touch tracked LESSONS.md (2026-06-18 lesson)`,
    );
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
  const exists = (rel) => {
    try {
      fs.statSync(path.join(repoRoot, rel));
      return true;
    } catch {
      return false;
    }
  };

  if (read(DOC) === null) failures.push(`missing core doc: ${DOC}`);
  const lessonsBody = read(LESSONS);
  const doc = read(DOC) || '';
  if (lessonsBody === null) {
    // Only a failure if the doc itself claims the LESSONS file is the sink --
    // matches the "skip gracefully unless the doc references it" instruction.
    if (doc && /skill-management\.LESSONS\.md/.test(doc)) {
      failures.push(`doc references ${LESSONS} but it is missing`);
    } else {
      warnings.push(`no LESSONS file at ${LESSONS} (doc does not reference it either)`);
    }
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
      failures.push(`file was removed for a documented reason but has returned: ${rel}`);
  }

  checkIsolationPrecedesHooks(repoRoot, failures);

  // The doc must still state the honest current-state split: the learning loop
  // is wired, the registry/aggregator-wiring layer above it is not. Losing this
  // line is exactly the kind of doc drift this lint exists to catch (a doc that
  // quietly starts claiming the registry is built when it is not).
  if (doc && !/design-only/i.test(doc)) {
    failures.push(
      `doc no longer flags any DESIGN-ONLY (unbuilt) layer -- skill-management.md must keep the honest wired-vs-design-only split`,
    );
  }
  if (doc && !/lessons-aggregator\.js/.test(doc)) {
    failures.push(
      'doc no longer names lessons-aggregator.js as the (currently unwired) cross-skill rollup',
    );
  }

  // The LESSONS file, if present, must keep recording the 2026-06-18 isolation
  // rule in prose -- the mechanical check above enforces the code, this ensures
  // the reasoning behind it cannot be quietly deleted from the written record.
  if (lessonsBody && !/isolat/i.test(lessonsBody)) {
    failures.push(
      `${LESSONS} no longer mentions isolation -- the 2026-06-18 shared-checkout lesson must stay recorded`,
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: skill-management doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/skill-management.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: skill-management doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  RUNTIME_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
  DOC,
  LESSONS,
};
