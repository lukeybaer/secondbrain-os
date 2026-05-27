import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  enqueueSleepTrigger,
  listPendingTriggers,
  getTrigger,
  drainSleepTriggers,
  formatPendingTriggersForBriefing,
  getQueueStats,
  type SleepTrigger,
} from '../sleep-time-trigger-queue';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-trigger-'));
}

describe('sleep-time-trigger-queue', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTmp();
  });

  it('enqueueSleepTrigger writes a pending trigger to the log + snapshot', () => {
    const t = enqueueSleepTrigger(dir, {
      type: 'contact-consolidate',
      key: 'contact:john-smith',
      source: 'vapi-call:abc123',
    });
    expect(t.id).toMatch(/^slp_/);
    expect(t.status).toBe('pending');
    expect(t.attempts).toBe(0);
    expect(fs.existsSync(path.join(dir, 'sleep-trigger-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sleep-trigger-pending.json'))).toBe(true);
  });

  it('dedupes same (type, key) within the window', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    const a = enqueueSleepTrigger(dir, {
      type: 'contact-consolidate',
      key: 'contact:x',
      source: 'gmail-thread:1',
      now: t0,
    });
    const b = enqueueSleepTrigger(dir, {
      type: 'contact-consolidate',
      key: 'contact:x',
      source: 'gmail-thread:2',
      now: new Date('2026-05-22T05:05:00Z'),
      dedupeWindowMinutes: 15,
    });
    expect(b.id).toBe(a.id);
    expect(listPendingTriggers(dir)).toHaveLength(1);
  });

  it('does NOT dedupe outside the window', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    enqueueSleepTrigger(dir, {
      type: 'contact-consolidate',
      key: 'contact:y',
      source: 's1',
      now: t0,
    });
    enqueueSleepTrigger(dir, {
      type: 'contact-consolidate',
      key: 'contact:y',
      source: 's2',
      now: new Date('2026-05-22T05:20:00Z'),
      dedupeWindowMinutes: 15,
    });
    expect(listPendingTriggers(dir)).toHaveLength(2);
  });

  it('does NOT dedupe across different types', () => {
    enqueueSleepTrigger(dir, { type: 'contact-consolidate', key: 'contact:z', source: 's' });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'contact:z', source: 's' });
    expect(listPendingTriggers(dir)).toHaveLength(2);
  });

  it('drainSleepTriggers calls the handler exactly once per pending trigger on success', async () => {
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'a', source: 's' });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'b', source: 's' });

    const seen: string[] = [];
    const result = await drainSleepTriggers(dir, async (t) => {
      seen.push(t.key);
    });

    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(listPendingTriggers(dir)).toHaveLength(0);
  });

  it('handler errors leave the trigger pending with incremented attempts', async () => {
    const t = enqueueSleepTrigger(dir, {
      type: 'contact-consolidate', key: 'fragile', source: 's',
    });

    const result = await drainSleepTriggers(dir, async () => {
      throw new Error('graphiti down');
    });

    expect(result.failed).toBe(1);
    expect(result.giveUpCount).toBe(0);
    expect(result.errors[0].error).toBe('graphiti down');

    const stillPending = getTrigger(dir, t.id);
    expect(stillPending?.status).toBe('pending');
    expect(stillPending?.attempts).toBe(1);
    expect(stillPending?.lastError).toBe('graphiti down');
  });

  it('marks a trigger failed after maxAttempts is reached', async () => {
    enqueueSleepTrigger(dir, { type: 'contact-consolidate', key: 'doomed', source: 's' });

    let attempts = 0;
    const handler = async () => {
      attempts++;
      throw new Error('always-broken');
    };

    await drainSleepTriggers(dir, handler, { maxAttempts: 3 });
    await drainSleepTriggers(dir, handler, { maxAttempts: 3 });
    const final = await drainSleepTriggers(dir, handler, { maxAttempts: 3 });

    expect(attempts).toBe(3);
    expect(final.giveUpCount).toBe(1);
    expect(listPendingTriggers(dir)).toHaveLength(0);
    const stats = getQueueStats(dir);
    expect(stats.failed).toBe(1);
  });

  it('maxToProcess limits drain batch size', async () => {
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: '1', source: 's' });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: '2', source: 's' });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: '3', source: 's' });

    const result = await drainSleepTriggers(dir, async () => {}, { maxToProcess: 2 });
    expect(result.attempted).toBe(2);
    expect(listPendingTriggers(dir)).toHaveLength(1);
  });

  it('listPendingTriggers returns oldest-first', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    const t1 = new Date('2026-05-22T05:05:00Z');
    const t2 = new Date('2026-05-22T05:10:00Z');

    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'b', source: 's', now: t1 });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'a', source: 's', now: t0 });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'c', source: 's', now: t2 });

    expect(listPendingTriggers(dir).map((t: SleepTrigger) => t.key)).toEqual(['a', 'b', 'c']);
  });

  it('formatPendingTriggersForBriefing groups by type', () => {
    expect(formatPendingTriggersForBriefing(dir)).toBe('Sleep-time queue: idle.');
    enqueueSleepTrigger(dir, { type: 'contact-consolidate', key: 'a', source: 's' });
    enqueueSleepTrigger(dir, { type: 'contact-consolidate', key: 'b', source: 's' });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'a', source: 's' });

    const line = formatPendingTriggersForBriefing(dir);
    expect(line).toContain('3 pending');
    expect(line).toContain('contact-consolidate');
    expect(line).toContain('graphiti-reindex');
  });

  it('getQueueStats reports oldestPendingAt', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'old', source: 's', now: t0 });
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'newer', source: 's',
      now: new Date('2026-05-22T05:10:00Z') });
    const stats = getQueueStats(dir);
    expect(stats.pending).toBe(2);
    expect(stats.oldestPendingAt).toBe(t0.toISOString());
  });

  it('done triggers move out of pending and into stats.done', async () => {
    enqueueSleepTrigger(dir, { type: 'graphiti-reindex', key: 'k', source: 's' });
    await drainSleepTriggers(dir, async () => {});
    const stats = getQueueStats(dir);
    expect(stats.done).toBe(1);
    expect(stats.pending).toBe(0);
  });
});
