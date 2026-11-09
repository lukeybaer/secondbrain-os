'use strict';

// The one declaration of the overnight watcher heartbeat vocabulary (state
// machine audit finding 14, Owner decision,
// https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC). The launcher writes these
// states, the supervisor and the liveness metric grade them, and the catch-up
// run reads them. They used to be copied between files, with two staleness
// values (30 and 45 minutes). Every reader and writer imports this module.
//
// Exception: scripts/briefing-cloud-control.js is installed as one static file
// and cannot import. Its inline copy is pinned to IN_PROGRESS_WATCHER_STATES
// here by scripts/__tests__/briefing-cloud-control.test.js.

const { defineStateMachine } = require('./ledger-state-machine');

// A live heartbeat beats every 60s. 30 minutes is the single "silent too long"
// line for both the supervisor (escalate) and the liveness metric (red).
const WATCHER_HEARTBEAT_STALE_MS = 30 * 60 * 1000;

// Wait states the model-free terminal coordinator writes between polls
// (2026-09-06: these were missing from the contract, so the supervisor graded
// a live coordinator as WATCHER-DOWN all night and escalated twice).
const COORDINATOR_WAIT_STATES = [
  'waiting-materialized-state',
  'waiting-settlement-lock',
  'waiting-terminal-assessment-reserve',
  'report-research',
  'terminal-delivery',
];
// Active states the coordinator writes while it performs bounded work itself
// (retrying a blocked alert, owner maintenance, repairing a wrong-date board,
// freezing the evidence floor). The coordinator is alive and beating in each.
const COORDINATOR_ACTIVE_STATES = [
  'blocked-alert-retry',
  'owner-maintenance',
  'board-date-repair',
  'evidence-freeze-floor',
];
const IN_PROGRESS_LIST = [
  'running',
  'starting',
  'relaunching',
  'waiting-assessment-cap',
  'waiting-evidence-gate-retry',
  'waiting-night-spend-circuit',
  'waiting-unchanged',
  ...COORDINATOR_WAIT_STATES,
  ...COORDINATOR_ACTIVE_STATES,
];
// The watcher stopped for the night and the night is healthy. A last beat here
// is settled history, not staleness.
const HEALTHY_TERMINAL_LIST = ['finished', 'finished-early', 'repair-cutoff'];
// The watcher stopped without finishing. The supervisor grades these by name:
// `exhausted` against the finalized report, `failed` as a real outage.
const UNHEALTHY_TERMINAL_LIST = ['exhausted', 'failed'];

const IN_PROGRESS_WATCHER_STATES = new Set(IN_PROGRESS_LIST);
const TERMINAL_WATCHER_STATES = new Set(HEALTHY_TERMINAL_LIST);
const SETTLED_WATCHER_STATES = new Set([...HEALTHY_TERMINAL_LIST, ...UNHEALTHY_TERMINAL_LIST]);
const LIVE_WATCHER_STATES = new Set([...IN_PROGRESS_LIST, ...HEALTHY_TERMINAL_LIST]);

// Any in-progress state may move to any other, or stop for the night. Nothing
// leaves a settled state.
const transitions = { '': [...IN_PROGRESS_LIST] };
for (const state of IN_PROGRESS_LIST) {
  transitions[state] = [...IN_PROGRESS_LIST, ...SETTLED_WATCHER_STATES];
}
const inFlight = {};
for (const state of IN_PROGRESS_LIST) inFlight[state] = { ttlMs: WATCHER_HEARTBEAT_STALE_MS };

const watcherHeartbeatMachine = defineStateMachine({
  name: 'watcher-heartbeat',
  transitions,
  terminal: [...SETTLED_WATCHER_STATES],
  // `delivered` sat in the launcher's wedged-owner list but was never written.
  aliases: { delivered: 'finished-early' },
  inFlight,
});

function isSettledWatcherState(state) {
  return watcherHeartbeatMachine.isTerminal(state);
}

/**
 * Validate a heartbeat state write. Returns the canonical state, or throws
 * IllegalTransitionError for an undeclared state or a move out of a settled one.
 */
function assertWatcherHeartbeatMove(from, to) {
  return watcherHeartbeatMachine.assertTransition(from, to);
}

module.exports = {
  COORDINATOR_ACTIVE_STATES,
  COORDINATOR_WAIT_STATES,
  IN_PROGRESS_WATCHER_STATES,
  LIVE_WATCHER_STATES,
  SETTLED_WATCHER_STATES,
  TERMINAL_WATCHER_STATES,
  WATCHER_HEARTBEAT_STALE_MS,
  assertWatcherHeartbeatMove,
  isSettledWatcherState,
  watcherHeartbeatMachine,
};
