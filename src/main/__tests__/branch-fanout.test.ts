import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runBranches,
  unwrapSuccessful,
  failedBranches,
  readCheckpoint,
  writeCheckpoint,
  clearRun,
  BranchCheckpoint,
} from '../branch-fanout';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
}

describe('branch-fanout', () => {
  it('runs every branch on a fresh run and records checkpoints', async () => {
    const dir = tmpDir();
    const result = await runBranches('run1', [1, 2, 3], dir, async (item) => item * 10);
    expect(result.ran).toBe(3);
    expect(result.cached).toBe(0);
    expect(result.failed).toBe(0);
    expect(unwrapSuccessful(result).sort()).toEqual([10, 20, 30]);

    for (let i = 0; i < 3; i++) {
      const cp = readCheckpoint<number>(dir, 'run1', `branch-${i}`);
      expect(cp).not.toBeNull();
      expect(cp!.ok).toBe(true);
      expect(cp!.attempt).toBe(1);
    }
  });

  it('short-circuits to cached results when checkpoints already exist', async () => {
    const dir = tmpDir();
    let invocations = 0;
    const fn = async (item: number) => {
      invocations += 1;
      return item + 1;
    };
    const first = await runBranches('runC', [1, 2, 3], dir, fn);
    expect(invocations).toBe(3);
    expect(first.cached).toBe(0);

    const second = await runBranches('runC', [1, 2, 3], dir, fn);
    expect(invocations).toBe(3);
    expect(second.cached).toBe(3);
    expect(second.ran).toBe(0);
    expect(unwrapSuccessful(second).sort()).toEqual([2, 3, 4]);
  });

  it('partial-resume runs only the missing branches', async () => {
    const dir = tmpDir();
    const items = ['a', 'b', 'c'];
    let calls: string[] = [];
    const fn = async (item: string) => {
      calls.push(item);
      return item.toUpperCase();
    };

    // simulate a prior run that completed the first two branches only
    const earlier: BranchCheckpoint<string> = {
      branch_id: 'branch-0',
      ok: true,
      result: 'A',
      started_at: '2026-05-01T00:00:00.000Z',
      finished_at: '2026-05-01T00:00:01.000Z',
      duration_ms: 1000,
      attempt: 1,
    };
    writeCheckpoint(dir, 'runP', earlier);
    writeCheckpoint(dir, 'runP', { ...earlier, branch_id: 'branch-1', result: 'B' });

    calls = [];
    const out = await runBranches('runP', items, dir, fn);
    expect(calls).toEqual(['c']);
    expect(out.ran).toBe(1);
    expect(out.cached).toBe(2);
    expect(unwrapSuccessful(out).sort()).toEqual(['A', 'B', 'C']);
  });

  it('records failures to checkpoint with the error message', async () => {
    const dir = tmpDir();
    const fn = async (item: number) => {
      if (item === 2) throw new Error('boom on 2');
      return item;
    };
    const result = await runBranches('runF', [1, 2, 3], dir, fn);
    expect(result.failed).toBe(1);
    expect(result.ran).toBe(3);
    const failed = failedBranches(result);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('boom on 2');
    const cp = readCheckpoint<number>(dir, 'runF', 'branch-1');
    expect(cp!.ok).toBe(false);
    expect(cp!.error).toBe('boom on 2');
  });

  it('does not silently retry a failed checkpoint by default', async () => {
    const dir = tmpDir();
    const fn = async (item: number) => {
      if (item === 2) throw new Error('boom');
      return item;
    };
    await runBranches('runR', [1, 2, 3], dir, fn);
    let secondInvocations = 0;
    const fn2 = async (item: number) => {
      secondInvocations += 1;
      return item;
    };
    const out = await runBranches('runR', [1, 2, 3], dir, fn2);
    expect(secondInvocations).toBe(0);
    expect(out.cached).toBe(3);
    expect(out.failed).toBe(1);
  });

  it('retries failed checkpoints when retryFailed=true and bumps attempt', async () => {
    const dir = tmpDir();
    let firstFn = async (item: number) => {
      if (item === 2) throw new Error('boom');
      return item;
    };
    await runBranches('runRF', [1, 2, 3], dir, firstFn);
    let calls = 0;
    const secondFn = async (item: number) => {
      calls += 1;
      return item * 100; // succeeds this time
    };
    const out = await runBranches('runRF', [1, 2, 3], dir, secondFn, { retryFailed: true });
    expect(calls).toBe(1);
    expect(out.cached).toBe(2);
    expect(out.ran).toBe(1);
    expect(out.failed).toBe(0);
    const cp = readCheckpoint<number>(dir, 'runRF', 'branch-1');
    expect(cp!.attempt).toBe(2);
    expect(cp!.result).toBe(200);
  });

  it('respects maxConcurrency to bound in-flight branches', async () => {
    const dir = tmpDir();
    let inflight = 0;
    let peak = 0;
    const fn = async (item: number) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((res) => setTimeout(res, 5));
      inflight -= 1;
      return item;
    };
    await runBranches('runMC', [1, 2, 3, 4, 5, 6, 7, 8], dir, fn, { maxConcurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('uses custom branchId for stable cache keys across re-orderings', async () => {
    const dir = tmpDir();
    type Job = { name: string; payload: number };
    const fn = async (j: Job) => j.payload * 2;
    const opts = { branchId: (j: Job) => j.name };

    const ordered = [
      { name: 'a', payload: 1 },
      { name: 'b', payload: 2 },
      { name: 'c', payload: 3 },
    ];
    await runBranches('runID', ordered, dir, fn, opts);

    const reordered = [
      { name: 'c', payload: 3 },
      { name: 'a', payload: 1 },
      { name: 'b', payload: 2 },
    ];
    const out = await runBranches('runID', reordered, dir, fn, opts);
    expect(out.cached).toBe(3);
    expect(out.ran).toBe(0);
  });

  it('clearRun deletes all branch checkpoints for a run', async () => {
    const dir = tmpDir();
    await runBranches('clr', [1, 2], dir, async (n) => n);
    expect(fs.existsSync(path.join(dir, 'clr'))).toBe(true);
    clearRun(dir, 'clr');
    expect(fs.existsSync(path.join(dir, 'clr'))).toBe(false);
  });

  it('returns empty result for empty input without writing any files', async () => {
    const dir = tmpDir();
    const out = await runBranches('empty', [], dir, async () => 0);
    expect(out.branches).toHaveLength(0);
    expect(out.ran).toBe(0);
    expect(out.cached).toBe(0);
    expect(out.failed).toBe(0);
  });
});
