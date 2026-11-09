'use strict';

// Land-time category gate (#b 2026-10-16, change 2). The scoped land gate ran
// 12 related files for the Oct 15 lands, so 17 breaks elsewhere in the
// Briefing and Ingest categories surfaced only in the night's System Health
// probe. Land now also runs the whole System Health test category of every
// changed code file and refuses any failure that master does not already
// have. Pre-existing reds on master never block (that would freeze every
// lander, the reason the gate was scoped in the first place), and the
// catch-all "other" category (over 1,000 files) stays with the nightly probe.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKIPPED_CATEGORIES = new Set(['other']);
const CODE_PATH = /^(scripts|src|tests|config)\//;

// Non-code files (docs, .md, .json references) have no test category, yet
// tests read them through fs (the Oct 26 startup.md edit broke a brand-lock test
// nobody ran). Any test file whose source names a changed non-code file by
// repo-relative path or basename runs with the category gate. Bounded by
// scope, not by count (Codex F1, 2026-10-28): only test files under the given
// roots are read and generic basenames match by full path only, but every
// matching test runs. A cap of 60 would have dropped the sixty-first test of
// a wide change silently, which is the morning-red class this gate exists for.
const CODE_EXT = /\.(c?js|mjs|jsx|tsx?)$/i;
const TEST_FILE = /\.test\.(c?js|mjs|jsx|tsx?)$/i;
const GENERIC_BASENAMES = new Set(['readme.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'index.md', 'index.json', 'memory.md', 'skill.md', 'lessons.md', 'learnings.md']);

function listTestFiles(root, dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (TEST_FILE.test(e.name)) out.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

function testsReadingChangedFiles(changedFiles = [], { root, testRoots = ['scripts/__tests__', 'tests'] } = {}) {
  const needles = [];
  for (const raw of changedFiles) {
    const file = String(raw || '').replace(/\\/g, '/');
    if (!file || CODE_EXT.test(file)) continue;
    needles.push(file);
    const base = path.posix.basename(file);
    if (base.length >= 5 && !GENERIC_BASENAMES.has(base.toLowerCase())) needles.push(base);
  }
  if (!needles.length || !root) return [];
  const hits = [];
  for (const test of listTestFiles(root, testRoots)) {
    let text;
    try { text = fs.readFileSync(path.join(root, test), 'utf8'); } catch { continue; }
    if (needles.some((n) => text.includes(n))) hits.push(test);
  }
  return hits.sort();
}

// S-2 (#b 2026-10-28): the category gate skips the catch-all "other" category
// (over 1,000 files), so a change to heal-executor.js, session-sweep.mjs or
// emails-to-action.js ran none of their own tests and four were red by
// morning. Any test file that imports or requires a changed code file (by
// repo-relative path or by basename, with or without the extension) now runs
// with the gate, whatever its category. Bounded by scope like the reader
// selector, never by count.
const CODE_BASENAME_SKIP = new Set(['index', 'main', 'utils', 'util', 'helpers', 'config', 'constants', 'types']);
const IMPORT_EXT = '(\\.(c?js|mjs|jsx|tsx?))?[\'"`)]';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testsImportingChangedFiles(changedFiles = [], { root, testRoots = ['scripts/__tests__', 'tests'] } = {}) {
  const needles = [];
  for (const raw of changedFiles) {
    const file = String(raw || '').replace(/\\/g, '/');
    if (!file || !CODE_EXT.test(file) || TEST_FILE.test(file)) continue;
    const stem = file.replace(CODE_EXT, '');
    const base = path.posix.basename(stem);
    needles.push(new RegExp(`${escapeRegExp(stem)}${IMPORT_EXT}`));
    if (base.length >= 5 && !CODE_BASENAME_SKIP.has(base.toLowerCase())) {
      needles.push(new RegExp(`/${escapeRegExp(base)}${IMPORT_EXT}`));
      // S-1 (#b 2026-11-01): tests that spawn a script build its path from
      // segments, path.join(REPO, 'scripts', 'otter-wavlm-speaker-resolver.js'),
      // so neither needle above matched and three resolver tests went red on
      // master. A quoted basename with its extension is a reference too.
      needles.push(new RegExp(`['"\`]${escapeRegExp(path.posix.basename(file))}['"\`]`));
    }
  }
  if (!needles.length || !root) return [];
  const hits = [];
  for (const test of listTestFiles(root, testRoots)) {
    let text;
    try { text = fs.readFileSync(path.join(root, test), 'utf8'); } catch { continue; }
    if (needles.some((n) => n.test(text))) hits.push(test);
  }
  return hits.sort();
}

function categoriesForChangedFiles(changedFiles = [], { categoryOf } = {}) {
  const out = new Set();
  for (const raw of changedFiles) {
    const file = String(raw || '').replace(/\\/g, '/');
    if (!CODE_PATH.test(file)) continue;
    const category = categoryOf(file);
    if (category && !SKIPPED_CATEGORIES.has(category)) out.add(category);
  }
  return [...out].sort();
}

// Vitest JSON report -> repo-relative failing test files. Only a failed file
// counts; skipped or pending files are not failures (Codex review 7f4fce6d5978).
function failedFilesFromReport(report, root) {
  const results = Array.isArray(report && report.testResults) ? report.testResults : [];
  return results
    .filter((r) => r && r.status === 'failed')
    .map((r) => {
      const name = String(r.name || '');
      return (path.isAbsolute(name) ? path.relative(root, name) : name).replace(/\\/g, '/');
    })
    .filter(Boolean)
    .sort();
}

// runVitest(files, cwd) -> { failedFiles: string[], timedOut: boolean, crashed: boolean }
// runAtBase(files) -> { failedFiles: string[] } | null when the base cannot be checked
function runCategoryGate({ changedFiles, categoryOf, listCategoryFiles, runVitest, runAtBase, listReaderTests, log = () => {} }) {
  const categories = categoriesForChangedFiles(changedFiles, { categoryOf });
  const readers = listReaderTests ? listReaderTests(changedFiles) : [];
  if (!categories.length && !readers.length) {
    log('category gate: no changed code file belongs to a named test category and no test reads a changed file; nothing to run.');
    return { green: true, categories, ranCount: 0, newFailures: [], preexisting: [], files: [] };
  }
  const files = [...new Set([...categories.flatMap((c) => listCategoryFiles(c)), ...readers])].sort();
  if (readers.length) log(`category gate: ${readers.length} test file(s) read or import a changed file: ${readers.slice(0, 5).join(', ')}${readers.length > 5 ? ', ...' : ''}.`);
  if (categories.length) log(`category gate: running the whole ${categories.join(', ')} categor${categories.length === 1 ? 'y' : 'ies'} (${files.length} files).`);
  const head = runVitest(files);
  if (head.timedOut || head.crashed) {
    log(`category gate: the category run ${head.timedOut ? 'timed out' : 'did not produce a report'}; refusing the land.`);
    return { green: false, categories, ranCount: files.length, newFailures: [], preexisting: [], files, reason: head.timedOut ? 'timeout' : 'no-report' };
  }
  if (!head.failedFiles.length) {
    log('category gate: green.');
    return { green: true, categories, ranCount: files.length, newFailures: [], preexisting: [], files };
  }
  log(`category gate: ${head.failedFiles.length} file(s) failed; checking which also fail on master.`);
  const base = runAtBase(head.failedFiles);
  const baseFailed = new Set((base && base.failedFiles) || []);
  const preexisting = head.failedFiles.filter((f) => baseFailed.has(f));
  let newFailures = base ? head.failedFiles.filter((f) => !baseFailed.has(f)) : head.failedFiles;
  // Like with like (2026-10-28): master reruns only the failed files, alone,
  // while the change ran them inside the full parallel category run. Three
  // lands in a row were refused by a different unrelated file each time (a
  // Windows rename race, a mock-call race, a 1 ms clock skew), each green
  // alone on both sides. A candidate new failure is rerun alone at this change
  // too, the same way master was checked; only one that fails again blocks.
  let flaky = [];
  if (base && newFailures.length) {
    const again = runVitest(newFailures);
    if (!again.timedOut && !again.crashed) {
      const stillFailed = new Set(again.failedFiles);
      flaky = newFailures.filter((f) => !stillFailed.has(f));
      newFailures = newFailures.filter((f) => stillFailed.has(f));
    }
  }
  for (const f of preexisting) log(`  pre-existing on master (not blocking): ${f}`);
  for (const f of flaky) log(`  failed only under the full parallel run, passes alone here and on master (flaky, not blocking): ${f}`);
  for (const f of newFailures) log(`  NEW failure from this change: ${f}`);
  if (!base) log('category gate: master could not be checked, so every failure counts as new.');
  return { green: newFailures.length === 0, categories, ranCount: files.length, newFailures, preexisting, flaky, files };
}

// One vitest process per shard: a single 518-file run exhausted the 4 GB heap
// on the first real land check, and the nightly probe shards for the same reason.
const DEFAULT_SHARD_SIZE = 30;

function vitestRunner({ vitestEntry, nodePath, spawnSync, timeoutMs, env = process.env, shardSize = DEFAULT_SHARD_SIZE }) {
  const runShard = (files, cwd) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-category-'));
    const outFile = path.join(outDir, 'report.json');
    try {
      const res = spawnSync(
        process.execPath,
        [vitestEntry, 'run', '--reporter=dot', '--reporter=json', `--outputFile.json=${outFile}`, ...files],
        { cwd, stdio: 'inherit', env: { ...env, NODE_PATH: nodePath }, timeout: timeoutMs, windowsHide: true },
      );
      if (res.error && res.error.code === 'ETIMEDOUT') return { failedFiles: [], timedOut: true, crashed: false };
      if (res.error || res.signal || !fs.existsSync(outFile)) return { failedFiles: [], timedOut: false, crashed: true };
      const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const failedFiles = failedFilesFromReport(report, cwd);
      // A red exit or unsuccessful report must name a failed file; otherwise the
      // shard crashed (worker OOM, teardown error) or collected nothing, and
      // reading it as green would defeat the gate (Codex review 064c3efdf93b).
      const collected = Array.isArray(report && report.testResults) ? report.testResults.length : 0;
      const unexplained = (res.status !== 0 || (report && report.success === false)) && !failedFiles.length;
      if (unexplained || collected === 0) return { failedFiles, timedOut: false, crashed: true };
      return { failedFiles, timedOut: false, crashed: false };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };
  return (files, cwd) => {
    const out = { failedFiles: [], timedOut: false, crashed: false };
    for (let i = 0; i < files.length; i += shardSize) {
      const shard = runShard(files.slice(i, i + shardSize), cwd);
      out.failedFiles.push(...shard.failedFiles);
      if (shard.timedOut || shard.crashed) return { ...out, timedOut: shard.timedOut, crashed: shard.crashed };
    }
    out.failedFiles.sort();
    return out;
  };
}

module.exports = {
  DEFAULT_SHARD_SIZE,
  SKIPPED_CATEGORIES,
  categoriesForChangedFiles,
  failedFilesFromReport,
  runCategoryGate,
  testsReadingChangedFiles,
  testsImportingChangedFiles,
  vitestRunner,
};
