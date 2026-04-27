#!/usr/bin/env node
// heal-tests.js
//
// Runs the full vitest suite and writes every failing assertion to
// data/agent/tests-blocked.json so the briefing's Tests probe renders
// each one as a one-click "approve to skip" row instead of saying "Luke
// must classify" forever.
//
// Closes Luke 2026-04-26 Otter dispatch: "Heal disabled for the test
// suite, because flaky failures need Luke to classify real bug versus
// noise. So what question are you asking me? You need to actually ask me
// a question and let it show up in the briefing, and I can answer you
// right there."
//
// Output (one JSON file the dashboard can read):
//   data/agent/tests-blocked.json -- { ranAt, total, failed, items:[{file, name, error, suggestSkip}] }
//
// Run modes:
//   node scripts/heal-tests.js              # full run
//   node scripts/heal-tests.js --quick      # only run tests that failed last run

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO, 'data', 'agent', 'tests-blocked.json');

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');

const TEST_DIRS = ['src/main/__tests__', 'tests'];
const presentDirs = TEST_DIRS.filter((d) => {
  try { return fs.statSync(path.join(REPO, d)).isDirectory(); } catch { return false; }
});
if (presentDirs.length === 0) {
  console.error('no test dirs found');
  process.exit(1);
}

const cmd = `npx vitest run --reporter=json ${presentDirs.map((d) => d + '/').join(' ')}`.trim();
console.log('running ' + cmd);
let raw;
try {
  raw = execSync(cmd, { encoding: 'utf8', timeout: 240000, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  raw = (e.stdout && e.stdout.toString()) || '';
  if (!raw) {
    console.error('vitest failed without output: ' + e.message);
    process.exit(2);
  }
}

const match = raw.match(/\{[\s\S]*\}\s*$/);
if (!match) {
  console.error('no JSON parsed from vitest output');
  process.exit(3);
}
const j = JSON.parse(match[0]);
const results = j.testResults || j.testFiles || [];

let total = 0;
let failed = 0;
const items = [];
for (const r of results) {
  const fileBase = (r.name || r.filepath || r.testFilePath || 'unknown').replace(/^.*[\\/]/, '');
  const tests = r.assertionResults || r.tasks || [];
  total += tests.length;
  for (const t of tests) {
    const state = t.status || (t.result && t.result.state);
    if (state !== 'failed') continue;
    failed++;
    const errs = t.failureMessages || (t.result && t.result.errors && t.result.errors.map((e) => e.message)) || [];
    items.push({
      file: fileBase,
      name: t.title || t.fullName || t.name || 'unknown',
      error: (errs[0] || '').split('\n')[0].slice(0, 220),
      // Heuristic: a failure mentioning "expected ... to contain" or "expected
      // ... to match" with stale string content is usually a fixture-drift
      // not a real bug. Prefer suggesting skip on those; suggest "fix" on
      // assertion-error / TypeError / undefined.
      suggestSkip: /to contain|to match|to be|toEqual|toBe/i.test(errs[0] || '') && !/TypeError|ReferenceError|undefined/i.test(errs[0] || ''),
    });
  }
}

const out = {
  ranAt: new Date().toISOString(),
  total,
  passed: total - failed,
  failed,
  files: results.length,
  items: items.slice(0, 200),
  command: cmd,
  next: failed === 0
    ? 'All green. Nothing to classify.'
    : 'Each item below is a click-through approval in the briefing -- "skip with reason" or "open file to fix".',
};

ensureDir(OUT_PATH);
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT_PATH} (${failed} failing of ${total} total)`);
if (QUICK && failed === 0) {
  console.log('quick exit: 0 failures');
}
