#!/usr/bin/env node
/**
 * Drift-lint for the CORE COMPONENTS registry block in memory/MEMORY.md.
 *
 * The registry is what routes an agent to the right dev-plans/core doc at
 * work time (scripts/claude-hooks/core-component-router.mjs parses it as
 * data). A core doc with no registry row is invisible to the router; a
 * registry row whose doc is gone routes to nothing. Both are drift.
 *
 * Category, not literals: this does not pin the 12 component names. It
 * asserts the INVARIANT both ways against whatever is on disk:
 *   1. every dev-plans/core/*.md doc (excluding *.LESSONS.md) has exactly
 *      one registry row pointing at it;
 *   2. every registry row's doc path exists on disk;
 *   3. every row parses (id, at least one keyword, dev-plans/core path) via
 *      the SAME parser the router uses (scripts/lib/core-component-registry.js),
 *      so the lint can never drift from the runtime format.
 *
 * Zero deps beyond fs/path + the shared parser, so it runs in a fresh
 * worktree. Wired into `npm run verify:core-drift`.
 *   node scripts/verify-core-registry-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkRegistryDrift } for tests.
 */

const fs = require('fs');
const path = require('path');
const { parseRegistryBlock } = require('./lib/core-component-registry.js');

const MEMORY_REL = 'memory/MEMORY.md';
const CORE_DIR_REL = 'dev-plans/core';

function checkRegistryDrift(repoRoot) {
  const failures = [];

  let memoryText = null;
  try {
    memoryText = fs.readFileSync(path.join(repoRoot, MEMORY_REL), 'utf8');
  } catch {
    failures.push(`missing ${MEMORY_REL}`);
    return { failures };
  }

  const { rows, found } = parseRegistryBlock(memoryText);
  if (!found) {
    failures.push(`${MEMORY_REL} has no "## CORE COMPONENTS" registry block`);
    return { failures };
  }
  if (rows.length === 0) {
    failures.push('registry block parses to ZERO rows (format drift breaks the router)');
    return { failures };
  }

  // Docs on disk (excluding LESSONS companions).
  let docs = [];
  try {
    docs = fs
      .readdirSync(path.join(repoRoot, CORE_DIR_REL))
      .filter((f) => f.endsWith('.md') && !f.endsWith('.LESSONS.md'))
      .map((f) => `${CORE_DIR_REL}/${f}`);
  } catch {
    failures.push(`cannot read ${CORE_DIR_REL}/`);
    return { failures };
  }

  const rowPaths = rows.map((r) => r.docPath);
  const rowPathSet = new Set(rowPaths);

  // 1. Every doc has a row.
  for (const doc of docs) {
    if (!rowPathSet.has(doc)) {
      failures.push(`core doc has NO registry row in ${MEMORY_REL}: ${doc}`);
    }
  }

  // 2. Every row path exists on disk (also catches rows for deleted docs).
  for (const row of rows) {
    if (!fs.existsSync(path.join(repoRoot, row.docPath))) {
      failures.push(`registry row "${row.id}" points at a missing doc: ${row.docPath}`);
    }
  }

  // 3. One row per doc and one row per id (a duplicate silently shadows).
  const seenPath = new Set();
  const seenId = new Set();
  for (const row of rows) {
    if (seenPath.has(row.docPath)) failures.push(`duplicate registry rows for ${row.docPath}`);
    if (seenId.has(row.id)) failures.push(`duplicate registry id "${row.id}"`);
    seenPath.add(row.docPath);
    seenId.add(row.id);
    if (row.keywords.length === 0) failures.push(`registry row "${row.id}" has no keywords`);
  }

  return { failures };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures } = checkRegistryDrift(repoRoot);
  if (failures.length) {
    console.error(`\nDRIFT: core-component registry out of sync (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      '\nFix memory/MEMORY.md ("## CORE COMPONENTS" block) or dev-plans/core/, then re-run.',
    );
    process.exit(1);
  }
  console.log(`OK: core-component registry in sync (${'' + fsCount()} docs routed).`);

  function fsCount() {
    try {
      return fs
        .readdirSync(path.join(repoRoot, CORE_DIR_REL))
        .filter((f) => f.endsWith('.md') && !f.endsWith('.LESSONS.md')).length;
    } catch {
      return '?';
    }
  }
}

if (require.main === module) main();

module.exports = { checkRegistryDrift, MEMORY_REL, CORE_DIR_REL };
