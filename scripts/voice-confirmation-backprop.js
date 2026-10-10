#!/usr/bin/env node
/**
 * Durable post-click backpropagation for Daily Briefing voice confirmations.
 *
 * The web endpoint only records acceptance and starts this worker. A lock keeps
 * retries serialized, while the job ledger records running/completed/failed
 * state and latency independently from the browser request.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { addDaysToDayKey, ctDayKeyForInstant } = require('./lib/ct-day.js');
const {
  acquireWorkerLock,
  appendVoiceConfirmationJobEvent,
  collectJobStates,
  jobsPathForDataRoot,
  readVoiceConfirmationJobEvents,
  releaseWorkerLock,
  selectVoiceConfirmationDispatch,
  voiceConfirmationJobNeedsAcousticDiscovery,
  voiceConfirmationJobRequiresGitRelay,
  workerLockPathForDataRoot,
} = require('./lib/voice-confirmation-jobs.js');
const {
  markVoiceConfirmationAwaitingReview,
  queueVoiceConfirmationRepair,
  readVoiceConfirmationOwnerTask,
  readVoiceConfirmationOwnerTaskStrict,
} = require('./lib/voice-confirmation-owner-loop.js');
const { readVoicePeopleProjectionHealth } = require('./lib/voice-people-projection-health.js');
const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
// Durable per-click state: voice-confirmation-jobs.jsonl.
const JOBS_PATH = jobsPathForDataRoot(DATA_ROOT);
// Shared with the backend scheduler, which reads it before dispatching.
const WORKER_LOCK_PATH = workerLockPathForDataRoot(DATA_ROOT);
const STATUS_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'voiceprints',
  'voice-confirmation-backprop-latest.json',
);
const GIT_PEOPLE_SYNC_REQUESTS_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'people',
  'voice-git-people-sync-requests.jsonl',
);
const GIT_PEOPLE_SYNC_RECEIPTS_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'people',
  'voice-git-people-sync-receipts.jsonl',
);

function saveStatus(report) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function markGitPeopleSyncRequestsReady(
  requestsPath = GIT_PEOPLE_SYNC_REQUESTS_PATH,
  requestIds = null,
  identitiesByRequest = {},
) {
  if (!fs.existsSync(requestsPath)) return 0;
  const latest = new Map();
  for (const line of fs.readFileSync(requestsPath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row?.request_id) latest.set(row.request_id, row);
    } catch {
      // A malformed unrelated line must not erase otherwise durable requests.
    }
  }
  const nonMutatingActions = new Set([
    'not_them',
    'ignore',
    'dismiss',
    'dont_know',
    'non_speech',
  ]);
  const allowedRequestIds = requestIds ? new Set(requestIds) : null;
  const identitiesFor = (row) => [
    ...new Set(
      [
        ...(Array.isArray(identitiesByRequest[row.request_id])
          ? identitiesByRequest[row.request_id]
          : []),
        row.selected_person_id || '',
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ];
  const ready = [...latest.values()].filter(
    (row) => {
      const identities = identitiesFor(row);
      const exactScopeMissing =
        identities.length > 0 &&
        (row.schema !== 'life_archive_voice_git_people_sync_request.v1' ||
          row.reason !== 'otter_exact_call_people_projection' ||
          row.archive_wide_mutation !== false ||
          !Array.isArray(row.identities) ||
          !row.identities.length);
      return (
        (row.status === 'queued' || (row.status === 'ready' && exactScopeMissing)) &&
        (!allowedRequestIds || allowedRequestIds.has(row.request_id)) &&
        !nonMutatingActions.has(String(row.action || ''))
      );
    },
  );
  if (!ready.length) return 0;
  fs.mkdirSync(path.dirname(requestsPath), { recursive: true });
  fs.appendFileSync(
    requestsPath,
    ready
      .map((row) => {
        const identities = identitiesFor(row);
        return JSON.stringify({
          ...(identities.length
            ? {
                schema: 'life_archive_voice_git_people_sync_request.v1',
                identities,
                archive_wide_mutation: false,
                reason: 'otter_exact_call_people_projection',
              }
            : {}),
          request_id: row.request_id,
          status: 'ready',
          ready_at: new Date().toISOString(),
          voice_cluster_id: row.voice_cluster_id || '',
          action: row.action || '',
          person_file_path: row.person_file_path || '',
          selected_person_id: identities[0] || row.selected_person_id || '',
          source: 'voice-confirmation-backprop',
        });
      })
      .join('\n') + '\n',
    'utf8',
  );
  return ready.length;
}

function isSoftResolverFailure(label, status, stdout, stderr) {
  if (label !== 'wavlm_resolver' || status !== 2 || String(stderr || '').trim()) return false;
  try {
    const report = JSON.parse(stdout);
    const errors = Array.isArray(report?.errors) ? report.errors : [];
    return (
      report?.schema === 'life_archive_otter_speaker_resolver.v2' &&
      errors.length > 0 &&
      errors.every((error) => error?.error === 'embedding_unusable')
    );
  } catch {
    return false;
  }
}

// Audit steps exit 0 for green and 2 for publishable red evidence. Exit 2
// from these steps is not a failure - the projection work may be complete
// while the audit remains red for relay requests or other advisory issues.
const AUDIT_STEP_LABELS = new Set([
  'people_projection_audit',
  'people_projection_audit_after_failure',
  'people_projection_audit_without_open_job',
]);

// A step that walks the WHOLE corpus must never inherit the light-step default.
//
// Live root cause 2026-08-16: `life_relevance` had no entry here, so
// otter-life-relevance-enricher.js ran under the 120s default. Measured
// read-only on EC2 it needs 127,878ms, and --write is heavier, so every single
// run was SIGTERM-killed at 120s (result.status null). The backprop then
// aborted before speaker_intelligence_report / speaker_people_sync / sync_people
// could refresh call-content projection - which is why four confirmed
// identities sat at call_content_projection_missing_or_stale and why the
// Save-actions metric published red while every measured Save had closed.
//
// Corpus size only grows, so these budgets are sized as headroom over measured
// runtime, not as a snug fit that silently re-trips next quarter.
const LIGHT_STEP_TIMEOUT_MS = 120000;
const FULL_CORPUS_STEP_TIMEOUT_MS = 900000;

const STEP_TIMEOUT_MS_BY_LABEL = {
  apply: 300000,
  speaker_identity_completeness_before_cluster: 300000,
  apply_cluster_resolutions: 300000,
  voice_confirmed_match_sanity: 300000,
  promote_confirmed_acoustic: 300000,
  apply_promoted_cluster_resolutions: 300000,
  wavlm_resolver: FULL_CORPUS_STEP_TIMEOUT_MS,
};

// Steps that read or rewrite the WHOLE corpus. Deliberately its own set rather
// than reusing FULL_STATE_REPLAY_STEP_LABELS: that set decides which steps RUN
// when there are no job states, and widening it would change step selection.
// This set only decides how long a step is allowed to take.
const FULL_CORPUS_STEP_LABELS = new Set([
  'life_relevance',
  'speaker_intelligence_report',
  'speaker_people_sync',
  'voiceprint_people_sync',
  'sync_people',
  'people_projection_audit',
]);

// Category rule, not a one-label patch: any full-corpus step, and any `_after_*`
// recovery variant of one, gets the full-corpus budget.
function stepTimeoutMs(label) {
  const name = String(label || '');
  if (Object.prototype.hasOwnProperty.call(STEP_TIMEOUT_MS_BY_LABEL, name)) {
    return STEP_TIMEOUT_MS_BY_LABEL[name];
  }
  const base = name.replace(/_after_(?:failure|promotion|cluster)$/, '');
  if (FULL_CORPUS_STEP_LABELS.has(name) || FULL_CORPUS_STEP_LABELS.has(base)) {
    return FULL_CORPUS_STEP_TIMEOUT_MS;
  }
  if (Object.prototype.hasOwnProperty.call(STEP_TIMEOUT_MS_BY_LABEL, base)) {
    return STEP_TIMEOUT_MS_BY_LABEL[base];
  }
  return LIGHT_STEP_TIMEOUT_MS;
}

// Steps that load the full resolved-call corpus into memory and have been
// observed to exceed the default V8 heap limit (~1.9 GB measured for
// speaker_intelligence_report on this corpus size). Corpus size only grows,
// so these are sized with headroom over the measured OOM watermark.
//
// Live root cause 2026-08-18: speaker_intelligence_report_after_failure ran
// without a heap override, hit ~1.9 GB, and was killed with
// "Ineffective mark-compacts near heap limit". The backprop then reported
// failed_step_timed_out:true (status null) and left 12 identities at
// call_content_projection_missing_or_stale.
const FULL_CORPUS_NODE_HEAP_MB = 4096;
const STEP_NODE_HEAP_MB_BY_LABEL = {
  life_relevance: FULL_CORPUS_NODE_HEAP_MB,
  speaker_intelligence_report: FULL_CORPUS_NODE_HEAP_MB,
};

// Same category rule as stepTimeoutMs: the explicit label wins first; then any
// `_after_*` recovery variant of a labeled step inherits the same heap limit.
function stepNodeHeapMb(label) {
  const name = String(label || '');
  if (Object.prototype.hasOwnProperty.call(STEP_NODE_HEAP_MB_BY_LABEL, name)) {
    return STEP_NODE_HEAP_MB_BY_LABEL[name];
  }
  const base = name.replace(/_after_(?:failure|promotion|cluster)$/, '');
  if (Object.prototype.hasOwnProperty.call(STEP_NODE_HEAP_MB_BY_LABEL, base)) {
    return STEP_NODE_HEAP_MB_BY_LABEL[base];
  }
  return 0;
}

function run(label, args, stepEnv = {}) {
  const heapMb = stepNodeHeapMb(label);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SKIP_EC2_PUBLISH: '1',
      ...(heapMb ? { NODE_OPTIONS: `--max-old-space-size=${heapMb}` } : {}),
      ...(label === 'wavlm_resolver'
        ? {
            VOICE_SPEAKER_BACKEND: 'ecapa',
            VOICE_ECAPA_PYTHON:
              process.env.VOICE_ECAPA_PYTHON || '/opt/secondbrain-durable/voice-venv/bin/python',
            VOICE_ECAPA_MODEL_CACHE:
              process.env.VOICE_ECAPA_MODEL_CACHE ||
              '/mnt/sbvoice/life-archive/voiceprints/model-cache/speechbrain-ecapa-voxceleb',
          }
        : {}),
      ...stepEnv,
    },
    timeout: stepTimeoutMs(label),
  });
  const softFailure = isSoftResolverFailure(label, result.status, result.stdout, result.stderr);
  // Audit steps exit 0 (green) or 2 (publishable red). Exit 2 is not a
  // backprop failure: the People File projection may be complete while the
  // audit remains red for relay requests or other non-projection issues.
  const auditPublishableRed = AUDIT_STEP_LABELS.has(label) && result.status === 2;
  return {
    label,
    args,
    status: result.status,
    ok: result.status === 0 || softFailure || auditPublishableRed,
    soft_failure: softFailure,
    audit_publishable_red: auditPublishableRed || undefined,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

const POST_SAVE_REMATCH_ACTIONS = new Set([
  'confirm',
  'correct',
  'link_person_file',
  'create_people_file',
]);
const POST_SAVE_REMATCH_TIMEOUT_MS = 60000;
const POST_SAVE_REMATCH_HEAP_MB = 2048;

// After an owner Save enrolls a person, score the other unknown clusters for
// that voice and record near misses as provisional review proposals. It runs
// here, after apply, never in the POST handler; under nice with a 2 GB heap;
// the child enforces a 60 s deadline itself and the spawn is killed shortly
// after as a backstop. Its result is advisory and never fails the job.
function postSaveRematchInvocations(jobStates, personIdsFor = resolvedPersonIdsForJobStates) {
  const out = [];
  for (const state of jobStates || []) {
    const action = String(state?.action || state?.latest?.action || '');
    if (!POST_SAVE_REMATCH_ACTIONS.has(action)) continue;
    const voiceId = String(state?.voice_cluster_id || state?.latest?.voice_cluster_id || '');
    if (!/^unknown_voice_ecapa_/i.test(voiceId)) continue;
    const personId = personIdsFor([state])[0] || '';
    if (!personId) continue;
    out.push({
      person_id: personId,
      saved_cluster_id: voiceId,
      request_id: String(state?.request_id || ''),
    });
  }
  return out;
}

function runPostSaveRematchForJobStates(jobStates, { spawnSyncFn = spawnSync } = {}) {
  // One owner click is one worker job; cap at one bounded child so the
  // worker's added wall time never exceeds one deadline plus backstop.
  const invocations = postSaveRematchInvocations(jobStates);
  const elided = Math.max(0, invocations.length - 1);
  return invocations.slice(0, 1).map((invocation) => {
    const nodeArgs = [
      path.join(REPO, 'scripts', 'voice-post-save-rematch.js'),
      '--write',
      '--person-id',
      invocation.person_id,
      '--saved-cluster-id',
      invocation.saved_cluster_id,
      '--job-request-id',
      invocation.request_id,
      '--timeout-ms',
      String(POST_SAVE_REMATCH_TIMEOUT_MS),
    ];
    const options = {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${POST_SAVE_REMATCH_HEAP_MB}`,
      },
      timeout: POST_SAVE_REMATCH_TIMEOUT_MS + 15000,
    };
    let result =
      process.platform === 'win32'
        ? spawnSyncFn(process.execPath, nodeArgs, options)
        : spawnSyncFn('nice', ['-n', '10', process.execPath, ...nodeArgs], options);
    if (result?.error?.code === 'ENOENT') result = spawnSyncFn(process.execPath, nodeArgs, options);
    return {
      label: 'post_save_rematch',
      advisory: true,
      elided_invocations: elided,
      ok: true,
      rematch_ok: result?.status === 0,
      status: result?.status ?? null,
      ...invocation,
      stdout: String(result?.stdout || '').slice(-2000),
      stderr: String(result?.stderr || '').slice(-1000),
    };
  });
}

function projectionRecoveryStepsAfterFailure(label) {
  if (
    !ACOUSTIC_DISCOVERY_STEP_LABELS.has(label) ||
    /^(?:speaker_people_sync_after_promotion|voiceprint_people_sync_after_promotion)$/.test(label)
  ) {
    return [];
  }
  return [
    [
      'speaker_intelligence_report_after_failure',
      ['scripts/otter-speaker-intelligence-report.js', '--write'],
    ],
    [
      'speaker_people_sync_after_failure',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync_after_failure',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
  ];
}

function openJobStates(
  events = readVoiceConfirmationJobEvents(JOBS_PATH),
  requestId = '',
  { includeCompleted = false } = {},
) {
  return [...collectJobStates(events).values()].filter(
    (state) =>
      (includeCompleted || state.latest?.job_status !== 'completed') &&
      (!requestId || state.request_id === requestId),
  );
}

// An id-less run (the backend audit replay, the briefing refresh contract, the
// metric skill's manual replay) used to take the oldest open Save, which is by
// construction capped, backing off, or inside its relay wait, so every newer
// RED audit re-ran it past its budget. It now starts only the Save the
// scheduler itself would dispatch. With none, it runs no Save and the
// full-state replay reconciles alone. The caller holds the worker lock, and
// the audit inputs only choose between a replay and nothing, both of which
// mean no Save here.
function idlessWorkerJobStates(
  events = readVoiceConfirmationJobEvents(JOBS_PATH),
  { nowMs = Date.now() } = {},
) {
  const plan = selectVoiceConfirmationDispatch(events, { nowMs, workerLockHeld: false });
  return plan?.requestId ? openJobStates(events, plan.requestId) : [];
}

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? String(argv[index + 1]) : '';
}

function resolvedPersonIdsForJobStates(jobStates, registryPath = path.join(
  DATA_ROOT,
  'life-archive',
  'voice-identity-registry.json',
)) {
  const registry = readJson(registryPath, {});
  const out = new Set();
  for (const state of jobStates) {
    const voiceId = state.voice_cluster_id || state.latest?.voice_cluster_id || '';
    const resolution = /^unknown_voice_ecapa_/i.test(voiceId)
      ? registry.acoustic_group_resolutions?.[voiceId]
      : registry.voice_cluster_resolutions?.[voiceId];
    const personId = String(
      resolution?.person_id || state.selected_person_id || state.latest?.selected_person_id || '',
    ).trim();
    if (personId) out.add(personId);
  }
  return [...out];
}

function ownerReviewSummary(state, personIds = []) {
  const action = String(state.action || '');
  const voiceId = state.voice_cluster_id || state.latest?.voice_cluster_id || 'the selected voice';
  if (action === 'not_them') {
    return `Recorded that ${voiceId} is not ${state.guessed_name || 'the suggested person'}, preserved the voice as unknown, and refreshed call-content projection for the confirmed people in its affected calls.`;
  }
  if (action === 'dont_know') return `Left ${voiceId} explicitly unknown, as ExampleCo requested.`;
  if (action === 'non_speech') return `Recorded ${voiceId} as non-speech.`;
  if (personIds.length) return `Applied ${voiceId} to ${personIds.join(', ')} and refreshed that exact People file.`;
  return `Applied ExampleCo's ${action || 'voice'} decision for ${voiceId}.`;
}

function appendJobState(states, jobStatus, fields = {}) {
  const eventAt = new Date().toISOString();
  for (const state of states) {
    appendVoiceConfirmationJobEvent(JOBS_PATH, {
      request_id: state.request_id,
      voice_cluster_id: state.latest?.voice_cluster_id || '',
      person_file_path: state.latest?.person_file_path || '',
      job_status: jobStatus,
      event_at: eventAt,
      ...fields,
    });
  }
}

const ACOUSTIC_DISCOVERY_STEP_LABELS = new Set([
  'speaker_identity_completeness_before_cluster',
  'apply_cluster_resolutions',
  'wavlm_resolver',
  'speaker_identity_completeness',
  'voice_confirmed_match_sanity',
  'promote_confirmed_acoustic',
  'apply_promoted_cluster_resolutions',
  'speaker_identity_completeness_after_promotion',
  'speaker_intelligence_report_after_promotion',
  'speaker_people_sync_after_promotion',
  'voiceprint_people_sync_after_promotion',
  'queue',
  'audio',
]);

const FULL_STATE_REPLAY_STEP_LABELS = new Set([
  'life_relevance',
  'speaker_intelligence_report',
  'speaker_people_sync',
  'sync_people',
  'people_projection_audit',
]);

function stepsForJobStates(jobStates, steps, projectionProofOptions = undefined) {
  if (!jobStates.length) {
    return steps.filter(([label]) => FULL_STATE_REPLAY_STEP_LABELS.has(label));
  }
  if (jobStatesAlreadyHaveProjectionProof(jobStates, projectionProofOptions)) {
    return steps.filter(([label]) =>
      ['speaker_people_sync', 'sync_people', 'people_projection_audit'].includes(label),
    );
  }
  const needsAcousticDiscovery = jobStates.some((state) =>
    voiceConfirmationJobNeedsAcousticDiscovery(state),
  );
  if (needsAcousticDiscovery) return steps;
  return steps.filter(([label]) => !ACOUSTIC_DISCOVERY_STEP_LABELS.has(label));
}

const NEGATIVE_IDENTITY_PROJECTION_STEPS = new Set([
  'apply',
  'speaker_identity_completeness_before_cluster',
  'apply_cluster_resolutions',
  'queue',
  'people_projection_audit',
]);

function selectedStepsForJobStates(jobStates, steps) {
  // A denial changes an identity edge. Reapply that exact durable denial to
  // enriched calls, then let apply-voice-cluster-resolutions invoke the
  // identity-change hook that refreshes call-content People projection before
  // the audit closes. Other owner actions retain the deliberately small exact
  // apply + queue path.
  if (jobStates.some((state) => String(state.action || '') === 'not_them')) {
    return steps.filter(([label]) => NEGATIVE_IDENTITY_PROJECTION_STEPS.has(label));
  }
  return steps.filter(([label]) => ['apply', 'queue'].includes(label));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function latestRelayReceiptByRequestId(receipts = readJsonl(GIT_PEOPLE_SYNC_RECEIPTS_PATH)) {
  const latest = new Map();
  for (const row of receipts) {
    if (row?.request_id) latest.set(row.request_id, row);
  }
  return latest;
}

const SUPERSEDED_RELAY_MAX_HOPS = 32;
// Owner task states a superseded Save may settle to awaiting-review. A running
// task holds a live lease, and a reviewed or done task already belongs to ExampleCo.
const SUPERSEDED_OWNER_TASK_SETTLE_STATUSES = new Set(['queued', 'blocked', 'failed']);

// A newer Save that stages the same People File marks the older relay request
// `superseded`, so the older request can never land under its own id. Follow
// the bounded, cycle-safe superseded_by chain and return the first replacement
// whose latest receipt is landed, or null while every replacement is unlanded.
function landedSupersedingRelay(
  requestId,
  latestRequests,
  receiptsByRequestId,
  maxHops = SUPERSEDED_RELAY_MAX_HOPS,
) {
  const own = latestRequests.get(requestId);
  if (own?.status !== 'superseded') return null;
  const seen = new Set([requestId]);
  let current = own;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const nextId = String(current?.superseded_by || '');
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    const receipt = receiptsByRequestId.get(nextId);
    if (receipt?.status === 'landed') {
      return {
        superseded_by: String(own.superseded_by),
        landed_request_id: nextId,
        landed_commit_sha: String(receipt.landed_commit_sha || ''),
      };
    }
    current = latestRequests.get(nextId);
    if (current?.status !== 'superseded') return null;
  }
  return null;
}

function reconcileLandedRelayCompletions({
  events = readVoiceConfirmationJobEvents(JOBS_PATH),
  relayReceipts = readJsonl(GIT_PEOPLE_SYNC_RECEIPTS_PATH),
  relayRequests = readJsonl(GIT_PEOPLE_SYNC_REQUESTS_PATH),
  jobsPath = JOBS_PATH,
  appendEvent = appendVoiceConfirmationJobEvent,
  markAwaitingReview = markVoiceConfirmationAwaitingReview,
  readOwnerTask = readVoiceConfirmationOwnerTask,
  // Tells a missing task from an unreadable one; the lenient reader cannot.
  readOwnerTaskStrict = readVoiceConfirmationOwnerTaskStrict,
  now = new Date(),
} = {}) {
  const receiptsByRequestId = latestRelayReceiptByRequestId(relayReceipts);
  const completedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const latestRequests = new Map();
  for (const row of Array.isArray(relayRequests) ? relayRequests : []) {
    if (row?.request_id) latestRequests.set(row.request_id, row);
  }
  // Only a Save whose own projection already ran may settle from a replacing
  // relay; an unapplied Save still has identity work the replacement never did.
  const projectedRequestIds = new Set(
    events.filter((row) => row?.job_status === 'awaiting_git_relay').map((row) => row.request_id),
  );
  let reconciled = 0;
  for (const state of collectJobStates(events).values()) {
    const receipt = receiptsByRequestId.get(state.request_id);
    if (receipt?.status !== 'landed') {
      if (state.latest?.job_status === 'completed' || !projectedRequestIds.has(state.request_id)) {
        continue;
      }
      let superseding = null;
      try {
        superseding = landedSupersedingRelay(state.request_id, latestRequests, receiptsByRequestId);
      } catch {
        superseding = null;
      }
      if (!superseding) continue;
      // The replacing Save owns the owner review. An open owner task (queued,
      // blocked or failed) is moved out of the repair queue FIRST, so its
      // "replay only this request" prompt can never re-apply the superseded
      // decision. A running, reviewed or done task is left alone. If the task
      // cannot be read or the settlement fails, the job is left open and the
      // next reconcile retries both: a completed job is never revisited, so
      // completing first would strand the task in the repair queue for good.
      // The strict reader is what makes an unreadable task throw here; the
      // lenient one would report it as no task at all.
      try {
        const ownerTask = readOwnerTaskStrict(state.request_id);
        if (SUPERSEDED_OWNER_TASK_SETTLE_STATUSES.has(String(ownerTask?.status || ''))) {
          const sha = superseding.landed_commit_sha.slice(0, 12);
          markAwaitingReview(
            state.request_id,
            `A newer Save (${superseding.landed_request_id}) replaced this voice decision and its People File relay landed${sha ? ` in commit ${sha}` : ''}. The newer decision stands, so this Save needs no repair or replay.`,
          );
        }
      } catch {
        continue;
      }
      appendEvent(jobsPath, {
        request_id: state.request_id,
        voice_cluster_id: state.voice_cluster_id || state.latest?.voice_cluster_id || '',
        person_file_path: state.person_file_path || state.latest?.person_file_path || '',
        action: state.action || '',
        job_status: 'completed',
        completed_at: completedAt,
        completion_latency_ms: state.accepted_at
          ? Math.max(0, Date.parse(completedAt) - Date.parse(state.accepted_at))
          : undefined,
        completion_evidence: 'superseded_relay_landed',
        ...superseding,
        event_at: completedAt,
      });
      reconciled += 1;
      continue;
    }
    const ownerTask = readOwnerTask(state.request_id);
    const ownerProjectionSettled = ownerTask?.status === 'awaiting-review';
    const jobSettled = state.latest?.job_status === 'completed';
    if (jobSettled && ownerProjectionSettled) continue;
    if (!jobSettled) {
      appendEvent(jobsPath, {
        request_id: state.request_id,
        voice_cluster_id: state.latest?.voice_cluster_id || '',
        person_file_path: state.latest?.person_file_path || '',
        action: state.action || '',
        job_status: 'completed',
        completed_at: completedAt,
        completion_latency_ms: state.accepted_at
          ? Math.max(0, Date.parse(completedAt) - Date.parse(state.accepted_at))
          : undefined,
        completion_evidence: 'landed_git_relay_receipt',
        landed_commit_sha: String(receipt.landed_commit_sha || ''),
        event_at: completedAt,
      });
    }
    try {
      markAwaitingReview(
        state.request_id,
        ownerReviewSummary(state, resolvedPersonIdsForJobStates([state])),
      );
    } catch {
      // The job completion remains durable; a later owner-loop reconciliation
      // can restore the review projection without replaying the identity write.
    }
    reconciled += 1;
  }
  return reconciled;
}

function requestIdsWithProjectionEvents(
  eventsPath = path.join(
    DATA_ROOT,
    'life-archive',
    'people',
    'voice-people-file-projection-events.jsonl',
  ),
) {
  return new Set(
    readJsonl(eventsPath)
      .flatMap((row) => row.request_ids || [])
      .filter(Boolean),
  );
}

function auditProjectionPopulationsClosed(
  auditPath = path.join(
    DATA_ROOT,
    'life-archive',
    'voiceprints',
    'voice-people-file-projection-audit-latest.json',
  ),
) {
  const audit = readJson(auditPath, null);
  if (!audit) return false;
  const expected = Number(audit.expected_people_files || 0);
  const current = Number(audit.current_people_file_projections || 0);
  const instrumented = Number(audit.instrumented_confirmation_actions || 0);
  const projected = Number(audit.confirmation_actions_with_projection_event || 0);
  return (
    expected > 0 &&
    current >= expected &&
    projected >= instrumented &&
    Number(audit.missing_or_stale_people_file_projections || 0) === 0 &&
    Number(audit.unprojected_confirmation_actions || 0) === 0
  );
}

function jobStatesAlreadyHaveProjectionProof(
  jobStates,
  {
    projectedRequestIds = requestIdsWithProjectionEvents(),
    projectionPopulationsClosed = auditProjectionPopulationsClosed(),
  } = {},
) {
  if (!jobStates.length || !projectionPopulationsClosed) return false;
  return jobStates.every((state) => projectedRequestIds.has(state.request_id));
}

function reconcileFullStateProjection({ runFn = run } = {}) {
  const steps = [
    [
      'speaker_people_sync_without_open_job',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync_without_open_job',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    [
      'people_projection_audit_without_open_job',
      ['scripts/voice-people-file-projection-audit.js', '--write'],
    ],
  ];
  const results = [];
  for (const [label, args] of steps) {
    const result = runFn(label, args);
    results.push(result);
    if (!result.ok) break;
  }
  return {
    ok: results.length === steps.length && results.every((row) => row.ok),
    results,
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function currentBriefingDateForInstant(nowMs = Date.now()) {
  const instant = new Date(nowMs);
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(instant)
    .find((part) => part.type === 'hour');
  const day = ctDayKeyForInstant(instant);
  return Number(hourPart && hourPart.value) >= 23 ? addDaysToDayKey(day, 1) : day;
}

function activeControllerDate({
  dataRoot = DATA_ROOT,
  pidAlive = processIsAlive,
  hostname = os.hostname(),
} = {}) {
  const leasePath = path.join(dataRoot, 'agent', 'card-controller', 'active-lease.json');
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const date = String(lease.date || '').slice(0, 10);
    const ownerHost = String(lease.hostname || '');
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      (!ownerHost || ownerHost === hostname) &&
      pidAlive(Number(lease.pid))
    ) {
      return date;
    }
  } catch {
    // Missing or malformed lease falls back to the briefing calendar boundary.
  }
  return '';
}

function queueProjectionHealthRefresh({
  repoRoot = REPO,
  dataRoot = DATA_ROOT,
  spawnFn = spawn,
  nowMs = Date.now(),
  pidAlive = processIsAlive,
  hostname = os.hostname(),
} = {}) {
  const runner = path.join(repoRoot, 'scripts', 'ec2-card-controller-exact-run.sh');
  if (!fs.existsSync(runner)) return null;
  const briefingDate =
    activeControllerDate({ dataRoot, pidAlive, hostname }) || currentBriefingDateForInstant(nowMs);
  let fd;
  try {
    const logDir = path.join(dataRoot, 'agent', 'card-refresh-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'voice-people-projection-' + Date.now() + '.log');
    fd = fs.openSync(logPath, 'a');
    const child = spawnFn('/usr/bin/bash', [runner], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        SECONDBRAIN_CONTROLLER_ROOT: repoRoot,
        SECONDBRAIN_DATA_DIR: dataRoot,
        BRIEFING_DATE: briefingDate,
        BRIEFING_CONTROLLER_CARD: 'system_health',
        BRIEFING_CONTROLLER_WORK_UNIT: 'system_health:voice-people-projection',
        BRIEFING_CARD_CONTROLLER_MAX_SECONDS: '600',
      },
    });
    if (child && typeof child.unref === 'function') child.unref();
    return {
      pid: child && child.pid,
      log_path: logPath,
      briefing_date: briefingDate,
      supervisor: 'ec2-card-controller-exact-run',
    };
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// The graded audit fields the System Health voice-people-projection row reads.
// generated_at is excluded on purpose: every audit run rewrites it, so hashing
// it would queue the exact controller on every worker run again.
function projectionAuditRefreshHash(audit) {
  if (!audit || typeof audit !== 'object' || typeof audit.status !== 'string') return '';
  const count = (value) => Number(value || 0);
  const material = {
    status: audit.status,
    projection_status: String(audit.projection_status || ''),
    problems: (Array.isArray(audit.problems) ? audit.problems : []).map(String).sort(),
    expected_people_files: count(audit.expected_people_files),
    current_people_file_projections: count(audit.current_people_file_projections),
    missing_or_stale_people_file_projections: count(audit.missing_or_stale_people_file_projections),
    people_file_writes_observed: count(audit.people_file_writes_observed),
    relay_requests_open: count(audit.relay_requests_open),
    relay_requests_failed: count(audit.relay_requests_failed),
    relay_requests_stale_open: count(audit.relay_requests_stale_open),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

// The refresh must fire whenever what the System Health rows grade changes, and
// the grade reads more than the audit: the Save job ledger, this worker's
// status, the identity hook and the relay ledgers. A superseded Save closing
// turns the verdict while the audit stays identical, and an audit-only hash
// then kept the old red card. Hash the grader's own verdict (status, detail and
// problems of the projection and Save-action rows) together with the audit
// fields. An unreadable audit or a grader error reads as unreadable, which
// fails open to a refresh.
function projectionHealthRefreshHash({
  audit,
  dataRoot = DATA_ROOT,
  nowMs = Date.now(),
  readHealth = readVoicePeopleProjectionHealth,
} = {}) {
  const auditHash = projectionAuditRefreshHash(audit);
  if (!auditHash) return '';
  try {
    const health = readHealth({ dataDir: dataRoot, nowMs });
    if (!health || typeof health.status !== 'string') return '';
    const graded = (part) => ({
      status: String(part?.status || ''),
      detail: String(part?.detail || ''),
      problems: (Array.isArray(part?.problems) ? part.problems : []).map(String).sort(),
    });
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          audit: auditHash,
          projection: graded(health),
          save_actions: graded(health.save_actions),
        }),
      )
      .digest('hex');
  } catch {
    return '';
  }
}

// ec2-card-controller-exact-run.sh prints this line only after the controller
// itself ran and exited 0. Its cutoff refusal (exit 3), duplicate-flock exit and
// failed controller print other lines. A test renders the script's own echo
// lines so this pattern and the runner cannot drift apart.
const RUNNER_REFRESH_FINISHED_RE = /^\[card-controller-exact-run\] \S+ finished status=0 /m;
// A runner that can never refresh (every unattended run after the 4:30 AM
// cutoff) is re-queued at most once per audit hash in this window.
const PROJECTION_REFRESH_REQUEUE_MS = 30 * 60 * 1000;

// The marker is written at spawn, so it only proves a refresh was queued. Honor
// it while that runner is still alive, or once its log shows the controller
// finished; any error reads as unconfirmed.
function projectionRefreshMarkerConfirmed(
  marker,
  { pidAlive = processIsAlive, readLog = (file) => fs.readFileSync(file, 'utf8') } = {},
) {
  try {
    const pid = Number(marker?.pid);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return 'runner_alive';
  } catch {
    // An unusable liveness probe falls through to the log evidence.
  }
  try {
    const logPath = String(marker?.log_path || '');
    if (logPath && RUNNER_REFRESH_FINISHED_RE.test(readLog(logPath))) return 'runner_finished_status_0';
  } catch {
    // A missing or unreadable log is not evidence that the refresh ran.
  }
  return '';
}

// Queue the exact System Health refresh only when the graded audit changed
// since the last confirmed refresh. A stale Save replayed every two minutes once
// spawned about 600 identical controller runs a day. Unreadable evidence fails
// open to today's spawn, and the marker moves only after a spawn returns a pid,
// so a failed spawn is retried on the next worker run. A matching marker whose
// runner exited without refreshing is re-queued, bounded per audit hash.
function queueProjectionHealthRefreshIfChanged({
  dataRoot = DATA_ROOT,
  auditPath = path.join(
    dataRoot,
    'life-archive',
    'voiceprints',
    'voice-people-file-projection-audit-latest.json',
  ),
  markerPath = path.join(
    dataRoot,
    'life-archive',
    'voiceprints',
    'voice-people-projection-refresh-marker.json',
  ),
  queueRefreshFn = () => queueProjectionHealthRefresh({ dataRoot }),
  pidAlive = processIsAlive,
  readLog = undefined,
  readHealth = readVoicePeopleProjectionHealth,
  requeueAfterMs = PROJECTION_REFRESH_REQUEUE_MS,
  now = new Date(),
} = {}) {
  // Named audit_hash for the marker's sake; it covers every graded input.
  const auditHash = projectionHealthRefreshHash({
    audit: readJson(auditPath, null),
    dataRoot,
    nowMs: now.getTime(),
    readHealth,
  });
  const marker = readJson(markerPath, null);
  const markerHash = typeof marker?.audit_hash === 'string' ? marker.audit_hash : '';
  let unconfirmedRequeue = false;
  if (auditHash && markerHash === auditHash) {
    const confirmed = projectionRefreshMarkerConfirmed(marker, {
      pidAlive,
      ...(readLog ? { readLog } : {}),
    });
    const skip = (reason) => ({
      skipped: true,
      reason,
      audit_hash: auditHash,
      marker_queued_at: String(marker.queued_at || ''),
    });
    if (confirmed) return { ...skip('projection_audit_unchanged'), refresh_evidence: confirmed };
    const sinceQueuedMs = now.getTime() - Date.parse(String(marker.queued_at || ''));
    if (Number.isFinite(sinceQueuedMs) && sinceQueuedMs >= 0 && sinceQueuedMs < requeueAfterMs) {
      return skip('projection_refresh_unconfirmed_requeue_wait');
    }
    unconfirmedRequeue = true;
  }
  const cardRefresh = queueRefreshFn();
  if (!cardRefresh?.pid) return cardRefresh;
  const refreshReason = unconfirmedRequeue
    ? 'projection_refresh_unconfirmed'
    : !auditHash
      ? 'projection_audit_unreadable'
      : markerHash
        ? 'projection_audit_changed'
        : 'refresh_marker_unreadable';
  if (auditHash) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            schema: 'life_archive_voice_people_projection_refresh_marker.v1',
            audit_hash: auditHash,
            queued_at: now.toISOString(),
            pid: cardRefresh.pid,
            log_path: cardRefresh.log_path || '',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } catch {
      // Without a marker the next worker run queues again: today's behavior.
    }
  }
  return { ...cardRefresh, audit_hash: auditHash || null, refresh_reason: refreshReason };
}

function attachCardRefresh(report, outcome) {
  if (!outcome) return false;
  if (outcome.skipped) report.card_refresh_skipped = outcome;
  else report.card_refresh = outcome;
  return true;
}

function publishFullStateReconciliation({
  report,
  saveStatusFn = saveStatus,
  queueRefreshFn = queueProjectionHealthRefreshIfChanged,
} = {}) {
  saveStatusFn(report);
  // Persist whether the exact controller was queued or skipped.
  if (attachCardRefresh(report, queueRefreshFn())) saveStatusFn(report);
  return report;
}

// A worker that finds the lock busy used to exit without a ledger row, so an
// exact dispatch that never ran spent none of its Save's budget. Record one
// counted dispatch_failed row, and never for a Save that is already completed.
function recordWorkerLockBusy(
  requestedJobId,
  {
    events = readVoiceConfirmationJobEvents(JOBS_PATH),
    jobsPath = JOBS_PATH,
    appendEvent = appendVoiceConfirmationJobEvent,
    now = new Date(),
  } = {},
) {
  const state = requestedJobId ? openJobStates(events, requestedJobId)[0] : null;
  if (!state) return false;
  appendEvent(jobsPath, {
    request_id: state.request_id,
    voice_cluster_id: state.voice_cluster_id || state.latest?.voice_cluster_id || '',
    person_file_path: state.person_file_path || state.latest?.person_file_path || '',
    job_status: 'dispatch_failed',
    error: 'worker_lock_busy',
    counted_attempt: true,
    event_at: now.toISOString(),
  });
  return true;
}

function main() {
  const workerStartedAtMs = Date.now();
  const workerStartedAt = new Date(workerStartedAtMs).toISOString();
  const requestedJobId = argValue('--job-request-id');
  const forceExactReplay = process.argv.slice(2).includes('--force-exact-replay');
  const lock = acquireWorkerLock(WORKER_LOCK_PATH);
  if (!lock) {
    if (requestedJobId) {
      try {
        recordWorkerLockBusy(requestedJobId);
      } catch {
        // An unwritable ledger keeps today's silent busy exit.
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: 'life_archive_voice_confirmation_backprop.v1',
          generated_at: new Date().toISOString(),
          ok: true,
          phase: 'already_running',
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  // The desktop relay can land while this cloud worker is idle. Reconcile its
  // durable receipt before selecting open jobs so a later audit replay cannot
  // append `awaiting_git_relay` after an already-landed `completed` row.
  reconcileLandedRelayCompletions();
  // One click is one exact owner. A retry without an explicit id takes at most
  // one eligible Save instead of replaying every historical Save together.
  const jobStates = requestedJobId
    ? openJobStates(undefined, requestedJobId, { includeCompleted: forceExactReplay })
    : idlessWorkerJobStates();
  if (!jobStates.length) {
    // Full-state projection also advances when call evidence or the durable
    // enrollment registry changes without creating a new Save job. The metric
    // skill prescribes this command as its idempotent replay, so an empty Save
    // queue must still reconcile both generated People File blocks and audit
    // the result.
    const reconciliation = reconcileFullStateProjection();
    const report = {
      schema: 'life_archive_voice_confirmation_backprop.v1',
      generated_at: new Date().toISOString(),
      started_at: workerStartedAt,
      phase: reconciliation.ok
        ? 'full_state_projection_reconciled_without_open_job'
        : 'full_state_projection_failed_without_open_job',
      ok: reconciliation.ok,
      requested_job_id: requestedJobId || null,
      results: reconciliation.results,
    };
    publishFullStateReconciliation({ report });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    releaseWorkerLock(WORKER_LOCK_PATH, lock.token);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  appendJobState(jobStates, 'running', {
    started_at: workerStartedAt,
    worker_pid: process.pid,
    phase: 'starting',
  });
  const exactVoiceId = String(jobStates[0]?.voice_cluster_id || jobStates[0]?.latest?.voice_cluster_id || '');
  const exactRequestId = String(jobStates[0]?.request_id || '');
  const steps = [
    [
      'apply',
      [
        'scripts/apply-voice-confirmation-actions.js',
        '--write',
        ...(exactVoiceId ? ['--voice-cluster-id', exactVoiceId] : []),
        ...(exactRequestId ? ['--request-id', exactRequestId] : []),
      ],
    ],
    ['people_file_target_repair', ['scripts/voice-people-file-target-repair.js', '--write']],
    [
      'speaker_identity_completeness_before_cluster',
      ['scripts/otter-speaker-identity-completeness.js', '--write'],
      {
        // Prepare a coherent archive first. The cluster writer immediately
        // after this step owns the identity-change hook and People File sync.
        SPEAKER_IDENTITY_CHANGE_HOOK: '0',
      },
    ],
    [
      'apply_cluster_resolutions',
      ['scripts/apply-voice-cluster-resolutions.js', '--write', '--json'],
    ],
    ['life_relevance', ['scripts/otter-life-relevance-enricher.js', '--write']],
    ['speaker_intelligence_report', ['scripts/otter-speaker-intelligence-report.js', '--write']],
    [
      'speaker_people_sync',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'sync_people',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    [
      'wavlm_resolver',
      [
        'scripts/otter-wavlm-speaker-resolver.js',
        '--write',
        '--limit',
        process.env.VOICE_BACKPROP_WAVLM_LIMIT || '80',
      ],
    ],
    [
      'speaker_identity_completeness',
      ['scripts/otter-speaker-identity-completeness.js', '--write'],
    ],
    ['voice_confirmed_match_sanity', ['scripts/voice-confirmed-match-sanity-check.js', '--write']],
    [
      'promote_confirmed_acoustic',
      ['scripts/voice-promote-confirmed-acoustic-matches.js', '--write'],
    ],
    [
      'apply_promoted_cluster_resolutions',
      ['scripts/apply-voice-cluster-resolutions.js', '--write', '--json'],
    ],
    [
      'speaker_identity_completeness_after_promotion',
      ['scripts/otter-speaker-identity-completeness.js', '--write'],
    ],
    [
      'speaker_intelligence_report_after_promotion',
      ['scripts/otter-speaker-intelligence-report.js', '--write'],
    ],
    [
      'speaker_people_sync_after_promotion',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync_after_promotion',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    ['queue', ['scripts/voice-confirmation-queue-build.js', '--write']],
    [
      'audio',
      [
        'scripts/otter-audio-download.js',
        'queue',
        '--queue',
        'data/life-archive/people/briefing-voice-queue-latest.json',
        '--limit',
        process.env.VOICE_CONFIRMATION_AUDIO_LIMIT || '60',
        '--json',
      ],
    ],
    ['people_projection_audit', ['scripts/voice-people-file-projection-audit.js', '--write']],
  ];
  // A pure not-them/ignore/dismiss save already has an asserted answer. It
  // must apply that answer, refresh the affected archive projections, and
  // prove the full-state People File audit. Global acoustic discovery is
  // unrelated work and can race current exact-call projections.
  // An owner click is not a request to rebuild the voice archive. Apply the
  // exact action, refresh only the affected People file, rebuild the review
  // queue, and leave broad archive discovery to its existing scheduled owner.
  const selectedSteps = selectedStepsForJobStates(jobStates, steps);
  const results = [];
  let report;
  try {
    for (const [label, args, stepEnv = {}] of selectedSteps) {
      appendJobState(jobStates, 'running', {
        started_at: workerStartedAt,
        worker_pid: process.pid,
        phase: `running_${label}`,
      });
      saveStatus({
        schema: 'life_archive_voice_confirmation_backprop.v1',
        generated_at: new Date().toISOString(),
        started_at: workerStartedAt,
        phase: `running_${label}`,
        ok: null,
        job_request_ids: jobStates.map((state) => state.request_id),
        results,
      });
      const result = run(label, args, stepEnv);
      if (label === 'apply' && result.ok) {
        const personIds = resolvedPersonIdsForJobStates(jobStates);
        if (personIds.length) {
          const targetedSync = run('sync_people_exact', [
            'scripts/sync-voiceprints-to-people-files.js',
            '--write',
            '--json',
            ...personIds.flatMap((personId) => ['--person-id', personId]),
          ]);
          targetedSync.person_ids = personIds;
          results.push(targetedSync);
          if (!targetedSync.ok) {
            result.ok = false;
            result.targeted_people_sync_failed = true;
          }
        }
        if (result.ok) {
          // Advisory: proposals only, bounded, never fails the owner's job.
          results.push(...runPostSaveRematchForJobStates(jobStates));
        }
      }
      if ((label === 'sync_people' || label === 'apply') && result.ok) {
        const identitiesByRequest = Object.fromEntries(
          jobStates.map((state) => [
            state.request_id,
            resolvedPersonIdsForJobStates([state]),
          ]),
        );
        result.git_people_sync_requests_marked_ready = markGitPeopleSyncRequestsReady(
          GIT_PEOPLE_SYNC_REQUESTS_PATH,
          jobStates.map((state) => state.request_id),
          identitiesByRequest,
        );
      }
      results.push(result);
      saveStatus({
        schema: 'life_archive_voice_confirmation_backprop.v1',
        generated_at: new Date().toISOString(),
        started_at: workerStartedAt,
        phase: result.ok ? `completed_${label}` : `failed_${label}`,
        ok: result.ok,
        job_request_ids: jobStates.map((state) => state.request_id),
        results,
      });
      if (!result.ok && label !== 'audio') {
        if (label !== 'people_projection_audit') {
          for (const [recoveryLabel, recoveryArgs] of projectionRecoveryStepsAfterFailure(label)) {
            const recovery = run(recoveryLabel, recoveryArgs);
            if (recoveryLabel === 'voiceprint_people_sync_after_failure' && recovery.ok) {
              recovery.git_people_sync_requests_marked_ready =
                markGitPeopleSyncRequestsReady();
            }
            results.push(recovery);
            if (!recovery.ok) break;
          }
          const auditAfterFailure = run('people_projection_audit_after_failure', [
            'scripts/voice-people-file-projection-audit.js',
            '--write',
          ]);
          results.push(auditAfterFailure);
        }
        break;
      }
    }
    const completedAt = new Date().toISOString();
    const ok = results.every((row) => row.ok || row.label === 'audio');
    // Name the step that actually failed. `phase` alone collapses to the string
    // "failed", which made System Health render the useless "durable retry
    // failed at failed" instead of pointing at life_relevance.
    const failedStepRow = ok
      ? null
      : [...results].reverse().find((row) => !row.ok && row.label !== 'audio');
    report = {
      schema: 'life_archive_voice_confirmation_backprop.v1',
      generated_at: completedAt,
      started_at: workerStartedAt,
      runtime_ms: Date.now() - workerStartedAtMs,
      ok,
      phase: ok ? 'completed' : 'failed',
      failed_step: failedStepRow ? failedStepRow.label : '',
      failed_step_timed_out: failedStepRow ? failedStepRow.status === null : false,
      job_request_ids: jobStates.map((state) => state.request_id),
      results,
    };
    if (ok) {
      const resolvedPersonIds = resolvedPersonIdsForJobStates(jobStates);
      for (const state of jobStates) {
        const relayRequired = voiceConfirmationJobRequiresGitRelay(state);
        const completionLatencyMs = state.accepted_at
          ? Math.max(0, Date.parse(completedAt) - Date.parse(state.accepted_at))
          : null;
        appendVoiceConfirmationJobEvent(JOBS_PATH, {
          request_id: state.request_id,
          voice_cluster_id: state.latest?.voice_cluster_id || '',
          person_file_path: state.latest?.person_file_path || '',
          action: state.action || '',
          job_status: relayRequired ? 'awaiting_git_relay' : 'completed',
          projection_completed_at: completedAt,
          ...(relayRequired
            ? {}
            : {
                completed_at: completedAt,
                completion_latency_ms: Number.isFinite(completionLatencyMs)
                  ? completionLatencyMs
                  : undefined,
                completion_evidence: 'green_full_state_projection_audit',
              }),
          worker_runtime_ms: report.runtime_ms,
        });
        if (!relayRequired) {
          try {
            markVoiceConfirmationAwaitingReview(
              state.request_id,
              ownerReviewSummary(state, resolvedPersonIds),
            );
          } catch (ownerLoopError) {
            report.owner_loop_error = ownerLoopError.message;
          }
        }
      }
    } else {
      const failedRow = [...results].reverse().find((row) => !row.ok && row.label !== 'audio');
      appendJobState(jobStates, 'failed', {
        failed_at: completedAt,
        failure_phase: failedRow ? `failed_${failedRow.label}` : 'failed_unknown',
        error_tail: String(failedRow?.stderr || failedRow?.stdout || '').slice(-1000),
        worker_runtime_ms: report.runtime_ms,
      });
      for (const state of jobStates) {
        try {
          queueVoiceConfirmationRepair(
            state.request_id,
            String(failedRow?.stderr || failedRow?.stdout || failedRow?.label || 'exact action failed').slice(-1800),
          );
        } catch (ownerLoopError) {
          report.owner_loop_error = ownerLoopError.message;
        }
      }
    }
    saveStatus(report);
    if (attachCardRefresh(report, queueProjectionHealthRefreshIfChanged())) saveStatus(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const failedAt = new Date().toISOString();
    appendJobState(jobStates, 'failed', {
      failed_at: failedAt,
      failure_phase: 'failed_worker_exception',
      error_tail: String(error?.stack || error?.message || error).slice(-1000),
      worker_runtime_ms: Date.now() - workerStartedAtMs,
    });
    for (const state of jobStates) {
      try {
        queueVoiceConfirmationRepair(state.request_id, String(error?.stack || error?.message || error));
      } catch {
        // The job ledger remains canonical even if its review projection is unavailable.
      }
    }
    report = {
      schema: 'life_archive_voice_confirmation_backprop.v1',
      generated_at: failedAt,
      started_at: workerStartedAt,
      runtime_ms: Date.now() - workerStartedAtMs,
      ok: false,
      phase: 'failed_worker_exception',
      error: String(error?.stack || error?.message || error).slice(-4000),
      job_request_ids: jobStates.map((state) => state.request_id),
      results,
    };
    saveStatus(report);
    if (attachCardRefresh(report, queueProjectionHealthRefreshIfChanged())) saveStatus(report);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    releaseWorkerLock(WORKER_LOCK_PATH, lock.token);
  }
}

if (require.main === module) main();

module.exports = {
  POST_SAVE_REMATCH_TIMEOUT_MS,
  POST_SAVE_REMATCH_HEAP_MB,
  PROJECTION_REFRESH_REQUEUE_MS,
  RUNNER_REFRESH_FINISHED_RE,
  postSaveRematchInvocations,
  runPostSaveRematchForJobStates,
  ACOUSTIC_DISCOVERY_STEP_LABELS,
  AUDIT_STEP_LABELS,
  FULL_STATE_REPLAY_STEP_LABELS,
  FULL_CORPUS_STEP_LABELS,
  LIGHT_STEP_TIMEOUT_MS,
  FULL_CORPUS_STEP_TIMEOUT_MS,
  FULL_CORPUS_NODE_HEAP_MB,
  STEP_NODE_HEAP_MB_BY_LABEL,
  stepTimeoutMs,
  stepNodeHeapMb,
  activeControllerDate,
  currentBriefingDateForInstant,
  markGitPeopleSyncRequestsReady,
  latestRelayReceiptByRequestId,
  landedSupersedingRelay,
  idlessWorkerJobStates,
  openJobStates,
  processIsAlive,
  jobStatesAlreadyHaveProjectionProof,
  projectionRecoveryStepsAfterFailure,
  projectionAuditRefreshHash,
  projectionHealthRefreshHash,
  publishFullStateReconciliation,
  queueProjectionHealthRefresh,
  queueProjectionHealthRefreshIfChanged,
  recordWorkerLockBusy,
  reconcileLandedRelayCompletions,
  reconcileFullStateProjection,
  stepsForJobStates,
  selectedStepsForJobStates,
  ownerReviewSummary,
};
