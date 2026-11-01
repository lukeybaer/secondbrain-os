'use strict';

const { canonicalPersonId } = require('./canonical-speaker-identity');

function voiceNamePairKey(left, right) {
  const ids = [left, right].map(canonicalPersonId).filter(Boolean).sort();
  return ids.length === 2 && ids[0] !== ids[1] ? ids.join('|') : '';
}

/** Last append-only pair effect wins. Undo never erases a safety hold. */
function heldVoiceNamePairs(ledger = []) {
  const state = new Map();
  for (const row of ledger) {
    const key = String(row?.pair_key || '');
    if (!key) continue;
    if (row.pair_effect === 'hold') state.set(key, row);
    if (row.pair_effect === 'clear') state.delete(key);
  }
  return state;
}

module.exports = { heldVoiceNamePairs, voiceNamePairKey };
