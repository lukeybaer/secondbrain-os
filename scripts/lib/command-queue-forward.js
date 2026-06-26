// command-queue-forward.js
//
// Pure logic for the always-on stale-command drainer.
//
// Why this exists: Vapi/Telegram "claude" commands land in ec2-server.js's
// in-memory commandQueue and are ONLY consumed by the Electron desktop-app
// worker (src/main/command-queue.ts) polling /commands/pending. When the
// desktop app is closed (e.g. a 1:41am phone call), the command sits pending
// forever and the work never triggers. 2026-06-01: ExampleCo's Cyber Cab briefing
// request was orphaned exactly this way.
//
// Fix: the always-on EC2 dispatch-processor (scripts/process-dispatches.js)
// drains stale unclaimed commands and forwards them into dispatch-queue.jsonl
// plus a Telegram alert, so nothing is ever silently dropped. The handoff is
// race-safe via an atomic pending->forwarded transition (forwardTransition):
// once forwarded, the PC worker's claim (pending->in_progress) returns 409 and
// it must not execute. Codex flagged the double-execution risk (the PC worker
// ignored failed claims) during the 2026-06-01 review.

const FORWARDABLE_TYPES = new Set(['claude']);

/**
 * A command is stale-forwardable when it is a code/claude task that has been
 * sitting pending longer than the grace window and was never answered inline
 * on a live call. The grace window lets the fast PC worker claim first when it
 * is awake; only genuinely orphaned commands get forwarded.
 *
 * @param {object} cmd      command record from the EC2 queue
 * @param {number} nowMs    current time in ms (injected for testability)
 * @param {number} graceMs  how long a command may sit pending before forwarding
 */
function isStaleForwardable(cmd, nowMs, graceMs) {
  if (!cmd || typeof cmd !== 'object') return false;
  if (!FORWARDABLE_TYPES.has(cmd.type)) return false;
  if (cmd.status !== 'pending') return false;
  if (cmd.repliedInline) return false; // already answered on the live call
  const created = Date.parse(cmd.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created >= graceMs;
}

/**
 * Atomic ownership transition. Only a still-pending command can be forwarded;
 * anything already claimed, completed, failed, or previously forwarded returns
 * a 409 so a concurrent consumer cannot double-process it. Mutates cmd in place
 * to mirror the existing claim handler in ec2-server.js.
 *
 * @returns {{ ok: boolean, code: number, status?: string }}
 */
function forwardTransition(cmd, nowIso) {
  if (!cmd || cmd.status !== 'pending') {
    return { ok: false, code: 409, status: cmd && cmd.status };
  }
  cmd.status = 'forwarded';
  cmd.updatedAt = nowIso;
  cmd.forwardedAt = nowIso;
  return { ok: true, code: 200, status: 'forwarded' };
}

/**
 * Map a forwarded command onto a dispatch-queue.jsonl row so the always-on
 * process-dispatches pipeline picks it up on its next tick (classify, then
 * backlog plus Telegram). itemRef ExampleCos the command id so the receipt is
 * traceable and idempotent across ticks.
 */
function commandToDispatchEntry(cmd, nowIso) {
  const source = cmd.replyTo === 'telegram' ? 'telegram_command' : 'vapi_command';
  return {
    ts: nowIso,
    source,
    date: nowIso.slice(0, 10),
    section: 'orphaned voice/telegram command',
    itemRef: cmd.id,
    comment: typeof cmd.prompt === 'string' ? cmd.prompt : '',
    command_id: cmd.id,
    origin_ts: cmd.createdAt,
    status: 'queued',
  };
}

module.exports = { isStaleForwardable, forwardTransition, commandToDispatchEntry, FORWARDABLE_TYPES };
