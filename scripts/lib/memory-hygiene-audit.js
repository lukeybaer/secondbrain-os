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

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
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
function extractMdPointers(indexContent) {
  const out = new Set();
  const re = /`([A-Za-z0-9_./-]+\.md)`/g;
  let m;
  while ((m = re.exec(String(indexContent || ''))) !== null) {
    const ref = m[1];
    if (ref.startsWith('/') || ref.includes('..') || /^[A-Za-z]:/.test(ref)) continue;
    out.add(ref);
  }
  return [...out];
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
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) names.add(e.name);
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

  let indexContent = '';
  try {
    indexContent = fs.readFileSync(path.join(memoryDir, indexName), 'utf8');
  } catch {
    /* a missing index is itself surfaced below via deadPointers staying empty */
  }
  const basenames =
    opts.basenames || collectMdBasenames([memoryDir, path.join(repoRoot, 'dev-plans')]);
  const deadPointers = findDeadPointers(indexContent, existsFn, {
    repoRoot,
    memoryDir,
    basenameExists: (n) => basenames.has(n),
  });

  const issueCount = frontmatterIssues.length + deadPointers.length;
  const verdict = issueCount === 0 ? 'clean' : 'issues';

  return {
    scanned: files.length,
    frontmatterIssues,
    deadPointers,
    issueCount,
    verdict,
  };
}

function oneLine(report) {
  if (report.verdict === 'clean') {
    return `memory hygiene [clean] ${report.scanned} files, 0 issues`;
  }
  return `memory hygiene [issues] ${report.frontmatterIssues.length} frontmatter, ${report.deadPointers.length} dead pointer(s) across ${report.scanned} files`;
}

module.exports = {
  MEMORY_DIR,
  REQUIRED_FIELDS,
  extractFrontmatter,
  checkFrontmatter,
  extractMdPointers,
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
