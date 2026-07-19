// scripts/lib/memory-hygiene-audit.js
//
// A repo-wide "/doctor" for Amy's memory corpus (Letta-inspired memory-quality
// audit). The memory-validation.sh PostToolUse hook enforces the frontmatter
// contract one write at a time, but nothing has ever swept the ~380 existing
// memory/*.md files, and nothing checks that the backtick `*.md` pointers in
// the always-loaded MEMORY.md index still resolve. Dead pointers and missing
// frontmatter are silent rot in the single most-loaded file Amy has.
//
// This auditor uses the SAME contract as memory-validation.sh (frontmatter
// must open with '---'; required fields name/description/type; MEMORY.md and
// contacts/ are exempt) so it never invents a divergent rule -- it just covers
// the whole corpus instead of the file being written.
//
// Deliberately scoped to two UNAMBIGUOUS, near-zero-false-positive checks:
//   1. frontmatter validity of top-level Tier-2 topic files
//   2. dead `*.md` pointers in MEMORY.md
// Wikilink ([[slug]]) resolution is intentionally NOT attempted: the kebab
// slugs do not map cleanly to the snake_case filenames, so any resolver would
// be guess-driven and false-positive heavy -- dead weight, per the frugal
// regression-test rule. A tight, trustworthy auditor beats a noisy one.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Anchored to this file's own repo (worktree-safe). A session-wide
// SECONDBRAIN_ROOT pointing at the shared checkout must never make a
// worktree audit silently report on the wrong corpus (2026-07-19).
const REPO = path.resolve(__dirname, '..', '..');
const MEMORY_DIR = path.join(REPO, 'memory');
const INDEX_FILE = 'MEMORY.md';
const REQUIRED_FIELDS = ['name', 'description', 'type'];

// --- pure helpers (no fs) ----------------------------------------------------

// extractFrontmatter(content) -> the text between the first two '---' fences,
// or null if the file does not open with a frontmatter fence.
function extractFrontmatter(content) {
  const text = String(content || '');
  // Tolerate a leading BOM/newline but the first non-empty line must be '---'.
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (lines[i] === undefined || lines[i].trim() !== '---') return null;
  const start = i + 1;
  for (let j = start; j < lines.length; j += 1) {
    if (lines[j].trim() === '---') return lines.slice(start, j).join('\n');
  }
  return null; // opened a fence but never closed it
}

// checkFrontmatter(content) -> { ok, missing: [...] }. Mirrors the hook: a file
// with no frontmatter reports missing 'frontmatter'; otherwise each required
// field must appear as a key line within the block.
function checkFrontmatter(content) {
  const block = extractFrontmatter(content);
  if (block === null) return { ok: false, missing: ['frontmatter'] };
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    const re = new RegExp(`^\\s*${field}\\s*:`, 'm');
    if (!re.test(block)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

// extractMdPointers(indexContent) -> de-duped list of backtick-wrapped tokens
// that look like a markdown file reference. Skips absolute paths and '..'.
// 2026-07-19: also expands single-group brace tokens like
// `project_{alpha,beta}.md` into concrete refs. 17 such groups (~87 refs) in
// the real MEMORY.md were previously invisible to this regex, so "0 dead
// pointers" overstated what was verified (memory-hygiene tooling audit).
// Tokens containing '*' are globs: they cannot be liveness-checked as exact
// files and are returned separately by extractGlobPatterns for the orphan
// reachability check.
function expandBraceToken(token) {
  const m = token.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  // Comma-less groups like `{repo}/CLAUDE.md` are prose placeholders ("any
  // repo"), not enumerations; expanding them fabricates dead pointers.
  if (!m || !m[2].includes(',')) return [token];
  return m[2].split(',').map((part) => `${m[1]}${part.trim()}${m[3]}`);
}

function extractRawTokens(indexContent) {
  const out = [];
  const re = /`([A-Za-z0-9_.{},*/ -]+\.md)`/g;
  let m;
  while ((m = re.exec(String(indexContent || ''))) !== null) {
    const ref = m[1].replace(/ /g, '');
    if (ref.startsWith('/') || ref.includes('..') || /^[A-Za-z]:/.test(ref)) continue;
    out.push(ref);
  }
  return out;
}

function extractMdPointers(indexContent) {
  const out = new Set();
  for (const raw of extractRawTokens(indexContent)) {
    for (const expanded of expandBraceToken(raw)) {
      if (expanded.includes('*') || expanded.includes('{')) continue;
      out.add(expanded);
    }
  }
  return [...out];
}

// Glob patterns present in an index (`feedback_*.md`, brace groups whose
// expansion still ExampleCos '*'). Basename-level matchers for reachability.
function extractGlobPatterns(indexContent) {
  const out = new Set();
  for (const raw of extractRawTokens(indexContent)) {
    for (const expanded of expandBraceToken(raw)) {
      if (expanded.includes('*') && !expanded.includes('{')) out.add(expanded);
    }
  }
  return [...out];
}

function globToRegex(glob) {
  const base = glob.split('/').pop();
  return new RegExp(
    '^' +
      base
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
}

// findDeadPointers(indexContent, existsFn, opts) -> [refs].
//   - A pointer WITH a directory component (e.g. `dev-plans/core/x.md`) is a
//     deliberate navigational link and must resolve at that exact relative path
//     under the repo root OR memory/.
//   - A BARE basename (e.g. `spine.md`) is often prose shorthand whose full path
//     appears elsewhere; it is satisfied if it resolves flat in memory/ OR if a
//     file of that basename exists anywhere in the doc tree (opts.basenameExists).
// existsFn(absPath)->bool and opts.basenameExists(name)->bool are injectable so
// resolution is unit-testable.
function findDeadPointers(indexContent, existsFn, opts = {}) {
  const repoRoot = opts.repoRoot || REPO;
  const memoryDir = opts.memoryDir || MEMORY_DIR;
  const basenameExists = opts.basenameExists || (() => false);
  const dead = [];
  for (const ref of extractMdPointers(indexContent)) {
    if (ref.includes('/')) {
      const candidates = [path.join(repoRoot, ref), path.join(memoryDir, ref)];
      if (!candidates.some((p) => existsFn(p))) dead.push(ref);
    } else if (!existsFn(path.join(memoryDir, ref)) && !basenameExists(ref)) {
      dead.push(ref);
    }
  }
  return dead;
}

// Recursively collect every *.md basename under the given roots (cheap doc-tree
// index used to satisfy bare-basename prose references). Bounded to known doc
// roots so it never walks node_modules or the whole repo.
function collectMdBasenames(roots) {
  const names = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // archive/ must NOT satisfy bare pointers: a file moved to archive
        // leaving its index line behind is exactly the stale-pointer defect
        // this audit exists to catch (Codex peer review 2b449a3f9b52).
        if (e.name === 'archive') continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) names.add(e.name);
    }
  };
  for (const r of roots) walk(r);
  return names;
}

// --- fs-backed audit ---------------------------------------------------------

function listTopLevelTopicFiles(memoryDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX_FILE)
    .map((e) => e.name)
    .sort();
}

// auditMemoryDir(opts) -> structured report. opts.memoryDir / opts.repoRoot /
// opts.indexFile / opts.existsFn are injectable for tests.
function auditMemoryDir(opts = {}) {
  const memoryDir = opts.memoryDir || MEMORY_DIR;
  const repoRoot = opts.repoRoot || REPO;
  const indexName = opts.indexFile || INDEX_FILE;
  const existsFn = opts.existsFn || ((p) => fs.existsSync(p));

  const files = listTopLevelTopicFiles(memoryDir);
  const frontmatterIssues = [];
  for (const name of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(memoryDir, name), 'utf8');
    } catch {
      frontmatterIssues.push({ file: name, missing: ['unreadable'] });
      continue;
    }
    const r = checkFrontmatter(content);
    if (!r.ok) frontmatterIssues.push({ file: name, missing: r.missing });
  }

  // 2026-07-19 fix: a missing/unreadable index used to yield verdict "clean"
  // (zero pointers -> zero dead pointers), i.e. deleting the single
  // always-loaded file read as a healthy corpus. It is now a distinct issue.
  let indexContent = '';
  let indexMissing = false;
  try {
    indexContent = fs.readFileSync(path.join(memoryDir, indexName), 'utf8');
  } catch {
    indexMissing = true;
  }
  const basenames =
    opts.basenames ||
    collectMdBasenames([
      memoryDir,
      path.join(repoRoot, 'dev-plans'),
      path.join(repoRoot, 'skills'),
      path.join(repoRoot, 'scheduled-tasks'),
    ]);
  const deadPointers = findDeadPointers(indexContent, existsFn, {
    repoRoot,
    memoryDir,
    basenameExists: (n) => basenames.has(n),
  });

  // Reverse direction (report-only): top-level files unreachable from the
  // indexes. Reachable = literal/brace-expanded pointer in MEMORY.md or
  // RULES_INDEX.md, or matched by a glob those indexes carry (e.g.
  // `feedback_*.md`). Report-only because 200-line Tier-1 is capped by
  // design; the weekly consolidation pass and the briefing card surface the
  // count, the gate does not fail on it.
  let rulesContent = '';
  try {
    rulesContent = fs.readFileSync(path.join(memoryDir, 'RULES_INDEX.md'), 'utf8');
  } catch {
    /* optional secondary index */
  }
  const reachable = new Set(
    [...extractMdPointers(indexContent), ...extractMdPointers(rulesContent)].map((r) =>
      r.split('/').pop(),
    ),
  );
  const globRes = [...extractGlobPatterns(indexContent), ...extractGlobPatterns(rulesContent)]
    // A path-prefixed catch-all like `secondbrain/memory/*.md` has basename
    // `*.md`, which would mark EVERY file reachable and make the orphan
    // check vacuous (Codex peer review 2b449a3f9b52). Only prefixed globs
    // (feedback_*.md) express a real index convention.
    .filter((g) => g.split('/').pop() !== '*.md')
    .map(globToRegex);
  const orphans = files.filter(
    (name) =>
      name !== 'RULES_INDEX.md' && !reachable.has(name) && !globRes.some((re) => re.test(name)),
  );

  const issueCount = frontmatterIssues.length + deadPointers.length + (indexMissing ? 1 : 0);
  const verdict = issueCount === 0 ? 'clean' : 'issues';

  return {
    scanned: files.length,
    frontmatterIssues,
    deadPointers,
    indexMissing,
    orphans,
    issueCount,
    verdict,
  };
}

function oneLine(report) {
  const orphanNote =
    report.orphans && report.orphans.length
      ? `, ${report.orphans.length} unindexed (report-only)`
      : '';
  if (report.verdict === 'clean') {
    return `memory hygiene [clean] ${report.scanned} files, 0 issues${orphanNote}`;
  }
  const indexNote = report.indexMissing ? ', INDEX MISSING' : '';
  return `memory hygiene [issues] ${report.frontmatterIssues.length} frontmatter, ${report.deadPointers.length} dead pointer(s)${indexNote} across ${report.scanned} files${orphanNote}`;
}

module.exports = {
  MEMORY_DIR,
  REQUIRED_FIELDS,
  extractFrontmatter,
  checkFrontmatter,
  extractMdPointers,
  extractGlobPatterns,
  expandBraceToken,
  findDeadPointers,
  collectMdBasenames,
  auditMemoryDir,
  oneLine,
};

if (require.main === module) {
  const report = auditMemoryDir();
  // eslint-disable-next-line no-console
  console.log(oneLine(report));
  if (report.frontmatterIssues.length) {
    // eslint-disable-next-line no-console
    console.log('\nFrontmatter issues:');
    for (const i of report.frontmatterIssues) {
      // eslint-disable-next-line no-console
      console.log(`  ${i.file}: missing ${i.missing.join(', ')}`);
    }
  }
  if (report.deadPointers.length) {
    // eslint-disable-next-line no-console
    console.log('\nDead MEMORY.md pointers:');
    for (const ref of report.deadPointers) {
      // eslint-disable-next-line no-console
      console.log(`  ${ref}`);
    }
  }
  process.exit(report.verdict === 'clean' ? 0 : 1);
}
