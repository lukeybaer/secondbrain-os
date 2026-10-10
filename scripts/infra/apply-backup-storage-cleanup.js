#!/usr/bin/env node
'use strict';

// Storage cleanup executor (top-15 item 14, review receipt d3300c3babe0).
// Default is --dry-run. --apply needs --owner-approval "<exact owner text and date>".
//
//   node scripts/infra/apply-backup-storage-cleanup.js [--lifecycle] [--snapshot-id snap-...]...
//        [--apply --owner-approval "<text>"]
//
// Actions are idempotent, verified after the fact, and logged to an atomic
// receipt at <data dir>/agent/storage-cleanup/<ts>.json. The prior lifecycle
// configuration is saved beside it as the rollback artifact.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accountId, readBucketVersioning, runAws } = require('./apply-otter-storage-lifecycle.js');

const REVIEW_ID = 'd3300c3babe0';
const RULE_ID = 'snapshots-noncurrent-30d';
const SNAPSHOT_ID_RE = /^snap-[0-9a-f]{8,17}$/;

function buildSnapshotRule() {
  return {
    ID: RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: 'snapshots/' },
    NoncurrentVersionExpiration: { NoncurrentDays: 30 },
  };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
// AWS returns the same rule with its keys in its own order, so compare by
// content with sorted object keys, never by raw JSON text.
const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const canon = (config) => `${JSON.stringify(config, null, 2)}\n`;

function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (platform !== 'win32') return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const out = { apply: false, lifecycle: false, snapshotIds: [], ownerApproval: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--lifecycle') out.lifecycle = true;
    else if (a === '--snapshot-id') out.snapshotIds.push(String(argv[++i] || ''));
    else if (a === '--owner-approval') out.ownerApproval = String(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  for (const id of out.snapshotIds) {
    if (!SNAPSHOT_ID_RE.test(id)) throw new Error(`Invalid --snapshot-id: ${id}`);
  }
  if (!out.lifecycle && out.snapshotIds.length === 0) {
    throw new Error('Nothing to do: pass --lifecycle and/or --snapshot-id');
  }
  if (out.apply && out.ownerApproval.trim().length < 10) {
    throw new Error('Refusing --apply without --owner-approval "<exact owner text and date>"');
  }
  return out;
}

function makeAws(region, runAwsFn) {
  return async (args, { json = true } = {}) => {
    const out = await runAwsFn([...args, '--region', region, ...(json ? ['--output', 'json'] : [])]);
    return json ? JSON.parse(out || 'null') : out;
  };
}

async function readLifecycle(aws, bucket) {
  try {
    return await aws(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket]);
  } catch (error) {
    if (/NoSuchLifecycleConfiguration/i.test(String(error?.stderr || error?.message || error))) {
      return { Rules: [] };
    }
    throw error;
  }
}

// The new config keeps every existing rule untouched and in order, then adds
// the snapshot rule (unless it is already there exactly).
function planLifecycle(current) {
  const rules = Array.isArray(current.Rules) ? current.Rules : [];
  const want = buildSnapshotRule();
  const existing = rules.find((r) => r.ID === RULE_ID);
  if (existing) {
    if (same(existing, want)) return { alreadyPresent: true, next: clone(current) };
    throw new Error(`Rule ${RULE_ID} already exists with different content; refusing to overwrite`);
  }
  return { alreadyPresent: false, next: { ...clone(current), Rules: [...clone(rules), want] } };
}

function verifyLifecycle(before, after) {
  const b = Array.isArray(before.Rules) ? before.Rules : [];
  const a = Array.isArray(after.Rules) ? after.Rules : [];
  const problems = [];
  if (a.length !== b.length + (b.some((r) => r.ID === RULE_ID) ? 0 : 1)) problems.push('rule count mismatch');
  for (const rule of b) {
    const got = a.find((r) => r.ID === rule.ID);
    if (!got || !same(got, rule)) problems.push(`existing rule changed or missing: ${rule.ID}`);
  }
  const added = a.find((r) => r.ID === RULE_ID);
  if (!added || !same(added, buildSnapshotRule())) problems.push(`${RULE_ID} missing or not exact`);
  if (!same(before.TransitionDefaultMinimumObjectSize, after.TransitionDefaultMinimumObjectSize)) {
    problems.push('TransitionDefaultMinimumObjectSize changed');
  }
  return problems;
}

const isNotFound = (error) =>
  /InvalidSnapshot\.NotFound|InvalidSnapshotID\.NotFound/i.test(String(error?.stderr || error?.message || error));

const mappedSnapshotIds = (mappings) =>
  (mappings || []).map((m) => m?.Ebs?.SnapshotId).filter(Boolean);

// Everything that could still depend on a snapshot, captured fresh each time.
async function captureReferences(aws, snapshotId) {
  const refs = [];
  const images =
    (await aws(['ec2', 'describe-images', '--owners', 'self', '--include-deprecated', '--include-disabled']))
      ?.Images || [];
  for (const img of images) {
    if (mappedSnapshotIds(img.BlockDeviceMappings).includes(snapshotId)) refs.push(`ami:${img.ImageId}`);
  }
  const templates = (await aws(['ec2', 'describe-launch-templates']))?.LaunchTemplates || [];
  let versionCount = 0;
  for (const lt of templates) {
    // No --versions argument returns every version of the template.
    const all =
      (await aws(['ec2', 'describe-launch-template-versions', '--launch-template-id', lt.LaunchTemplateId]))
        ?.LaunchTemplateVersions || [];
    for (const v of all) {
      versionCount += 1;
      if (mappedSnapshotIds(v.LaunchTemplateData?.BlockDeviceMappings).includes(snapshotId)) {
        refs.push(`launch-template:${lt.LaunchTemplateId}:v${v.VersionNumber}`);
      }
    }
  }
  const reservations = (await aws(['ec2', 'describe-instances']))?.Reservations || [];
  const volumeIds = [];
  for (const r of reservations) {
    for (const inst of r.Instances || []) {
      for (const m of inst.BlockDeviceMappings || []) {
        if (m?.Ebs?.VolumeId) volumeIds.push(m.Ebs.VolumeId);
      }
    }
  }
  // Instance mappings carry volume ids only; the volume holds its source snapshot.
  const volumes = volumeIds.length
    ? (await aws(['ec2', 'describe-volumes', '--volume-ids', ...volumeIds]))?.Volumes || []
    : [];
  for (const v of volumes) if (v.SnapshotId === snapshotId) refs.push(`instance-volume:${v.VolumeId}`);
  const derived =
    (await aws(['ec2', 'describe-volumes', '--filters', `Name=snapshot-id,Values=${snapshotId}`]))?.Volumes || [];
  for (const v of derived) {
    if (!refs.includes(`instance-volume:${v.VolumeId}`)) refs.push(`volume:${v.VolumeId}`);
  }
  return {
    refs,
    counts: {
      images: images.length,
      launchTemplates: templates.length,
      launchTemplateVersions: versionCount,
      instanceVolumes: volumeIds.length,
    },
  };
}

async function describeSnapshot(aws, snapshotId) {
  try {
    const r = await aws(['ec2', 'describe-snapshots', '--snapshot-ids', snapshotId]);
    return r?.Snapshots?.[0] || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  runAwsFn = runAws,
  now = () => new Date(),
  dataDir,
} = {}) {
  const args = parseArgs(argv);
  const mode = args.apply ? 'apply' : 'dry_run';
  const region = env.AWS_REGION || 'us-east-1';
  const aws = makeAws(region, runAwsFn);
  const account = await accountId({ region, runAwsFn });
  const bucket = env.SECONDBRAIN_BACKUP_BUCKET || `${account}-secondbrain-backups`;
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dataDir || defaultDataDir(env), 'agent', 'storage-cleanup');
  const receiptPath = path.join(dir, `${stamp}.json`);
  const rollbackPath = path.join(dir, `${stamp}-lifecycle-before.json`);

  const receipt = {
    mode,
    started_at: now().toISOString(),
    finished_at: null,
    status: 'started',
    review_id: REVIEW_ID,
    owner_approval: args.apply ? args.ownerApproval : null,
    account,
    bucket,
    region,
    pre_state: {},
    actions: [],
    error: null,
  };
  const save = () => writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  save();

  try {
    if (args.lifecycle) {
      const action = { type: 'lifecycle_rule', rule_id: RULE_ID, status: 'pending' };
      receipt.actions.push(action);
      const versioning = await readBucketVersioning({ bucket, region, runAwsFn });
      const before = await readLifecycle(aws, bucket);
      const beforeText = canon(before);
      writeAtomic(rollbackPath, beforeText);
      const savedHash = sha256(fs.readFileSync(rollbackPath, 'utf8'));
      if (savedHash !== sha256(beforeText)) throw new Error('Rollback artifact failed read-back verification');
      receipt.pre_state.lifecycle = {
        versioning,
        rule_ids: (before.Rules || []).map((r) => r.ID),
        sha256: savedHash,
        rollback_artifact: rollbackPath,
      };
      const plan = planLifecycle(before);
      action.proposed_rule = buildSnapshotRule();
      if (plan.alreadyPresent) {
        action.status = 'already_present';
      } else if (!args.apply) {
        action.status = 'would_apply';
      } else {
        if (versioning !== 'Enabled') throw new Error(`Refusing lifecycle apply: bucket versioning is ${versioning}`);
        const recheck = await readLifecycle(aws, bucket);
        if (sha256(canon(recheck)) !== savedHash) {
          throw new Error('Lifecycle configuration changed since it was captured; refusing to put');
        }
        const extra = before.TransitionDefaultMinimumObjectSize
          ? ['--transition-default-minimum-object-size', before.TransitionDefaultMinimumObjectSize]
          : [];
        await aws(
          [
            's3api', 'put-bucket-lifecycle-configuration', '--bucket', bucket,
            '--lifecycle-configuration', JSON.stringify({ Rules: plan.next.Rules }), ...extra,
          ],
          { json: false },
        );
        const after = await readLifecycle(aws, bucket);
        const problems = verifyLifecycle(before, after);
        action.post_state_sha256 = sha256(canon(after));
        action.verification_problems = problems;
        if (problems.length) {
          action.status = 'verification_failed';
          throw new Error(`Lifecycle postcondition failed: ${problems.join('; ')} (rollback artifact: ${rollbackPath})`);
        }
        action.status = 'applied_verified';
      }
      save();
    }

    for (const snapshotId of args.snapshotIds) {
      const action = { type: 'delete_snapshot', snapshot_id: snapshotId, status: 'pending' };
      receipt.actions.push(action);
      const meta = await describeSnapshot(aws, snapshotId);
      if (!meta) {
        action.status = 'already_absent';
        save();
        continue;
      }
      action.metadata = {
        owner_id: meta.OwnerId,
        volume_size_gb: meta.VolumeSize,
        start_time: meta.StartTime,
        description: meta.Description,
        state: meta.State,
        tags: meta.Tags || [],
      };
      if (meta.OwnerId && meta.OwnerId !== account) {
        action.status = 'refused_not_self_owned';
        throw new Error(`Refusing ${snapshotId}: owned by ${meta.OwnerId}, not ${account}`);
      }
      const captured = await captureReferences(aws, snapshotId);
      action.references = captured.refs;
      action.reference_scan = captured.counts;
      if (captured.refs.length) {
        action.status = 'refused_referenced';
        throw new Error(`Refusing ${snapshotId}: referenced by ${captured.refs.join(', ')}`);
      }
      if (!args.apply) {
        action.status = 'would_delete';
        save();
        continue;
      }
      await aws(['ec2', 'delete-snapshot', '--snapshot-id', snapshotId], { json: false });
      if (await describeSnapshot(aws, snapshotId)) {
        action.status = 'verification_failed';
        throw new Error(`Snapshot ${snapshotId} still exists after delete-snapshot`);
      }
      action.status = 'deleted_verified';
      save();
    }
    receipt.status = args.apply ? 'applied' : 'dry_run_ok';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error?.message || error);
    receipt.finished_at = now().toISOString();
    save();
    process.stdout.write(`${JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2)}\n`);
    throw error;
  }
  receipt.finished_at = now().toISOString();
  save();
  const report = { ...receipt, receipt_path: receiptPath };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REVIEW_ID,
  RULE_ID,
  buildSnapshotRule,
  captureReferences,
  main,
  parseArgs,
  planLifecycle,
  verifyLifecycle,
};
