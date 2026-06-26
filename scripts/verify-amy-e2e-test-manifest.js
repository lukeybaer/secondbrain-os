#!/usr/bin/env node
// Verifier gate for the Amy E2E overhaul (dev-plans/amy-e2e-review-cloud-first-2026-06-11.html).
//
// Reads dev-plans/amy-e2e-test-manifest.json, checks every entry:
//   - status "held"  -> skipped (ExampleCo explicitly deferred it; reported, never run)
//   - file missing   -> reported as missing (phase cannot claim done)
//   - file present   -> executed via vitest; pass/fail recorded back into the manifest
//
// Output: per-epic scorecard (key X/N, regression X/N) + data/agent/amy-e2e-verify-report.json.
// Exit 0 only when every non-held test in scope exists and passes.
//
// Usage:
//   node scripts/verify-amy-e2e-test-manifest.js            # full run, all epics
//   node scripts/verify-amy-e2e-test-manifest.js --epic E0  # phase gate for one epic
//   npm run verify:amy-e2e

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'dev-plans', 'amy-e2e-test-manifest.json');
const REPORT_PATH = path.join(REPO, 'data', 'agent', 'amy-e2e-verify-report.json');
const VITEST_TIMEOUT_MS = 10 * 60 * 1000;

function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Pure: split manifest tests into held / missing / present for a given epic filter.
function partitionTests(tests, { epic = null, repoRoot = REPO, exists = null } = {}) {
  const fileExists = exists || ((f) => fs.existsSync(path.join(repoRoot, f)));
  const inScope = tests.filter((t) => !epic || t.epic === epic);
  const held = inScope.filter((t) => t.status === 'held');
  const runnable = inScope.filter((t) => t.status !== 'held');
  const missing = runnable.filter((t) => !fileExists(t.file));
  const present = runnable.filter((t) => fileExists(t.file));
  return { inScope, held, missing, present };
}

// Pure: build the per-epic scorecard from partitioned + executed results.
function buildScorecard(tests, resultsByFile) {
  const epics = {};
  for (const t of tests) {
    const e = (epics[t.epic] ||= {
      key: { passing: 0, failing: 0, missing: 0, held: 0, total: 0 },
      regression: { passing: 0, failing: 0, missing: 0, held: 0, total: 0 },
    });
    const bucket = e[t.type];
    if (!bucket) continue;
    bucket.total += 1;
    if (t.status === 'held') bucket.held += 1;
    else if (resultsByFile[t.file] === 'passed') bucket.passing += 1;
    else if (resultsByFile[t.file] === 'failed') bucket.failing += 1;
    else bucket.missing += 1;
  }
  return epics;
}

function runVitest(files, repoRoot = REPO) {
  if (!files.length) return {};
  const jsonOut = path.join(repoRoot, 'data', 'agent', 'amy-e2e-vitest-out.json');
  const args = ['vitest', 'run', '--reporter=json', `--outputFile=${jsonOut}`, ...files];
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: VITEST_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
  const results = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    for (const tr of parsed.testResults || []) {
      const rel = path.relative(repoRoot, tr.name).replace(/\\/g, '/');
      results[rel] = tr.status === 'passed' ? 'passed' : 'failed';
    }
  } catch (err) {
    // Reporter output unusable: mark every file failed so the gate fails loud, never silent.
    for (const f of files) results[f] = 'failed';
    results.__error = `vitest reporter parse failed: ${err.message}; exit=${res.status}`;
  }
  return results;
}

function formatScorecard(epics, epicNames = {}) {
  const lines = [];
  for (const [epic, s] of Object.entries(epics).sort()) {
    const k = s.key;
    const r = s.regression;
    const tag = (b) =>
      `${b.passing}/${b.total - b.held} passing` +
      (b.held ? ` (${b.held} held)` : '') +
      (b.missing ? ` [${b.missing} MISSING]` : '') +
      (b.failing ? ` [${b.failing} FAILING]` : '');
    lines.push(
      `${epic} ${epicNames[epic] || ''}\n  key:        ${tag(k)}\n  regression: ${tag(r)}`,
    );
  }
  return lines.join('\n');
}

function main() {
  const epicArgIdx = process.argv.indexOf('--epic');
  const epic = epicArgIdx >= 0 ? process.argv[epicArgIdx + 1] : null;

  const manifest = loadManifest();
  const { inScope, held, missing, present } = partitionTests(manifest.tests, { epic });

  console.log(
    `[verify:amy-e2e] scope=${epic || 'ALL'} tests=${inScope.length} held=${held.length} missing=${missing.length} running=${present.length}`,
  );
  const resultsByFile = runVitest(present.map((t) => t.file));

  // Persist statuses back into the manifest so it stays the live source of truth.
  for (const t of manifest.tests) {
    if (t.status === 'held') continue;
    if (!epic || t.epic === epic) {
      if (resultsByFile[t.file] === 'passed') t.status = 'passing';
      else if (resultsByFile[t.file] === 'failed') t.status = 'failing';
      else if (missing.includes(t)) t.status = 'planned';
    }
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  const scorecard = buildScorecard(inScope, resultsByFile);
  const failures = present.filter((t) => resultsByFile[t.file] !== 'passed');
  const report = {
    ranAt: new Date().toISOString(),
    scope: epic || 'ALL',
    scorecard,
    held: held.map((t) => ({ id: t.id, reason: t.holdReason || '' })),
    missing: missing.map((t) => ({ id: t.id, file: t.file })),
    failing: failures.map((t) => ({ id: t.id, file: t.file })),
    gate: failures.length === 0 && missing.length === 0 ? 'GREEN' : 'RED',
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  console.log(formatScorecard(scorecard, manifest.epics));
  console.log(`[verify:amy-e2e] gate=${report.gate} report=${path.relative(REPO, REPORT_PATH)}`);
  if (report.gate !== 'GREEN') process.exit(1);
}

if (require.main === module) main();

module.exports = { loadManifest, partitionTests, buildScorecard, formatScorecard };
