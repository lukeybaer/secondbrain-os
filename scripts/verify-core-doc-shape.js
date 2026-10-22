#!/usr/bin/env node
/**
 * Shape lint for the core component docs in dev-plans/core/*.md.
 *
 * The 12 core docs are the "one manual per room" authority files. This lint
 * keeps them SHAPED like manuals instead of sprawl: a machine-readable
 * frontmatter routing block, a bounded "In one minute" orientation section,
 * a bounded numbered "Invariants" section, no "Current state" status dump
 * (dated facts belong in the component's .LESSONS.md), and a hard total
 * word cap so the most important rule can never again sit at the 11% mark
 * of a 9,000-word page.
 *
 * Category, not literals: it does not pin the component names. For every
 * dev-plans/core/*.md (excluding *.LESSONS.md) it asserts:
 *   1. YAML frontmatter at the very top with component/owns/triggers/paths;
 *      component equals the filename; triggers match the doc's registry row
 *      keywords in memory/MEMORY.md (parsed by the SAME parser the router
 *      uses, scripts/lib/core-component-registry.js).
 *   2. A "## In one minute" section of at most 200 words.
 *   3. A "## Invariants" section with 1..15 numbered one-line items.
 *   4. NO "Current state" section heading.
 *   5. At most 2,500 words total.
 *
 * Zero deps beyond fs/path + the shared registry parser, so it runs in a
 * fresh worktree. Wired into `npm run verify:core-drift`.
 *   node scripts/verify-core-doc-shape.js
 * Exit 0 = in shape, 1 = violations. Importable as { checkShape } for tests.
 */

const fs = require('fs');
const path = require('path');
const { parseRegistryBlock } = require('./lib/core-component-registry.js');

const CORE_DIR_REL = 'dev-plans/core';
const MEMORY_REL = 'memory/MEMORY.md';
const MAX_TOTAL_WORDS = 2500;
const MAX_MINUTE_WORDS = 200;
const MAX_INVARIANTS = 15;

function wordCount(text) {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
}

/** Parse the leading `--- ... ---` frontmatter block. Returns null when absent. */
function parseFrontmatter(text) {
  const norm = String(text || '').replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const block = lines.slice(1, end);
  const fields = {};
  let currentKey = null;
  for (const line of block) {
    const keyMatch = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      fields[currentKey] = { value: keyMatch[2].trim(), items: [] };
      continue;
    }
    const itemMatch = line.match(/^\s+-\s+(.*)$/);
    if (itemMatch && currentKey) {
      fields[currentKey].items.push(itemMatch[1].trim());
    }
  }
  return { fields, bodyStart: end + 1, body: lines.slice(end + 1).join('\n') };
}

/** Parse a triggers value: inline flow list [a, "b c", d] or dash-list items. */
function parseListField(field) {
  if (!field) return [];
  const out = [];
  const inline = field.value.match(/^\[(.*)\]$/);
  if (inline) {
    for (const part of inline[1].split(',')) {
      const cleaned = part
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
      if (cleaned) out.push(cleaned);
    }
  }
  for (const item of field.items) {
    const cleaned = item.replace(/^["']|["']$/g, '').trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Extract a `## <name>` section body (to the next `## ` heading). Null when absent. */
function extractSection(body, name) {
  const lines = String(body || '').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function checkDocShape(docRel, text, registryRows) {
  const failures = [];
  const name = path.basename(docRel, '.md');

  // 1. Frontmatter routing block.
  const fm = parseFrontmatter(text);
  if (!fm) {
    failures.push(`${docRel}: missing YAML frontmatter routing block at the top of the file`);
    return failures; // Everything else keys off it; report the one real cause.
  }
  for (const key of ['component', 'owns', 'triggers', 'paths']) {
    const field = fm.fields[key];
    const hasValue = field && (field.value.length > 0 || field.items.length > 0);
    if (!hasValue) failures.push(`${docRel}: frontmatter is missing a non-empty "${key}:" field`);
  }
  if (fm.fields.component && fm.fields.component.value && fm.fields.component.value !== name) {
    failures.push(
      `${docRel}: frontmatter component "${fm.fields.component.value}" does not equal the filename "${name}"`,
    );
  }

  // Triggers must stay consistent with the registry row keywords for this doc.
  const row = (registryRows || []).find((r) => r.docPath === docRel);
  if (row) {
    const triggers = parseListField(fm.fields.triggers).map((t) => t.toLowerCase());
    const keywords = row.keywords.map((k) => String(k).toLowerCase());
    const missing = keywords.filter((k) => !triggers.includes(k));
    const extra = triggers.filter((t) => !keywords.includes(t));
    if (missing.length || extra.length) {
      failures.push(
        `${docRel}: frontmatter triggers [${triggers.join(', ')}] do not match the MEMORY.md registry keywords [${keywords.join(', ')}]`,
      );
    }
  }

  // 2. In one minute, hard-capped.
  const minute = extractSection(fm.body, 'In one minute');
  if (minute === null) {
    failures.push(`${docRel}: missing "## In one minute" section`);
  } else if (wordCount(minute) > MAX_MINUTE_WORDS) {
    failures.push(
      `${docRel}: "## In one minute" is ${wordCount(minute)} words (max ${MAX_MINUTE_WORDS})`,
    );
  }

  // 3. Invariants: numbered, bounded.
  const invariants = extractSection(fm.body, 'Invariants');
  if (invariants === null) {
    failures.push(`${docRel}: missing "## Invariants" section`);
  } else {
    const items = invariants.split('\n').filter((l) => /^\s*\d+[.)]\s+\S/.test(l));
    if (items.length === 0) {
      failures.push(`${docRel}: "## Invariants" has no numbered items`);
    } else if (items.length > MAX_INVARIANTS) {
      failures.push(`${docRel}: "## Invariants" has ${items.length} items (max ${MAX_INVARIANTS})`);
    }
  }

  // 4. No Current state section: dated facts live in the .LESSONS.md file.
  if (/^#{2,6}\s+(?:\d+[.)]?\s*)?Current state\b/im.test(fm.body)) {
    failures.push(
      `${docRel}: has a "Current state" section; salvage rules into Invariants, move dated facts to the LESSONS file, delete status prose`,
    );
  }

  // 5. Total word cap.
  const total = wordCount(text);
  if (total > MAX_TOTAL_WORDS) {
    failures.push(
      `${docRel}: ${total} words total (max ${MAX_TOTAL_WORDS}); move detail to LESSONS`,
    );
  }

  return failures;
}

function checkShape(repoRoot) {
  const failures = [];

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
  if (docs.length === 0) {
    failures.push(`no core docs found under ${CORE_DIR_REL}/`);
    return { failures };
  }

  let registryRows = [];
  try {
    const memoryText = fs.readFileSync(path.join(repoRoot, MEMORY_REL), 'utf8');
    const { rows, found } = parseRegistryBlock(memoryText);
    if (found) registryRows = rows;
    else failures.push(`${MEMORY_REL} has no "## CORE COMPONENTS" registry block`);
  } catch {
    failures.push(`missing ${MEMORY_REL} (cannot check trigger/registry consistency)`);
  }

  for (const docRel of docs) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(repoRoot, docRel), 'utf8');
    } catch {
      failures.push(`cannot read ${docRel}`);
      continue;
    }
    failures.push(...checkDocShape(docRel, text, registryRows));
  }

  return { failures };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures } = checkShape(repoRoot);
  if (failures.length) {
    console.error(`\nSHAPE: core docs violate the doc-shape contract (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      '\nFix the doc shape (frontmatter, In one minute, Invariants, no Current state, word cap), then re-run.',
    );
    process.exit(1);
  }
  console.log('OK: all core docs pass the shape contract.');
}

if (require.main === module) main();

module.exports = {
  checkShape,
  checkDocShape,
  parseFrontmatter,
  extractSection,
  wordCount,
  MAX_TOTAL_WORDS,
  MAX_MINUTE_WORDS,
  MAX_INVARIANTS,
  CORE_DIR_REL,
};
