/**
 * Tests for task-worker.ts, the act worker's selection logic.
 *
 * selectQueuedToRun is the pure decision step: given queued tasks, the
 * concurrency cap, and how many runs are already active, it returns the ids
 * to start. It runs ONLY human-approved tasks, the gate that stops a raw
 * scraped directive from auto-executing.
 */

import { describe, it, expect } from 'vitest';
import { selectQueuedToRun, isWorkerEnabled } from '../task-worker';
import type { Task } from '../task-store';

function task(id: string, status: Task['status'], createdAt: string, approved = false): Task {
  return {
    id,
    kind: 'action',
    origin: 'otter',
    prompt: id,
    title: id,
    status,
    createdAt,
    updatedAt: createdAt,
    history: [{ status: 'queued', ts: createdAt }],
    approved,
  };
}

describe('selectQueuedToRun', () => {
  it('returns only approved queued tasks, oldest first, up to the available slots', () => {
    const tasks = [
      task('c', 'queued', '2026-05-18T03:00:00Z', true),
      task('a', 'queued', '2026-05-18T01:00:00Z', true),
      task('b', 'queued', '2026-05-18T02:00:00Z', true),
      task('done', 'done', '2026-05-18T00:00:00Z', true),
    ];
    expect(selectQueuedToRun(tasks, 2, 0)).toEqual(['a', 'b']);
  });

  it('excludes unapproved queued tasks, a scraped directive never auto-runs', () => {
    const tasks = [
      task('unapproved', 'queued', '2026-05-18T01:00:00Z', false),
      task('approved', 'queued', '2026-05-18T02:00:00Z', true),
    ];
    expect(selectQueuedToRun(tasks, 5, 0)).toEqual(['approved']);
  });

  it('subtracts already-active runs from the cap', () => {
    const tasks = [
      task('a', 'queued', '2026-05-18T01:00:00Z', true),
      task('b', 'queued', '2026-05-18T02:00:00Z', true),
    ];
    expect(selectQueuedToRun(tasks, 2, 1)).toEqual(['a']);
  });

  it('returns nothing when the cap is full', () => {
    const tasks = [task('a', 'queued', '2026-05-18T01:00:00Z', true)];
    expect(selectQueuedToRun(tasks, 2, 2)).toEqual([]);
  });

  it('returns nothing when there are no approved queued tasks', () => {
    const tasks = [
      task('a', 'running', '2026-05-18T01:00:00Z', true),
      task('b', 'queued', '2026-05-18T02:00:00Z', false),
    ];
    expect(selectQueuedToRun(tasks, 2, 0)).toEqual([]);
  });
});

describe('isWorkerEnabled', () => {
  it('runs by default and is hard-disabled only by SECONDBRAIN_TASK_WORKER=off', () => {
    const prev = process.env.SECONDBRAIN_TASK_WORKER;
    try {
      delete process.env.SECONDBRAIN_TASK_WORKER;
      expect(isWorkerEnabled()).toBe(true);
      process.env.SECONDBRAIN_TASK_WORKER = 'on';
      expect(isWorkerEnabled()).toBe(true);
      process.env.SECONDBRAIN_TASK_WORKER = 'off';
      expect(isWorkerEnabled()).toBe(false);
      process.env.SECONDBRAIN_TASK_WORKER = 'OFF';
      expect(isWorkerEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SECONDBRAIN_TASK_WORKER;
      else process.env.SECONDBRAIN_TASK_WORKER = prev;
    }
  });
});
