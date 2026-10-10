'use strict';

const CONFIRMED_IDENTITY_STATUSES = new Set([
  'confirmed_by_ExampleCo',
  'confirmed_reference_voiceprint_match',
  'confirmed_reference_voiceprint_acoustic_group',
  'confirmed_by_ExampleCo_cluster',
  'confirmed_by_ExampleCo_acoustic_group',
  'confirmed_by_ExampleCo_cluster_binding',
]);

function canonicalPersonId(personId) {
  return String(personId || '').trim().replace(/^person:/, '');
}

function canonicalSpeakerId(personId) {
  const id = canonicalPersonId(personId);
  return id ? `person:${id}` : '';
}

function resolveRegistryPersonId(registry, personId) {
  let current = canonicalPersonId(personId);
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const next = canonicalPersonId(registry?.person_id_aliases?.[current]);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function isCanonicalSpeakerId(value) {
  return /^person:[^\s:]+$/.test(String(value || ''));
}

function isConfirmedIdentityStatus(value) {
  return CONFIRMED_IDENTITY_STATUSES.has(String(value || '').trim());
}

function isConfirmedIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    isConfirmedIdentityStatus(value.status) ||
    isConfirmedIdentityStatus(value.identity_tier) ||
    isConfirmedIdentityStatus(value.confidence_tier)
  ) {
    return Boolean(canonicalPersonId(value.person_id || value.confirmed_person_id));
  }
  return Boolean(
    canonicalPersonId(value.person_id) &&
      value.identity_confirmation_status === 'confirmed_by_ExampleCo' &&
      value.voiceprint_status === 'enrolled',
  );
}

function confirmedVoiceprintPerson(person) {
  return isConfirmedIdentity(person);
}

function isAttestedLegacyMatchableEnrollment(enrollment) {
  const provenance = enrollment?.reference_provenance;
  return Boolean(
    provenance?.eligibility_basis === 'legacy_trusted' &&
      provenance?.acoustic_capability_at_migration === 'legacy_trusted_matchable' &&
      /^[a-f0-9]{64}$/.test(String(provenance?.enrollment_record_sha256 || '').toLowerCase()) &&
      /^[a-f0-9]{64}$/.test(String(provenance?.receipt_sha256 || '').toLowerCase()),
  );
}

function isConfirmedRegistryPerson(registry, personId) {
  const id = resolveRegistryPersonId(registry, personId);
  if (!id) return false;
  const person =
    registry?.people?.[id] ||
    registry?.people?.[`person:${id}`] ||
    Object.values(registry?.people || {}).find(
      (row) => canonicalPersonId(row?.person_id) === id,
    );
  const enrollments = (registry?.enrollments || []).filter(
    (row) => resolveRegistryPersonId(registry, row?.person_id) === id,
  );
  const confirmed = Boolean(
    (person &&
      [
        person.status,
        person.identity_tier,
        person.confidence_tier,
        person.identity_confirmation_status,
      ].some(isConfirmedIdentityStatus)) ||
      enrollments.some((row) =>
        [
          row.identity_confirmation_status,
          row.identity_tier,
          row.confidence_tier,
        ].some(isConfirmedIdentityStatus),
      ),
  );
  const enrolled = Boolean(
    person?.voiceprint_status === 'enrolled' ||
      enrollments.some((row) =>
        ['active', 'enrolled'].includes(String(row?.status || '').trim()) ||
        row?.voiceprint_status === 'enrolled' ||
        isAttestedLegacyMatchableEnrollment(row),
      ),
  );
  return confirmed && enrolled;
}

function confirmedRegistryIdentity(identity = {}, registry = {}, options = {}) {
  const deniedPersonIds = new Set(
    (options.deniedPersonIds || []).map(canonicalPersonId).filter(Boolean),
  );
  const directPersonId = canonicalPersonId(identity.person_id || identity.confirmed_person_id);
  if (directPersonId && !deniedPersonIds.has(directPersonId)) return { ...identity };
  const clusterIds = [
    identity.source_voice_cluster_id,
    identity.voice_cluster_id,
    identity.unknown_speaker_id,
    identity.source_acoustic_group_id,
    identity.acoustic_unknown_id,
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && !/^person:/i.test(value));
  for (const clusterId of [...new Set(clusterIds)]) {
    const resolution =
      registry?.voice_cluster_resolutions?.[clusterId] ||
      registry?.acoustic_group_resolutions?.[clusterId];
    const status = String(resolution?.status || '').trim();
    const personId = canonicalPersonId(resolution?.person_id);
    if (!personId || deniedPersonIds.has(personId) || !isConfirmedIdentityStatus(status)) continue;
    const denied = (registry?.voice_cluster_denials?.[clusterId] || []).some(
      (row) => canonicalPersonId(row?.denied_person_id) === personId,
    );
    if (denied) continue;
    const canonical = applyCanonicalSpeakerIdentity({ ...identity }, personId, {
      sourceVoiceClusterId: identity.source_voice_cluster_id || identity.voice_cluster_id,
      sourceAcousticGroupId:
        identity.source_acoustic_group_id || identity.acoustic_unknown_id || clusterId,
    });
    canonical.resolved_person = String(
      resolution.display_name || identity.resolved_person || identity.display_name || personId,
    );
    canonical.display_name = canonical.resolved_person;
    canonical.identity_tier = status;
    canonical.identity_confirmation_status = status;
    canonical.registry_resolution_id = clusterId;
    return canonical;
  }
  return { ...identity };
}

function applyCanonicalSpeakerIdentity(target, personId, options = {}) {
  if (!target) return target;
  const id = canonicalPersonId(personId);
  const speakerId = canonicalSpeakerId(id);
  if (!speakerId) return target;

  const observedVoiceId = String(
    options.sourceVoiceClusterId
    || target.source_voice_cluster_id
    || target.voice_cluster_id
    || target.unknown_speaker_id
    || target.speaker_id
    || '',
  ).trim();
  const observedAcousticId = String(
    options.sourceAcousticGroupId
    || target.source_acoustic_group_id
    || target.acoustic_unknown_id
    || '',
  ).trim();

  target.person_id = id;
  target.canonical_speaker_id = speakerId;
  target.speaker_id = speakerId;
  target.voice_cluster_id = speakerId;
  if (observedVoiceId && observedVoiceId !== speakerId && !isCanonicalSpeakerId(observedVoiceId)) {
    target.source_voice_cluster_id = observedVoiceId;
  }
  if (observedAcousticId && observedAcousticId !== speakerId) {
    target.source_acoustic_group_id = observedAcousticId;
  }
  target.unknown_speaker_id = null;
  target.acoustic_unknown_id = null;
  return target;
}

function mergePersonRecords(primary = {}, incoming = {}) {
  const out = { ...incoming, ...primary };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (out[key] === undefined || out[key] === null || out[key] === '') out[key] = value;
  }
  return out;
}

function canonicalizeVoiceIdentityRegistry(registry, options = {}) {
  const normalizePersonId = options.canonicalizePersonId || canonicalPersonId;
  const migrations = [];
  registry.people ||= {};
  registry.enrollments ||= [];
  const recordAlias = (from, to) => {
    if (!from || !to || from === to) return;
    registry.person_id_aliases ||= {};
    registry.person_id_aliases[from] = to;
  };

  for (const personId of Object.keys(registry.people)) {
    const canonical = normalizePersonId(personId);
    if (!canonical || canonical === personId) continue;
    registry.people[canonical] = {
      ...mergePersonRecords(registry.people[canonical] || {}, registry.people[personId] || {}),
      person_id: canonical,
    };
    recordAlias(personId, canonical);
    delete registry.people[personId];
    migrations.push({ from: personId, to: canonical });
  }

  for (const enrollment of registry.enrollments) {
    if (!enrollment.person_id) continue;
    const storedPersonId = canonicalPersonId(enrollment.person_id);
    const normalizedPersonId = normalizePersonId(storedPersonId);
    if (normalizedPersonId && normalizedPersonId !== storedPersonId) {
      recordAlias(storedPersonId, normalizedPersonId);
    }
    // A provenance-stamped enrollment is an immutable evidence record. Its
    // historical label may be wrong, but the correction belongs in the alias
    // layer, not inside the attested row.
    if (enrollment.reference_provenance) continue;
    enrollment.person_id = normalizedPersonId;
    const canonicalId = canonicalSpeakerId(enrollment.person_id);
    if (
      enrollment.voice_cluster_id
      && enrollment.voice_cluster_id !== canonicalId
      && !enrollment.source_voice_cluster_id
    ) enrollment.source_voice_cluster_id = enrollment.voice_cluster_id;
    enrollment.canonical_speaker_id = canonicalId;
    enrollment.voice_cluster_id = canonicalId;
    if (enrollment.acoustic_unknown_id && !enrollment.source_acoustic_group_id) {
      enrollment.source_acoustic_group_id = enrollment.acoustic_unknown_id;
    }
    enrollment.acoustic_unknown_id = null;
  }

  for (const resolution of Object.values(registry.voice_cluster_resolutions || {})) {
    if (resolution.person_id) {
      resolution.person_id = normalizePersonId(resolution.person_id);
      resolution.canonical_speaker_id = canonicalSpeakerId(resolution.person_id);
    }
    if (resolution.guessed_person_id) {
      resolution.guessed_person_id = normalizePersonId(resolution.guessed_person_id);
    }
  }

  for (const rows of Object.values(registry.voice_cluster_denials || {})) {
    for (const denial of rows || []) {
      if (denial.denied_person_id) denial.denied_person_id = normalizePersonId(denial.denied_person_id);
    }
  }

  for (const correction of registry.manual_corrections || []) {
    for (const field of [
      'person_id',
      'corrected_person_id',
      'confirmed_person_id',
      'guessed_person_id',
      'denied_person_id',
    ]) {
      if (correction[field]) correction[field] = normalizePersonId(correction[field]);
    }
    const personId = correction.person_id
      || correction.confirmed_person_id
      || correction.corrected_person_id;
    if (personId) correction.canonical_speaker_id = canonicalSpeakerId(personId);
  }

  for (const resolution of Object.values(registry.acoustic_group_resolutions || {})) {
    if (!resolution.person_id) continue;
    resolution.person_id = normalizePersonId(resolution.person_id);
    resolution.canonical_speaker_id = canonicalSpeakerId(resolution.person_id);
  }

  for (const [personId, person] of Object.entries(registry.people)) {
    person.person_id = normalizePersonId(person.person_id || personId);
    if (person.identity_confirmation_status === 'confirmed_by_ExampleCo' || person.voiceprint_status === 'enrolled') {
      person.canonical_speaker_id = canonicalSpeakerId(person.person_id);
    }
  }

  // A resolution's display_name is a copy taken when it was written. The
  // People record owns the spelling, so an owner correction (PRIVATE_NAME, not
  // the system-generated "PRIVATE_NAME PRIVATE_NAME") reaches every resolution instead of
  // being overwritten again by the stale copies.
  for (const map of [registry.voice_cluster_resolutions, registry.acoustic_group_resolutions]) {
    for (const resolution of Object.values(map || {})) {
      const name = canonicalDisplayName(registry, resolution?.person_id, '');
      if (name) resolution.display_name = name;
    }
  }
  return migrations;
}

function canonicalDisplayName(registry, personId, fallback = '') {
  const id = resolveRegistryPersonId(registry, personId);
  const name = id ? String(registry?.people?.[id]?.display_name || '').trim() : '';
  return name || fallback;
}

module.exports = {
  CONFIRMED_IDENTITY_STATUSES,
  canonicalPersonId,
  canonicalSpeakerId,
  resolveRegistryPersonId,
  isCanonicalSpeakerId,
  isConfirmedIdentity,
  isConfirmedRegistryPerson,
  isConfirmedIdentityStatus,
  confirmedRegistryIdentity,
  isAttestedLegacyMatchableEnrollment,
  confirmedVoiceprintPerson,
  applyCanonicalSpeakerIdentity,
  canonicalizeVoiceIdentityRegistry,
  canonicalDisplayName,
};
