'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { testCategoryKey, TEST_CATEGORY_LABELS } = require('./system-health-tests-row');
const { releaseShaFromPhysicalRoot } = require('./release-identity');
const { writeJsonAtomic } = require('./briefing-cards/card-format');
const ROOT = path.resolve(__dirname, '../..');
const MAX_AGE_MS = 24 * 3600000;
const DEFAULT_SHARD_SIZE = 15;
const CATEGORY_DEFAULT_SHARD_SIZE = Object.freeze({ video: 5 });
const DEFAULT_SHARD_TIMEOUT_MS = 10 * 60 * 1000;
const EPHEMERAL_CONTROLLER_ENV = Object.freeze([
  'AMY_BRIEFING_SELF_HEAL_REFRESH',
  'BRIEFING_CARD_CONTROLLER_AUTHORITY',
  'BRIEFING_CARD_CONTROLLER_AUTHORITY_FILE',
  'BRIEFING_CONTROLLER_CARD',
  'BRIEFING_CONTROLLER_CONFLICT_LEASES',
  'BRIEFING_CONTROLLER_CONFLICT_LEASES_SHADOW_PASSED',
  'BRIEFING_CONTROLLER_MUTATION_REQUIRED',
  'BRIEFING_CONTROLLER_OWNER_KIND',
  'BRIEFING_CONTROLLER_TAKEOVER_REQUEST_ID',
  'BRIEFING_CONTROLLER_TRANSACTION',
  'BRIEFING_CONTROLLER_WORK_UNIT',
  'CARD_CONTROLLER_DIRECT_DELEGATION',
  'CARD_CONTROLLER_HOST_ADMISSION_TOKEN',
  'CARD_CONTROLLER_LEASE_TOKEN',
  'CARD_CONTROLLER_MAX_SECONDS',
  'CARD_CONTROLLER_OTTER_SCOPE',
  'CARD_CONTROLLER_PARENT_RUN_ID',
  'CARD_CONTROLLER_REVERIFY_ONLY',
  'CARD_CONTROLLER_SCOPE_HASH',
  'CARD_CONTROLLER_SCOPE_KEYS',
  'CARD_CONTROLLER_SCOPE_TOKEN',
  'CARD_CONTROLLER_SUPERVISOR_LOCK_PATH',
  'CARD_CONTROLLER_SUPERVISOR_LOCK_TOKEN',
  'CARD_CONTROLLER_SUPERVISOR_PID',
  'SB_SUPERVISED_REFRESH',
  'SELF_HEAL_REFRESH_CARDS',
  'SELF_HEAL_REFRESH_SKIP',
]);
const CATEGORY_FOR_SLUG = Object.freeze(Object.fromEntries(Object.keys(TEST_CATEGORY_LABELS).map((key) => [key === 'ranker' ? 'action-item-ranker' : key === 'health' ? 'self-heal' : key, key])));
function receiptPath(dataDir, category) {
  if (!Object.hasOwn(TEST_CATEGORY_LABELS, category)) throw new Error('Unknown test category');
  return path.join(dataDir, 'agent', 'system-health-test-categories', `${category}.json`);
}
function sourceSha(root) {
  try { const physical = releaseShaFromPhysicalRoot(fs.realpathSync(root)); if (physical) return physical; } catch {}
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}
function assertMatchingTestSource(repoRoot, sourceRoot, expectedSha = sourceSha(repoRoot)) {
  let checkoutSha = '';
  try {
    checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
  } catch { /* An installed copy cannot prove source checkout identity. */ }
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || sourceSha(repoRoot) !== expectedSha || checkoutSha !== expectedSha) {
    throw new Error('Test source checkout does not match the running release.');
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: sourceRoot, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (status.trim()) throw new Error('dirty');
  } catch { throw new Error('Test source checkout is dirty or cannot prove its files match the release.'); }
  return { sourceSha: expectedSha, sourceRoot, sourceClean: true };
}
// A deployed release can lag the build checkout. Test its immutable Git object
// in an owned detached worktree; never move or reset the shared source branch.
function acquireMatchingTestSource(repoRoot, sourceRoot = require('./codex-worktree').resolveCodexSourceRoot(repoRoot).repoRoot) {
  const expectedSha = sourceSha(repoRoot);
  if (sourceSha(sourceRoot) === expectedSha) {
    return { ...assertMatchingTestSource(repoRoot, sourceRoot, expectedSha), cleanup() {} };
  }
  const git = (args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('unknown release');
    git(['cat-file', '-e', `${expectedSha}^{commit}`]);
  } catch { throw new Error('Test source checkout does not match the running release and its exact Git object is unavailable.'); }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-release-test-source-'));
  const ownedRoot = path.join(parent, 'source');
  let added = false, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    if (added) git(['worktree', 'remove', '--force', ownedRoot]);
    fs.rmSync(parent, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    git(['worktree', 'add', '--detach', ownedRoot, expectedSha]); added = true;
    // Reuse installed dependencies only when their declaring inputs match.
    for (const name of ['package.json', 'package-lock.json']) {
      const read = root => { try { return fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
      const wanted = read(ownedRoot), installed = read(sourceRoot);
      if (wanted !== installed) throw new Error(`Exact-release test dependencies differ (${name}); prepare matching dependencies before retry.`);
    }
    const modules = path.join(sourceRoot, 'node_modules');
    if (!fs.existsSync(modules)) throw new Error('Exact-release test dependencies are missing.');
    fs.symlinkSync(fs.realpathSync(modules), path.join(ownedRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return { ...assertMatchingTestSource(repoRoot, ownedRoot, expectedSha), cleanup };
  } catch (error) { cleanup(); throw error; }
}
function categoryFiles(repoRoot, category) {
  // The tracked Vitest roster, not untracked files or Playwright suites that
  // Vitest excludes. These include/exclude shapes mirror vitest.config.ts.
  const files = execFileSync('git', ['ls-files', '-z', '--', 'scripts', 'src', 'tests'], { cwd: repoRoot, encoding: 'utf8', timeout: 10000 }).split('\0');
  return files.filter((file) =>
    (/^scripts\/__tests__\/.*\.test\.js$/.test(file) || /^src\/.*\/__tests__\/.*\.test\.ts$/.test(file) || /^tests\/.*\.spec\.ts$/.test(file)) &&
    !/\.pw\.spec\.ts$/.test(file) && file !== 'tests/projects.spec.ts' && testCategoryKey({ file }) === category,
  ).sort();
}
function normalizedResultName(sourceRoot, name) {
  const value = String(name || '');
  const relative = path.isAbsolute(value) ? path.relative(sourceRoot, value) : value;
  return relative.replace(/\\/g, '/').replace(/^\.\//, '');
}
function categoryTestEnvironment({ baseEnv = process.env, sourceRoot, testDataDir }) {
  const env = {
    ...baseEnv,
    NODE_ENV: 'test',
    SECONDBRAIN_ROOT: sourceRoot,
    SECONDBRAIN_DATA_DIR: testDataDir,
  };
  // Category proofs are independent test runs, not descendants authorized to
  // mutate on behalf of the controller that invoked the measurement. Retain
  // machine configuration and feature flags, but remove the outer run's
  // short-lived ownership, lease, supervisor, and mutation-fence identity.
  for (const name of EPHEMERAL_CONTROLLER_ENV) delete env[name];
  return env;
}
function categoryRosterDigest(files) {
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex');
}
function validateShardReport({ report, shard, sourceRoot, shardIndex }) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error(`Shard ${shardIndex + 1} produced invalid JSON test evidence.`);
  }
  for (const key of ['numPassedTests', 'numFailedTests', 'numPendingTests']) {
    if (!Number.isInteger(report[key]) || report[key] < 0) {
      throw new Error(`Shard ${shardIndex + 1} produced an invalid ${key} count.`);
    }
  }
  const reported = report.testResults.map((row) => normalizedResultName(sourceRoot, row?.name));
  const unique = new Set(reported);
  const expected = new Set(shard);
  if (
    reported.length !== shard.length ||
    unique.size !== reported.length ||
    [...unique].some((name) => !expected.has(name)) ||
    [...expected].some((name) => !unique.has(name))
  ) {
    throw new Error(`Shard ${shardIndex + 1} did not report its exact assigned file roster.`);
  }
  return {
    reported,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
  };
}
function readCategoryProof({ dataDir, category, repoRoot = ROOT, now = new Date(), sha = sourceSha(repoRoot) }) {
  let r;
  try { r = JSON.parse(fs.readFileSync(receiptPath(dataDir, category), 'utf8')); } catch {}
  const fail = (reason) => ({ status: 'red', detail: `${TEST_CATEGORY_LABELS[category]}: ${reason}; run its exact category probe before live verification.` });
  if (!r || r.schema !== 'system-health-test-category@1' || r.category !== category) return fail('no category-specific measured proof');
  const age = Number(now) - Date.parse(r.checkedAt);
  if (!sha || r.sourceSha !== sha || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return fail('wrong release, stale, or future category result');
  if (r.status !== 'green') return { status: 'red', detail: r.detail || 'Category run failed.' };
  const hasShardEvidence = ['shardSize', 'shardCount', 'completedShards', 'shards', 'skipped'].some((key) => Object.hasOwn(r, key));
  const durableRosterValid = !hasShardEvidence || (
    r.rosterEvidence?.schema === 'system-health-test-category-roster@1' &&
    r.rosterEvidence.selector === 'tracked-vitest-category@1' &&
    r.rosterEvidence.sourceSha === r.sourceSha &&
    r.rosterEvidence.sourceClean === true &&
    Number.isInteger(r.rosterEvidence.fileCount) &&
    Array.isArray(r.files) &&
    r.rosterEvidence.fileCount === r.files.length &&
    /^[a-f0-9]{64}$/.test(r.rosterEvidence.digest || '') &&
    r.rosterEvidence.digest === categoryRosterDigest(r.files)
  );
  let exactRoster = durableRosterValid;
  if (sourceSha(repoRoot) === sha) {
    try {
      // A source checkout can independently re-enumerate the selection. Keep
      // that stronger check whenever Git metadata is present.
      exactRoster = exactRoster && JSON.stringify(r.files) === JSON.stringify(categoryFiles(repoRoot, category));
    } catch {
      // Atomic installed releases intentionally contain no .git directory.
      // Their reader consumes the source-bound roster attestation written
      // while the producer held a clean exact-release checkout.
      if (!hasShardEvidence) exactRoster = false;
    }
  }
  const shardedValid = !hasShardEvidence || (
    Number.isInteger(r.shardSize) && r.shardSize > 0 && r.shardSize <= 50 &&
    Number.isInteger(r.shardCount) && r.shardCount > 0 && r.completedShards === r.shardCount &&
    r.shardCount === Math.ceil(r.files.length / r.shardSize) &&
    Number.isInteger(r.skipped) && r.skipped >= 0 && Array.isArray(r.shards) && r.shards.length === r.shardCount &&
    r.shards.every((shard, index) => shard?.index === index + 1 && Number.isInteger(shard.files) && shard.files === Math.min(r.shardSize, r.files.length - index * r.shardSize) && Number.isInteger(shard.passed) && shard.passed >= 0 && Number.isInteger(shard.failed) && shard.failed >= 0 && Number.isInteger(shard.skipped) && shard.skipped >= 0 && shard.exitCode === 0 && shard.success === true) &&
    r.shards.reduce((sum, shard) => sum + shard.files, 0) === r.files.length &&
    r.shards.reduce((sum, shard) => sum + shard.passed, 0) === r.passed &&
    r.shards.reduce((sum, shard) => sum + shard.failed, 0) === r.failed &&
    r.shards.reduce((sum, shard) => sum + shard.skipped, 0) === r.skipped
  );
  const timedExecutionValid = !Object.hasOwn(r, 'shardTimeoutMs') || (
    Number.isInteger(r.shardTimeoutMs) && r.shardTimeoutMs >= 1000 && r.shardTimeoutMs <= 60 * 60 * 1000 &&
    Number.isInteger(r.durationMs) && r.durationMs >= 0 &&
    r.shards.every((shard) => Number.isInteger(shard.durationMs) && shard.durationMs >= 0) &&
    r.shards.reduce((sum, shard) => sum + shard.durationMs, 0) <= r.durationMs
  );
  const valid = Array.isArray(r.files) && r.files.length > 0 && new Set(r.files).size === r.files.length && exactRoster && r.files.every((file) => testCategoryKey({ file }) === category) &&
    r.completedFiles === r.files.length && Number.isInteger(r.passed) && r.passed > 0 && r.failed === 0 && r.exitCode === 0 && /^[a-f0-9]{64}$/.test(r.inputDigest || '') && shardedValid && timedExecutionValid;
  return valid ? { status: 'green', detail: `${r.passed} assertions passed in all ${r.files.length} selected category files at ${r.checkedAt}; release ${sha.slice(0, 12)}.` } : fail('green result lacks complete category evidence');
}
function collectCategoryProof({ dataDir, category, repoRoot = ROOT, sourceRoot, now = new Date(), run = spawnSync, timeoutMs = DEFAULT_SHARD_TIMEOUT_MS, shardSize } = {}) {
  require('./scheduled-write-ownership').assertRuntimeDataRoot(dataDir);
  const proof = { schema: 'system-health-test-category@1', category, checkedAt: new Date(now).toISOString(), sourceSha: sourceSha(repoRoot), status: 'red' };
  const file = receiptPath(dataDir, category);
  let testDataDir, sourceLease, startedAtMs;
  try {
    if (!sourceRoot) { sourceLease = acquireMatchingTestSource(repoRoot); sourceRoot = sourceLease.sourceRoot; }
    assertMatchingTestSource(repoRoot, sourceRoot, proof.sourceSha);
    proof.sourceRoot = sourceRoot;
    const files = categoryFiles(sourceRoot, category);
    if (!files.length) throw new Error('No category test files exist in the release source checkout.');
    proof.files = files;
    proof.inputDigest = crypto.createHash('sha256').update(files.map((name) => `${name}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex')}`).join('\n')).digest('hex');
    proof.rosterEvidence = {
      schema: 'system-health-test-category-roster@1',
      selector: 'tracked-vitest-category@1',
      sourceSha: proof.sourceSha,
      sourceClean: true,
      fileCount: files.length,
      digest: categoryRosterDigest(files),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const output = `${file}.${process.pid}.${Date.now()}.vitest.json`;
    proof.outputPath = output;
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-health-category-data-'));
    const vitest = path.join(path.dirname(require.resolve('vitest/package.json', { paths: [sourceRoot, ROOT] })), 'vitest.mjs');
    const defaultShardSize = CATEGORY_DEFAULT_SHARD_SIZE[category] || DEFAULT_SHARD_SIZE;
    const boundedShardSize = Math.max(1, Math.min(50, Number.isInteger(shardSize) ? shardSize : defaultShardSize));
    const boundedTimeoutMs = Math.max(1000, Math.min(60 * 60 * 1000, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : DEFAULT_SHARD_TIMEOUT_MS));
    const shards = [];
    for (let index = 0; index < files.length; index += boundedShardSize) shards.push(files.slice(index, index + boundedShardSize));
    proof.shardSize = boundedShardSize;
    proof.shardTimeoutMs = boundedTimeoutMs;
    proof.shardCount = shards.length;
    proof.completedShards = 0;
    proof.passed = 0;
    proof.failed = 0;
    proof.skipped = 0;
    proof.completedFiles = 0;
    proof.shards = [];
    const allResults = [];
    let aggregateExitCode = 0;
    startedAtMs = Date.now();
    for (let index = 0; index < shards.length; index += 1) {
      const shard = shards[index];
      const shardOutput = `${output}.shard-${String(index + 1).padStart(3, '0')}-of-${String(shards.length).padStart(3, '0')}.json`;
      const shardStartedAtMs = Date.now();
      const result = run(process.execPath, [vitest, 'run', ...shard, '--maxWorkers=1', '--reporter=json', `--outputFile=${shardOutput}`], {
        cwd: sourceRoot,
        env: categoryTestEnvironment({ sourceRoot, testDataDir }),
        timeout: boundedTimeoutMs,
        // The JSON output file is the authoritative evidence. Ignoring console
        // streams prevents verbose tests from blocking while Vitest flushes a
        // captured stderr pipe; missing or incomplete JSON still fails closed.
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      assertMatchingTestSource(repoRoot, sourceRoot, proof.sourceSha);
      let report;
      try { report = JSON.parse(fs.readFileSync(shardOutput, 'utf8')); } catch { throw new Error(result.error?.message || `Shard ${index + 1} produced no complete JSON test result.`); }
      const counts = validateShardReport({ report, shard, sourceRoot, shardIndex: index });
      proof.passed += counts.passed;
      proof.failed += counts.failed;
      proof.skipped += counts.skipped;
      proof.completedFiles += counts.reported.length;
      proof.completedShards += 1;
      const exitCode = Number.isInteger(result.status) ? result.status : 1;
      if (exitCode !== 0 && aggregateExitCode === 0) aggregateExitCode = exitCode;
      proof.shards.push({
        index: index + 1,
        files: shard.length,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        exitCode,
        success: report.success === true,
        durationMs: Math.max(0, Date.now() - shardStartedAtMs),
      });
      allResults.push(...report.testResults);
      if (report.success !== true && aggregateExitCode === 0) aggregateExitCode = 1;
    }
    proof.exitCode = aggregateExitCode;
    proof.durationMs = Math.max(0, Date.now() - startedAtMs);
    writeJsonAtomic(output, {
      success: aggregateExitCode === 0 && proof.failed === 0,
      numPassedTests: proof.passed,
      numFailedTests: proof.failed,
      numPendingTests: proof.skipped,
      testResults: allResults,
    });
    proof.status = aggregateExitCode === 0 && proof.failed === 0 && proof.passed > 0 && proof.completedFiles === files.length && proof.completedShards === shards.length ? 'green' : 'red';
    proof.detail = `${proof.passed} passed; ${proof.failed} failed; ${proof.skipped} skipped; ${proof.completedFiles}/${files.length} category files completed across ${proof.completedShards}/${shards.length} shard(s); exit ${proof.exitCode}.`;
  } catch (error) {
    if (startedAtMs !== undefined) proof.durationMs = Math.max(0, Date.now() - startedAtMs);
    proof.detail = String(error.message || error).slice(0, 500);
  }
  finally {
    if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
    try { sourceLease?.cleanup(); } catch (error) { proof.status = 'red'; proof.detail = `Test source cleanup failed: ${error.message}`; }
  }
  writeJsonAtomic(file, proof);
  return proof;
}
module.exports = { CATEGORY_FOR_SLUG, CATEGORY_DEFAULT_SHARD_SIZE, DEFAULT_SHARD_SIZE, DEFAULT_SHARD_TIMEOUT_MS, EPHEMERAL_CONTROLLER_ENV, receiptPath, sourceSha, assertMatchingTestSource, acquireMatchingTestSource, categoryFiles, categoryTestEnvironment, readCategoryProof, collectCategoryProof, validateShardReport };
