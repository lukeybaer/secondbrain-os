'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'voice_disposition_suggestions.v1';
const ALLOWED_DISPOSITIONS = new Set(['noise_or_mixed_artifact']);

function suggestionsPath(dataRoot) {
  const root = path.resolve(dataRoot || process.env.SECONDBRAIN_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
  return path.join(root, 'life-archive', 'voiceprints', 'voice-disposition-suggestions.json');
}

function readVoiceDispositionSuggestions(options = {}) {
  const file = options.file || suggestionsPath(options.dataRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    return new Map(
      rows
        .filter(
          (row) =>
            row &&
            row.status === 'proposed' &&
            ALLOWED_DISPOSITIONS.has(String(row.disposition || '')) &&
            String(row.acoustic_unknown_id || '').trim(),
        )
        .map((row) => [String(row.acoustic_unknown_id), row]),
    );
  } catch {
    return new Map();
  }
}

function suggestionForCurrentMembership(suggestions, acousticId, membershipFingerprint) {
  const row = suggestions instanceof Map ? suggestions.get(String(acousticId || '')) : null;
  if (!row) return null;
  const proposedMembership = String(row.membership_fingerprint || '').trim();
  const currentMembership = String(membershipFingerprint || '').trim();
  if (!proposedMembership || !currentMembership || proposedMembership !== currentMembership) {
    return null;
  }
  return row;
}

function writeVoiceDispositionSuggestion(
  { acousticId, disposition, ownerRequestText, reason, membershipFingerprint = '', now = new Date() },
  options = {},
) {
  const id = String(acousticId || '').trim();
  const exactOwnerRequest = String(ownerRequestText || '').trim();
  const why = String(reason || '').trim();
  const proposedAt = now instanceof Date ? now : new Date(now);
  if (!id.startsWith('unknown_voice_')) throw new Error('an unknown acoustic voice id is required');
  if (!ALLOWED_DISPOSITIONS.has(String(disposition || ''))) {
    throw new Error(`unsupported disposition suggestion: ${disposition || '(empty)'}`);
  }
  if (!exactOwnerRequest) throw new Error('owner request text is required');
  if (!why) throw new Error('a review reason is required');
  if (!String(membershipFingerprint || '').trim()) {
    throw new Error('the exact current membership fingerprint is required');
  }
  if (!Number.isFinite(proposedAt.getTime())) throw new Error('proposal timestamp is invalid');

  const file = options.file || suggestionsPath(options.dataRoot);
  let document = { schema: SCHEMA, updated_at: proposedAt.toISOString(), suggestions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.suggestions)) document = parsed;
  } catch {
    // First proposal creates the durable document.
  }
  const row = {
    acoustic_unknown_id: id,
    disposition: String(disposition),
    status: 'proposed',
    source: 'owner_explicit_correction',
    owner_request_text: exactOwnerRequest,
    reason: why,
    membership_fingerprint: String(membershipFingerprint || ''),
    proposed_at: proposedAt.toISOString(),
    requires_owner_confirmation: true,
    suppresses_queue: false,
  };
  document.schema = SCHEMA;
  document.updated_at = proposedAt.toISOString();
  document.suggestions = document.suggestions.filter(
    (item) => String(item?.acoustic_unknown_id || '') !== id,
  );
  document.suggestions.push(row);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(document, null, 2));
  fs.renameSync(temp, file);
  return { file, row };
}

module.exports = {
  SCHEMA,
  ALLOWED_DISPOSITIONS,
  suggestionsPath,
  readVoiceDispositionSuggestions,
  suggestionForCurrentMembership,
  writeVoiceDispositionSuggestion,
};
