/**
 * The canonical terminal Task statuses, for JS callers.
 *
 * MUST equal the TERMINAL set in `src/main/task-store.ts`. `failed` is
 * deliberately absent from both: the state machine allows `failed -> queued`,
 * so a failed task can be retried and become live again. Treating it as
 * terminal is how the legacy-authority quarantine originally skipped poisoned
 * failed tasks, leaving them to regain claimability on retry (Codex adversarial
 * review 2026-08-02).
 *
 * Parity with the TypeScript source is pinned by
 * `scripts/__tests__/task-terminal-status-parity.test.js`, which reads
 * task-store.ts directly. Change one and that test fails until both agree.
 */
const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled', 'removed_non_actionable']);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || ''));
}

module.exports = { TERMINAL_STATUSES, isTerminalStatus };
