/**
 * Launch one durable voice-resolution queue item in Fargate.
 *
 * Called by the Otter landing-event queue reconciler. The queue owns retries
 * and one exact otid+source-revision job owns each launch.
 *
 * Off by default. Enable on EC2 with VOICE_FARGATE_ENABLED=1 once the cluster +
 * task definition exist. Until then this is a no-op so importing it is safe.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadOtterRawArchiveReceipt,
  materializeOtterRawRevision,
  otterRawArchiveReceiptPath,
} = require('./otter-raw-archive-receipt');
const { runtimeStageBudgetValidation } = require('./otter-stage-budgets');

const VOICE_TASK_STANDARD_ENV = Object.freeze({
  VOICE_FARGATE_ACOUSTIC_ONLY: '1',
  OTTER_FARGATE_ACOUSTIC_VOICE_TIMEOUT_FLOOR_MS: '1800000',
  VOICE_SPEAKER_BACKEND: 'ecapa',
  SPEAKER_MATCH_SCORE: '0.56',
  SPEAKER_MATCH_MARGIN: '0.06',
});

// Stage the raw transcript(s) for these otids from the local raw dir onto the
// EFS mount so the Fargate container (which reads raw from EFS) can find them.
// Without this the container has no raw to download/diarize and no-ops "green".
// Returns { staged:[otid], missing:[otid] }.
function stageRawToEfs(ids, options = {}) {
  const localRaw = process.env.OTTER_RAW_DIR || '/opt/secondbrain/data/otter/raw';
  const localData =
    options.dataDir ||
    process.env.SECONDBRAIN_DATA_DIR ||
    process.env.SECONDBRAIN_DATA ||
    '/opt/secondbrain/data';
  const efsData = process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice';
  const efsRaw = path.join(efsData, 'otter', 'raw');
  const sourceRevision = String(options.sourceRevision || '').toLowerCase();
  const sourceRevisionsByOtid = options.sourceRevisionsByOtid || {};
  const out = { staged: [], missing: [], archive_receipts_staged: [] };
  let normalizeOtid = (v) => String(v || '').replace(/^otter_/, '');
  try {
    ({ normalizeOtid } = require('./otter-otid'));
  } catch {
    /* fallback above */
  }
  const byOtid = new Map();
  const needsCurrentRawLookup = ids.some((otid) =>
    !String(sourceRevisionsByOtid[otid] || sourceRevision || '').trim(),
  );
  if (needsCurrentRawLookup) {
    let files = [];
    try {
      files = fs.readdirSync(localRaw).filter((n) => n.endsWith('.json'));
    } catch {
      files = [];
    }
    // Filename discovery is only needed for an unversioned current-raw launch.
    // Exact-revision work owns an archive receipt and must not reread the entire
    // mutable raw directory before materializing that one immutable revision.
    for (const n of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(localRaw, n), 'utf8'));
        const otid = normalizeOtid(raw.otterId || raw.id || raw.otid || raw.speech_id || '');
        if (otid && !byOtid.has(otid)) byOtid.set(otid, n);
      } catch {
        /* skip unreadable */
      }
    }
  }
  try {
    fs.mkdirSync(efsRaw, { recursive: true });
  } catch {
    /* mount may be down */
  }
  for (const otid of ids) {
    const fname = byOtid.get(otid);
    try {
      const exactSourceRevision = String(sourceRevisionsByOtid[otid] || sourceRevision || '')
        .toLowerCase();
      if (exactSourceRevision) {
        if (sourceRevision && ids.length !== 1) {
          throw new Error('one exact source revision cannot stage multiple call ids');
        }
        const loaded = loadOtterRawArchiveReceipt({
          dataDir: localData,
          otid,
          sourceRevision: exactSourceRevision,
        });
        if (!loaded.ok) throw new Error(loaded.problems.join('; '));
        const stagedName =
          `${String(otid).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}-${exactSourceRevision.slice(
            0,
            12,
          )}.json`;
        materializeOtterRawRevision({
          dataDir: localData,
          otid,
          sourceRevision: exactSourceRevision,
          localRawPath:
            (fname ? path.join(localRaw, fname) : '') ||
            String(loaded.receipt?.local_archive?.path || ''),
          destination: path.join(efsRaw, stagedName),
          downloadFn: options.downloadFn,
        });
        const receiptSource = otterRawArchiveReceiptPath({
          dataDir: localData,
          otid,
          sourceRevision: exactSourceRevision,
        });
        const receiptRelative = path.relative(localData, receiptSource);
        const receiptDestination = path.join(efsData, receiptRelative);
        fs.mkdirSync(path.dirname(receiptDestination), { recursive: true });
        const receiptTemp = `${receiptDestination}.${process.pid}.${Date.now()}.tmp`;
        fs.copyFileSync(receiptSource, receiptTemp);
        fs.renameSync(receiptTemp, receiptDestination);
        out.archive_receipts_staged.push(otid);
      } else {
        if (!fname) throw new Error('local raw transcript is missing');
        fs.copyFileSync(path.join(localRaw, fname), path.join(efsRaw, fname));
      }
      out.staged.push(otid);
    } catch (error) {
      out.missing.push(otid);
      out.errors ||= {};
      out.errors[otid] = error.message;
    }
  }
  return out;
}

// The EC2 registry is canonical job INPUT. Fargate may rewrite its workspace
// copy while running the legacy monolithic tail, but that copy never comes back
// through the reconciler. Each launch replaces it with a fresh local snapshot.
function stageVoiceIdentityRegistry(options = {}) {
  const fsApi = options.fsApi || fs;
  const localData =
    options.localData ||
    process.env.SECONDBRAIN_DATA_DIR ||
    process.env.SECONDBRAIN_DATA ||
    '/opt/secondbrain/data';
  const efsData = options.efsData || process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice';
  const source = path.join(localData, 'life-archive', 'voice-identity-registry.json');
  const destination = path.join(efsData, 'life-archive', 'voice-identity-registry.json');
  const receiptRelativeRoot = path.join(
    'life-archive',
    'voiceprints',
    'legacy-reference-migration-receipts',
  );
  const receiptSourceRoot = path.resolve(localData, receiptRelativeRoot);
  const receiptDestinationRoot = path.resolve(efsData, receiptRelativeRoot);
  let registryBytes;
  let registry;
  try {
    registryBytes = fsApi.readFileSync(source);
    registry = JSON.parse(registryBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { status: 'error', error: `canonical registry unreadable: ${error.message}` };
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { status: 'error', error: 'canonical registry is not a JSON object' };
  }
  const receiptStages = [];
  const receiptByPath = new Map();
  for (const enrollment of Array.isArray(registry.enrollments) ? registry.enrollments : []) {
    const provenance = enrollment?.reference_provenance;
    if (provenance?.eligibility_basis !== 'legacy_trusted') continue;
    const receiptPath = String(provenance.receipt_path || '');
    const expectedHash = String(provenance.receipt_sha256 || '').toLowerCase();
    const receiptSource = path.resolve(localData, receiptPath);
    const sourceRelative = path.relative(receiptSourceRoot, receiptSource);
    if (
      !receiptPath ||
      sourceRelative === '' ||
      sourceRelative.startsWith('..') ||
      path.isAbsolute(sourceRelative)
    ) {
      return {
        status: 'error',
        error: `legacy receipt path out of scope: ${receiptPath || '<missing>'}`,
      };
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      return {
        status: 'error',
        error: `legacy receipt hash invalid: ${receiptPath}`,
      };
    }
    let stat;
    try {
      stat = fsApi.lstatSync(receiptSource);
    } catch (error) {
      return {
        status: 'error',
        error: `legacy receipt missing: ${receiptPath} (${error.message})`,
      };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        status: 'error',
        error: `legacy receipt is not a regular file: ${receiptPath}`,
      };
    }
    let bytes;
    try {
      bytes = fsApi.readFileSync(receiptSource);
    } catch (error) {
      return {
        status: 'error',
        error: `legacy receipt unreadable: ${receiptPath} (${error.message})`,
      };
    }
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      return {
        status: 'error',
        error: `legacy receipt hash mismatch: ${receiptPath}`,
      };
    }
    const receiptDestination = path.resolve(receiptDestinationRoot, sourceRelative);
    const prior = receiptByPath.get(receiptDestination);
    if (prior && prior.hash !== expectedHash) {
      return {
        status: 'error',
        error: `legacy receipt destination conflict: ${receiptPath}`,
      };
    }
    if (!prior) {
      const item = {
        destination: receiptDestination,
        bytes,
        hash: expectedHash,
      };
      receiptByPath.set(receiptDestination, item);
      receiptStages.push(item);
    }
  }
  const registryStage = `${destination}.stage-${process.pid}-${Date.now().toString(36)}.tmp`;
  const registrySha256 = crypto.createHash('sha256').update(registryBytes).digest('hex');
  const snapshotRelativePath = path.join(
    'life-archive',
    'voiceprints',
    'identity-registry-snapshots',
    `${registrySha256}.json`,
  );
  const snapshotDestination = path.join(efsData, snapshotRelativePath);
  const temporaryPaths = [];
  let receiptsStaged = 0;
  let receiptsReused = 0;
  try {
    for (const receipt of receiptStages) {
      fsApi.mkdirSync(path.dirname(receipt.destination), { recursive: true });
      if (fsApi.existsSync(receipt.destination)) {
        const existingStat = fsApi.lstatSync(receipt.destination);
        if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
          throw new Error(`legacy receipt destination is not a regular file: ${receipt.destination}`);
        }
        const existingHash = crypto
          .createHash('sha256')
          .update(fsApi.readFileSync(receipt.destination))
          .digest('hex');
        if (existingHash === receipt.hash) {
          receiptsReused += 1;
          continue;
        }
      }
      const stagedReceipt =
        `${receipt.destination}.stage-${process.pid}-${Date.now().toString(36)}.tmp`;
      temporaryPaths.push(stagedReceipt);
      fsApi.writeFileSync(stagedReceipt, receipt.bytes, { flag: 'wx', mode: 0o644 });
      fsApi.renameSync(stagedReceipt, receipt.destination);
      receiptsStaged += 1;
    }
    fsApi.mkdirSync(path.dirname(destination), { recursive: true });
    fsApi.mkdirSync(path.dirname(snapshotDestination), { recursive: true });
    if (fsApi.existsSync(snapshotDestination)) {
      const existingSnapshot = fsApi.readFileSync(snapshotDestination);
      const existingHash = crypto.createHash('sha256').update(existingSnapshot).digest('hex');
      if (existingHash !== registrySha256) {
        throw new Error(`immutable registry snapshot hash mismatch: ${snapshotRelativePath}`);
      }
    } else {
      const snapshotStage =
        `${snapshotDestination}.stage-${process.pid}-${Date.now().toString(36)}.tmp`;
      temporaryPaths.push(snapshotStage);
      fsApi.writeFileSync(snapshotStage, registryBytes, { flag: 'wx', mode: 0o644 });
      fsApi.renameSync(snapshotStage, snapshotDestination);
    }
    temporaryPaths.push(registryStage);
    fsApi.writeFileSync(registryStage, registryBytes, { flag: 'wx', mode: 0o644 });
    fsApi.renameSync(registryStage, destination);
    return {
      status: 'staged',
      people: Object.keys(registry.people || {}).length,
      enrollments: Array.isArray(registry.enrollments) ? registry.enrollments.length : 0,
      receipts_staged: receiptsStaged,
      receipts_reused: receiptsReused,
      snapshot_path: snapshotRelativePath.replace(/\\/g, '/'),
      snapshot_sha256: registrySha256,
    };
  } catch (error) {
    return { status: 'error', error: `canonical registry stage failed: ${error.message}` };
  } finally {
    for (const temporaryPath of temporaryPaths) {
      try { fsApi.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    }
  }
}

// Stage the measured stage-clock contract beside the canonical registry. The
// container fails closed when this artifact is missing or stale; copying it at
// launch prevents an old EFS workspace from silently reintroducing fixed
// deadlines.
function stageVoiceStageBudgets() {
  const localData =
    process.env.SECONDBRAIN_DATA_DIR || process.env.SECONDBRAIN_DATA || '/opt/secondbrain/data';
  const efsData = process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice';
  const relative = path.join(
    'life-archive',
    'voiceprints',
    'otter-call-processing-stage-budgets-latest.json',
  );
  const source = path.join(localData, relative);
  const destination = path.join(efsData, relative);
  let artifact;
  let sourceText;
  try {
    sourceText = fs.readFileSync(source, 'utf8');
    artifact = JSON.parse(sourceText);
  } catch (error) {
    return { status: 'error', error: `stage-budget artifact unreadable: ${error.message}` };
  }
  const runtimeValidation = runtimeStageBudgetValidation(artifact);
  if (!runtimeValidation.ok) {
    return {
      status: 'error',
      error: `stage-budget artifact is not runnable: ${runtimeValidation.problems.join('; ')}`,
    };
  }
  const staged = `${destination}.stage-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, staged);
    fs.renameSync(staged, destination);
    return {
      status: 'staged',
      generated_at: artifact.generated_at || '',
      formula: artifact.formula || '',
      mode: runtimeValidation.mode,
      bootstrap_stages: runtimeValidation.bootstrap_stages || [],
      snapshot_path: relative.replace(/\\/g, '/'),
      snapshot_sha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
    };
  } catch (error) {
    return { status: 'error', error: `stage-budget artifact stage failed: ${error.message}` };
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* best effort */ }
  }
}

// Count voice tasks currently RUNNING or PENDING in the cluster for bounded
// parallel capacity. Exact calls are independent; stage-local rollup locks
// protect shared state. Returns null if either lookup is unavailable, which
// makes the caller stop while the durable queue retains the exact job.
function countActiveVoiceTasks(region, cluster, spawnSyncFn = spawnSync) {
  const res = spawnSyncFn(
    'aws',
    [
      'ecs',
      'list-tasks',
      '--region',
      region,
      '--cluster',
      cluster,
      '--desired-status',
      'RUNNING',
      '--output',
      'json',
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  if (!res || res.status !== 0) return null;
  try {
    const running = (JSON.parse(res.stdout).taskArns || []).length;
    const resP = spawnSyncFn(
      'aws',
      [
        'ecs',
        'list-tasks',
        '--region',
        region,
        '--cluster',
        cluster,
        '--desired-status',
        'PENDING',
        '--output',
        'json',
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    if (!resP || resP.status !== 0) return null;
    const pending = (JSON.parse(resP.stdout).taskArns || []).length;
    return running + pending;
  } catch {
    return null;
  }
}

function voiceTaskEnvironment(ids, opts = {}) {
  const registrySnapshot = opts.identityRegistrySnapshot || {};
  return [
    { name: 'OTIDS', value: ids.join(',') },
    { name: 'VOICE_REASON', value: opts.reason || 'otter-ingest-watch' },
    ...(opts.sourceRevision
      ? [{ name: 'OTTER_SOURCE_REVISION_HASH', value: String(opts.sourceRevision) }]
      : []),
    ...(opts.cohortRunId
      ? [{ name: 'OTTER_COHORT_RUN_ID', value: String(opts.cohortRunId) }]
      : []),
    ...(opts.cohortBundleSha256
      ? [{ name: 'OTTER_COHORT_BUNDLE_SHA256', value: String(opts.cohortBundleSha256) }]
      : []),
    ...(registrySnapshot.snapshot_path && registrySnapshot.snapshot_sha256
      ? [
          {
            name: 'VOICE_IDENTITY_REGISTRY_SNAPSHOT_PATH',
            value: String(registrySnapshot.snapshot_path),
          },
          {
            name: 'VOICE_IDENTITY_REGISTRY_SNAPSHOT_SHA256',
            value: String(registrySnapshot.snapshot_sha256),
          },
        ]
      : []),
    ...Object.entries(VOICE_TASK_STANDARD_ENV).map(([name, value]) => ({ name, value })),
  ];
}

function ecsStartedBy(value) {
  const sanitized = String(value || 'otter-ingest-watch').replace(/[^A-Za-z0-9_-]/g, '-');
  if (sanitized.length <= 36) return sanitized;
  const suffix = crypto.createHash('sha256').update(sanitized).digest('hex').slice(0, 6);
  return `${sanitized.slice(0, 29)}-${suffix}`;
}

function launchVoiceTask(otids, opts = {}) {
  const ids = [...new Set((otids || []).filter(Boolean))];
  if (!ids.length) return { launched: false, reason: 'no_otids' };
  if (process.env.VOICE_FARGATE_ENABLED !== '1') {
    return { launched: false, reason: 'disabled', otids: ids };
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  const cluster = process.env.VOICE_FARGATE_CLUSTER || 'secondbrain-voice';
  const taskDef = process.env.VOICE_FARGATE_TASKDEF || 'secondbrain-voice';
  const subnets = (process.env.VOICE_FARGATE_SUBNETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sgs = (process.env.VOICE_FARGATE_SECURITY_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const containerName = process.env.VOICE_FARGATE_CONTAINER || 'voice';
  const maxActiveTasks = Math.max(
    1,
    Number.parseInt(process.env.VOICE_FARGATE_MAX_ACTIVE_TASKS || '10', 10) || 10,
  );
  if (!subnets.length || !sgs.length) {
    return { launched: false, reason: 'missing_network_config', otids: ids };
  }
  // Stage-local locks isolate shared rollups, so independent calls may run in
  // parallel. The active-task lookup is only a bounded-capacity guard. Unknown
  // state fails closed and the durable landing queue retains the exact job.
  const active = (opts.countActiveTasksFn || countActiveVoiceTasks)(
    region,
    cluster,
    opts.spawnSyncFn || spawnSync,
  );
  if (active === null) {
    return { launched: false, reason: 'active_task_lookup_failed', otids: ids };
  }
  if (active >= maxActiveTasks) {
    return {
      launched: false,
      reason: 'deferred_capacity',
      active,
      capacity: maxActiveTasks,
      otids: ids,
    };
  }
  // Stage the raw transcript(s) onto EFS first; the container reads raw from EFS.
  const registry = (opts.stageRegistryFn || stageVoiceIdentityRegistry)();
  if (registry.status !== 'staged') {
    return {
      launched: false,
      reason: 'registry_stage_failed',
      detail: registry.error || 'voice identity registry could not be staged',
      otids: ids,
      registry,
    };
  }
  const staged = (opts.stageRawFn || stageRawToEfs)(ids, {
    sourceRevision: opts.sourceRevision,
    sourceRevisionsByOtid: opts.sourceRevisionsByOtid,
  });
  if (staged.missing?.length) {
    return {
      launched: false,
      reason: 'raw_stage_failed',
      detail: `raw transcript unavailable for ${staged.missing.join(',')}`,
      otids: ids,
      staged,
      registry,
    };
  }
  const stageBudgets = (opts.stageBudgetsFn || stageVoiceStageBudgets)();
  if (stageBudgets.status !== 'staged') {
    return {
      launched: false,
      reason: 'stage_budget_stage_failed',
      detail: stageBudgets.error || 'measured stage clocks could not be staged',
      otids: ids,
      staged,
      registry,
      stageBudgets,
    };
  }
  // Public-subnet, short-lived task with a locked-down SG (no NAT Gateway -> the
  // image pull needs a public IP). Codex P2.
  const netConfig = JSON.stringify({
    awsvpcConfiguration: {
      subnets,
      securityGroups: sgs,
      assignPublicIp: 'ENABLED',
    },
  });
  const overrides = JSON.stringify({
    containerOverrides: [
      {
        name: containerName,
        environment: voiceTaskEnvironment(ids, {
          ...opts,
          identityRegistrySnapshot: registry,
        }),
      },
    ],
  });
  const args = [
    'ecs',
    'run-task',
    '--region',
    region,
    '--cluster',
    cluster,
    '--task-definition',
    taskDef,
    '--launch-type',
    'FARGATE',
    '--count',
    '1',
    '--network-configuration',
    netConfig,
    '--overrides',
    overrides,
    ...(opts.idempotencyKey
      ? ['--client-token', String(opts.idempotencyKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)]
      : []),
    ...(opts.taskGroup ? ['--group', String(opts.taskGroup).slice(0, 255)] : []),
    '--started-by',
    ecsStartedBy(opts.startedBy),
  ];
  const res = (opts.spawnSyncFn || spawnSync)('aws', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (!res || res.status !== 0) {
    return {
      launched: false,
      reason: 'run_task_failed',
      detail: String(res?.stderr || '').slice(-400),
      otids: ids,
      staged,
      registry,
      stageBudgets,
    };
  }
  let taskArn = null;
  try {
    const parsed = JSON.parse(res.stdout);
    taskArn = (parsed.tasks || [])[0]?.taskArn || null;
    if (!taskArn || (Array.isArray(parsed.failures) && parsed.failures.length > 0)) {
      return {
        launched: false,
        reason: 'run_task_failed',
        detail: JSON.stringify(parsed.failures || []).slice(-400),
        otids: ids,
        staged,
        registry,
        stageBudgets,
      };
    }
  } catch {
    return {
      launched: false,
      reason: 'run_task_failed',
      detail: 'ECS run-task returned unreadable JSON',
      otids: ids,
      staged,
      registry,
      stageBudgets,
    };
  }
  return { launched: true, otids: ids, taskArn, staged, registry, stageBudgets };
}

module.exports = {
  launchVoiceTask,
  stageRawToEfs,
  stageVoiceIdentityRegistry,
  stageVoiceStageBudgets,
  countActiveVoiceTasks,
  voiceTaskEnvironment,
  ecsStartedBy,
  VOICE_TASK_STANDARD_ENV,
};
