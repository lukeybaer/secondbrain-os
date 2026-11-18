'use strict';

const { trackCheckHolds } = require('./voice-track-name-check');

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

// Owner decision: an envelope holds the names of the day it was made. The owner's own
// answers, a settled machine conflict, or a voice check on this revision outrank it.
// The tier test matches confirmed_by_owner and every "_by_owner" unknown, not
// confirmed_by_owner_cluster, which a machine can stamp.
function callFileHolds(exactIdentity, projectedIdentity, sourceRevision) {
  const tier = String(projectedIdentity?.identity_tier || '');
  if (/_by_owner(_unknown)?$/.test(tier)) return true;
  if (projectedIdentity?.machine_conflict_resolution) return true;
  return trackCheckHolds(projectedIdentity, {
    personId: personId(exactIdentity),
    sourceRevision,
  });
}

function mergeMonotonicIdentity(exactIdentity = {}, projectedIdentity = {}, options = {}) {
  // On a recorded call the call file is the record. A caller passes an empty
  // projection when the file is not on this revision, and that still falls through.
  if (options.callFileAuthoritative && Object.keys(projectedIdentity || {}).length) {
    return projectedIdentity;
  }
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
  if (isConfirmedIdentity(exactIdentity)) {
    if (callFileHolds(exactIdentity, projectedIdentity, String(options.sourceRevision || ''))) {
      return projectedIdentity;
    }
    return exactIdentity;
  }
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
  callFileHolds,
  isConfirmedIdentity,
  isDurableUnknownIdentity,
  mergeMonotonicIdentity,
  personId,
};
