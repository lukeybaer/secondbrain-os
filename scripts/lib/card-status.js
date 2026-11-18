'use strict';

// The one declared set of card statuses (state machine audit #9, the owner,
// 2026-11-03, https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC). A card status
// had five spellings and two normalizers that disagreed on a missing value.
// Every reader and writer imports normalizeCardStatus() from here, and the Gate
// B receipt regex is built from CARD_STATUSES, so a status a committed card can
// carry (stale included) can never fall out of the receipt check.
//
// Row statuses (green, red, informational) belong to work units, not cards;
// they have their own normalizer in briefing-card-controller.js.

const { defineStateMachine } = require('./ledger-state-machine');

// clean, defect, blocked, stale: a committed card. human-gated, unknown: a QC
// verdict that waits on a person or could not be read.
const CARD_STATUSES = Object.freeze(['clean', 'defect', 'blocked', 'stale', 'human-gated', 'unknown']);

// Old spellings. Anything else unrecognized is not aliased, it fails closed.
const CARD_STATUS_ALIASES = Object.freeze({ human_gated: 'human-gated', unverified: 'unknown' });

// An unrecognized or missing status must never read as clean. 'blocked' is the
// non-clean value the card artifacts already used for it.
const FAIL_CLOSED_CARD_STATUS = 'blocked';

// A card is rebuilt into whatever its latest QC says, so every move between
// declared statuses is legal. The machine is used for the declared set and the
// aliases, not to refuse a move.
const cardStatusMachine = defineStateMachine({
  name: 'card-status',
  transitions: Object.fromEntries(['', ...CARD_STATUSES].map((from) => [from, CARD_STATUSES.filter((to) => to !== from)])),
  aliases: CARD_STATUS_ALIASES,
});

function cleanSpelling(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** True when the value is a declared card status or a known old spelling. */
function isCardStatus(value) {
  const spelling = cleanSpelling(value);
  return spelling !== '' && cardStatusMachine.isKnown(spelling);
}

/** Declared status for a value; missing or unrecognized becomes the fail-closed status. */
function normalizeCardStatus(value) {
  const spelling = cleanSpelling(value);
  return isCardStatus(spelling) ? cardStatusMachine.normalize(spelling) : FAIL_CLOSED_CARD_STATUS;
}

/** Regex alternation of every declared status, for receipt and log-line matchers. */
function cardStatusAlternation() {
  return CARD_STATUSES.join('|');
}

module.exports = {
  CARD_STATUSES,
  CARD_STATUS_ALIASES,
  FAIL_CLOSED_CARD_STATUS,
  isCardStatus,
  normalizeCardStatus,
  cardStatusAlternation,
};
