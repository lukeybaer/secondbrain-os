// E1-K4: Amy can ask ExampleCo one TLDR follow-up, render a reply box, and resume
// the same durable task after the reply is saved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTask,
  getTask,
  replyTaskFeedback,
  requestTaskFeedback,
  setTasksDir,
  transition,
  updateTask,
} from '../task-store';
import { projectAmyTasks } from '../amy-projects';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-feedback-'));
  setTasksDir(path.join(dir, 'tasks'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('E1-K4 requires-feedback roundtrip', () => {
  it('exposes the TLDR question, accepts the reply, and resumes to completion', () => {
    const task = createTask({
      kind: 'action',
      origin: 'app',
      prompt: 'Book the follow-up call.',
      title: 'Book follow-up call',
    });
    transition(task.id, 'running');
    const waiting = requestTaskFeedback(task.id, {
      tldr: 'Need one detail before booking.',
      question: 'What day should Amy propose?',
    });

    expect(waiting.status).toBe('requires-feedback');
    expect(waiting.feedbackRequest?.tldr).toBe('Need one detail before booking.');
    expect(projectAmyTasks([waiting])[0].visibleStatusLabel).toBe('Needs your reply');

    const resumed = replyTaskFeedback(task.id, 'Offer Tuesday afternoon first.');
    expect(resumed.status).toBe('queued');
    expect(resumed.prompt).toContain('Offer Tuesday afternoon first.');
    expect(resumed.feedbackRequest?.replies?.[0].text).toBe('Offer Tuesday afternoon first.');

    transition(task.id, 'running');
    updateTask(task.id, { resultSummary: 'TLDR: Tuesday afternoon was proposed.' });
    transition(task.id, 'done');

    const final = getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.history.map((h) => h.status)).toEqual([
      'queued',
      'running',
      'requires-feedback',
      'queued',
      'running',
      'done',
    ]);
  });
});
