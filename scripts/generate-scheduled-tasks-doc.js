#!/usr/bin/env node
'use strict';
// Rewrites the generated block of memory/reference_amy_state_locations.md that
// names every scheduled-tasks/ directory, from the directories themselves
// (name + SKILL.md frontmatter description). owner decision: docs that list
// what code does are generated from code, not hand-maintained.
//   node scripts/generate-scheduled-tasks-doc.js          rewrite the block
//   node scripts/generate-scheduled-tasks-doc.js --check  exit 1 if stale
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DOC = path.join(REPO, 'memory', 'reference_amy_state_locations.md');
const BEGIN = '<!-- BEGIN generated:scheduled-tasks (node scripts/generate-scheduled-tasks-doc.js) -->';
const END = '<!-- END generated:scheduled-tasks -->';

function descriptionOf(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return '';
  const m = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const d = m && m[1].match(/^description:\s*(.*)$/m);
  return d ? d[1].trim().replace(/^["']|["']$/g, '') : '';
}

function generateBlock(repo = REPO) {
  const root = path.join(repo, 'scheduled-tasks');
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
  const lines = names.map((n) => {
    const desc = descriptionOf(path.join(root, n));
    return desc ? `- \`${n}\`: ${desc}` : `- \`${n}\``;
  });
  return [BEGIN, ...lines, END].join('\n');
}

function applyBlock(text, block) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error('generated:scheduled-tasks markers missing in doc');
  return text.slice(0, start) + block + text.slice(end + END.length);
}

function main() {
  const text = fs.readFileSync(DOC, 'utf8');
  const next = applyBlock(text, generateBlock());
  if (process.argv.includes('--check')) {
    if (next !== text) { console.error('reference_amy_state_locations.md scheduled-tasks block is stale; run node scripts/generate-scheduled-tasks-doc.js'); process.exit(1); }
    return;
  }
  if (next !== text) fs.writeFileSync(DOC, next);
}

if (require.main === module) main();
module.exports = { generateBlock, applyBlock, BEGIN, END, DOC };
