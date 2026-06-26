/**
 * Launch the voice-resolution Fargate task for a batch of new otids.
 *
 * Called from otter-ingest-watch on EC2 when genuinely new transcripts arrive.
 * Codex Phase 2 review:
 *  - P4: batch ALL new otids from a poll into ONE task, never one task per otid
 *    (the orchestrator lock makes a concurrent second task false-succeed).
 *  - The 30-min EventBridge cron is the repair path, not primary delivery.
 *
 * Off by default. Enable on EC2 with VOICE_FARGATE_ENABLED=1 once the cluster +
 * task definition exist. Until then this is a no-op so importing it is safe.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Stage the raw transcript(s) for these otids from the local raw dir onto the
// EFS mount so the Fargate container (which reads raw from EFS) can find them.
// Without this the container has no raw to download/diarize and no-ops "green".
// Returns { staged:[otid], missing:[otid] }.
function stageRawToEfs(ids) {
  const localRaw = process.env.OTTER_RAW_DIR || '/opt/secondbrain/data/otter/raw';
  const efsRaw = path.join(process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice', 'otter', 'raw');
  const out = { staged: [], missing: [] };
  let normalizeOtid = (v) => String(v || '').replace(/^otter_/, '');
  try {
    ({ normalizeOtid } = require('./otter-otid'));
  } catch {
    /* fallback above */
  }
  let files = [];
  try {
    files = fs.readdirSync(localRaw).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  // Map otid -> local filename by reading each raw's id (filenames are slugged).
  const byOtid = new Map();
  for (const n of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(localRaw, n), 'utf8'));
      const otid = normalizeOtid(raw.otterId || raw.id || raw.otid || raw.speech_id || '');
      if (otid && !byOtid.has(otid)) byOtid.set(otid, n);
    } catch {
      /* skip unreadable */
    }
  }
  try {
    fs.mkdirSync(efsRaw, { recursive: true });
  } catch {
    /* mount may be down */
  }
  for (const otid of ids) {
    const fname = byOtid.get(otid);
    if (!fname) {
      out.missing.push(otid);
      continue;
    }
    try {
      fs.copyFileSync(path.join(localRaw, fname), path.join(efsRaw, fname));
      out.staged.push(otid);
    } catch {
      out.missing.push(otid);
    }
  }
  return out;
}

// Count voice tasks currently RUNNING or PENDING in the cluster. Single-
// concurrency is the primary defense against the EFS shared-state races (probe
// index, probe wavs, embedding cache, registry): with at most one voice task
// alive, no two tasks share scratch at all. For a few-meetings/day workload the
// throughput cost is negligible. Returns a number, or null if the check could
// not run (in which case the caller proceeds, failing open).
function countActiveVoiceTasks(region, cluster) {
  const res = spawnSync(
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
  if (res.status !== 0) return null; // fail open: do not block on a transient AWS error
  try {
    const running = (JSON.parse(res.stdout).taskArns || []).length;
    const resP = spawnSync(
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
    const pending = resP.status === 0 ? (JSON.parse(resP.stdout).taskArns || []).length : 0;
    return running + pending;
  } catch {
    return null;
  }
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
  if (!subnets.length || !sgs.length) {
    return { launched: false, reason: 'missing_network_config', otids: ids };
  }
  // SINGLE-CONCURRENCY GATE (primary race fix). If a voice task is already
  // RUNNING/PENDING, defer: the otid stays un-enriched, so the next poll (or the
  // repair cron) relaunches it once the cluster is free. This serializes voice
  // processing so concurrent tasks can never share EFS scratch. Fails open if
  // the check itself errors (better to risk a rare race than to never launch).
  if (process.env.VOICE_FARGATE_ALLOW_CONCURRENT !== '1') {
    const active = countActiveVoiceTasks(region, cluster);
    if (active !== null && active > 0) {
      return { launched: false, reason: 'deferred_single_concurrency', active, otids: ids };
    }
  }
  // Stage the raw transcript(s) onto EFS first; the container reads raw from EFS.
  const staged = stageRawToEfs(ids);
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
        environment: [
          { name: 'OTIDS', value: ids.join(',') },
          { name: 'VOICE_REASON', value: opts.reason || 'otter-ingest-watch' },
        ],
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
    '--started-by',
    'otter-ingest-watch',
  ];
  const res = spawnSync('aws', args, { encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    return {
      launched: false,
      reason: 'run_task_failed',
      detail: String(res.stderr || '').slice(-400),
      otids: ids,
      staged,
    };
  }
  let taskArn = null;
  try {
    taskArn = (JSON.parse(res.stdout).tasks || [])[0]?.taskArn || null;
  } catch {
    /* ignore */
  }
  return { launched: true, otids: ids, taskArn, staged };
}

module.exports = { launchVoiceTask, stageRawToEfs, countActiveVoiceTasks };
