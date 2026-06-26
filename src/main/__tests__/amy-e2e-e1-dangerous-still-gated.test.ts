// E1-R5: dangerous patterns stay human-gated even after safe auto-approval
// improvements.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAutoRunnable, matchDangerousPattern, type ExtractedDispatch } from '../task-extract';
import { drainIntake, type ExtractFn } from '../task-intake';
import { listTasks, setTasksDir } from '../task-store';

let dir: string;
let queuePath: string;
let consumedPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangerous-gate-'));
  setTasksDir(path.join(dir, 'tasks'));
  queuePath = path.join(dir, 'dispatch-queue.jsonl');
  consumedPath = path.join(dir, 'consumed.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('E1-R5 dangerous dispatch gate', () => {
  it('rejects destructive wording even when the extraction is confident', () => {
    const extracted: ExtractedDispatch = {
      prompt: 'Delete the production database backup.',
      confident: true,
      reason: 'clear',
      actionType: 'summarize',
    };

    expect(matchDangerousPattern(extracted.prompt)).toBe('Delete');
    expect(isAutoRunnable(extracted)).toBe(false);
  });

  it('records but does not approve a dangerous dispatch from intake', async () => {
    fs.writeFileSync(
      queuePath,
      JSON.stringify({
        ts: new Date().toISOString(),
        source: 'telegram',
        itemRef: 'danger-1',
        comment: 'delete it',
        match_hash: 'danger-1',
      }) + '\n',
    );
    const fakeExtract: ExtractFn = async () => ({
      prompt: 'Delete the production database backup.',
      confident: false,
      reason: 'held: matched destructive-action guard ("Delete")',
      actionType: 'mutate',
    });

    const result = await drainIntake(queuePath, consumedPath, fakeExtract);
    expect(result.created).toBe(1);
    expect(result.approved).toBe(0);
    expect(listTasks()[0]?.approved).toBeUndefined();
  });
});
