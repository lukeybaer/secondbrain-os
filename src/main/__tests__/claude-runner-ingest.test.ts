/**
 * Tests for runClaudeCodeIngest in claude-runner.ts.
 *
 * Verifies that the ingest variant sets SECONDBRAIN_SESSION_MODE=ingest in
 * the child process environment and merges extraEnv correctly. The actual
 * spawn is stubbed — we only care that the env passed to child_process.spawn
 * ExampleCos the ingest marker, because that is what the session-start-inject.sh
 * hook reads to decide which Tier 1 payload to emit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stubs ─────────────────────────────────────────────────────────────────────

type SpawnArgs = {
  command: string;
  args: string[];
  options: { env?: Record<string, string | undefined> };
};

const capturedSpawns: SpawnArgs[] = [];

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  return {
    spawn: (command: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
      capturedSpawns.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => undefined, end: () => undefined };
      child.kill = () => undefined;
      // Emit a successful close asynchronously so the Promise resolves.
      setImmediate(() => {
        (child.stdout as EventEmitter).emit('data', Buffer.from('OK'));
        child.emit('close', 0);
      });
      return child;
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/secondbrain-test',
    getPath: () => '/tmp/secondbrain-test',
    isPackaged: false,
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {},
}));

import { runClaudeCode, runClaudeCodeIngest } from '../claude-runner';

beforeEach(() => {
  capturedSpawns.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runClaudeCodeIngest', () => {
  it('sets SECONDBRAIN_SESSION_MODE=ingest in the spawned child env', async () => {
    await runClaudeCodeIngest('do the thing', { cwd: '/tmp' });
    expect(capturedSpawns).toHaveLength(1);
    const env = capturedSpawns[0].options.env;
    expect(env).toBeDefined();
    expect(env!['SECONDBRAIN_SESSION_MODE']).toBe('ingest');
  });

  it('still strips CLAUDECODE to avoid nested-session errors', async () => {
    process.env['CLAUDECODE'] = '1';
    try {
      await runClaudeCodeIngest('do the thing');
      const env = capturedSpawns[0].options.env;
      expect(env!['CLAUDECODE']).toBeUndefined();
    } finally {
      delete process.env['CLAUDECODE'];
    }
  });

  it('merges caller-supplied extraEnv on top of the ingest marker', async () => {
    await runClaudeCodeIngest('do the thing', {
      extraEnv: { FOO: 'bar', BAZ: 'qux' },
    });
    const env = capturedSpawns[0].options.env;
    expect(env!['SECONDBRAIN_SESSION_MODE']).toBe('ingest');
    expect(env!['FOO']).toBe('bar');
    expect(env!['BAZ']).toBe('qux');
  });

  it('extraEnv cannot override the ingest marker — the mode is sticky', async () => {
    await runClaudeCodeIngest('do the thing', {
      extraEnv: { SECONDBRAIN_SESSION_MODE: 'full' },
    });
    const env = capturedSpawns[0].options.env;
    expect(env!['SECONDBRAIN_SESSION_MODE']).toBe('ingest');
  });
});

describe('runClaudeCode (control)', () => {
  it('does NOT set SECONDBRAIN_SESSION_MODE — full Tier 1 load is the default', async () => {
    await runClaudeCode('do the thing');
    const env = capturedSpawns[0].options.env;
    expect(env!['SECONDBRAIN_SESSION_MODE']).toBeUndefined();
  });
});
