'use strict';

// PEOPLE IDENTITY HOLD PRECHECK (#b Oct 14 2026).
//
// On Oct 11 and Oct 13-14 the overnight controller spent 1.91M and 4.19M
// tokens of model repair on system_health:voice-people-projection while the
// People sync was failing with exact_identity_not_confirmed. Only the owner can
// confirm an identity, so no code change can clear that block in one night.
//
// Narrower than the withdrawn Oct 12 pull precheck: it fires only when the
// healer's sole target is the projection row and the newest sync receipt
// (within 36h) failed naming exact_identity_not_confirmed. Any other failure,
// a mixed-target healer, or a stale receipt keeps the normal repair path.

const fs = require('fs');
const path = require('path');

const WORK_UNIT_ID = 'system_health:voice-people-projection';
const MARKER = 'exact_identity_not_confirmed';
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const OUTCOME = 'people-sync-held-on-unconfirmed-identity';

function receiptsPath(dataDir) {
  return path.join(dataDir, 'life-archive', 'people', 'voice-git-people-sync-receipts.jsonl');
}

function latestReceipt(dataDir, fsApi = fs) {
  let raw = '';
  try {
    raw = fsApi.readFileSync(receiptsPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (row && typeof row === 'object') return row;
    } catch {
      // skip a torn line
    }
  }
  return null;
}

// Returns null when a model session may proceed, else the decision to record.
function peopleIdentityHoldPrecheck({ dataDir, workUnitIds = [], nowMs = Date.now(), fsApi = fs } = {}) {
  try {
    const ids = (Array.isArray(workUnitIds) ? workUnitIds : []).map((id) =>
      String(id || '').toLowerCase(),
    );
    if (!dataDir || ids.length !== 1 || ids[0] !== WORK_UNIT_ID) return null;
    const latest = latestReceipt(dataDir, fsApi);
    if (!latest || latest.status !== 'failed') return null;
    if (!String(latest.error || '').includes(MARKER)) return null;
    const at = Date.parse(latest.updated_at || '');
    if (!Number.isFinite(at) || nowMs - at > MAX_AGE_MS) return null;
    return {
      outcome: OUTCOME,
      repairClass: 'owner_action',
      receiptUpdatedAt: latest.updated_at,
      note:
        'People sync is holding a voice that the owner has not confirmed yet, so no model session starts. ' +
        'Confirming or rejecting that voice on the review queue releases it; code cannot.',
    };
  } catch {
    return null;
  }
}

module.exports = { WORK_UNIT_ID, MARKER, OUTCOME, latestReceipt, peopleIdentityHoldPrecheck };
