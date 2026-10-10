const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  launchVoiceTask,
  stageRawToEfs,
  stageVoiceIdentityRegistry,
  stageVoiceStageBudgets,
} = require('./voice-fargate-trigger');

const MAX_COHORT_CALLS = 47;
const DEFAULT_TASK_VCPU = 2;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, 'utf8');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validateCohortManifest(manifest, { maxCalls = MAX_COHORT_CALLS } = {}) {
  if (!manifest || !Array.isArray(manifest.calls) || manifest.calls.length === 0) {
    throw new Error('cohort manifest must contain at least one call');
  }
  if (manifest.calls.length > maxCalls) {
    throw new Error(`cohort manifest exceeds the ${maxCalls} calls safety limit`);
  }
  const seen = new Set();
  const calls = manifest.calls.map((call, index) => {
    const otid = String(call?.otid || '').trim();
    const sourceRevision = String(call?.sourceRevision || call?.source_revision || '').toLowerCase();
    if (!otid) throw new Error(`call ${index + 1} is missing otid`);
    if (seen.has(otid)) throw new Error(`duplicate otid in cohort manifest: ${otid}`);
    seen.add(otid);
    if (!/^[a-f0-9]{64}$/.test(sourceRevision)) {
      throw new Error(`call ${otid} has an invalid source revision`);
    }
    return { ...call, otid, sourceRevision };
  });
  return { ...manifest, calls };
}

function buildCohortBundle({
  runId,
  manifest,
  registrySnapshot,
  stageBudgets,
}) {
  const exact = validateCohortManifest(manifest);
  const bundle = {
    schema: 'secondbrain.otter-cohort-run-bundle.v1',
    run_id: String(runId),
    cohort: exact.cohort || null,
    calls: exact.calls.map((call) => ({
      otid: call.otid,
      title: call.title || call.otid,
      source_revision: call.sourceRevision,
      needs_acoustic: call.needsAcoustic !== false,
    })),
    registry_snapshot_path: registrySnapshot?.snapshot_path || null,
    registry_snapshot_sha256: registrySnapshot?.snapshot_sha256 || null,
    stage_budgets: stageBudgets
      ? {
          snapshot_path: stageBudgets.snapshot_path || null,
          snapshot_sha256:
            stageBudgets.snapshot_sha256 || sha256(canonicalBytes(stageBudgets)),
          mode: stageBudgets.mode || null,
        }
      : null,
  };
  const bytes = canonicalBytes(bundle);
  return { bundle, bytes, sha256: sha256(bytes) };
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}

function awsJson(spawnSyncFn, args) {
  const result = spawnSyncFn('aws', args, { encoding: 'utf8', timeout: 60000 });
  if (!result || result.status !== 0) {
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} failed: ${String(result?.stderr || '').slice(-400)}`);
  }
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`AWS ${args.slice(0, 2).join(' ')} returned unreadable JSON`);
  }
}

function verifyS3Object({ spawnSyncFn, bucket, key, bytes }) {
  const head = awsJson(spawnSyncFn, [
    's3api',
    'head-object',
    '--bucket',
    bucket,
    '--key',
    key,
    '--output',
    'json',
  ]);
  const expected = sha256(bytes);
  if (Number(head.ContentLength) !== bytes.length || head.Metadata?.sha256 !== expected) {
    throw new Error(`S3 object verification failed for ${key}`);
  }
}

function isMountedPath(target, { mountInfoPath = '/proc/self/mountinfo' } = {}) {
  if (process.platform !== 'linux') return false;
  let resolved;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return false;
  }
  try {
    return fs
      .readFileSync(mountInfoPath, 'utf8')
      .split(/\r?\n/)
      .some((line) => {
        const fields = line.split(' ');
        const mountPoint = String(fields[4] || '')
          .replace(/\\040/g, ' ')
          .replace(/\\011/g, '\t')
          .replace(/\\134/g, '\\');
        return mountPoint && path.resolve(mountPoint) === path.resolve(resolved);
      });
  } catch {
    return false;
  }
}

function persistCohortBundle({
  bundle,
  bytes,
  sha256: bundleSha256,
  runDir,
  efsData,
  bucket,
  prefix,
  spawnSyncFn = spawnSync,
  verifyEfsMountFn = isMountedPath,
  completedAt = new Date().toISOString(),
}) {
  if (!bucket || !prefix) throw new Error('S3 bucket and cohort prefix are required');
  if (!verifyEfsMountFn(efsData)) {
    throw new Error(`EFS cohort bundle path is not a mounted filesystem: ${efsData}`);
  }
  const localBundle = path.join(runDir, 'bundle.json');
  const efsBundle = path.join(efsData, 'agent', 'otter-cohort-runs', bundle.run_id, 'bundle.json');
  writeAtomic(localBundle, bytes);
  writeAtomic(efsBundle, bytes);
  const bundleKey = `${prefix.replace(/\/$/, '')}/bundle.json`;
  awsJson(spawnSyncFn, [
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    bundleKey,
    '--body',
    localBundle,
    '--metadata',
    `sha256=${bundleSha256}`,
    '--output',
    'json',
  ]);
  verifyS3Object({ spawnSyncFn, bucket, key: bundleKey, bytes });

  const receipt = {
    schema: 'secondbrain.otter-cohort-run-bundle-receipt.v1',
    run_id: bundle.run_id,
    bundle_sha256: bundleSha256,
    bundle_bytes: bytes.length,
    completed_at: completedAt,
  };
  const receiptBytes = canonicalBytes(receipt);
  const localReceipt = path.join(runDir, 'bundle-receipt.json');
  const efsReceipt = path.join(
    efsData,
    'agent',
    'otter-cohort-runs',
    bundle.run_id,
    'bundle-receipt.json',
  );
  writeAtomic(localReceipt, receiptBytes);
  writeAtomic(efsReceipt, receiptBytes);
  const receiptKey = `${prefix.replace(/\/$/, '')}/receipt.json`;
  awsJson(spawnSyncFn, [
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    receiptKey,
    '--body',
    localReceipt,
    '--metadata',
    `sha256=${sha256(receiptBytes)}`,
    '--output',
    'json',
  ]);
  verifyS3Object({ spawnSyncFn, bucket, key: receiptKey, bytes: receiptBytes });
  return {
    status: 'verified',
    bundle_sha256: bundleSha256,
    bundle_key: bundleKey,
    receipt_key: receiptKey,
  };
}

function runCohortBurst({
  runId,
  manifest,
  adoptedOtids = new Set(),
  launchOtids = null,
  quotaVcpu,
  reservedVcpu = 0,
  taskVcpu = DEFAULT_TASK_VCPU,
  initialActiveTasks = 0,
  stageRegistryFn = stageVoiceIdentityRegistry,
  stageBudgetsFn = stageVoiceStageBudgets,
  stageRawFn = stageRawToEfs,
  persistBundleFn,
  launchFn = launchVoiceTask,
}) {
  const exact = validateCohortManifest(manifest);
  const adoptedSet = adoptedOtids instanceof Set ? adoptedOtids : new Set(adoptedOtids || []);
  const launchSet = launchOtids
    ? launchOtids instanceof Set
      ? launchOtids
      : new Set(launchOtids)
    : null;
  const calls = exact.calls.filter(
    (call) => !adoptedSet.has(call.otid) && (launchSet ? launchSet.has(call.otid) : call.needsAcoustic !== false),
  );
  const unknownSelections = launchSet
    ? [...launchSet].filter((otid) => !exact.calls.some((call) => call.otid === otid))
    : [];
  if (unknownSelections.length) {
    throw new Error(`launch selection is outside the exact cohort: ${unknownSelections.join(',')}`);
  }
  const requiredVcpu = reservedVcpu + calls.length * taskVcpu;
  if (!Number.isFinite(Number(quotaVcpu)) || requiredVcpu > Number(quotaVcpu)) {
    throw new Error(`Fargate vCPU quota is insufficient: need ${requiredVcpu}, have ${quotaVcpu}`);
  }

  const registry = stageRegistryFn();
  if (registry?.status !== 'staged') throw new Error(`registry staging failed: ${registry?.error || 'unknown'}`);
  const stageBudgets = stageBudgetsFn();
  if (stageBudgets?.status !== 'staged') {
    throw new Error(`stage budget staging failed: ${stageBudgets?.error || 'unknown'}`);
  }
  const revisions = Object.fromEntries(calls.map((call) => [call.otid, call.sourceRevision]));
  const staged = stageRawFn(
    calls.map((call) => call.otid),
    { sourceRevisionsByOtid: revisions },
  );
  if (staged?.missing?.length) {
    throw new Error(`raw staging failed for ${staged.missing.join(',')}`);
  }

  const built = buildCohortBundle({ runId, manifest: exact, registrySnapshot: registry, stageBudgets });
  const persisted = persistBundleFn({ ...built, registrySnapshot: registry, stageBudgets });
  if (persisted?.status !== 'verified' || !/^[a-f0-9]{64}$/.test(persisted.bundle_sha256 || '')) {
    throw new Error('immutable cohort bundle receipt was not verified');
  }

  const launched = [];
  const failed = [];
  for (const call of calls) {
    const result = launchFn([call.otid], {
      sourceRevision: call.sourceRevision,
      cohortRunId: runId,
      cohortBundleSha256: persisted.bundle_sha256,
      idempotencyKey: `${runId}-${call.otid}-${call.sourceRevision.slice(0, 12)}`,
      startedBy: `otter-cohort-${runId}`,
      taskGroup: `otter-cohort:${runId}`,
      countActiveTasksFn: () => initialActiveTasks + launched.length,
      stageRegistryFn: () => registry,
      stageBudgetsFn: () => stageBudgets,
      stageRawFn: () => ({ staged: [call.otid], missing: [] }),
    });
    const entry = { otid: call.otid, sourceRevision: call.sourceRevision, ...result };
    if (result?.launched) launched.push(entry);
    else failed.push(entry);
  }
  return {
    run_id: runId,
    exact_calls: exact.calls.length,
    adopted: exact.calls.filter((call) => adoptedSet.has(call.otid)).map((call) => call.otid),
    selected: calls.map((call) => call.otid),
    launched,
    failed,
    required_vcpu: requiredVcpu,
    bundle: persisted,
  };
}

module.exports = {
  MAX_COHORT_CALLS,
  buildCohortBundle,
  persistCohortBundle,
  runCohortBurst,
  isMountedPath,
  validateCohortManifest,
};
