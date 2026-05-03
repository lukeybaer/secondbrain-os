/**
 * Tests for ingest-queue.ts , file-based work queue for batched ingest.
 *
 * Covers: enqueue, listPending, claim, markDone, markFailed, escalate, drain
 * happy path, drain escape hatch, drain retry/auto-fail, queueCounts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  enqueue,
  listPending,
  claim,
  markDone,
  markFailed,
  escalate,
  release,
  queueCounts,
  drain,
  type IngestItem,
  type DrainResult,
} from '../ingest-queue';

// ── Filesystem isolation ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-queue-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeItem(overrides: Partial<IngestItem> = {}): Omit<IngestItem, 'id' | 'receivedAt' | 'attempts'> {
  return {
    source: 'gmail',
    externalId: 'msg-abc',
    rawRef: '/tmp/gmail/raw/msg-abc.json',
    kind: 'gmail:thread:enrich',
    meta: { subject: 'hello' },
    ...overrides,
  };
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('creates an item in pending/ with generated id + receivedAt + attempts=0', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]+$/);

    const filePath = path.join(tmpRoot, 'pending', `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const item = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IngestItem;
    expect(item.id).toBe(id);
    expect(item.source).toBe('gmail');
    expect(item.externalId).toBe('msg-abc');
    expect(item.kind).toBe('gmail:thread:enrich');
    expect(item.attempts).toBe(0);
    expect(Date.parse(item.receivedAt)).not.toBeNaN();
  });

  it('creates all five state directories on first enqueue', () => {
    enqueue(makeItem(), { queueRoot: tmpRoot });
    for (const s of ['pending', 'in-progress', 'done', 'failed', 'escalated']) {
      expect(fs.existsSync(path.join(tmpRoot, s))).toBe(true);
    }
  });

  it('generates monotonically-sortable ids for items enqueued in sequence', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(enqueue(makeItem({ externalId: `msg-${i}` }), { queueRoot: tmpRoot }));
      // Slight delay so the ms timestamp component differs
      await new Promise((r) => setTimeout(r, 2));
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

// ── Listing + counts ──────────────────────────────────────────────────────────

describe('listPending + queueCounts', () => {
  it('returns pending items in chronological order', async () => {
    const a = enqueue(makeItem({ externalId: 'a' }), { queueRoot: tmpRoot });
    await new Promise((r) => setTimeout(r, 2));
    const b = enqueue(makeItem({ externalId: 'b' }), { queueRoot: tmpRoot });
    await new Promise((r) => setTimeout(r, 2));
    const c = enqueue(makeItem({ externalId: 'c' }), { queueRoot: tmpRoot });
    const pending = listPending(tmpRoot);
    expect(pending.map((i) => i.id)).toEqual([a, b, c]);
  });

  it('queueCounts reports zeroes on empty queue after layout is created', () => {
    enqueue(makeItem(), { queueRoot: tmpRoot });
    // Remove the file but keep the layout
    const pending = fs.readdirSync(path.join(tmpRoot, 'pending'));
    for (const f of pending) fs.unlinkSync(path.join(tmpRoot, 'pending', f));
    const counts = queueCounts(tmpRoot);
    expect(counts.pending).toBe(0);
    expect(counts['in-progress']).toBe(0);
    expect(counts.done).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.escalated).toBe(0);
  });
});

// ── Claim + state transitions ─────────────────────────────────────────────────

describe('claim + markDone + markFailed + escalate + release', () => {
  it('claim moves an item from pending/ to in-progress/ and increments attempts', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    const claimed = claim(id, tmpRoot);
    expect(claimed).not.toBeNull();
    expect(claimed?.attempts).toBe(1);
    expect(fs.existsSync(path.join(tmpRoot, 'pending', `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'in-progress', `${id}.json`))).toBe(true);
  });

  it('claim returns null when the item file is missing (race)', () => {
    const result = claim('does-not-exist', tmpRoot);
    expect(result).toBeNull();
  });

  it('markDone moves an item from in-progress/ to done/', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    claim(id, tmpRoot);
    markDone(id, tmpRoot);
    expect(fs.existsSync(path.join(tmpRoot, 'in-progress', `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'done', `${id}.json`))).toBe(true);
  });

  it('markFailed moves to failed/ and annotates lastError', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    claim(id, tmpRoot);
    markFailed(id, 'network timeout', tmpRoot);
    const filePath = path.join(tmpRoot, 'failed', `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IngestItem;
    expect(stored.meta?.lastError).toBe('network timeout');
  });

  it('escalate moves to escalated/ and records the reason', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    claim(id, tmpRoot);
    escalate(id, 'unknown sender', tmpRoot);
    const filePath = path.join(tmpRoot, 'escalated', `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IngestItem;
    expect(stored.meta?.escalationReason).toBe('unknown sender');
  });

  it('release moves an item back from in-progress/ to pending/', () => {
    const id = enqueue(makeItem(), { queueRoot: tmpRoot });
    claim(id, tmpRoot);
    release(id, tmpRoot);
    expect(fs.existsSync(path.join(tmpRoot, 'pending', `${id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'in-progress', `${id}.json`))).toBe(false);
  });
});

// ── Drain happy path + escape hatch + retry budget ────────────────────────────

describe('drain', () => {
  it('processes every pending item, routes by handler outcome, and moves files atomically', async () => {
    enqueue(makeItem({ externalId: 'happy-1' }), { queueRoot: tmpRoot });
    enqueue(makeItem({ externalId: 'happy-2' }), { queueRoot: tmpRoot });
    enqueue(makeItem({ externalId: 'anomaly-1' }), { queueRoot: tmpRoot });
    enqueue(makeItem({ externalId: 'crash-1' }), { queueRoot: tmpRoot });

    const handler = async (item: IngestItem): Promise<DrainResult> => {
      if (item.externalId === 'anomaly-1') return { outcome: 'escalated', reason: 'unknown contact' };
      if (item.externalId === 'crash-1') return { outcome: 'failed', error: 'parse error' };
      return { outcome: 'done', note: 'enriched' };
    };

    const report = await drain(handler, { queueRoot: tmpRoot });
    expect(report.processed).toBe(4);
    expect(report.done).toBe(2);
    expect(report.escalated).toBe(1);
    expect(report.failed).toBe(1);

    const counts = queueCounts(tmpRoot);
    expect(counts.pending).toBe(0);
    expect(counts['in-progress']).toBe(0);
    expect(counts.done).toBe(2);
    expect(counts.escalated).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it('catches a handler that throws and marks the item failed instead of crashing the pass', async () => {
    enqueue(makeItem({ externalId: 'throw-1' }), { queueRoot: tmpRoot });
    enqueue(makeItem({ externalId: 'good-1' }), { queueRoot: tmpRoot });

    const handler = async (item: IngestItem): Promise<DrainResult> => {
      if (item.externalId === 'throw-1') throw new Error('boom');
      return { outcome: 'done' };
    };

    const report = await drain(handler, { queueRoot: tmpRoot });
    expect(report.processed).toBe(2);
    expect(report.done).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.items.find((i) => i.note?.includes('boom'))?.outcome).toBe('failed');
  });

  it('respects maxItems and leaves the rest in pending/', async () => {
    for (let i = 0; i < 5; i += 1) {
      enqueue(makeItem({ externalId: `x-${i}` }), { queueRoot: tmpRoot });
      await new Promise((r) => setTimeout(r, 2));
    }
    const handler = async (): Promise<DrainResult> => ({ outcome: 'done' });
    const report = await drain(handler, { queueRoot: tmpRoot, maxItems: 2 });
    expect(report.processed).toBe(2);
    expect(queueCounts(tmpRoot).pending).toBe(3);
  });

  it('auto-fails items that exceed maxAttempts without calling the handler', async () => {
    const id = enqueue(makeItem({ externalId: 'stubborn' }), { queueRoot: tmpRoot });
    // Bump attempts above the retry budget by claiming and releasing 3 times.
    for (let i = 0; i < 3; i += 1) {
      claim(id, tmpRoot);
      release(id, tmpRoot);
    }

    let handlerCalls = 0;
    const handler = async (): Promise<DrainResult> => {
      handlerCalls += 1;
      return { outcome: 'done' };
    };

    const report = await drain(handler, { queueRoot: tmpRoot, maxAttempts: 3 });
    expect(report.processed).toBe(1);
    expect(report.failed).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(queueCounts(tmpRoot).failed).toBe(1);
  });
});
