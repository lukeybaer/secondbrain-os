'use strict';

// scripts/self-heal/heal-decision.js
//
// The brain of the QC-at-output heal loop: given a card's observed state, decide what
// to do this iteration by composing the three landed primitives:
//   - verdict.js        : the QC predicate + the canonical healLadder for the card
//   - attempt-ledger.js : durable memory of options already tried (and why they failed)
//   - briefing-clean-contract.buildBlockedCardOutput : the honest L1-L4 hard-block
//
// Returns exactly one of:
//   { action: 'pass' }                                  card meets its contract
//   { action: 'heal', cardId, option, remaining }       try this next UNTRIED option
//   { action: 'blocked', cardId, honestBlock, attempts } TRUE exhaustion: give up
//                                                        honestly, the block names every
//                                                        option tried and why it failed
//
// "blocked" only happens when the ledger says no untried unique viable option remains.
// That is ExampleCo's rule: only give up after exhausting the menu, and remember across
// iterations/nights so you never repeat an option or quit prematurely.

const { verdict } = require('./verdict.js');
const ledger = require('./attempt-ledger.js');
const { safeBuildBlockedCardOutput, cardOutputQc } = require('../lib/briefing-clean-contract.js');

function decideHeal(cardId, observed = {}, healRecord = null, opts = {}) {
  const v = verdict(cardId, observed, opts);
  if (v.status === 'pass') return { action: 'pass', cardId, reason: v.reason };

  const ladder = v.healLadder && v.healLadder.length ? v.healLadder : opts.ladder || [];
  const remaining = ledger.remainingUniqueOptions(cardId, ladder, opts);

  if (remaining.length > 0) {
    return {
      action: 'heal',
      cardId,
      option: remaining[0],
      remaining: remaining.length,
      reason: v.reason,
      failureMode: v.failureMode || null,
    };
  }

  // Exhausted: emit the honest hard-block, grounded in the durable attempt history.
  // The base block is guaranteed QC-clean (safeBuildBlockedCardOutput falls back to a
  // minimal honest block when the heal record is malformed). We then enrich whatITried
  // with the ledger's attempt summary, but a ledger option string can itself carry
  // self-talk (whatITried is exempt from the self-directed ban but NOT from the
  // self-narration ban), so we re-QC the enriched block and, on failure, keep the
  // guaranteed-clean base whatITried. The returned honestBlock can never fail QC.
  const summary = ledger.summarizeForHonestBlock(cardId, opts);
  const base = safeBuildBlockedCardOutput(
    healRecord || { target: cardId, detail: v.reason, healed: false },
  );
  const triedLines = summary.attempts.map(
    (a) => `${a.option}${a.failureReason ? ` (failed: ${a.failureReason})` : ` (${a.outcome})`}`,
  );
  const whatITried = triedLines.length
    ? `Tried ${summary.count} option(s), all exhausted: ${triedLines.join('; ')}.`
    : base.whatITried;
  let honestBlock = { ...base, whatITried, attempts: summary.attempts };
  let qc = cardOutputQc(honestBlock);
  if (!qc.ok) {
    // The enriched whatITried (or some other sourced field) leaked banned self-talk:
    // fall back to the guaranteed-clean base text, preserving the attempt history.
    honestBlock = { ...base, attempts: summary.attempts };
    qc = cardOutputQc(honestBlock);
  }
  honestBlock.qc = qc;
  return { action: 'blocked', cardId, honestBlock, attempts: summary.attempts };
}

// Record the outcome of one heal attempt into the durable ledger. The loop calls this
// AFTER it has tried an option and observed the result through the full cycle
// (land -> deploy -> verify in prod). outcome is one of attempt-ledger's outcomes;
// a 'deployed-verified' outcome also resets the card's attempt memory (it is healed).
function recordHealOutcome(cardId, outcome, opts = {}) {
  const o = outcome || {};
  const row = ledger.recordAttempt(cardId, o, opts);
  if (o.outcome === 'deployed-verified') {
    ledger.recordResolved(cardId, { commit: o.commit, deployRef: o.deployRef, ts: o.ts }, opts);
  }
  return row;
}

module.exports = { decideHeal, recordHealOutcome };
