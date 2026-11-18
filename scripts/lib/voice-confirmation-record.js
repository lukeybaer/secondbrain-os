'use strict';

// The durable voice-confirmation action record and its sync-request id, shared
// by the briefing endpoint (ec2-server.js POST /briefing/voice-confirm) and the
// owner-directed CLI (scripts/owner-voice-identity.js) so both write the same
// shape into data/life-archive/people/voice-confirmation-actions.jsonl.
const crypto = require('node:crypto');

function buildVoiceConfirmationRecord(fields = {}) {
  return {
    ts: fields.ts || new Date().toISOString(),
    date: fields.date || '',
    section: fields.section || 'VOICE CONFIRMATION / SPEAKER LEARNING',
    voiceClusterId: fields.voiceClusterId,
    action: fields.action,
    guessedName: fields.guessedName || '',
    correctedName: fields.correctedName || '',
    personFilePath: fields.personFilePath || '',
    personFileName: fields.personFileName || '',
    selectedPersonId: fields.selectedPersonId || '',
    linkedExistingPeopleFileForTypedName: fields.linkedExistingPeopleFileForTypedName || '',
    assignmentClusterId: fields.assignmentClusterId || '',
    notes: fields.notes || '',
    clusterFingerprint: fields.clusterFingerprint || '',
    provisionalIdentity: Boolean(fields.provisionalIdentity),
    correctedNameWasTyped: Boolean(fields.correctedNameWasTyped),
    // See the endpoint comments: bank the call count and exact call set the owner
    // saw so a leave-unknown resurfaces on a genuinely new call.
    callCountAtDecision: fields.callCountAtDecision ?? null,
    otidsAtDecision: fields.otidsAtDecision ?? null,
    source: fields.source || 'briefing-dashboard',
    status: 'queued_for_backpropagation',
    ...(fields.extra || {}),
  };
}

function gitPeopleSyncRequestIdFor(record) {
  return `voice-people-sync-${crypto
    .createHash('sha1')
    .update(
      [
        record.ts,
        record.voiceClusterId,
        record.action,
        record.personFilePath,
        record.selectedPersonId,
        record.correctedName,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16)}`;
}

function gitPeopleSyncRequestRow(record, savedTo) {
  return {
    request_id: record.gitPeopleSyncRequestId,
    requested_at: record.ts,
    status: 'queued',
    voice_cluster_id: record.voiceClusterId,
    action: record.action,
    person_file_path: record.personFilePath,
    selected_person_id: record.selectedPersonId,
    corrected_name: record.correctedName,
    source_action_log: savedTo,
  };
}

module.exports = { buildVoiceConfirmationRecord, gitPeopleSyncRequestIdFor, gitPeopleSyncRequestRow };
