// E1-R1: the main intake origins still converge into the task spine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, listTasks, setTasksDir } from '../task-store';
import { drainIntake, type ExtractFn } from '../task-intake';

let dir: string;
let queuePath: string;
let consumedPath: string;

const fakeExtract: ExtractFn = async (raw) => ({
  prompt: raw,
  confident: false,
  reason: 'held for review in convergence test',
  actionType: 'ExampleCo',
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-converges-'));
  setTasksDir(path.join(dir, 'tasks'));
  queuePath = path.join(dir, 'dispatch-queue.jsonl');
  consumedPath = path.join(dir, 'consumed.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('E1-R1 intake convergence', () => {
  it('telegram, vapi, otter, email, dashboard, and codex each land one spine task', async () => {
    const entries = [
      { ts: '2026-06-12T12:00:00Z', source: 'telegram', itemRef: 'tg-1', comment: 'telegram ask', match_hash: 'tg' },
      { ts: '2026-06-12T12:00:01Z', source: 'vapi', itemRef: 'call-1', comment: 'voice ask', match_hash: 'vapi' },
      { ts: '2026-06-12T12:00:02Z', source: 'otter', itemRef: 'otter-1', comment: 'otter ask', match_hash: 'otter' },
      { ts: '2026-06-12T12:00:03Z', source: 'gmail', itemRef: 'msg-1', comment: 'email ask', match_hash: 'gmail' },
    ];
    fs.writeFileSync(queuePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    expect((await drainIntake(queuePath, consumedPath, fakeExtract)).created).toBe(4);

    createTask({ kind: 'action', origin: 'app', title: 'dashboard ask', prompt: 'dashboard ask' });
    createTask({ kind: 'action', origin: 'codex', title: 'codex ask', prompt: 'codex ask' });

    const tasks = listTasks();
    expect(tasks).toHaveLength(6);
    expect(tasks.map((task) => task.origin).sort()).toEqual([
      'app',
      'codex',
      'gmail',
      'otter',
      'telegram',
      'voice',
    ]);
  });
});
