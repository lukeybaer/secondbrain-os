#!/usr/bin/env node
/**
 * voice-git-people-sync.js -- run the people-file sync on the GIT machine.
 *
 * Phase 2 closes the loop: Fargate resolves voices and writes artifacts to EFS;
 * EC2 reconciles them into its dashboard dir; this script (run on the PC, the
 * git-authoritative machine) pulls the resolved registry + speaker-intelligence
 * artifacts down from EC2 and runs the people-file sync against the local git
 * checkout, then commits any people-file changes.
 *
 * Why the container does NOT do this: people files are git-tracked; a container
 * writing them to ephemeral EFS would diverge from git. So the container skips
 * people sync (VOICE_SKIP_PEOPLE_SYNC=1) and this runs where git lives.
 *
 * Confirmed-voiceprint-match-only gate is enforced inside
 * sync-voiceprints-to-people-files.js; this script does not relax it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureCodexWorktree, isSharedCheckout } = require('./lib/codex-worktree.js');
const { isConfirmedRegistryPerson } = require('./lib/canonical-speaker-identity');
const { findForbiddenPeople } = require('./lib/forbidden-people.js');

const REPO = path.resolve(__dirname, '..');
const EC2 = process.env.EC2_HOST || 'ec2-user@ExampleCo';
// ExampleCo 2026-09-22: the relay runs on the EC2 host itself, where the queue and
// the People mirror live, instead of a once-daily PC task. In local mode every
// remote step below runs as the same shell command or file copy on this host.
const RELAY_LOCAL = process.env.VOICE_GIT_PEOPLE_SYNC_LOCAL === '1';
const SSH_KEY =
  (RELAY_LOCAL ? 'local-host' : '') ||
  process.env.EC2_SSH_KEY ||
  [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'sb-key.pem'),
    path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.ssh',
      'secondbrain-backend-key.pem',
    ),
  ].find((p) => fs.existsSync(p));

// Resolved artifacts the people sync reads. Pulled EC2 (reconciled-from-EFS) ->
// local git checkout so the sync runs on the freshest Fargate output.
const PULL = [
  'data/life-archive/voice-identity-registry.json',
  'data/life-archive/people/voice-git-people-sync-requests.jsonl',
  'data/life-archive/people/voice-git-people-sync-receipts.jsonl',
  'data/life-archive/people/voice-people-file-projection-events.jsonl',
  'data/life-archive/voiceprints/otter-speaker-intelligence-latest.json',
  'data/life-archive/voiceprints/speaker-pareto-latest.json',
  'data/life-archive/voiceprints/otter-speaker-analytics-latest.json',
  'data/life-archive/voiceprints/voice-discovery-roster-latest.json',
];
const RELAY_REQUESTS = path.join(
  REPO,
  'data',
  'life-archive',
  'people',
  'voice-git-people-sync-requests.jsonl',
);
const RELAY_RECEIPTS = path.join(
  REPO,
  'data',
  'life-archive',
  'people',
  'voice-git-people-sync-receipts.jsonl',
);
const RELAY_REQUESTS_REL = 'data/life-archive/people/voice-git-people-sync-requests.jsonl';
const RELAY_HEALTH_PATH =
  process.env.VOICE_GIT_PEOPLE_SYNC_HEALTH_PATH ||
  (RELAY_LOCAL
    ? path.join(
        process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data',
        'agent',
        'voice-git-people-sync-health.json',
      )
    : '') ||
  path.join(
    process.env.APPDATA ||
      path.join(process.env.USERPROFILE || process.env.HOME || REPO, 'AppData', 'Roaming'),
    'secondbrain',
    'data',
    'agent',
    'voice-git-people-sync-health.json',
  );

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

// Translate one ssh/scp invocation into its same-host equivalent. ssh runs its
// remote command through bash; scp becomes cp with the host prefix removed.
function localizeRemoteCommand(cmd, args, { ec2 = EC2 } = {}) {
  if (cmd === 'ssh') return ['bash', ['-c', String(args[args.length - 1])]];
  if (cmd !== 'scp') return [cmd, args];
  const operands = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-i' || args[i] === '-o') {
      i += 1;
      continue;
    }
    operands.push(String(args[i]).startsWith(`${ec2}:`) ? String(args[i]).slice(ec2.length + 1) : args[i]);
  }
  return ['cp', operands];
}

function sh(cmd, args, opts = {}) {
  const [run, runArgs] = RELAY_LOCAL ? localizeRemoteCommand(cmd, args) : [cmd, args];
  return spawnSync(run, runArgs, { cwd: REPO, encoding: 'utf8', timeout: 120000, ...opts });
}

function dependencyNodeModulesRoot({ repoRoot = REPO, env = process.env, fsApi = fs } = {}) {
  const candidates = [
    path.join(repoRoot, 'node_modules'),
    env.SECONDBRAIN_MAIN_ROOT ? path.join(env.SECONDBRAIN_MAIN_ROOT, 'node_modules') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, 'secondbrain', 'node_modules') : '',
    env.USERPROFILE
      ? path.join(env.USERPROFILE, 'Documents', 'GitHub', 'secondbrain', 'node_modules')
      : '',
  ].filter(Boolean);
  // Linked worktrees can have a deliberately tiny node_modules directory for
  // focused tests. Its mere existence does not prove that the production
  // People relay can load its runtime dependencies. Select the first complete
  // runtime instead of junctioning a fresh relay worktree to a partial one.
  return (
    candidates.find(
      (candidate) =>
        fsApi.existsSync(candidate) &&
        fsApi.existsSync(path.join(candidate, 'js-yaml', 'package.json')),
    ) || ''
  );
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pendingRelayRequestsFromRows(requestRows, receiptRows) {
  const latestReceipt = new Map();
  for (const row of receiptRows) {
    if (row?.request_id) latestReceipt.set(row.request_id, row);
  }
  const byId = new Map();
  for (const row of requestRows) {
    if (row?.request_id) byId.set(row.request_id, row);
  }
  return [...byId.values()].filter(
    (row) => row.status === 'ready' && latestReceipt.get(row.request_id)?.status !== 'landed',
  );
}

function pendingRelayRequests() {
  return pendingRelayRequestsFromRows(readJsonl(RELAY_REQUESTS), readJsonl(RELAY_RECEIPTS));
}

function remotePendingRelayRequests({
  shFn = sh,
  sshKey = SSH_KEY,
  ec2 = EC2,
} = {}) {
  if (!sshKey) {
    return {
      ok: false,
      count: 0,
      request_ids: [],
      failed_request_ids: [],
      reason: 'no_ssh_key',
    };
  }
  const remoteJs = [
    "const fs=require('fs');",
    "const read=(file)=>{try{return fs.readFileSync(file,'utf8').split(/\\r?\\n/).filter(Boolean).map((line)=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean)}catch{return []}};",
    "const base='/opt/secondbrain/data/life-archive/people/';",
    "let requests=read(base+'voice-git-people-sync-requests.jsonl');",
    "const receipts=read(base+'voice-git-people-sync-receipts.jsonl');",
    'const latest=new Map();',
    "for(const row of receipts){if(row&&row.request_id)latest.set(row.request_id,row)}",
    'const byId=new Map();',
    "for(const row of requests){if(row&&row.request_id)byId.set(row.request_id,row)}",
    "const metaDir=base+'pending-contact-meta/';",
    "if(fs.existsSync(metaDir)){for(const name of fs.readdirSync(metaDir).filter((name)=>name.endsWith('.json'))){let event=null;try{event=JSON.parse(fs.readFileSync(metaDir+name,'utf8'))}catch{};if(!event||!event.request_id||byId.has(event.request_id))continue;const recovered={schema:'life_archive_voice_git_people_sync_request.v1',request_id:event.request_id,status:'ready',ready_at:event.occurred_at||new Date().toISOString(),identities:[String(event.person_id)],archive_wide_mutation:false,reason:'people_learning_daily_projection',person_file_path:event.person_file_path,source:event.source||'recovered_staging_meta',staging_event_id:event.event_id,recovered_from_meta:true};fs.appendFileSync(base+'voice-git-people-sync-requests.jsonl',JSON.stringify(recovered)+'\\n');byId.set(recovered.request_id,recovered)}}",
    "const reasons=new Set(['otter_exact_call_people_projection','people_learning_daily_projection']);",
    "const exact=[...byId.values()].filter((row)=>row.status==='ready'&&reasons.has(row.reason)&&row.archive_wide_mutation===false&&Array.isArray(row.identities)&&row.identities.length>0);",
    "const pending=exact.filter((row)=>latest.get(row.request_id)?.status!=='landed');",
    "const failed=exact.filter((row)=>latest.get(row.request_id)&&latest.get(row.request_id).status==='failed');",
    'process.stdout.write(JSON.stringify({count:pending.length,request_ids:pending.map((row)=>row.request_id).filter(Boolean),failed_request_ids:failed.map((row)=>row.request_id).filter(Boolean)}));',
  ].join('');
  const payload = Buffer.from(remoteJs, 'utf8').toString('base64');
  const result = shFn(
    'ssh',
    [
      '-i',
      sshKey,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      ec2,
      `printf '%s' '${payload}' | base64 -d | node`,
    ],
    { timeout: 30000 },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      count: 0,
      request_ids: [],
      failed_request_ids: [],
      reason: 'remote_pending_check_failed',
      stderr: String(result.stderr || '').slice(-500),
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || ''));
    if (
      !Number.isInteger(parsed.count) ||
      parsed.count < 0 ||
      !Array.isArray(parsed.request_ids)
    ) {
      throw new Error('invalid pending response');
    }
    return {
      ok: true,
      count: parsed.count,
      request_ids: parsed.request_ids.map(String),
      failed_request_ids: Array.isArray(parsed.failed_request_ids)
        ? parsed.failed_request_ids.map(String)
        : [],
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      request_ids: [],
      failed_request_ids: [],
      reason: 'remote_pending_response_invalid',
      stderr: String(error.message || error),
    };
  }
}

function exactRelayScope(requests) {
  if (!Array.isArray(requests) || !requests.length) return null;
  if (
    requests.some(
      (row) =>
        row?.schema !== 'life_archive_voice_git_people_sync_request.v1' ||
        row?.status !== 'ready' ||
        !['otter_exact_call_people_projection', 'people_learning_daily_projection'].includes(
          row?.reason,
        ) ||
        row?.archive_wide_mutation !== false ||
        !Array.isArray(row?.identities) ||
        !row.identities.length,
    )
  ) {
    return null;
  }
  return {
    identities: [...new Set(requests.flatMap((row) => row.identities.map(String)))].sort(),
  };
}

function exactRelayBatch(requests) {
  const rows = Array.isArray(requests) ? requests : [];
  const exact = rows.filter(
    (row) =>
      row?.schema === 'life_archive_voice_git_people_sync_request.v1' &&
      row?.status === 'ready' &&
      ['otter_exact_call_people_projection', 'people_learning_daily_projection'].includes(
        row?.reason,
      ) &&
      row?.archive_wide_mutation === false &&
      Boolean(String(row?.request_id || '').trim()) &&
      Array.isArray(row?.identities) &&
      row.identities.length > 0,
  );
  if (exact.length !== rows.length) {
    return { ok: false, reason: 'mixed_or_invalid_exact_scope', requests: [] };
  }
  if (!exact.length) {
    return { ok: false, reason: 'no_ready_exact_requests', requests: [] };
  }
  const byCallRevision = new Map();
  for (const row of exact) {
    const otid = String(row.otid || '').trim();
    const sourceRevision = String(row.source_revision || '').trim().toLowerCase();
    // Call projections retain the strict call+revision conflict key. Generic
    // People-learning producers do not have an Otter id/revision, so their
    // durable request id is the independent unit of idempotency instead of all
    // generic events incorrectly colliding on the same empty key.
    const key =
      otid && sourceRevision
        ? `call:${otid}\u0000${sourceRevision}`
        : `request:${String(row.request_id).trim()}`;
    const group = byCallRevision.get(key) || [];
    group.push(row);
    byCallRevision.set(key, group);
  }
  const conflicts = [...byCallRevision.values()].filter((group) => group.length > 1).flat();
  const batchable = [...byCallRevision.values()]
    .filter((group) => group.length === 1)
    .flat();
  if (!batchable.length && conflicts.length) {
    return {
      ok: false,
      reason: 'conflicting_ready_requests_for_same_call_revision',
      requests: [],
      deferred_conflicts: conflicts,
    };
  }
  return {
    ok: true,
    reason: conflicts.length ? 'batchable_with_isolated_conflicts' : 'batchable',
    requests: batchable,
    deferred_conflicts: conflicts,
    request_ids: batchable.map((row) => String(row.request_id || '')).filter(Boolean),
    identities: [...new Set(batchable.flatMap((row) => row.identities.map(String)))].sort(),
  };
}

function validateExactRelayRegistryScope(registry, scope) {
  return (scope?.identities || []).filter(
    (personId) => {
      if (isConfirmedRegistryPerson(registry, personId)) return false;
      const person = registry?.people?.[personId] || {};
      return person.identity_confirmation_status !== 'confirmed_by_ExampleCo';
    },
  );
}

function exactRelayPeoplePaths(requests, registry) {
  const paths = [];
  const otterIdentities = [];
  for (const request of requests || []) {
    if (request?.reason === 'people_learning_daily_projection') {
      paths.push(String(request.person_file_path || '').replace(/\\/g, '/'));
    } else {
      for (const personId of request?.identities || []) {
        otterIdentities.push(String(personId));
        paths.push(String(registry?.people?.[personId]?.contact_file || '').replace(/\\/g, '/'));
      }
    }
  }
  const unconfirmed = validateExactRelayRegistryScope(registry, {
    identities: [...new Set(otterIdentities)],
  });
  if (unconfirmed.length) return { ok: false, reason: 'exact_identity_not_confirmed', identities: unconfirmed, paths: [] };
  const invalid = paths.find(
    (rel) =>
      rel !== 'memory/user_profile.md' &&
      !/^memory\/contacts\/[A-Za-z0-9_.-]+\.md$/.test(rel),
  );
  if (invalid !== undefined) return { ok: false, reason: 'invalid_exact_contact_path', path: invalid, paths: [] };
  return { ok: true, paths: [...new Set(paths)].sort() };
}

function writeRelayHealth(report, file = RELAY_HEALTH_PATH) {
  const health = {
    schema: 'voice_git_people_sync_health.v1',
    generated_at: new Date().toISOString(),
    status: report?.ok ? 'green' : 'red',
    stage: report?.stage || 'unknown',
    landed_commit_sha: report?.landed_commit_sha || '',
    relay_request_ids: Array.isArray(report?.relay_request_ids) ? report.relay_request_ids : [],
    worktree: report?.worktree || '',
    child_status: Number.isInteger(report?.child_status) ? report.child_status : null,
    publish_status: Number.isInteger(report?.publish_status) ? report.publish_status : null,
    error: String(
      report?.child_stderr ||
        report?.land_stderr ||
        report?.publish_stderr ||
        report?.relay_receipts?.stderr ||
        '',
    ).slice(-2000),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return health;
}

function publishableProjectionAuditShell(command) {
  return [
    'audit_status=0',
    `${command} || audit_status=$?`,
    '[ "$audit_status" -eq 0 ] || [ "$audit_status" -eq 2 ] || exit "$audit_status"',
  ].join('\n');
}

function buildRelayReceiptRows(
  requests,
  status,
  landedCommitSha = '',
  stage = '',
  error = '',
  updatedAt = new Date().toISOString(),
) {
  return requests.map((request) => ({
    request_id: request.request_id,
    status,
    updated_at: updatedAt,
    landed_commit_sha: landedCommitSha || '',
    stage,
    error: String(error || '').slice(0, 1000),
  }));
}

function publishRelayReceipts(requests, status, landedCommitSha = '', stage = '', error = '') {
  if (!requests.length) return { ok: true, published: 0 };
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key', published: 0 };
  const rows = buildRelayReceiptRows(requests, status, landedCommitSha, stage, error);
  const payload = Buffer.from(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  ).toString('base64');
  const completedAt = new Date().toISOString();
  const jobRows =
    status === 'landed'
      ? requests.map((request) => ({
          schema: 'life_archive_voice_confirmation_job.v1',
          request_id: request.request_id,
          voice_cluster_id: request.voice_cluster_id || '',
          person_file_path: request.person_file_path || '',
          job_status: 'completed',
          completed_at: completedAt,
          landed_commit_sha: landedCommitSha || '',
          event_at: completedAt,
        }))
      : [];
  const jobPayload = jobRows.length
    ? Buffer.from(`${jobRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8').toString(
        'base64',
      )
    : '';
  const sshOpts = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  const remote = [
    'set -e',
    'mkdir -p /opt/secondbrain/data/life-archive/people',
    `printf '%s' '${payload}' | base64 -d >> ` +
      '/opt/secondbrain/data/life-archive/people/voice-git-people-sync-receipts.jsonl',
    publishableProjectionAuditShell(
      'SECONDBRAIN_DATA_DIR=/opt/secondbrain/data ' +
        'node /opt/secondbrain/scripts/voice-people-file-projection-audit.js --write',
    ),
    ...(jobPayload
      ? [
          `printf '%s' '${jobPayload}' | base64 -d >> ` +
            '/opt/secondbrain/data/life-archive/people/voice-confirmation-jobs.jsonl',
        ]
      : []),
  ].join('\n');
  const result = sh('ssh', [...sshOpts, EC2, remote], { timeout: 30000 });
  return {
    ok: result.status === 0,
    published: result.status === 0 ? rows.length : 0,
    status,
    landed_commit_sha: landedCommitSha || '',
    stderr: String(result.stderr || '').slice(-500),
  };
}

function restoreUnownedLeftovers(cwd, { spawnSyncFn = spawnSync } = {}) {
  const diff = spawnSyncFn('git', ['diff', '--name-only'], { cwd, encoding: 'utf8' });
  const paths = String(diff.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!paths.length) return [];
  spawnSyncFn('git', ['checkout', '--', ...paths], { cwd, encoding: 'utf8' });
  return paths;
}

// A failed relay receipt must name its cause. The child can die by timeout or
// signal, or report failure only in its stdout JSON, leaving stderr empty; an
// empty receipt error made every failed People File relay undiagnosable.
function childFailureReason(child, childReport) {
  const stderr = String(child?.stderr || '').trim();
  if (stderr) return stderr.slice(-2000);
  const parts = [];
  if (child?.error) parts.push(`spawn_error: ${child.error.code || child.error.message || child.error}`);
  if (child?.signal) parts.push(`signal: ${child.signal}`);
  parts.push(`exit_status: ${child?.status ?? 'null'}`);
  const reported = [
    childReport?.error,
    childReport?.reason,
    childReport?.stage && `stage=${childReport.stage}`,
    childReport?.sync?.skipped && `sync=${childReport.sync.skipped}`,
    childReport?.commit?.reason && `commit=${childReport.commit.reason}`,
  ]
    .filter(Boolean)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
  if (reported.length) parts.push(`child_report: ${reported.join('; ')}`);
  else {
    const stdoutTail = String(child?.stdout || '').trim().slice(-500);
    if (stdoutTail) parts.push(`child_stdout_tail: ${stdoutTail}`);
  }
  return parts.join(' | ');
}

function runIsolatedPeopleSync(argv = process.argv.slice(2), deps = {}) {
  const ensureWorktreeFn = deps.ensureWorktreeFn || ensureCodexWorktree;
  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const shFn = deps.shFn || sh;
  const publishRelayReceiptsFn = deps.publishRelayReceiptsFn || publishRelayReceipts;
  const discardLeftoversFn = deps.discardLeftoversFn || restoreUnownedLeftovers;
  const isolation = ensureWorktreeFn({
    repoRoot: REPO,
    purpose: 'voice-git-people-sync',
    branchPrefix: 'codex/voice-people-sync',
    forceNew: true,
  });
  const script = path.join(isolation.cwd, 'scripts', 'voice-git-people-sync.js');
  const sourceNodeModules = dependencyNodeModulesRoot();
  const isolatedNodeModules = path.join(isolation.cwd, 'node_modules');
  if (
    process.platform === 'win32' &&
    sourceNodeModules &&
    path.resolve(sourceNodeModules) !== path.resolve(isolatedNodeModules) &&
    !fs.existsSync(isolatedNodeModules)
  ) {
    fs.symlinkSync(sourceNodeModules, isolatedNodeModules, 'junction');
  }
  const childNodePath = [
    fs.existsSync(isolatedNodeModules) ? isolatedNodeModules : '',
    sourceNodeModules,
    process.env.NODE_PATH || '',
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const forwarded = argv.filter(
    (arg) =>
      ![
        '--isolated-child',
        '--publish-only',
        '--no-publish',
        '--commit',
        '--force-isolated',
      ].includes(arg),
  );
  const child = spawnSyncFn(
    process.execPath,
    [script, ...forwarded, '--isolated-child', '--commit', '--no-publish'],
    {
      cwd: isolation.cwd,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      env: {
        ...process.env,
        SECONDBRAIN_MAIN_ROOT: REPO,
        ...(childNodePath ? { NODE_PATH: childNodePath } : {}),
      },
    },
  );
  const report = {
    schema: 'life_archive_voice_git_people_sync_isolated.v1',
    generated_at: new Date().toISOString(),
    worktree: isolation.cwd,
    branch: isolation.branch,
    child_status: child.status,
    child_stdout: String(child.stdout || '').slice(-12000),
    child_stderr: String(child.stderr || '').slice(-2000),
  };

  let childReport = null;
  try {
    childReport = JSON.parse(String(child.stdout || ''));
  } catch {
    // The child status is still authoritative; parsing only avoids a no-op land.
  }
  const relayRequests = Array.isArray(childReport?.relay_requests)
    ? childReport.relay_requests
    : [];
  report.relay_request_ids = relayRequests.map((row) => row.request_id).filter(Boolean);
  if (child.status !== 0) {
    report.child_failure_reason = childFailureReason(child, childReport);
    report.child_stderr = report.child_stderr || report.child_failure_reason;
    report.relay_receipts = publishRelayReceiptsFn(
      relayRequests,
      'failed',
      '',
      'sync_and_commit',
      report.child_failure_reason,
    );
    return { ...report, ok: false, stage: 'sync_and_commit' };
  }
  const noPeopleChanges = childReport?.commit?.reason === 'no_people_changes';
  // The child commits only the People files its exact batch owns. Producers can
  // still rewrite other tracked files, and land's rebase refuses any unstaged
  // change, so those leftovers blocked every landing. They are not this relay's
  // output: restore them and record the paths so the next full sweep owns them.
  if (!noPeopleChanges) {
    report.unowned_leftovers_restored = discardLeftoversFn(isolation.cwd);
  }
  const land = noPeopleChanges
    ? { status: 0, stdout: '', stderr: '', skipped: 'no_people_changes' }
    : spawnSyncFn(process.execPath, ['scripts/land.js', '--apply'], {
        cwd: isolation.cwd,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000,
      });
  report.land_status = land.status;
  report.land_stdout = String(land.stdout || '').slice(-8000);
  report.land_stderr = String(land.stderr || '').slice(-2000);
  report.land_skipped = land.skipped || null;
  if (land.status !== 0) {
    report.relay_receipts = publishRelayReceiptsFn(
      relayRequests,
      'failed',
      '',
      'land',
      report.land_stderr,
    );
    return { ...report, ok: false, stage: 'land' };
  }

  const exactScope = childReport?.sync?.exact_identity_scope === true;
  const publishArgs = ['--isolated-child', '--publish-only'];
  const publish = exactScope
    ? { status: 0, stdout: '{"skipped":"exact_scope_already_live"}', stderr: '' }
    : spawnSyncFn(process.execPath, [script, ...publishArgs], {
        cwd: isolation.cwd,
        encoding: 'utf8',
        timeout: 15 * 60 * 1000,
        env: { ...process.env, SECONDBRAIN_MAIN_ROOT: REPO },
      });
  report.publish_status = publish.status;
  report.publish_stdout = String(publish.stdout || '').slice(-4000);
  report.publish_stderr = String(publish.stderr || '').slice(-2000);
  const landedShaResult = shFn('git', ['rev-parse', 'origin/master']);
  const landedCommitSha =
    landedShaResult.status === 0 ? String(landedShaResult.stdout || '').trim() : '';
  report.landed_commit_sha = landedCommitSha;
  report.relay_receipts = publishRelayReceiptsFn(
    relayRequests,
    publish.status === 0 ? 'landed' : 'failed',
    publish.status === 0 ? landedCommitSha : '',
    publish.status === 0 ? 'complete' : 'publish',
    report.publish_stderr,
  );
  const receiptOk = report.relay_receipts.ok;
  return {
    ...report,
    ok: publish.status === 0 && receiptOk,
    stage: publish.status !== 0 ? 'publish' : receiptOk ? 'complete' : 'relay_receipt',
  };
}

function pullArtifacts() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key' };
  const sshOpts = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  const bootstrap = sh(
    'ssh',
    [
      ...sshOpts,
      EC2,
      'mkdir -p /opt/secondbrain/data/life-archive/people && ' +
        'touch /opt/secondbrain/data/life-archive/people/voice-git-people-sync-requests.jsonl ' +
        '/opt/secondbrain/data/life-archive/people/voice-git-people-sync-receipts.jsonl',
    ],
    { timeout: 30000 },
  );
  if (bootstrap.status !== 0) {
    return {
      ok: false,
      reason: 'remote_relay_bootstrap_failed',
      pulled: [],
      failed: [...PULL],
      stderr: String(bootstrap.stderr || '').slice(-500),
    };
  }
  const pulled = [];
  const failed = [];
  for (const rel of PULL) {
    fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true });
    const r = sh('scp', [...sshOpts, `${EC2}:/opt/secondbrain/${rel}`, rel]);
    if (r.status === 0) pulled.push(rel);
    else failed.push({ path: rel, stderr: String(r.stderr || '').slice(-300) });
  }
  return {
    ok: pulled.length === PULL.length && failed.length === 0,
    pulled,
    failed,
    expected: PULL.length,
  };
}

// Fail-closed forbidden-people screen for people files pulled from EC2: a hit
// deletes the pulled copy and fails that entry so the lane never lands it.
function screenPulledPeopleFile(localPath, fsApi = fs) {
  let matches;
  try {
    matches = findForbiddenPeople(fsApi.readFileSync(localPath, 'utf8'));
  } catch (error) {
    return `forbidden-name screen could not read pulled people file: ${String(error.message || error).slice(0, 200)}`;
  }
  if (!matches.length) return null;
  try {
    fsApi.unlinkSync(localPath);
  } catch {
    /* entry still fails below; nothing can land from a failed pull */
  }
  return `forbidden name(s) ${matches.join(', ')} in pulled people file; removed, nothing will land`;
}

function pullEc2CreatedContacts() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key', pulled: [] };
  const sshOpts = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  const contactsDir = path.join(REPO, 'memory', 'contacts');
  fs.mkdirSync(contactsDir, { recursive: true });
  const list = sh(
    'ssh',
    [
      ...sshOpts,
      EC2,
      "find /opt/secondbrain/memory/contacts -maxdepth 1 -type f -name '*.md' -printf '%f\\n'",
    ],
    { timeout: 30000 },
  );
  if (list.status !== 0)
    return {
      ok: false,
      reason: 'remote_list_failed',
      pulled: [],
      stderr: String(list.stderr || '').slice(-300),
    };
  const pulled = [];
  const failed = [];
  for (const name of String(list.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+\.md$/.test(name) || name === 'INDEX.md' || name.startsWith('_'))
      continue;
    const localPath = path.join(contactsDir, name);
    if (fs.existsSync(localPath)) continue;
    const r = sh(
      'scp',
      [...sshOpts, `${EC2}:/opt/secondbrain/memory/contacts/${name}`, localPath],
      { timeout: 30000 },
    );
    if (r.status !== 0) {
      failed.push({ path: `memory/contacts/${name}`, stderr: String(r.stderr || '').slice(-300) });
      continue;
    }
    const screenError = screenPulledPeopleFile(localPath);
    if (screenError) failed.push({ path: `memory/contacts/${name}`, stderr: screenError });
    else pulled.push(`memory/contacts/${name}`);
  }
  return { ok: failed.length === 0, pulled, failed };
}

function pullExactRelayPeopleFiles(requests) {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key', pulled: [] };
  const scope = exactRelayScope(requests);
  if (!scope) return { ok: false, reason: 'invalid_exact_scope', pulled: [] };
  let registry = null;
  try {
    registry = JSON.parse(
      fs.readFileSync(
        path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json'),
        'utf8',
      ),
    );
  } catch {
    return { ok: false, reason: 'registry_missing', pulled: [] };
  }
  const pathPlan = exactRelayPeoplePaths(requests, registry);
  if (!pathPlan.ok) return { ...pathPlan, pulled: [] };
  const sshOpts = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  const expected = pathPlan.paths;
  const pulled = [];
  const failed = [];
  for (const rel of expected) {
    const local = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const remoteCandidates = exactRelayRemoteContactPaths(rel);
    let result = null;
    let pulledFrom = '';
    for (const remotePath of remoteCandidates) {
      result = sh('scp', [...sshOpts, `${EC2}:${remotePath}`, local], {
        timeout: 30000,
      });
      if (result.status === 0) {
        pulledFrom = remotePath;
        break;
      }
    }
    const screenError = pulledFrom ? screenPulledPeopleFile(local) : null;
    if (pulledFrom && !screenError) pulled.push(rel);
    else
      failed.push({
        path: rel,
        attempted_remote_paths: remoteCandidates,
        stderr: screenError || String(result?.stderr || '').slice(-300),
      });
  }
  return {
    ok: failed.length === 0 && pulled.length === expected.length,
    identities: scope.identities,
    pulled,
    failed,
  };
}

function exactRelayRemoteContactPaths(rel) {
  if (/^memory\/contacts\/[A-Za-z0-9_.-]+\.md$/.test(rel)) {
    return [
      `/opt/secondbrain/data/life-archive/people/pending-contacts/${path.basename(rel)}`,
      `/opt/secondbrain/${rel}`,
    ];
  }
  return [`/opt/secondbrain/${rel}`];
}

function authoritativePullSucceeded(noPull, pull, contacts) {
  return Boolean(noPull || (pull?.ok === true && contacts?.ok === true));
}

function executeRelayProjection(
  {
    noPull = false,
    noPublish = false,
    noCommit = true,
    requestId = '',
    exactOnly = false,
  } = {},
  deps = {},
) {
  const pullArtifactsFn = deps.pullArtifactsFn || pullArtifacts;
  const pullContactsFn = deps.pullContactsFn || pullEc2CreatedContacts;
  const pullExactContactsFn = deps.pullExactContactsFn || pullExactRelayPeopleFiles;
  const pendingRequestsFn = deps.pendingRequestsFn || pendingRelayRequests;
  const runPeopleSyncFn = deps.runPeopleSyncFn || runPeopleSync;
  const commitPeopleChangesFn = deps.commitPeopleChangesFn || commitPeopleChanges;
  const publishContactsFn = deps.publishContactsFn || publishCanonicalContactsToEc2;
  const report = {
    schema: 'life_archive_voice_git_people_sync.v1',
    generated_at: new Date().toISOString(),
  };
  report.pull = noPull ? { skipped: true } : pullArtifactsFn();
  const requestsAvailable = noPull || report.pull?.pulled?.includes(RELAY_REQUESTS_REL);
  const pendingRequests = requestsAvailable ? pendingRequestsFn() : [];
  const selectedRequests = exactOnly
    ? pendingRequests.filter((row) =>
        ['otter_exact_call_people_projection', 'people_learning_daily_projection'].includes(
          row?.reason,
        ),
      )
    : pendingRequests;
  report.relay_requests = requestId
    ? selectedRequests.filter((row) => row?.request_id === requestId)
    : selectedRequests;
  const requestScopeOk = !requestId || report.relay_requests.length === 1;
  report.request_scope = requestId
    ? {
        request_id: requestId,
        matched: requestScopeOk,
        pending_count_before_filter: pendingRequests.length,
      }
    : { request_id: '', matched: true };
  const exactBatchMode = exactOnly || Boolean(requestId);
  const exactBatch = exactBatchMode
    ? exactRelayBatch(report.relay_requests)
    : { ok: false, reason: 'not_exact_batch_mode', requests: [] };
  report.exact_batch = exactBatch;
  if (exactBatch.ok && exactBatch.deferred_conflicts?.length) {
    report.deferred_relay_requests = exactBatch.deferred_conflicts;
    report.relay_requests = exactBatch.requests;
  }
  const exactScope = exactBatch.ok ? exactRelayScope(exactBatch.requests) : null;
  const exactBatchRequired = exactBatchMode;
  const batchScopeOk = requestScopeOk && (!exactBatchRequired || exactBatch.ok);
  report.ec2_created_contacts = noPull
    ? { skipped: true }
    : !batchScopeOk
      ? {
          skipped: requestScopeOk ? exactBatch.reason : 'requested_relay_missing',
          ok: false,
          pulled: [],
        }
    : exactScope
      ? pullExactContactsFn(exactBatch.requests)
      : pullContactsFn();
  const pullOk =
    batchScopeOk &&
    authoritativePullSucceeded(noPull, report.pull, report.ec2_created_contacts);
  const pullFailureReason = !requestScopeOk
    ? 'requested_relay_missing'
    : !batchScopeOk
      ? exactBatch.reason
      : 'authoritative_pull_failed';
  report.sync = pullOk
    ? exactScope
      ? runPeopleSyncFn(exactScope.identities)
      : runPeopleSyncFn()
    : {
        skipped: pullFailureReason,
        speaker_people_sync_ok: false,
        voiceprint_people_sync_ok: false,
        people_projection_audit_ok: false,
      };
  const syncOk =
    pullOk &&
    report.sync.voiceprint_people_sync_ok &&
    report.sync.speaker_people_sync_ok &&
    report.sync.people_projection_audit_ok;
  report.commit = !pullOk
    ? { skipped: pullFailureReason }
    : !syncOk
      ? { skipped: 'sync_failed' }
      : noCommit
        ? { skipped: true }
        : commitPeopleChangesFn(
            exactScope ? [...report.ec2_created_contacts.pulled].sort() : undefined,
          );
  const commitOk =
    noCommit || report.commit.committed || report.commit.reason === 'no_people_changes';
  report.publish_canonical_contacts = noPublish
    ? { skipped: true }
    : exactScope && syncOk && commitOk
      ? { skipped: 'exact_scope_already_live', ok: true }
    : syncOk && commitOk
      ? publishContactsFn()
      : { skipped: pullOk ? 'sync_or_commit_failed' : pullFailureReason };
  const publishOk = noPublish || report.publish_canonical_contacts.ok;
  return {
    report,
    ok: Boolean(pullOk && syncOk && commitOk && publishOk),
  };
}

function runPeopleSync(personIds = []) {
  // The two people-sync steps and the closure audit run directly against the
  // git checkout so the proof measures the files that will actually be landed.
  // Scheduled tasks may inherit SECONDBRAIN_ROOT from the shared checkout.
  // Pin both roots to this isolated worktree or the audit reads unrelated
  // shared runtime state and falsely reports a missing registry.
  const localEnv = {
    ...process.env,
    SECONDBRAIN_ROOT: REPO,
    SECONDBRAIN_DATA_DIR: path.join(REPO, 'data'),
  };
  const personArgs = [...new Set((personIds || []).map(String).filter(Boolean))]
    .sort()
    .flatMap((personId) => ['--person-id', personId]);
  const a = sh(
    process.execPath,
    ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write', ...personArgs],
    { env: localEnv },
  );
  const b = sh(
    process.execPath,
    [
      'scripts/sync-voiceprints-to-people-files.js',
      '--write',
      ...(personArgs.length ? personArgs : ['--all-contacts']),
      '--json',
    ],
    { env: localEnv },
  );
  const c = sh(process.execPath, ['scripts/voice-people-file-projection-audit.js', '--write'], {
    env: localEnv,
  });
  return {
    speaker_people_sync_ok: a.status === 0,
    voiceprint_people_sync_ok: b.status === 0,
    // Exit 2 is the audit's documented "completed, projection incomplete"
    // result. Blocking the commit on it deadlocked the loop: the files the
    // audit wants can only become complete through this commit.
    people_projection_audit_ok: c.status === 0 || c.status === 2,
    people_projection_audit_status: c.status,
    people_projection_audit: (() => {
      try {
        return JSON.parse(String(c.stdout || '{}'));
      } catch {
        return null;
      }
    })(),
    stderr: [
      String(a.stderr || '').slice(-300),
      String(b.stderr || '').slice(-300),
      String(c.stderr || '').slice(-300),
    ]
      .filter(Boolean)
      .join(' | '),
  };
}

function publishCanonicalContactsToEc2() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key' };
  const contactsDir = path.join(REPO, 'memory', 'contacts');
  if (!fs.existsSync(contactsDir)) return { ok: false, reason: 'contacts_dir_missing' };
  const sshOpts = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  const tmpName = `secondbrain-contacts-${Date.now()}.tar`;
  const manifestName = `${tmpName}.manifest`;
  const eventsName = `${tmpName}.projection-events.jsonl`;
  const tmpLocal = path.join(process.env.TEMP || process.env.TMPDIR || REPO, tmpName);
  const manifestLocal = path.join(process.env.TEMP || process.env.TMPDIR || REPO, manifestName);
  const eventsLocal = path.join(
    REPO,
    'data',
    'life-archive',
    'people',
    'voice-people-file-projection-events.jsonl',
  );
  const contactFiles = fs
    .readdirSync(contactsDir)
    .filter((name) => name.endsWith('.md') && name !== 'INDEX.md' && !name.startsWith('_'))
    .sort();
  if (!contactFiles.length) return { ok: false, reason: 'no_contact_files' };
  if (!fs.existsSync(eventsLocal)) return { ok: false, reason: 'projection_events_missing' };
  const pack = sh('tar', ['-cf', tmpLocal, ...contactFiles], { cwd: contactsDir, timeout: 120000 });
  if (pack.status !== 0)
    return { ok: false, reason: 'tar_failed', stderr: String(pack.stderr || '').slice(-300) };
  fs.writeFileSync(manifestLocal, `${contactFiles.join('\n')}\n`, 'utf8');
  try {
    const copy = sh('scp', [...sshOpts, tmpLocal, `${EC2}:/tmp/${tmpName}`], { timeout: 120000 });
    if (copy.status !== 0)
      return { ok: false, reason: 'scp_failed', stderr: String(copy.stderr || '').slice(-300) };
    const copyManifest = sh('scp', [...sshOpts, manifestLocal, `${EC2}:/tmp/${manifestName}`], {
      timeout: 120000,
    });
    if (copyManifest.status !== 0)
      return {
        ok: false,
        reason: 'manifest_scp_failed',
        stderr: String(copyManifest.stderr || '').slice(-300),
      };
    const copyEvents = sh('scp', [...sshOpts, eventsLocal, `${EC2}:/tmp/${eventsName}`], {
      timeout: 120000,
    });
    if (copyEvents.status !== 0)
      return {
        ok: false,
        reason: 'projection_events_scp_failed',
        stderr: String(copyEvents.stderr || '').slice(-300),
      };
    const remoteScript = [
      'set -e',
      'contacts_dir=/opt/secondbrain/memory/contacts',
      `tar_path=/tmp/${tmpName}`,
      `manifest_path=/tmp/${manifestName}`,
      `incoming_events=/tmp/${eventsName}`,
      'trap \'rm -f "$tar_path" "$manifest_path" "$incoming_events"\' EXIT',
      'mkdir -p "$contacts_dir"',
      'find "$contacts_dir" -maxdepth 1 -type f -name "*.md" ! -name "INDEX.md" ! -name "_*" -printf "%f\\n" | while IFS= read -r f; do',
      '  if ! grep -Fxq "$f" "$manifest_path"; then rm -f "$contacts_dir/$f"; fi',
      'done',
      'tar -xf "$tar_path" -C "$contacts_dir"',
      publishableProjectionAuditShell(
        'SECONDBRAIN_DATA_DIR=/opt/secondbrain/data ' +
          'node /opt/secondbrain/scripts/voice-people-file-projection-audit.js ' +
          '--merge-events "$incoming_events" --write',
      ),
    ].join('\n');
    const extract = sh('ssh', [...sshOpts, EC2, remoteScript], { timeout: 120000 });
    if (extract.status !== 0)
      return {
        ok: false,
        reason: 'remote_extract_failed',
        stderr: String(extract.stderr || '').slice(-300),
      };
    return {
      ok: true,
      published: contactFiles.length,
      projection_events_merged: true,
      projection_audit_stdout: String(extract.stdout || '').slice(-2000),
    };
  } finally {
    try {
      fs.unlinkSync(tmpLocal);
    } catch {
      /* ignore cleanup */
    }
    try {
      fs.unlinkSync(manifestLocal);
    } catch {
      /* ignore cleanup */
    }
  }
}

function commitPeopleChanges(exactPaths = null, { shFn = sh } = {}) {
  if (Array.isArray(exactPaths) && exactPaths.length === 0) {
    return { committed: false, reason: 'no_people_changes' };
  }
  const ownedPaths =
    Array.isArray(exactPaths) && exactPaths.length
      ? [...new Set(exactPaths)].sort()
      : ['memory/contacts', 'memory/user_profile.md'];
  const status = shFn('git', ['status', '--porcelain', '--', ...ownedPaths]);
  const changed = String(status.stdout || '').trim();
  if (!changed) return { committed: false, reason: 'no_people_changes' };
  const add = shFn('git', ['add', '--', ...ownedPaths]);
  if (add.status !== 0) {
    return {
      committed: false,
      reason: 'git_add_failed',
      stderr: String(add.stderr || add.stdout || '').slice(-300),
    };
  }
  const staged = shFn('git', ['diff', '--cached', '--quiet', '--', ...ownedPaths]);
  if (staged.status === 0) {
    return { committed: false, reason: 'no_people_changes' };
  }
  if (staged.status !== 1) {
    return {
      committed: false,
      reason: 'git_staged_diff_check_failed',
      stderr: String(staged.stderr || staged.stdout || '').slice(-300),
    };
  }
  // People files changed, so the memory-derived PII denylist is stale by
  // construction. Rebuild it here (this runs in the isolated worktree) so the
  // same landed commit refreshes data/agent/pii-denylist.json; the land gate
  // then re-runs tests/pii-screen.spec.ts against the fresh list because that
  // path is in PUBLIC_SYNC_GATE_FILES (scripts/lib/land-gate.js). The publish
  // workflow rebuild stays as the CI backstop.
  const denylistBuild = shFn(process.execPath, ['scripts/build-pii-denylist.js']);
  if (denylistBuild.status !== 0) {
    return {
      committed: false,
      reason: 'pii_denylist_rebuild_failed',
      stderr: String(denylistBuild.stderr || denylistBuild.stdout || '').slice(-300),
    };
  }
  const addDenylist = shFn('git', ['add', '--', 'data/agent/pii-denylist.json']);
  if (addDenylist.status !== 0) {
    return {
      committed: false,
      reason: 'git_add_failed',
      stderr: String(addDenylist.stderr || addDenylist.stdout || '').slice(-300),
    };
  }
  const msg = `chore(contacts): voice people-file sync from Fargate-resolved artifacts ${new Date().toISOString().slice(0, 10)}\n\nno-test-justification: generated people-file content from voice resolution, no code change`;
  const c = shFn('git', ['commit', '-m', msg]);
  return {
    committed: c.status === 0,
    files: changed.split('\n').length,
    stderr: String(c.stderr || c.stdout || '').slice(-300),
  };
}

function main() {
  if (process.argv.includes('--publish-only')) {
    const publish = publishCanonicalContactsToEc2();
    process.stdout.write(`${JSON.stringify({ publish_canonical_contacts: publish }, null, 2)}\n`);
    process.exitCode = publish.ok ? 0 : 1;
    return;
  }
  const isolatedChild = process.argv.includes('--isolated-child');
  const exactPoll = process.argv.includes('--exact-poll');
  let pendingPreflight = null;
  if (!isolatedChild && exactPoll) {
    pendingPreflight = remotePendingRelayRequests();
    if (!pendingPreflight.ok || pendingPreflight.count === 0) {
      const failedRequests = pendingPreflight.failed_request_ids || [];
      const report = {
        schema: 'life_archive_voice_git_people_sync_poll.v1',
        generated_at: new Date().toISOString(),
        ok: pendingPreflight.ok && failedRequests.length === 0,
        stage: !pendingPreflight.ok
          ? 'pending_check'
          : failedRequests.length
            ? 'failed_requests_present'
            : 'no_pending_requests',
        relay_request_ids: pendingPreflight.request_ids.length
          ? pendingPreflight.request_ids
          : failedRequests,
        pending: pendingPreflight,
      };
      report.health = writeRelayHealth(report);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
  }
  if (
    !isolatedChild &&
    (exactPoll || process.argv.includes('--force-isolated') || isSharedCheckout(REPO))
  ) {
    const isolated = runIsolatedPeopleSync(process.argv.slice(2));
    if (pendingPreflight) isolated.pending_preflight = pendingPreflight;
    isolated.health = writeRelayHealth(isolated);
    process.stdout.write(`${JSON.stringify(isolated, null, 2)}\n`);
    process.exitCode = isolated.ok ? 0 : 1;
    return;
  }

  const noPull = process.argv.includes('--no-pull');
  const noPublish = process.argv.includes('--no-publish');
  const requestId = argValue(process.argv.slice(2), '--request-id');
  // Default to NOT committing: even semantic people-file updates need an owned
  // landing decision in a multi-session repository. Pass --commit to opt in.
  const noCommit = !process.argv.includes('--commit');
  const { report, ok } = executeRelayProjection({
    noPull,
    noPublish,
    noCommit,
    requestId,
    exactOnly: exactPoll,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  pullArtifacts,
  pullEc2CreatedContacts,
  screenPulledPeopleFile,
  runPeopleSync,
  publishCanonicalContactsToEc2,
  commitPeopleChanges,
  runIsolatedPeopleSync,
  childFailureReason,
  restoreUnownedLeftovers,
  localizeRemoteCommand,
  pendingRelayRequests,
  pendingRelayRequestsFromRows,
  remotePendingRelayRequests,
  publishRelayReceipts,
  buildRelayReceiptRows,
  authoritativePullSucceeded,
  executeRelayProjection,
  writeRelayHealth,
  dependencyNodeModulesRoot,
  publishableProjectionAuditShell,
  exactRelayScope,
  exactRelayBatch,
  validateExactRelayRegistryScope,
  exactRelayPeoplePaths,
  pullExactRelayPeopleFiles,
  exactRelayRemoteContactPaths,
};
