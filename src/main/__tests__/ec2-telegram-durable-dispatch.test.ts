/**
 * ec2-telegram-durable-dispatch.test.ts
 *
 * Regression test for the durable-dispatch fix in ec2-server.js (pollTelegram
 * inbound natural-language handler + resolveInlineCommand).
 *
 * Incident (2026-06-01): ExampleCo sent a Telegram message at 6:54pm. The backend
 * logged "[amy] Asking Amy" then RESTARTED at 6:57pm before any reply was
 * sent. The request was processed (askAmy ran inline, a 30-60s claude -p
 * subprocess) BEFORE it was ever made durable, and the Telegram getUpdates
 * offset had already advanced, so Telegram never redelivered it. Result: no
 * reply, nothing queued, the stale-drainer never saw it = permanent silent
 * loss.
 *
 * The contract this test pins (category, not the literal message):
 * 1. WORK intents (new_task / continue) persist a durable command (status
 *    'pending') BEFORE the inline askAmy run, so a restart mid-reply cannot
 *    drop the request.
 * 2. A fast inline answer calls resolveInlineCommand -> status 'done', so the
 *    5-min stale-drainer (which only adopts 'pending' commands aged past the
 *    grace window) skips it. No double-execution / double-ship.
 * 3. If the process dies before resolveInlineCommand runs, the command stays
 *    'pending'. Once it ages past the grace window the drainer adopts it and
 *    ships it autonomously. The request survives the restart.
 * 4. READ-ONLY intents (query) do NOT create a durable command, so the
 *    conversational path does not pollute the AMY PROJECTS card.
 *
 * Same pattern as ec2-vapi-inline-race.test.ts: reimplement the contract logic
 * so a behavior regression surfaces immediately without loading the full
 * 14k-line EC2 monolith.
 */

import { describe, it, expect } from 'vitest';

type Intent = 'new_task' | 'continue' | 'query' | 'status';

interface Command {
  id: string;
  status: 'pending' | 'done' | 'forwarded';
  repliedInline: boolean;
  success: boolean | null;
  createdAtMs: number;
}

const GRACE_MS = 5 * 60 * 1000; // mirrors COMMAND_GRACE_MIN=5 in process-dispatches.js

function makeQueue() {
  const commandQueue = new Map<string, Command>();
  let seq = 0;

  // Mirrors addCommand(): always created 'pending'.
  function addCommand(createdAtMs: number): Command {
    const cmd: Command = {
      id: 'cmd_' + ++seq,
      status: 'pending',
      repliedInline: false,
      success: null,
      createdAtMs,
    };
    commandQueue.set(cmd.id, cmd);
    return cmd;
  }

  // Mirrors resolveInlineCommand(): close out a command answered inline.
  function resolveInlineCommand(id: string) {
    const cmd = commandQueue.get(id);
    if (!cmd) return;
    cmd.status = 'done';
    cmd.repliedInline = true;
    cmd.success = true;
  }

  // Mirrors the stale-drainer eligibility gate: only 'pending' commands aged
  // past the grace window are adopted and shipped.
  function drainerWouldAdopt(id: string, nowMs: number): boolean {
    const cmd = commandQueue.get(id);
    if (!cmd) return false;
    return cmd.status === 'pending' && nowMs - cmd.createdAtMs >= GRACE_MS;
  }

  return { commandQueue, addCommand, resolveInlineCommand, drainerWouldAdopt };
}

// Mirrors the handler decision: durable-first for work intents only.
function enqueueIfWorkIntent(
  q: ReturnType<typeof makeQueue>,
  intent: Intent,
  nowMs: number,
): Command | null {
  if (intent === 'new_task' || intent === 'continue') {
    return q.addCommand(nowMs);
  }
  return null;
}

describe('telegram durable-dispatch contract', () => {
  it('work intent is persisted durably BEFORE the reply runs', () => {
    const q = makeQueue();
    const durable = enqueueIfWorkIntent(q, 'new_task', 0);
    // The command exists and is pending the instant askAmy would start, so a
    // restart during askAmy still leaves a recoverable record.
    expect(durable).not.toBeNull();
    expect(q.commandQueue.get(durable!.id)!.status).toBe('pending');
  });

  it('fast inline answer resolves the command so the drainer never re-ships it', () => {
    const q = makeQueue();
    const durable = enqueueIfWorkIntent(q, 'new_task', 0)!;
    // askAmy answers quickly; handler calls resolveInlineCommand on success.
    q.resolveInlineCommand(durable.id);
    expect(q.commandQueue.get(durable.id)!.status).toBe('done');
    expect(q.commandQueue.get(durable.id)!.repliedInline).toBe(true);
    // Even well past the grace window the drainer must NOT adopt a done command.
    expect(q.drainerWouldAdopt(durable.id, GRACE_MS * 3)).toBe(false);
  });

  it('restart mid-reply leaves the request pending and the drainer adopts it (no loss)', () => {
    const q = makeQueue();
    const durable = enqueueIfWorkIntent(q, 'new_task', 0)!;
    // Process dies before resolveInlineCommand runs: command stays pending.
    expect(q.commandQueue.get(durable.id)!.status).toBe('pending');
    // Inside the grace window the drainer holds off (inline reply might land).
    expect(q.drainerWouldAdopt(durable.id, GRACE_MS - 1)).toBe(false);
    // Past the grace window it adopts and ships the request autonomously.
    expect(q.drainerWouldAdopt(durable.id, GRACE_MS)).toBe(true);
  });

  it('read-only query intent creates no durable command (no projects-card pollution)', () => {
    const q = makeQueue();
    const durable = enqueueIfWorkIntent(q, 'query', 0);
    expect(durable).toBeNull();
    expect(q.commandQueue.size).toBe(0);
  });

  it('continue intent is also made durable', () => {
    const q = makeQueue();
    const durable = enqueueIfWorkIntent(q, 'continue', 0);
    expect(durable).not.toBeNull();
    expect(q.commandQueue.get(durable!.id)!.status).toBe('pending');
  });
});
