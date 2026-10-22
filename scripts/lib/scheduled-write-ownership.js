'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTRY_RELATIVE_PATH = path.join('config', 'state-ownership.json');
const GIT_TIMEOUT_MS = 30_000;

function normalizeRepoPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function loadStateOwnership({ repoRoot } = {}) {
  const root = path.resolve(repoRoot || path.join(__dirname, '..', '..'));
  const file = path.join(root, REGISTRY_RELATIVE_PATH);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`state ownership registry is missing or invalid (${file}): ${error.message}`);
  }
  if (registry.schema !== 'amy.state_ownership.v1') {
    throw new Error(
      `state ownership registry has unsupported schema: ${registry.schema || 'missing'}`,
    );
  }
  if (!registry.scheduled_jobs || !registry.artifacts) {
    throw new Error('state ownership registry lacks scheduled_jobs or artifacts');
  }
  return registry;
}

function resolveRuntimeDataDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'secondbrain', 'data');
  }
  if (platform === 'linux') return '/opt/secondbrain/data';
  return path.resolve(homeDir, '.secondbrain', 'data');
}

const resolveScheduledRuntimeDataDir = resolveRuntimeDataDir;

function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function realPathWithMissingTail(candidate) {
  const resolved = path.resolve(candidate);
  const ancestor = nearestExistingAncestor(resolved);
  const realAncestor = fs.realpathSync.native(ancestor);
  const tail = path.relative(ancestor, resolved);
  return path.resolve(realAncestor, tail);
}

function runGitDefault(args, cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : '',
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function containingGitWorktree(candidate, { runGit = runGitDefault } = {}) {
  const resolved = realPathWithMissingTail(candidate);
  const ancestor = nearestExistingAncestor(resolved);
  const result = runGit(['rev-parse', '--show-toplevel'], ancestor);
  if (!result.ok) {
    if (result.status === 128 && /not a git repository/i.test(result.stderr)) return '';
    throw new Error(
      `unable to prove runtime data root is outside Git: ${resolved} ` +
        `(${result.error || result.stderr.trim() || result.signal || `exit ${result.status}`})`,
    );
  }
  const top = realPathWithMissingTail(result.stdout.trim());
  const relative = path.relative(top, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return top;
  return '';
}

function assertRuntimeDataRoot(dataDir, options = {}) {
  if (!dataDir) throw new Error('runtime data root is required');
  const resolved = path.resolve(dataDir);
  const worktree = containingGitWorktree(resolved, options);
  if (worktree) {
    throw new Error(
      `runtime data root resolves inside a Git worktree: ${resolved} (worktree ${worktree})`,
    );
  }
  return { ok: true, dataDir: resolved };
}

function readEc2InstanceIdentityDefault({ run = spawnSync } = {}) {
  const tokenResult = run(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '1',
      '--max-time',
      '2',
      '-X',
      'PUT',
      '-H',
      'X-aws-ec2-metadata-token-ttl-seconds: 60',
      'http://169.254.169.254/latest/api/token',
    ],
    { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (tokenResult.status !== 0 || !String(tokenResult.stdout || '').trim()) return null;
  const token = String(tokenResult.stdout).trim();
  const identityResult = run(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '1',
      '--max-time',
      '2',
      '-H',
      `X-aws-ec2-metadata-token: ${token}`,
      'http://169.254.169.254/latest/dynamic/instance-identity/document',
    ],
    { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (identityResult.status !== 0) return null;
  try {
    const document = JSON.parse(String(identityResult.stdout || ''));
    if (!document.instanceId || !document.region) return null;
    return { instanceId: String(document.instanceId), region: String(document.region) };
  } catch {
    return null;
  }
}

function pathspecCovers(pathspec, artifactPath) {
  const spec = normalizeRepoPath(pathspec);
  const artifact = normalizeRepoPath(artifactPath);
  if (!spec) return false;
  if (spec === artifact) return true;
  if (spec === 'data') return artifact === 'data' || artifact.startsWith('data/');
  return artifact.startsWith(`${spec}/`);
}

function validateGitLandingPathspecs({ pathspecs, registry, platform = process.platform } = {}) {
  if (!Array.isArray(pathspecs) || pathspecs.length === 0) {
    throw new Error('Git landing pathspecs must be a nonempty array');
  }
  const ownership = registry || loadStateOwnership();
  const normalized = pathspecs.map(normalizeRepoPath);
  const compare = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const compared = normalized.map(compare);
  const unsafe = normalized.find(
    (spec) => spec.split('/').includes('..') || /[*?\[\]{}]/.test(spec) || path.isAbsolute(spec),
  );
  if (unsafe)
    throw new Error(`Git landing pathspec must be a literal repo-relative path: ${unsafe}`);
  if (compared.includes('data')) {
    throw new Error('blanket data landing is forbidden; scheduled Git outputs must be explicit');
  }
  const runtimePaths = Object.entries(ownership.artifacts)
    .filter(([, row]) => row && row.storage_class === 'runtime')
    .map(([rel]) => compare(normalizeRepoPath(rel)));
  for (const spec of compared) {
    const covered = runtimePaths.find((rel) => pathspecCovers(spec, rel));
    if (covered) {
      throw new Error(`runtime-owned output cannot enter the Git lander: ${covered}`);
    }
  }
  return { ok: true, pathspecs: normalized };
}

function gitOutputRootsForJob({ skillName, registry, fallback = [] } = {}) {
  const ownership = registry || loadStateOwnership();
  const job = ownership.scheduled_jobs[String(skillName || '')];
  if (!job) return [...fallback];
  if (!Array.isArray(job.git_output_roots)) {
    throw new Error(`scheduled job ${skillName} lacks git_output_roots ownership`);
  }
  if (job.git_output_roots.length === 0) return [];
  return validateGitLandingPathspecs({
    pathspecs: job.git_output_roots,
    registry: ownership,
  }).pathspecs;
}

function scheduledRunCompletionOk({
  childStatus,
  runtimePublished,
  runtimeArchived,
  runtimeLiveRead = true,
  reapPostconditionClean,
} = {}) {
  return (
    Number.isFinite(childStatus) &&
    childStatus === 0 &&
    runtimePublished === true &&
    runtimeArchived === true &&
    runtimeLiveRead === true &&
    reapPostconditionClean === true
  );
}

function shouldArchiveCurrentRuntime({ executorOwnership } = {}) {
  return String((executorOwnership && executorOwnership.owner) || '').toLowerCase() !== 'attended';
}

function loadAttendedRunReceipt({ skillName, env = process.env } = {}) {
  const receiptPath = String(env.AMY_ATTENDED_RUN_RECEIPT || '').trim();
  if (!receiptPath) return null;
  if (!path.isAbsolute(receiptPath)) {
    throw new Error('attended scheduled-run receipt path must be absolute');
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`attended scheduled-run receipt is missing or invalid: ${error.message}`);
  }
  if (receipt.skill !== skillName) {
    throw new Error(
      `attended scheduled-run receipt is for ${receipt.skill || 'no job'}, not ${skillName}`,
    );
  }
  return receipt;
}

function validateAttendedRun({ skillName, job, receipt, now = new Date() } = {}) {
  if (!receipt) return null;
  const policy = job.attended_run;
  if (!policy || policy.allowed !== true) {
    throw new Error(`scheduled job ${skillName} does not allow an attended executor override`);
  }
  if (receipt.schema !== policy.receipt_schema) {
    throw new Error(`attended scheduled-run receipt has the wrong schema for ${skillName}`);
  }
  const authority = String(receipt.authorized_by || '').toLowerCase();
  const allowed = Array.isArray(policy.authorized_by)
    ? policy.authorized_by.map((value) => String(value).toLowerCase())
    : [];
  if (!allowed.includes(authority) || !String(receipt.reason || '').trim()) {
    throw new Error(
      `attended scheduled-run receipt lacks principal authority or reason for ${skillName}`,
    );
  }
  const issuedAt = Date.parse(receipt.issued_at || '');
  const expiresAt = Date.parse(receipt.expires_at || '');
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const maxTtlMs = Number(policy.max_ttl_minutes || 0) * 60_000;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(nowMs) ||
    issuedAt > nowMs + 60_000 ||
    expiresAt <= nowMs ||
    expiresAt <= issuedAt ||
    !maxTtlMs ||
    expiresAt - issuedAt > maxTtlMs
  ) {
    throw new Error(
      `attended scheduled-run receipt is expired or exceeds its TTL for ${skillName}`,
    );
  }
  return { ok: true, owner: 'attended', authorizedBy: authority, expiresAt: receipt.expires_at };
}

function assertScheduledExecutor({
  skillName,
  host,
  registry,
  canary = false,
  attendedReceipt = null,
  now = new Date(),
} = {}) {
  void canary;
  const ownership = registry || loadStateOwnership();
  const job = ownership.scheduled_jobs[String(skillName || '')];
  if (!job) return { ok: true, owner: 'legacy-unregistered' };
  const attended = validateAttendedRun({ skillName, job, receipt: attendedReceipt, now });
  if (attended) return attended;
  const expected = String((job.executor && job.executor.automatic_owner) || '');
  const identity =
    host && typeof host === 'object'
      ? host
      : { kind: String(host || '').toLowerCase(), instanceId: '' };
  const actual = String(identity.kind || '').toLowerCase();
  if (!expected) throw new Error(`scheduled job ${skillName} lacks an automatic owner`);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `scheduled job ${skillName} automatic owner is ${expected}; refusing executor ${actual || 'unknown'}`,
    );
  }
  const expectedInstance = String(job.executor.owner_instance_id || '');
  if (expectedInstance && String(identity.instanceId || '') !== expectedInstance) {
    throw new Error(
      `scheduled job ${skillName} owner instance is ${expectedInstance}; refusing ${identity.instanceId || 'unproven instance'}`,
    );
  }
  const expectedRegion = String(job.executor.owner_region || '');
  if (expectedRegion && String(identity.region || '') !== expectedRegion) {
    throw new Error(
      `scheduled job ${skillName} owner region is ${expectedRegion}; refusing ${identity.region || 'unproven region'}`,
    );
  }
  return {
    ok: true,
    owner: expected,
    instanceId: identity.instanceId || null,
    region: identity.region || null,
  };
}

function scheduledHost({
  env = process.env,
  platform = process.platform,
  readInstanceIdentity = readEc2InstanceIdentityDefault,
} = {}) {
  if (platform === 'linux') {
    try {
      const identity = readInstanceIdentity();
      if (identity && identity.instanceId && identity.region) {
        return {
          kind: 'cloud',
          instanceId: String(identity.instanceId),
          region: String(identity.region),
        };
      }
    } catch {
      // Fail closed below.
    }
    return { kind: 'linux-unproven', instanceId: '', region: '' };
  }
  if (platform === 'win32') {
    return { kind: 'desktop', instanceId: String(env.COMPUTERNAME || '').toLowerCase() };
  }
  return { kind: 'unknown', instanceId: '' };
}

module.exports = {
  REGISTRY_RELATIVE_PATH,
  assertRuntimeDataRoot,
  assertScheduledExecutor,
  containingGitWorktree,
  gitOutputRootsForJob,
  loadStateOwnership,
  loadAttendedRunReceipt,
  normalizeRepoPath,
  pathspecCovers,
  readEc2InstanceIdentityDefault,
  realPathWithMissingTail,
  resolveRuntimeDataDir,
  resolveScheduledRuntimeDataDir,
  scheduledRunCompletionOk,
  shouldArchiveCurrentRuntime,
  scheduledHost,
  validateAttendedRun,
  validateGitLandingPathspecs,
};
