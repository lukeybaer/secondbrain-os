/**
 * Tests for task-intake.ts, the cross-process bridge.
 *
 * Covers: dispatch-queue lines become Tasks with the right origin and source,
 * smart extraction cleans the prompt, confident extractions are auto-approved
 * while unclear ones are held unapproved, idempotency across restarts,
 * duplicate-line collapse, and malformed-line skipping. A fake extractor is
 * injected so no LLM call is made.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTasksDir, listTasks } from '../task-store';
import { drainIntake, type ExtractFn } from '../task-intake';

let testRoot: string;
let queuePath: string;
let consumedPath: string;

// Fake extractor: cleans the prompt and is "confident" only when the raw text
// contains the word CLEAR. Mirrors the real confident-vs-unclear behavior.
const fakeExtract: ExtractFn = async (raw) => ({
  prompt: `cleaned: ${raw}`,
  confident: raw.includes('CLEAR'),
  reason: raw.includes('CLEAR') ? 'clear request' : 'garbled',
});

function writeQueue(entries: object[]): void {
  fs.writeFileSync(queuePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-intake-'));
  setTasksDir(path.join(testRoot, 'tasks'));
  queuePath = path.join(testRoot, 'dispatch-queue.jsonl');
  consumedPath = path.join(testRoot, 'intake-consumed.json');
});

afterAll(() => {
  try {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('drainIntake', () => {
  it('creates a Task per dispatch with mapped origin, source, and cleaned prompt', async () => {
    writeQueue([
      { ts: 't1', source: 'otter', itemRef: 'ref-a', comment: 'approve the second one', match_hash: 'h1' },
      { ts: 't2', source: 'gmail', itemRef: 'msg-b', comment: 'reply to the invoice', match_hash: 'h2' },
    ]);
    const result = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(result.created).toBe(2);

    const tasks = listTasks();
    expect(tasks).toHaveLength(2);
    const otter = tasks.find((t) => t.origin === 'otter');
    expect(otter?.prompt).toBe('cleaned: approve the second one');
    expect(otter?.source).toEqual({ type: 'otter', ref: 'ref-a' });
  });

  it('auto-approves a confident extraction and holds an unclear one', async () => {
    writeQueue([
      { ts: 't1', source: 'otter', itemRef: 'r1', comment: 'CLEAR: email Bryant the deck', match_hash: 'c1' },
      { ts: 't2', source: 'otter', itemRef: 'r2', comment: 'uh the thing I I you know', match_hash: 'c2' },
    ]);
    const result = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(result.created).toBe(2);
    expect(result.approved).toBe(1);

    const tasks = listTasks();
    const confident = tasks.find((t) => t.prompt.includes('CLEAR'));
    const unclear = tasks.find((t) => !t.prompt.includes('CLEAR'));
    expect(confident?.approved).toBe(true);
    expect(unclear?.approved).toBeUndefined();
  });

  it('is idempotent: re-draining the same inbox creates nothing new', async () => {
    writeQueue([{ ts: 't', source: 'otter', itemRef: 'r', comment: 'do it', match_hash: 'h1' }]);
    expect((await drainIntake(queuePath, consumedPath, fakeExtract)).created).toBe(1);
    const second = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(second.created).toBe(0);
    expect(listTasks()).toHaveLength(1);
  });

  it('does not re-run a consumed directive after a restart', async () => {
    writeQueue([{ ts: 't', source: 'otter', itemRef: 'r', comment: 'do it', match_hash: 'h1' }]);
    await drainIntake(queuePath, consumedPath, fakeExtract);
    setTasksDir(path.join(testRoot, 'tasks-restarted'));
    const after = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(after.created).toBe(0);
    expect(listTasks()).toHaveLength(0);
  });

  it('collapses duplicate inbox lines (same match_hash) to a single Task', async () => {
    const dupe = { ts: 't', source: 'otter', itemRef: 'r', comment: 'do it', match_hash: 'dup' };
    writeQueue([dupe, dupe, dupe]);
    expect((await drainIntake(queuePath, consumedPath, fakeExtract)).created).toBe(1);
    expect(listTasks()).toHaveLength(1);
  });

  it('skips malformed and empty-comment lines', async () => {
    fs.writeFileSync(
      queuePath,
      [
        'not json at all',
        JSON.stringify({ source: 'otter', comment: '', match_hash: 'empty' }),
        JSON.stringify({ source: 'otter', comment: 'real one', match_hash: 'ok' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const result = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(result.created).toBe(1);
    expect(listTasks()).toHaveLength(1);
  });

  it('returns zero when the inbox does not exist', async () => {
    expect(await drainIntake(path.join(testRoot, 'nope.jsonl'), consumedPath, fakeExtract)).toEqual({
      created: 0,
      approved: 0,
      skipped: 0,
    });
  });
});
