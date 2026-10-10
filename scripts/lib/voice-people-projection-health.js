'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  jobsPathForDataRoot,
  summarizeVoiceConfirmationJobs,
} = require('./voice-confirmation-jobs.js');

const PROJECTION_ACTION_RE = /^(?:confirm|correct|link_person_file|create_people_file)$/;

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowTimestamp(row) {
  return (
    row?.updated_at ||
    row?.ready_at ||
    row?.requested_at ||
    row?.generated_at ||
    row?.landed_at ||
    row?.completed_at ||
    row?.ts ||
    row?.created_at ||
    row?.createdAt ||
    row?.confirmed_at ||
    ''
  );
}

function latestProof(rows, source, predicate = () => true) {
  return (
    (rows || [])
      .filter((row) => row && predicate(row) && timeMs(rowTimestamp(row)))
      .map((row) => ({ source, generated_at: rowTimestamp(row), row }))
      .sort((left, right) => timeMs(right.generated_at) - timeMs(left.generated_at))[0] || null
  );
}

function instrumentedConfirmation(row) {
  return Boolean(
    row && PROJECTION_ACTION_RE.test(String(row.action || '')) && row.gitPeopleSyncRequestId,
  );
}

function finiteAuditCount(audit, key, fallback = 0) {
  if (!audit || !Object.prototype.hasOwnProperty.call(audit, key)) return fallback;
  const value = Number(audit[key]);
  return Number.isFinite(value) ? value : fallback;
}

function evaluateVoicePeopleProjectionHealth({
  audit = null,
  confirmationActions = [],
  confirmationBackprop = null,
  identityChangeHook = null,
  relayRequests = [],
  relayReceipts = [],
  jobEvents = [],
  nowMs = Date.now(),
  maxAgeHours = 36,
} = {}) {
  const jobHealth = summarizeVoiceConfirmationJobs(jobEvents, { nowMs });
  const auditAtMs = timeMs(audit?.generated_at);
  const auditAgeHours = auditAtMs ? Math.max(0, (nowMs - auditAtMs) / 3.6e6) : null;
  const latestSave = latestProof(confirmationActions, 'confirmed Save', instrumentedConfirmation);
  const latestHook =
    identityChangeHook?.people_projection_required && timeMs(identityChangeHook.generated_at)
      ? {
          source: 'speaker identity change',
          generated_at: identityChangeHook.generated_at,
          row: identityChangeHook,
        }
      : null;
  const latestMutation =
    [latestSave, latestHook]
      .filter(Boolean)
      .sort((left, right) => timeMs(right.generated_at) - timeMs(left.generated_at))[0] || null;
  const auditCoversLatestMutation = Boolean(
    auditAtMs && (!latestMutation || auditAtMs >= timeMs(latestMutation.generated_at)),
  );
  const expected = Number(audit?.expected_people_files || 0);
  const current = Number(audit?.current_people_file_projections || 0);
  const instrumented = Number(audit?.instrumented_confirmation_actions || 0);
  const projected = Number(audit?.confirmation_actions_with_projection_event || 0);
  const declaredUnprojected = finiteAuditCount(
    audit,
    'unprojected_confirmation_actions',
    Math.max(instrumented - projected, 0),
  );
  const unprojected = Math.max(declaredUnprojected, instrumented - projected, 0);
  const declaredMissingPeopleFiles = finiteAuditCount(
    audit,
    'missing_or_stale_people_file_projections',
    Math.max(expected - current, 0),
  );
  const missingPeopleFiles = Math.max(declaredMissingPeopleFiles, expected - current, 0);
  const confirmedIdentityTotal = finiteAuditCount(
    audit,
    'confirmed_named_voice_identities',
    expected,
  );
  const confirmationActionsSeen = finiteAuditCount(audit, 'confirmation_actions_seen', NaN);
  const preInstrumentation = finiteAuditCount(
    audit,
    'pre_instrumentation_confirmation_actions',
    Number.isFinite(confirmationActionsSeen)
      ? Math.max(confirmationActionsSeen - instrumented, 0)
      : 0,
  );
  const identityProjectionCountsReconcile =
    confirmedIdentityTotal === expected && current + declaredMissingPeopleFiles === expected;
  const saveProjectionCountsReconcile = projected + declaredUnprojected === instrumented;
  const confirmationActionCountsReconcile =
    !Number.isFinite(confirmationActionsSeen) ||
    preInstrumentation + instrumented === confirmationActionsSeen;
  const unprojectedDistinctIdentities = finiteAuditCount(
    audit,
    'unprojected_confirmation_distinct_identities',
    0,
  );
  const unprojectedUnknownIdentityActions = finiteAuditCount(
    audit,
    'unprojected_confirmation_unknown_identity_actions',
    unprojected > 0 && unprojectedDistinctIdentities === 0 ? unprojected : 0,
  );
  const incompleteWithPendingSave = finiteAuditCount(
    audit,
    'incomplete_identities_with_pending_save',
    0,
  );
  const incompleteWithoutPendingSave = finiteAuditCount(
    audit,
    'incomplete_identities_without_pending_save',
    Math.max(missingPeopleFiles - incompleteWithPendingSave, 0),
  );
  const identityGapPartitionCountsReconcile =
    incompleteWithPendingSave + incompleteWithoutPendingSave === declaredMissingPeopleFiles &&
    incompleteWithPendingSave <= unprojectedDistinctIdentities &&
    unprojectedDistinctIdentities <= declaredUnprojected;
  const internalConsistency = Boolean(
    audit &&
    identityProjectionCountsReconcile &&
    saveProjectionCountsReconcile &&
    confirmationActionCountsReconcile &&
    identityGapPartitionCountsReconcile &&
    audit.internally_consistent !== false,
  );
  const relayFailed = Number(audit?.relay_requests_failed || 0);
  const relayStaleOpen = Number(audit?.relay_requests_stale_open || 0);
  const targetCollisions = Number(audit?.people_file_target_collisions || 0);
  const projectionProblems = [];
  const saveProblems = [];
  if (!audit) {
    projectionProblems.push('projection audit missing');
    saveProblems.push('Save-path audit missing');
  } else {
    if (!identityProjectionCountsReconcile) {
      projectionProblems.push('confirmed identity projection count arithmetic is inconsistent');
    }
    if (missingPeopleFiles > 0) {
      projectionProblems.push(
        `${missingPeopleFiles} confirmed identity People File projection(s) are incomplete`,
      );
    }
    if (targetCollisions > 0) {
      projectionProblems.push(`${targetCollisions} People File target collision(s)`);
    }
    if (
      !saveProjectionCountsReconcile ||
      !confirmationActionCountsReconcile ||
      !identityGapPartitionCountsReconcile
    ) {
      saveProblems.push('Save-path audit count arithmetic is inconsistent');
    }
    if (unprojected > 0) {
      saveProblems.push(`${unprojected} instrumented Save action(s) are incomplete`);
    }
    if (auditAgeHours == null || auditAgeHours > maxAgeHours) {
      projectionProblems.push('projection audit is stale');
      saveProblems.push('Save-path audit is stale');
    }
  }
  if (latestMutation && !auditCoversLatestMutation) {
    projectionProblems.push(
      'projection audit predates the latest confirmed voice identity mutation',
    );
    saveProblems.push('Save-path audit predates the latest confirmed voice identity mutation');
  }
  if (
    confirmationBackprop?.ok === false &&
    timeMs(confirmationBackprop.generated_at) >= auditAtMs
  ) {
    saveProblems.push('voice confirmation backprop failed after the latest projection audit');
  }
  if (
    identityChangeHook?.ok === false &&
    identityChangeHook?.people_projection_required &&
    timeMs(identityChangeHook.generated_at) >= auditAtMs
  ) {
    saveProblems.push('speaker identity change People File reconciliation failed');
  }
  if (jobHealth.pending_jobs > 0) {
    saveProblems.push('voice confirmation background Save jobs are incomplete');
  }
  if (relayFailed > 0) {
    saveProblems.push(`${relayFailed} People File relay request(s) failed`);
  }
  if (relayStaleOpen > 0) {
    saveProblems.push(`${relayStaleOpen} People File relay request(s) remain open after 24h`);
  }

  const projectionDetailParts = [];
  const saveDetailParts = [];
  if (audit) {
    projectionDetailParts.push(
      `Full-state audit: ${current}/${expected} confirmed identity People Files match the latest voice and call-content state${
        missingPeopleFiles > 0 ? ` (${missingPeopleFiles} incomplete)` : ''
      }`,
    );
    const pendingIdentityScope =
      unprojectedDistinctIdentities > 0
        ? `${unprojectedDistinctIdentities} identit${
            unprojectedDistinctIdentities === 1 ? 'y' : 'ies'
          }`
        : unprojectedUnknownIdentityActions > 0
          ? 'unresolved identity targets'
          : '';
    saveDetailParts.push(
      `Save-path audit: ${projected}/${instrumented} instrumented Save actions closed${
        unprojected > 0
          ? ` (${unprojected} incomplete${
              pendingIdentityScope ? ` across ${pendingIdentityScope}` : ''
            })`
          : ''
      }`,
    );
    if (preInstrumentation > 0) {
      saveDetailParts.push(
        `${preInstrumentation} older confirmed Save action${
          preInstrumentation === 1 ? '' : 's'
        } ${preInstrumentation === 1 ? 'is' : 'are'} covered by the full-state audit, not retroactive event receipts`,
      );
    }
    if (incompleteWithoutPendingSave > 0) {
      projectionDetailParts.push(
        `${incompleteWithoutPendingSave} other incomplete identit${
          incompleteWithoutPendingSave === 1 ? 'y was' : 'ies were'
        } found by the independent full-state audit and ${
          incompleteWithoutPendingSave === 1 ? 'is' : 'are'
        } not linked to a pending instrumented Save`,
      );
    }
  }
  if (audit && !identityProjectionCountsReconcile) {
    projectionDetailParts.push('confirmed identity projection count arithmetic is inconsistent');
  }
  if (
    audit &&
    (!saveProjectionCountsReconcile ||
      !confirmationActionCountsReconcile ||
      !identityGapPartitionCountsReconcile)
  ) {
    saveDetailParts.push('Save-path audit count arithmetic is inconsistent');
  }
  if (targetCollisions > 0) {
    projectionDetailParts.push(
      `${targetCollisions} People File target collision${targetCollisions === 1 ? '' : 's'}`,
    );
  }
  if (relayFailed > 0) {
    saveDetailParts.push(
      `${relayFailed} People File relay request${relayFailed === 1 ? '' : 's'} failed`,
    );
  }
  if (relayStaleOpen > 0) {
    saveDetailParts.push(
      `${relayStaleOpen} People File relay request${relayStaleOpen === 1 ? '' : 's'} remain open after 24h`,
    );
  }
  if (jobHealth.accepted_jobs > 0) {
    saveDetailParts.push(
      `Save jobs: ${jobHealth.completed_jobs}/${jobHealth.accepted_jobs} completed` +
        `${
          jobHealth.pending_jobs > 0
            ? ` (${jobHealth.pending_jobs} pending, ${jobHealth.failed_jobs} failed, ${jobHealth.stale_pending_jobs} stale)`
            : ''
        }` +
        `${
          jobHealth.ack_latency_p95_ms == null ? '' : `; ack p95 ${jobHealth.ack_latency_p95_ms}ms`
        }` +
        `${
          jobHealth.completion_latency_p95_ms == null
            ? ''
            : `; completion p95 ${jobHealth.completion_latency_p95_ms}ms`
        }`,
    );
  }
  if (latestSave && (!auditAtMs || timeMs(latestSave.generated_at) > auditAtMs)) {
    projectionDetailParts.push('the latest confirmed Save is newer than the full-state audit');
    saveDetailParts.push('the latest confirmed Save is newer than the Save-path audit');
  } else if (latestMutation && !auditCoversLatestMutation) {
    projectionDetailParts.push(`the latest ${latestMutation.source} is newer than the audit`);
    saveDetailParts.push(`the latest ${latestMutation.source} is newer than the audit`);
  }
  if (
    confirmationBackprop?.ok === false &&
    timeMs(confirmationBackprop.generated_at) >= auditAtMs
  ) {
    // Name the STEP. `phase` collapses to the literal string "failed" on the
    // final artifact, which rendered "durable retry failed at failed" and told
    // ExampleCo nothing. Prefer the recorded failed step; fall back to a running_*
    // phase; otherwise say plainly that the step is unnamed rather than
    // inventing one.
    const failedStep =
      confirmationBackprop.failed_step ||
      (/^running_(.+)$/.exec(String(confirmationBackprop.phase || ''))?.[1] ?? '') ||
      '';
    saveDetailParts.push(
      `durable retry failed at ${failedStep || 'an unnamed step'}${
        failedStep && confirmationBackprop.failed_step_timed_out ? ' (timed out)' : ''
      }`,
    );
  }
  if (!audit) {
    projectionDetailParts.push('no projection audit artifact exists');
    saveDetailParts.push('no Save-path audit artifact exists');
  }
  if (audit && auditAgeHours != null && auditAgeHours > maxAgeHours) {
    projectionDetailParts.push(`audit proof is ${Math.round(auditAgeHours)}h old`);
    saveDetailParts.push(`audit proof is ${Math.round(auditAgeHours)}h old`);
  }
  if (!projectionDetailParts.length)
    projectionDetailParts.push('no projection health detail is available');
  if (!saveDetailParts.length) saveDetailParts.push('no Save-path health detail is available');

  return {
    status: projectionProblems.length ? 'red' : 'green',
    detail: `${projectionDetailParts.join('; ')}.`,
    problems: projectionProblems,
    save_actions: {
      status: saveProblems.length ? 'red' : 'green',
      detail: `${saveDetailParts.join('; ')}.`,
      problems: saveProblems,
    },
    audit_status: audit?.status || 'MISSING',
    audit_generated_at: audit?.generated_at || '',
    audit_age_hours: auditAgeHours == null ? null : Math.round(auditAgeHours * 10) / 10,
    audit_covers_latest_mutation: auditCoversLatestMutation,
    latest_mutation_source: latestMutation?.source || '',
    latest_mutation_at: latestMutation?.generated_at || '',
    expected_people_files: expected,
    current_people_file_projections: current,
    missing_or_stale_people_file_projections: missingPeopleFiles,
    identity_projection_counts_reconcile: identityProjectionCountsReconcile,
    instrumented_confirmation_actions: instrumented,
    confirmation_actions_with_projection_event: projected,
    unprojected_confirmation_actions: unprojected,
    unprojected_confirmation_distinct_identities: unprojectedDistinctIdentities,
    unprojected_confirmation_unknown_identity_actions: unprojectedUnknownIdentityActions,
    incomplete_identities_with_pending_save: incompleteWithPendingSave,
    incomplete_identities_without_pending_save: incompleteWithoutPendingSave,
    save_projection_counts_reconcile: saveProjectionCountsReconcile,
    confirmation_action_counts_reconcile: confirmationActionCountsReconcile,
    identity_gap_partition_counts_reconcile: identityGapPartitionCountsReconcile,
    internal_consistency: internalConsistency,
    confirmation_actions_seen: Number.isFinite(confirmationActionsSeen)
      ? confirmationActionsSeen
      : null,
    pre_instrumentation_confirmation_actions: preInstrumentation,
    projection_run_events: Number(audit?.projection_run_events || 0),
    people_file_writes_observed: Number(audit?.people_file_writes_observed || 0),
    people_file_target_collisions: targetCollisions,
    relay_requests_failed: relayFailed,
    relay_requests_stale_open: relayStaleOpen,
    save_jobs_accepted: jobHealth.accepted_jobs,
    save_jobs_completed: jobHealth.completed_jobs,
    save_jobs_pending: jobHealth.pending_jobs,
    save_jobs_failed: jobHealth.failed_jobs,
    save_jobs_stale_pending: jobHealth.stale_pending_jobs,
    save_ack_latency_p50_ms: jobHealth.ack_latency_p50_ms,
    save_ack_latency_p95_ms: jobHealth.ack_latency_p95_ms,
    save_completion_latency_p50_ms: jobHealth.completion_latency_p50_ms,
    save_completion_latency_p95_ms: jobHealth.completion_latency_p95_ms,
  };
}

function readJson(file, fsApi) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readJsonl(file, fsApi) {
  try {
    return fsApi
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readVoicePeopleProjectionHealth({
  dataDir,
  fsApi = fs,
  nowMs = Date.now(),
  maxAgeHours = 36,
} = {}) {
  const vpDir = path.join(dataDir, 'life-archive', 'voiceprints');
  const peopleDir = path.join(dataDir, 'life-archive', 'people');
  return evaluateVoicePeopleProjectionHealth({
    audit: readJson(path.join(vpDir, 'voice-people-file-projection-audit-latest.json'), fsApi),
    confirmationActions: readJsonl(path.join(peopleDir, 'voice-confirmation-actions.jsonl'), fsApi),
    confirmationBackprop: readJson(
      path.join(vpDir, 'voice-confirmation-backprop-latest.json'),
      fsApi,
    ),
    identityChangeHook: readJson(
      path.join(vpDir, 'speaker-identity-change-hook-latest.json'),
      fsApi,
    ),
    relayRequests: readJsonl(path.join(peopleDir, 'voice-git-people-sync-requests.jsonl'), fsApi),
    relayReceipts: readJsonl(path.join(peopleDir, 'voice-git-people-sync-receipts.jsonl'), fsApi),
    jobEvents: readJsonl(jobsPathForDataRoot(dataDir), fsApi),
    nowMs,
    maxAgeHours,
  });
}

module.exports = {
  PROJECTION_ACTION_RE,
  finiteAuditCount,
  timeMs,
  rowTimestamp,
  instrumentedConfirmation,
  evaluateVoicePeopleProjectionHealth,
  readVoicePeopleProjectionHealth,
};
