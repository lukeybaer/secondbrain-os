'use strict';

function personId(identity = {}) {
  return (
    String(identity?.person_id || identity?.confirmed_person_id || '').trim() ||
    String(identity?.voice_cluster_id || '').match(/^person:(.+)$/)?.[1] ||
    ''
  );
}

function isConfirmedIdentity(identity = {}) {
  return Boolean(personId(identity));
}

function isDurableUnknownIdentity(identity = {}) {
  if (isConfirmedIdentity(identity)) return false;
  return /^unknown_voice_[a-z0-9_-]+$/i.test(
    String(
      identity?.acoustic_unknown_id ||
        identity?.unknown_speaker_id ||
        identity?.voice_cluster_id ||
        '',
    ),
  );
}

function mergeMonotonicIdentity(exactIdentity = {}, projectedIdentity = {}, options = {}) {
  const correction = options.ownerCorrection || null;
  if (correction?.action === 'correct') {
    const correctedPersonId = String(correction.selectedPersonId || '').trim();
    if (correctedPersonId && personId(projectedIdentity) === correctedPersonId) {
      return projectedIdentity;
    }
  }
  if (correction?.action === 'not_them') {
    const deniedPersonId = String(correction.deniedPersonId || '').trim();
    const projectedPersonId = personId(projectedIdentity);
    if (
      isDurableUnknownIdentity(projectedIdentity) ||
      (projectedPersonId &&
        projectedPersonId !== deniedPersonId &&
        options.projectedPersonConfirmed !== false)
    ) {
      return projectedIdentity;
    }
  }
  if (isConfirmedIdentity(exactIdentity)) return exactIdentity;
  if (isConfirmedIdentity(projectedIdentity)) {
    if (options.projectedPersonConfirmed === false && isDurableUnknownIdentity(exactIdentity)) {
      return exactIdentity;
    }
    return projectedIdentity;
  }
  if (isDurableUnknownIdentity(exactIdentity)) return exactIdentity;
  if (isDurableUnknownIdentity(projectedIdentity)) return projectedIdentity;
  return Object.keys(exactIdentity || {}).length ? exactIdentity : projectedIdentity;
}

module.exports = {
  isConfirmedIdentity,
  isDurableUnknownIdentity,
  mergeMonotonicIdentity,
  personId,
};
