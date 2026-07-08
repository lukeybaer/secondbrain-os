/**
 * Tests for codex-runner.ts, the READ-ONLY codex rung of the 2026-06-11
 * provider ladder (codex OpenAI-sub -> claude sub -> OpenAI API soft floor).
 *
 * The spawn fn is dependency-injected so no real codex binary runs. Categories
 * encoded (not literal triggers): the answer comes from the
 * --output-last-message temp FILE (stdout is narration and must never be the
 * answer), the read-only sandbox args are always present (binding safety
 * ruling: codex never writes code autonomously in this ladder), and every
 * failure mode (nonzero exit, auth/quota sentinel, timeout, spawn error,
 * empty output) returns text:null so the caller descends the ladder instead
 * of shipping garbage.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodex, runOpenAiFloor, isCliFailureOutput } from '../codex-runner';
import type { CodexChildLike, CodexSpawnFn } from '../codex-runner';

// The owner's name is operator PII and must not be hardcoded in source (it would
// leak into the public-sync payload, pii-screen.spec.ts gate). The codex prelude
// builds the persona line from memory/reference_operator_identity.json at
// runtime, so the test resolves the same owner name the same way and asserts the
// prelude reproduces it -- behavior is checked without embedding the literal.
const nodeRequire = createRequire(__filename);
const { loadOperatorIdentity } = nodeRequire('../../../scripts/lib/operator-identity.js');
const OWNER_FULL_NAME: string = loadOperatorIdentity().owner.fullName;

// -- fake child process ---------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { written: string; write: (c: string) => void; end: () => void };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: '',
    write(c: string) {
      this.written += c;
    },
    end() {
      /* no-op */
    },
  };
  child.kill = vi.fn();
  return child;
}

function makeSpawnStub(child: FakeChild): {
  calls: Array<{ cmd: string; args: string[] }>;
  spawnFn: CodexSpawnFn;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn: CodexSpawnFn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return child as ExampleCo as CodexChildLike;
  };
  return { calls, spawnFn };
}

function tmpOutFile(): string {
  return path.join(
    os.tmpdir(),
    `codex-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
}

// -- runCodex -------------------------------------------------------------------

describe('runCodex (read-only codex rung)', () => {
  it('reads the answer from the --output-last-message FILE, never stdout narration', async () => {
    const child = makeFakeChild();
    const { calls, spawnFn } = makeSpawnStub(child);
    const outFile = tmpOutFile();

    const p = runCodex('diagnose the flaky test', { outFile, spawnFn });
    child.stdout.emit('data', 'tool-call narration that must never be the answer');
    fs.writeFileSync(outFile, 'FINAL ANSWER\n');
    child.emit('close', 0);

    const res = await p;
    expect(res.text).toBe('FINAL ANSWER');
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codex');
    // Read-only sandbox is non-negotiable (Codex safety ruling).
    expect(calls[0].args.slice(0, 6)).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--output-last-message',
      outFile,
    ]);
    // Prompt travels via stdin so the shell never parses prompt text.
    expect(child.stdin.written).toContain('CODEX_AMY_PRELOAD_V1');
    expect(child.stdin.written).toContain('memory/MEMORY.md');
    expect(child.stdin.written).toContain('memory/AMY.md');
    expect(child.stdin.written).toContain(
      `You are Amy, ${OWNER_FULL_NAME}'s autonomous executive assistant`,
    );
    expect(child.stdin.written).toContain('=== TASK PROMPT ===\ndiagnose the flaky test');
    // Temp answer file is cleaned up.
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('appends -i <imagePath> when an image is supplied', async () => {
    const child = makeFakeChild();
    const { calls, spawnFn } = makeSpawnStub(child);
    const outFile = tmpOutFile();
    const p = runCodex('describe this', { outFile, spawnFn, imagePath: 'C:/tmp/shot.png' });
    fs.writeFileSync(outFile, 'a screenshot');
    child.emit('close', 0);
    await p;
    expect(calls[0].args.slice(-2)).toEqual(['-i', 'C:/tmp/shot.png']);
  });

  it('returns text:null on a nonzero exit so the caller descends the ladder', async () => {
    const child = makeFakeChild();
    const { spawnFn } = makeSpawnStub(child);
    const p = runCodex('q', { outFile: tmpOutFile(), spawnFn });
    child.emit('close', 1);
    const res = await p;
    expect(res.text).toBeNull();
    expect(res.failureReason).toBe('nonzero-exit');
  });

  it('classifies an auth/quota sentinel answer as a failure, not an answer', async () => {
    const child = makeFakeChild();
    const { spawnFn } = makeSpawnStub(child);
    const outFile = tmpOutFile();
    const p = runCodex('q', { outFile, spawnFn });
    // Any cli-output-guard sentinel (codex login, claude login, quota) counts.
    fs.writeFileSync(outFile, 'Run `codex login` to authenticate.');
    child.emit('close', 0);
    const res = await p;
    expect(res.text).toBeNull();
    expect(res.failureReason).toBe('sentinel-failure');
  });

  it('returns text:null when the run produces no answer at all', async () => {
    const child = makeFakeChild();
    const { spawnFn } = makeSpawnStub(child);
    const p = runCodex('q', { outFile: tmpOutFile(), spawnFn });
    child.emit('close', 0); // exit 0, but no answer file and empty stdout
    const res = await p;
    expect(res.text).toBeNull();
    expect(res.failureReason).toBe('empty-output');
  });

  it('kills a hung codex on timeout and reports the failure', async () => {
    const child = makeFakeChild();
    const { spawnFn } = makeSpawnStub(child);
    const res = await runCodex('q', { outFile: tmpOutFile(), spawnFn, timeoutMs: 25 });
    expect(res.text).toBeNull();
    expect(res.failureReason).toBe('timeout');
    expect(child.kill).toHaveBeenCalled();
  });

  it('survives a spawn error event without throwing', async () => {
    const child = makeFakeChild();
    const { spawnFn } = makeSpawnStub(child);
    const p = runCodex('q', { outFile: tmpOutFile(), spawnFn });
    child.emit('error', new Error('spawn codex ENOENT'));
    const res = await p;
    expect(res.text).toBeNull();
    expect(res.failureReason).toBe('spawn-error');
  });
});

// -- runOpenAiFloor ---------------------------------------------------------------

const FLOOR_KEY = 'sk-test-12345678901234567890';

describe('runOpenAiFloor (charged floor, transport injected)', () => {
  it('returns null without calling the transport when charged use is not approved', async () => {
    const transport = vi.fn();
    expect(await runOpenAiFloor('q', { apiKey: FLOOR_KEY, codexDown: true, transport })).toBeNull();
    expect(
      await runOpenAiFloor('q', { apiKey: FLOOR_KEY, allowChargedLlmApi: true, transport }),
    ).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns null without calling the transport when no usable api key is set', async () => {
    const transport = vi.fn();
    const approved = { allowChargedLlmApi: true, codexDown: true };
    expect(await runOpenAiFloor('q', { apiKey: '', transport, ...approved })).toBeNull();
    expect(await runOpenAiFloor('q', { apiKey: 'short', transport, ...approved })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it('parses the chat completion content on a 2xx response', async () => {
    const transport = vi.fn(async (body: string) => {
      const parsed = JSON.parse(body);
      expect(parsed.messages[parsed.messages.length - 1].content).toBe('q');
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: 'floor answer' } }] }),
      };
    });
    expect(
      await runOpenAiFloor('q', {
        apiKey: FLOOR_KEY,
        transport,
        allowChargedLlmApi: true,
        codexDown: true,
      }),
    ).toBe('floor answer');
  });

  it('returns null on a non-2xx response', async () => {
    const transport = vi.fn(async () => ({ status: 500, body: 'oops' }));
    expect(
      await runOpenAiFloor('q', {
        apiKey: FLOOR_KEY,
        transport,
        allowChargedLlmApi: true,
        codexDown: true,
      }),
    ).toBeNull();
  });

  it('returns null when the content is itself a quota/auth sentinel', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'You exceeded your current quota.' } }],
      }),
    }));
    expect(
      await runOpenAiFloor('q', {
        apiKey: FLOOR_KEY,
        transport,
        allowChargedLlmApi: true,
        codexDown: true,
      }),
    ).toBeNull();
  });
});

// -- sentinel re-export -----------------------------------------------------------

describe('isCliFailureOutput re-export', () => {
  it('exposes the shared cli-output-guard classifier to TS callers', () => {
    expect(isCliFailureOutput('Not logged in. Please run /login')).toBe(true);
    expect(isCliFailureOutput('Here is your answer: 42.')).toBe(false);
  });
});
