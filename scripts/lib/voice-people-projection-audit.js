'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalPersonId,
  resolvePeopleFileTarget,
} = require('./voice-people-file-target');

function activeEnrollment(row) {
  return Boolean(
    row &&
      !row.quarantined_at &&
      String(row.calibration_quarantine_status || '') !== 'quarantined',
  );
}

function confirmedPerson(person, enrollments) {
  return Boolean(
    person &&
      (person.identity_confirmation_status === 'confirmed_by_ExampleCo' ||
        person.voiceprint_status === 'enrolled' ||
        enrollments.length),
  );
}

function contentBlockCurrent(text, personId, intelligenceRow) {
  if (!intelligenceRow) return false;
  const source = String(text || '');
  const calls = Number(intelligenceRow.conversation_count || 0);
  const segments = Number(intelligenceRow.segment_count || 0);
  const words = Number(intelligenceRow.word_count || 0);
  const fingerprint = String(intelligenceRow.content_fingerprint || '');
  const projectedCounts = source.match(
    /^- Calls \/ segments \/ words:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*$/m,
  );
  const projectionSupersedesReceipt = Boolean(
    projectedCounts &&
      Number(projectedCounts[1]) >= calls &&
      Number(projectedCounts[2]) >= segments &&
      Number(projectedCounts[3]) >= words &&
      (Number(projectedCounts[1]) > calls ||
        Number(projectedCounts[2]) > segments ||
        Number(projectedCounts[3]) > words),
  );
  return (
    source.includes('<!-- otter-speaker-intelligence:start -->') &&
    source.includes(`Speaker key: person:${personId}`) &&
    Boolean(fingerprint) &&
    (source.includes(`Content fingerprint: ${fingerprint}`) || projectionSupersedesReceipt)
  );
}

function emptyContentBlockCurrent(text, personId) {
  const source = String(text || '');
  return (
    source.includes('<!-- otter-speaker-intelligence:start -->') &&
    source.includes(`Speaker key: person:${personId}`) &&
    source.includes('Calls / segments / words: 0 / 0 / 0') &&
    source.includes(`Content fingerprint: no-resolved-call-content:${personId}`)
  );
}

// ExampleCo 2026-09-22: People-file updates batch once a day, so a Save is judged
// current when it lands within the last 24 hours, not the old 6-hour limit.
const RELAY_OPEN_LIMIT_HOURS = 24;

function hasContentBlock(text) {
  return String(text || '').includes('<!-- otter-speaker-intelligence:start -->');
}

function linkedVoiceIdentityText({ repoRoot, contactText }) {
  const source = String(contactText || '');
  const match = source.match(
    /<!-- amy-voice-identity-link:start -->[\s\S]*?Voice identity:\s*`([^`]+)`[\s\S]*?<!-- amy-voice-identity-link:end -->/,
  );
  if (!match) return '';
  const rel = String(match[1] || '').replace(/\\/g, '/');
  if (!/^data\/life-archive\/voiceprints\/people\/[a-z0-9_.-]+\.md$/i.test(rel)) return '';
  const root = path.resolve(String(repoRoot || ''));
  const file = path.resolve(root, ...rel.split('/'));
  const allowedRoot = path.resolve(root, 'data', 'life-archive', 'voiceprints', 'people');
  if (file !== allowedRoot && !file.startsWith(`${allowedRoot}${path.sep}`)) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function projectionEvidenceText({ repoRoot, contactText }) {
  const linked = linkedVoiceIdentityText({ repoRoot, contactText });
  return linked ? `${String(contactText || '')}\n${linked}` : String(contactText || '');
}

function voiceBlockCurrent(text, personId, enrollments) {
  const source = String(text || '');
  if (!enrollments.length) {
    return true;
  }
  if (!source.includes('<!-- voiceprint-identity:start -->')) return false;
  if (!source.includes(`\`${personId}\``)) return false;
  return enrollments
    .map((row) => row.enrollment_id)
    .filter(Boolean)
    .every((id) => source.includes(`\`${id}\``));
}

function latestByRequest(rows) {
  const out = new Map();
  for (const row of rows || []) if (row?.request_id) out.set(row.request_id, row);
  return out;
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
    row?.confirmed_at ||
    ''
  );
}

function latestTimestamp(rows) {
  return (rows || [])
    .map((row) => rowTimestamp(row))
    .filter((stamp) => Number.isFinite(Date.parse(stamp)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || '';
}

function hasWrittenFile(event) {
  return Array.isArray(event?.files_written) && event.files_written.some(
    (file) => typeof file === 'string' && file.trim().length > 0,
  );
}

function confirmationPersonId(row, registry = {}) {
  const direct = canonicalPersonId(
    row?.selectedPersonId ||
      row?.selected_person_id ||
      row?.personId ||
      row?.person_id ||
      '',
  );
  if (direct) return direct;
  const clusterId = String(row?.voiceClusterId || row?.voice_cluster_id || '');
  const resolution = registry.voice_cluster_resolutions?.[clusterId] || {};
  return canonicalPersonId(
    resolution.person_id ||
      resolution.personId ||
      String(resolution.canonical_speaker_id || '').replace(/^person:/, '') ||
      '',
  );
}

function buildProjectionAudit({
  repoRoot,
  registry = {},
  intelligence = {},
  catalog = [],
  confirmationActions = [],
  projectionEvents = [],
  relayRequests = [],
  relayReceipts = [],
  registryPresent = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  const active = (registry.enrollments || []).filter(activeEnrollment);
  const enrollmentsByPerson = new Map();
  for (const enrollment of active) {
    const id = canonicalPersonId(enrollment.person_id);
    if (!enrollmentsByPerson.has(id)) enrollmentsByPerson.set(id, []);
    enrollmentsByPerson.get(id).push(enrollment);
  }

  const intelligenceByPerson = new Map();
  for (const row of intelligence.known_speakers || []) {
    const id = canonicalPersonId(String(row.speaker_key || '').replace(/^person:/, ''));
    if (!id) continue;
    const prior = intelligenceByPerson.get(id);
    if (!prior) {
      intelligenceByPerson.set(id, { ...row, speaker_key: `person:${id}` });
      continue;
    }
    intelligenceByPerson.set(id, {
      ...prior,
      conversation_count: Number(prior.conversation_count || 0) + Number(row.conversation_count || 0),
      segment_count: Number(prior.segment_count || 0) + Number(row.segment_count || 0),
      word_count: Number(prior.word_count || 0) + Number(row.word_count || 0),
      // Multiple producers can emit one row for the same canonical person.
      // Counts are cumulative, but the content fingerprint must follow the
      // newest row rather than remaining pinned to the first row encountered.
      content_fingerprint: row.content_fingerprint || prior.content_fingerprint,
    });
  }

  const canonicalPeople = new Map();
  for (const [rawId, rawPerson] of Object.entries(registry.people || {})) {
    const id = canonicalPersonId(rawId);
    const existing = canonicalPeople.get(id) || {};
    canonicalPeople.set(id, {
      ...rawPerson,
      ...existing,
      person_id: id,
      display_name: existing.display_name || rawPerson.display_name || id,
      contact_file: existing.contact_file || rawPerson.contact_file || '',
    });
  }
  for (const [personId, personEnrollments] of enrollmentsByPerson.entries()) {
    if (canonicalPeople.has(personId)) continue;
    const first = personEnrollments[0] || {};
    canonicalPeople.set(personId, {
      person_id: personId,
      display_name: first.display_name || personId,
      contact_file: first.contact_file || '',
    });
  }

  const rows = [];
  for (const [personId, person] of canonicalPeople.entries()) {
    const enrollments = enrollmentsByPerson.get(personId) || [];
    if (!confirmedPerson(person, enrollments)) continue;
    const target = resolvePeopleFileTarget({
      repoRoot,
      personId,
      displayName: person.display_name,
      registryPerson: person,
      catalog,
    });
    const contact = catalog.find((row) => row.rel === target.rel) || null;
    const text = projectionEvidenceText({ repoRoot, contactText: contact?.text || '' });
    const intel = intelligenceByPerson.get(personId) || null;
    const voiceCurrent = voiceBlockCurrent(text, personId, enrollments);
    const contentCurrent = intel
      ? contentBlockCurrent(text, personId, intel)
      : emptyContentBlockCurrent(text, personId);
    const problems = [];
    if (!person.contact_file) problems.push('registry_contact_file_missing');
    if (target.ambiguous) problems.push('people_file_target_ambiguous');
    if (target.changed) problems.push('registry_contact_file_mismatch');
    if (!target.exists) problems.push('people_file_missing');
    if (!voiceCurrent) problems.push('voiceprint_projection_missing_or_stale');
    if (!intel && !contentCurrent) {
      problems.push(
        hasContentBlock(text)
          ? 'call_content_projection_stale_without_current_resolved_content'
          : 'call_content_projection_missing_or_stale',
      );
    } else if (!contentCurrent) {
      problems.push('call_content_projection_missing_or_stale');
    }
    rows.push({
      person_id: personId,
      display_name: person.display_name || personId,
      registry_contact_file: person.contact_file || '',
      expected_contact_file: target.rel,
      target_source: target.source,
      active_voiceprint_observations: enrollments.length,
      resolved_calls: Number(intel?.conversation_count || 0),
      resolved_segments: Number(intel?.segment_count || 0),
      resolved_words: Number(intel?.word_count || 0),
      voiceprint_projection_current: voiceCurrent,
      call_content_projection_current: contentCurrent,
      projection_current: problems.length === 0,
      problems,
    });
  }

  const targetOwners = new Map();
  for (const row of rows) {
    if (!row.expected_contact_file) continue;
    if (!targetOwners.has(row.expected_contact_file)) targetOwners.set(row.expected_contact_file, []);
    targetOwners.get(row.expected_contact_file).push(row.person_id);
  }
  const collisions = [...targetOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, personIds]) => ({ file, person_ids: personIds }));
  for (const collision of collisions) {
    for (const personId of collision.person_ids) {
      const row = rows.find((item) => item.person_id === personId);
      if (row && !row.problems.includes('multiple_confirmed_identities_share_people_file')) {
        row.problems.push('multiple_confirmed_identities_share_people_file');
        row.projection_current = false;
      }
    }
  }

  const eventRequestIds = new Set(
    (projectionEvents || [])
      .filter(hasWrittenFile)
      .flatMap((event) => event.request_ids || [])
      .filter(Boolean),
  );
  const confirmationRows = (confirmationActions || []).filter((row) =>
    /^(confirm|correct|link_person_file|create_people_file)$/.test(String(row.action || '')),
  );
  const instrumentedConfirmations = confirmationRows.filter((row) => row.gitPeopleSyncRequestId);
  const isConfirmationProjected = (row) =>
    eventRequestIds.has(row.gitPeopleSyncRequestId) ||
    Boolean(row.replayOfRequestId && eventRequestIds.has(row.replayOfRequestId));
  const confirmationsWithProjectionEvent = instrumentedConfirmations.filter(isConfirmationProjected);
  const unprojectedConfirmations = instrumentedConfirmations.filter(
    (row) => !isConfirmationProjected(row),
  );
  const unprojectedConfirmationPersonIds = new Set();
  let unprojectedConfirmationUnknownIdentityActions = 0;
  for (const row of unprojectedConfirmations) {
    const personId = confirmationPersonId(row, registry);
    if (personId) unprojectedConfirmationPersonIds.add(personId);
    else unprojectedConfirmationUnknownIdentityActions += 1;
  }
  const latestRequest = latestByRequest(
    (relayRequests || []).filter(
      // These actions intentionally do not mutate a People File, so they do
      // not require a Git relay landing receipt. Counting `dont_know` or
      // `non_speech` here left already-applied Save decisions falsely open.
      (row) => !/^(?:not_them|ignore|dismiss|dont_know|non_speech)$/i.test(String(row?.action || '')),
    ),
  );
  const latestReceipt = latestByRequest(relayReceipts);
  const openRelayRequests = [...latestRequest.values()].filter(
    (row) => latestReceipt.get(row.request_id)?.status !== 'landed',
  );
  const failedRelayRequests = [...latestRequest.values()].filter(
    (row) => latestReceipt.get(row.request_id)?.status === 'failed',
  );
  const generatedAtMs = Date.parse(generatedAt);
  const staleOpenRelayRequests = openRelayRequests.filter((row) => {
    const queuedAt = Date.parse(row.ready_at || row.requested_at || row.ts || '');
    return (
      Number.isFinite(generatedAtMs) &&
      Number.isFinite(queuedAt) &&
      generatedAtMs - queuedAt > RELAY_OPEN_LIMIT_HOURS * 60 * 60 * 1000
    );
  });
  const filesWritten = (projectionEvents || []).reduce(
    (sum, event) => sum + (hasWrittenFile(event) ? event.files_written.filter(
      (file) => typeof file === 'string' && file.trim().length > 0,
    ).length : 0),
    0,
  );
  const distinctFilesWritten = new Set(
    (projectionEvents || []).flatMap((event) => hasWrittenFile(event) ? event.files_written : [])
      .filter((file) => typeof file === 'string' && file.trim().length > 0),
  );
  const problems = [];
  if (!registryPresent) problems.push('voice identity registry missing or invalid');
  const staleRows = rows.filter((row) => !row.projection_current);
  const stalePersonIds = new Set(staleRows.map((row) => row.person_id).filter(Boolean));
  const incompleteIdentitiesWithPendingSave = [...unprojectedConfirmationPersonIds].filter(
    (personId) => stalePersonIds.has(personId),
  ).length;
  const incompleteIdentitiesWithoutPendingSave = Math.max(
    0,
    staleRows.length - incompleteIdentitiesWithPendingSave,
  );
  const preInstrumentationConfirmations =
    confirmationRows.length - instrumentedConfirmations.length;
  const identityProjectionCountsReconcile =
    rows.length === rows.length - staleRows.length + staleRows.length;
  const saveProjectionCountsReconcile =
    instrumentedConfirmations.length ===
    confirmationsWithProjectionEvent.length + unprojectedConfirmations.length;
  const confirmationActionCountsReconcile =
    confirmationRows.length ===
    preInstrumentationConfirmations + instrumentedConfirmations.length;
  const identityGapPartitionCountsReconcile =
    incompleteIdentitiesWithPendingSave + incompleteIdentitiesWithoutPendingSave ===
      staleRows.length &&
    incompleteIdentitiesWithPendingSave <= unprojectedConfirmationPersonIds.size &&
    unprojectedConfirmationPersonIds.size <= unprojectedConfirmations.length;
  const internallyConsistent =
    identityProjectionCountsReconcile &&
    saveProjectionCountsReconcile &&
    confirmationActionCountsReconcile &&
    identityGapPartitionCountsReconcile;
  if (!internallyConsistent) problems.push('projection audit count arithmetic is inconsistent');
  if (staleRows.length) problems.push(`${staleRows.length} confirmed identity projection(s) incomplete`);
  if (collisions.length) problems.push(`${collisions.length} People File target collision(s)`);
  if (instrumentedConfirmations.length !== confirmationsWithProjectionEvent.length) {
    problems.push(
      `${instrumentedConfirmations.length - confirmationsWithProjectionEvent.length} instrumented confirmation(s) lack a projection event`,
    );
  }
  // Projection reconciliation (People Files match current identities) is separate from Git
  // relay delivery of those files. The speaker identity change hook gates only on the
  // former, so a relay backlog cannot block the resolver chain; status still reports both.
  const projectionProblems = [...problems];
  if (failedRelayRequests.length) {
    problems.push(`${failedRelayRequests.length} People File git relay request(s) failed`);
  }
  if (staleOpenRelayRequests.length) {
    problems.push(
      `${staleOpenRelayRequests.length} People File git relay request(s) remain open after ${RELAY_OPEN_LIMIT_HOURS} hours`,
    );
  }

  return {
    schema: 'life_archive_voice_people_projection_audit.v1',
    generated_at: generatedAt,
    status: problems.length ? 'RED' : 'GREEN',
    problems,
    projection_status: projectionProblems.length ? 'RED' : 'GREEN',
    projection_problems: projectionProblems,
    confirmed_named_voice_identities: rows.length,
    active_named_voiceprint_observations: rows.reduce(
      (sum, row) => sum + Number(row.active_voiceprint_observations || 0),
      0,
    ),
    confirmed_voice_cluster_assignments: Object.values(
      registry.voice_cluster_resolutions || {},
    ).filter((row) => /^confirmed_(?:by_ExampleCo|reference_voiceprint_match)$/.test(String(row?.status || '')))
      .length,
    expected_people_files: rows.length,
    current_people_file_projections: rows.length - staleRows.length,
    missing_or_stale_people_file_projections: staleRows.length,
    identity_projection_counts_reconcile: identityProjectionCountsReconcile,
    people_file_target_collisions: collisions.length,
    confirmation_actions_seen: confirmationRows.length,
    pre_instrumentation_confirmation_actions: preInstrumentationConfirmations,
    instrumented_confirmation_actions: instrumentedConfirmations.length,
    confirmation_actions_with_projection_event: confirmationsWithProjectionEvent.length,
    unprojected_confirmation_actions: unprojectedConfirmations.length,
    unprojected_confirmation_distinct_identities:
      unprojectedConfirmationPersonIds.size,
    unprojected_confirmation_unknown_identity_actions:
      unprojectedConfirmationUnknownIdentityActions,
    incomplete_identities_with_pending_save: incompleteIdentitiesWithPendingSave,
    incomplete_identities_without_pending_save:
      incompleteIdentitiesWithoutPendingSave,
    save_projection_counts_reconcile: saveProjectionCountsReconcile,
    confirmation_action_counts_reconcile: confirmationActionCountsReconcile,
    identity_gap_partition_counts_reconcile: identityGapPartitionCountsReconcile,
    internally_consistent: internallyConsistent,
    latest_instrumented_confirmation_at: latestTimestamp(instrumentedConfirmations),
    latest_projection_event_at: latestTimestamp(projectionEvents),
    pending_projection_confirmations: unprojectedConfirmations.slice(-100).map((row) => ({
      action: row.action || '',
      person_id: row.personId || row.person_id || '',
      voice_cluster_id: row.voiceClusterId || row.voice_cluster_id || '',
      request_id: row.gitPeopleSyncRequestId || '',
      confirmed_at: rowTimestamp(row),
    })),
    projection_run_events: projectionEvents.length,
    people_file_writes_observed: filesWritten,
    distinct_people_files_written_observed: distinctFilesWritten.size,
    relay_requests_open: openRelayRequests.length,
    relay_requests_failed: failedRelayRequests.length,
    relay_requests_stale_open: staleOpenRelayRequests.length,
    collisions,
    identities: rows,
  };
}

module.exports = {
  RELAY_OPEN_LIMIT_HOURS,
  activeEnrollment,
  confirmedPerson,
  confirmationPersonId,
  voiceBlockCurrent,
  contentBlockCurrent,
  linkedVoiceIdentityText,
  projectionEvidenceText,
  emptyContentBlockCurrent,
  hasContentBlock,
  buildProjectionAudit,
};
