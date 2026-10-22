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
function runCategoryGate({ changedFiles, categoryOf, listCategoryFiles, runVitest, runAtBase, log = () => {} }) {
  const categories = categoriesForChangedFiles(changedFiles, { categoryOf });
  if (!categories.length) {
    log('category gate: no changed code file belongs to a named test category; nothing to run.');
    return { green: true, categories, ranCount: 0, newFailures: [], preexisting: [] };
  }
  const files = [...new Set(categories.flatMap((c) => listCategoryFiles(c)))].sort();
  log(`category gate: running the whole ${categories.join(', ')} categor${categories.length === 1 ? 'y' : 'ies'} (${files.length} files).`);
  const head = runVitest(files);
  if (head.timedOut || head.crashed) {
    log(`category gate: the category run ${head.timedOut ? 'timed out' : 'did not produce a report'}; refusing the land.`);
    return { green: false, categories, ranCount: files.length, newFailures: [], preexisting: [], reason: head.timedOut ? 'timeout' : 'no-report' };
  }
  if (!head.failedFiles.length) {
    log('category gate: green.');
    return { green: true, categories, ranCount: files.length, newFailures: [], preexisting: [] };
  }
  log(`category gate: ${head.failedFiles.length} file(s) failed; checking which also fail on master.`);
  const base = runAtBase(head.failedFiles);
  const baseFailed = new Set((base && base.failedFiles) || []);
  const newFailures = base ? head.failedFiles.filter((f) => !baseFailed.has(f)) : head.failedFiles;
  const preexisting = head.failedFiles.filter((f) => baseFailed.has(f));
  for (const f of preexisting) log(`  pre-existing on master (not blocking): ${f}`);
  for (const f of newFailures) log(`  NEW failure from this change: ${f}`);
  if (!base) log('category gate: master could not be checked, so every failure counts as new.');
  return { green: newFailures.length === 0, categories, ranCount: files.length, newFailures, preexisting };
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
  vitestRunner,
};
