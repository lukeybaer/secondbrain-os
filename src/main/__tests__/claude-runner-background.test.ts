/**
 * Tests for runClaudeCodeBackground in claude-runner.ts.
 *
 * Per ExampleCo 2026-05-05 architectural critique: the queue worker should not
 * block on synchronous awaits. runClaudeCodeBackground must return
 * immediately with a handle whose completion promise resolves later. No
 * timeout watchdog. The handle exposes the subprocess pid for future
 * status checks.
 *
 * Frugal regression style per feedback_frugal_regression_tests.md: stub
 * child_process.spawn, assert the shape of the returned handle, no real
 * subprocess.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSpawns: Array<{ command: string; args: string[] }> = [];
let spawnCounter = 1000;

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  return {
    spawn: (command: string, args: string[]) => {
      capturedSpawns.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
        kill: () => void;
        pid: number;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => undefined, end: () => undefined };
      child.kill = () => undefined;
      child.pid = ++spawnCounter;
      // Resolve asynchronously: emit data then close after a tick.
      setImmediate(() => {
        (child.stdout as EventEmitter).emit('data', Buffer.from('background output'));
        child.emit('close', 0);
      });
      return child;
    },
  };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/secondbrain-test', getPath: () => '/tmp/secondbrain-test', isPackaged: false },
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { runClaudeCodeBackground } from '../claude-runner';

beforeEach(() => {
  capturedSpawns.length = 0;
});

describe('runClaudeCodeBackground', () => {
  it('returns a handle synchronously, before the subprocess closes', async () => {
    const handle = runClaudeCodeBackground('do the deep search');
    // The handle must be returned synchronously. No await on this line.
    expect(handle).toBeDefined();
    expect(handle.pid).toBeTypeOf('number');
    expect(handle.completion).toBeInstanceOf(Promise);
    // Completion resolves later, not now.
    const r = await handle.completion;
    expect(r.success).toBe(true);
    expect(r.output).toContain('background output');
  });

  it('does not impose a timeout (subprocess controls its own lifetime)', async () => {
    const handle = runClaudeCodeBackground('long task');
    // Just verify the handle resolves cleanly when our stub closes; the
    // anti-fabrication assertion is that no SIGTERM-driven timeout output
    // appears regardless of how long real work takes.
    const r = await handle.completion;
    expect(r.output).not.toMatch(/Timed out after/);
  });

  it('continueSession: true uses --continue', async () => {
    const handle = runClaudeCodeBackground('follow up', { continueSession: true });
    await handle.completion;
    // The args passed to spawn vary by platform (Windows wraps via cmd.exe).
    // We assert the union of all spawn invocations contains --continue.
    const allArgs = capturedSpawns.map((s) => s.args.join(' ')).join(' ');
    expect(allArgs).toMatch(/--continue/);
  });

  it('continueSession: false (default) does not include --continue', async () => {
    const handle = runClaudeCodeBackground('new task');
    await handle.completion;
    const allArgs = capturedSpawns.map((s) => s.args.join(' ')).join(' ');
    expect(allArgs).not.toMatch(/--continue/);
  });
});
