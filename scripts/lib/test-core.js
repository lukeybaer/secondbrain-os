'use strict';
/**
 * The cognitive core and the architecture checks (ship-jam S-2, owner decision).
 *
 * A land is blocked only by three things: the core (config/test-core.json, about
 * 500 behavior cases across the production features), the architecture checks
 * (the core-design drift lint chain, `npm run verify:core-drift`), and the tests
 * picked by what the change touches. Everything else runs after the deploy and
 * never blocks. Past the case cap, a new core test means merging or retiring one.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join('config', 'test-core.json');
const CASE_RE = /^\s*(?:it|test)(?:\.each\([^)]*\))?(?:\.only|\.concurrent)?\s*\(/gm;

function loadManifest(root = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
}

function coreFiles(root = REPO_ROOT) {
  try {
    const m = loadManifest(root);
    return [...new Set(Object.values(m.features || {}).flatMap((f) => f.files || []))];
  } catch {
    return [];
  }
}

/** Static case count (it/test calls), the same count the cap is held to. */
function countCases(root, file) {
  try {
    return (fs.readFileSync(path.join(root, file), 'utf8').match(CASE_RE) || []).length;
  } catch {
    return 0;
  }
}

/** Problems that block a land: missing core files, or the core past its case cap. */
function coreBudgetProblems(root = REPO_ROOT) {
  let m;
  try {
    m = loadManifest(root);
  } catch (err) {
    return [`config/test-core.json is unreadable: ${String(err.message).slice(0, 200)}`];
  }
  const problems = [];
  const files = coreFiles(root);
  const missing = files.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) problems.push(`core test file(s) missing: ${missing.join(', ')}; delete a core test only by replacing it in config/test-core.json`);
  const cases = files.reduce((n, f) => n + countCases(root, f), 0);
  const cap = (m.budget && m.budget.maxCases) || 560;
  if (cases > cap) problems.push(`the core holds ${cases} cases, past its cap of ${cap}; merge or retire a core test before adding one`);
  return problems;
}

/** The architecture checks: each `node scripts/verify-*.js` in the verify:core-drift chain. */
function architectureChecks(root = REPO_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return String(pkg.scripts['verify:core-drift'] || '')
      .split('&&')
      .map((s) => s.trim().split(/\s+/))
      .filter((p) => p[0] === 'node' && p[1])
      .map((p) => p.slice(1));
  } catch {
    return [];
  }
}

/**
 * Run every architecture check in parallel. Resolves to
 * { ok, failures: [{check, code, tail}], ms }. A check that cannot start fails.
 */
// A fresh worktree may have no node_modules junction; the checks then cannot load
// js-yaml and report false drift. Point them at the main checkout's node_modules.
function checkEnv(root, env = process.env) {
  if (fs.existsSync(path.join(root, 'node_modules', 'js-yaml', 'package.json'))) return env;
  let shared;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    shared = path.join(path.dirname(common), 'node_modules');
  } catch {
    return env;
  }
  if (!fs.existsSync(path.join(shared, 'js-yaml', 'package.json'))) return env;
  return { ...env, NODE_PATH: [shared, env.NODE_PATH].filter(Boolean).join(path.delimiter) };
}

function runArchitectureChecks({ root = REPO_ROOT, timeoutMs = 120000, spawnImpl = spawn, now = Date.now } = {}) {
  const started = now();
  const checks = architectureChecks(root);
  const env = checkEnv(root);
  if (!checks.length) return Promise.resolve({ ok: false, failures: [{ check: 'verify:core-drift', code: null, tail: 'no architecture checks found in package.json' }], ms: 0 });
  return Promise.all(checks.map((args) => new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnImpl(process.execPath, args, { cwd: root, windowsHide: true, env });
    } catch (err) {
      resolve({ check: args[0], code: null, tail: String(err.message) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const keep = (d) => { out = (out + d).slice(-4000); };
    if (child.stdout) child.stdout.on('data', keep);
    if (child.stderr) child.stderr.on('data', keep);
    child.on('error', (err) => { clearTimeout(timer); resolve({ check: args[0], code: null, tail: String(err.message) }); });
    // First line (usually the real error or the count) plus the last two.
    const brief = (lines) => (lines.length > 3 ? [lines[0], '...', ...lines.slice(-2)] : lines).join(' | ');
    child.on('close', (code) => { clearTimeout(timer); resolve({ check: args[0], code, tail: brief(out.trim().split(/\r?\n/)) }); });
  }))).then((results) => {
    const failures = results.filter((r) => r.code !== 0);
    return { ok: failures.length === 0, failures, ms: now() - started, count: checks.length };
  });
}

/** Append per-file results from a vitest JSON report to the test history (90-day proof for the cut). */
function appendTestHistory({ report, sha, source, file }) {
  try {
    const rows = (report && report.testResults ? report.testResults : []).map((t) => ({
      ts: new Date().toISOString(),
      sha: sha || null,
      source,
      file: path.relative(REPO_ROOT, t.name || '').replace(/\\/g, '/'),
      status: t.status,
      ms: Number.isFinite(t.endTime - t.startTime) ? t.endTime - t.startTime : null,
      failed: (t.assertionResults || []).filter((a) => a.status === 'failed').length,
    }));
    if (!rows.length) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return rows.length;
  } catch {
    return 0;
  }
}

if (require.main === module && process.argv.includes('--architecture')) {
  runArchitectureChecks({ root: process.cwd() }).then((r) => {
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  });
}

module.exports = { MANIFEST, loadManifest, coreFiles, countCases, coreBudgetProblems, architectureChecks, checkEnv, runArchitectureChecks, appendTestHistory };
