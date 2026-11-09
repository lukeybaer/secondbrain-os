'use strict';

// The one declaration of every outcome a card-controller RUN receipt can carry
// (state machine audit finding 24, Owner decision,
// https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC). Four files kept their own
// hand-synced lists of "terminal" outcomes with 6, 7 and 8 values, and three
// outcomes sat in none of them. They disagreed because "terminal" answers four
// different questions. Each question is a flag below, so a list is derived, not
// copied, and a new outcome must be classified before anyone can read it.
//
//   ended             the run is over: finishedAt is stamped, nothing is running.
//   ownedController   the run held the controller lease, so it is a real run that
//                     can shadow or replace an older one. A refused or planned
//                     run never owned the board.
//   boardSettled      the run finished a full pass and wrote its final board, so
//                     recovery may judge the board from it. A run that ended
//                     without settling the board must not settle the night.
//   endsHeartbeat     the outcome is stamped on the terminal controller
//                     heartbeat (endBeat), so the supervisor reads it as stopped.
//   completedPass     the run worked every planned unit to the end. The night
//                     report says "finished with no further action" only for
//                     these; any other ended run "ended early".
//
// Card-level outcomes (receipt.cards[].outcome, such as 'cleared') are a
// different vocabulary and are not declared here.
//
// Every outcome is emitted by scripts/lib/briefing-card-controller.js except
// `abandoned`, which the night owner stamps on a dead receipt
// (scripts/amy-night-run.js). scripts/__tests__/card-controller-outcomes.test.js
// scans both sources so an emitted outcome cannot ship unclassified.

const CONTROLLER = 'scripts/lib/briefing-card-controller.js';
const NIGHT_OWNER = 'scripts/amy-night-run.js';

function def(flags, emittedBy, meaning) {
  return Object.freeze({
    ended: false,
    ownedController: false,
    boardSettled: false,
    endsHeartbeat: false,
    completedPass: false,
    ...flags,
    emittedBy,
    meaning,
  });
}

const SETTLED = { ended: true, ownedController: true, boardSettled: true, endsHeartbeat: true };

const OUTCOMES = Object.freeze({
  running: def({}, CONTROLLER, 'initial receipt; the run is in flight'),
  clean: def({ ...SETTLED, completedPass: true }, CONTROLLER, 'full pass, final board clean'),
  'needs-attention': def(
    { ...SETTLED, completedPass: true },
    CONTROLLER,
    'full pass, final board still has non-clean cards',
  ),
  failed: def(SETTLED, CONTROLLER, 'fatal error during the pass'),
  'time-budget-exhausted': def(SETTLED, CONTROLLER, 'controller deadline reached mid-pass'),
  'frozen-after-rollback': def(SETTLED, CONTROLLER, 'a rollback froze the pass (receipt.frozen)'),
  'frozen-recovery-failed': def(SETTLED, CONTROLLER, 'the frozen-state recovery itself failed'),
  // Takeover requested by the cloud supervisor: admission stops, units not yet
  // started are refunded (settleCooperativeHandoffItems), and the run ends with
  // a final board. The process has stopped, so the heartbeat is terminal; the
  // board is NOT settled, because the next owner still has the work to do.
  'cooperative-handoff': def(
    { ended: true, ownedController: true, endsHeartbeat: true },
    CONTROLLER,
    'stopped admitting for a supervisor takeover; unstarted work was refunded, not done',
  ),
  // options.shadow: plans cards and writes the receipt, never takes the lease,
  // never starts a heartbeat, never touches a card.
  'shadow-planned': def({ ended: true }, CONTROLLER, 'plan-only run; no lease, no heartbeat, no card work'),
  // Lease refused (legacy lease, or the enforce-mode conflict lease twin). The
  // run never owned the lease or the canonical heartbeat.
  'lease-held': def({ ended: true }, CONTROLLER, 'refused: another run holds the controller lease'),
  'conflict-lease-held': def(
    { ended: true },
    CONTROLLER,
    'refused: a conflicting lease is held (enforce-mode twin of lease-held)',
  ),
  'blocked-before-input-window': def({ ended: true }, CONTROLLER, 'refused: input window not open yet'),
  'blocked-after-repair-freeze': def({ ended: true }, CONTROLLER, 'refused: terminal settlement closed scheduled repair'),
  'blocked-unverified-attended-action': def(
    { ended: true },
    CONTROLLER,
    'refused: the attended-action token did not verify, so no attended budget was granted',
  ),
  // The night owner closes a receipt whose process died while it still said
  // running. It started (it owned the controller), but it settled nothing.
  abandoned: def({ ended: true, ownedController: true }, NIGHT_OWNER, 'receipt closed after its process died'),
});

// The terminal controller heartbeat falls back to 'finished' when the receipt
// carries no outcome. It is a heartbeat stage, never a receipt outcome.
const HEARTBEAT_FALLBACK_STAGE = 'finished';

const names = Object.keys(OUTCOMES);
const pick = (flag) => new Set(names.filter((name) => OUTCOMES[name][flag]));

const ENDED_OUTCOMES = pick('ended');
const BOARD_SETTLED_OUTCOMES = pick('boardSettled');
const HEARTBEAT_TERMINAL_STAGES = new Set([...pick('endsHeartbeat'), HEARTBEAT_FALLBACK_STAGE]);
// A finished run that owned the controller. This is the set the supervisor
// treats as "a terminal run"; refused, planned and in-flight receipts are not.
const TERMINAL_RUN_OUTCOMES = new Set(names.filter((name) => OUTCOMES[name].ended && OUTCOMES[name].ownedController));
const COMPLETED_PASS_OUTCOMES = pick('completedPass');
const REFUSED_LAUNCH_OUTCOMES = new Set(['lease-held', 'conflict-lease-held']);

// Exact match, like the sets: an unlisted spelling is never a member, so a
// renamed or corrupted outcome cannot clear a dead run or settle a night.
const isKnownOutcome = (outcome) => Object.prototype.hasOwnProperty.call(OUTCOMES, String(outcome));
const isEndedOutcome = (outcome) => ENDED_OUTCOMES.has(String(outcome));
const isBoardSettledOutcome = (outcome) => BOARD_SETTLED_OUTCOMES.has(String(outcome));
const isTerminalRunOutcome = (outcome) => TERMINAL_RUN_OUTCOMES.has(String(outcome));
const isRefusedLaunchOutcome = (outcome) => REFUSED_LAUNCH_OUTCOMES.has(String(outcome));

function assertKnownOutcome(outcome) {
  if (!isKnownOutcome(outcome)) {
    const error = new Error(`card-controller outcome "${String(outcome)}" is not declared in card-controller-outcomes.js`);
    error.code = 'UNKNOWN_CONTROLLER_OUTCOME';
    throw error;
  }
  return String(outcome);
}

module.exports = {
  BOARD_SETTLED_OUTCOMES,
  COMPLETED_PASS_OUTCOMES,
  ENDED_OUTCOMES,
  HEARTBEAT_FALLBACK_STAGE,
  HEARTBEAT_TERMINAL_STAGES,
  OUTCOMES,
  REFUSED_LAUNCH_OUTCOMES,
  TERMINAL_RUN_OUTCOMES,
  assertKnownOutcome,
  isBoardSettledOutcome,
  isEndedOutcome,
  isKnownOutcome,
  isRefusedLaunchOutcome,
  isTerminalRunOutcome,
};
