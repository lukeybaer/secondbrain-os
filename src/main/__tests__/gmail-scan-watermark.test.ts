/**
 * Regression tests for scripts/gmail-scan-watermark.js.
 *
 * The Gmail action-item artifact (data/briefing-action-items.json) used to be
 * rebuilt daily by scanning the last 200 Gmail threads in full. Item 12
 * approved an incremental rebuild: a persisted watermark must ensure that on a
 * second run with no new threads, ZERO threads are re-fetched, and that a
 * thread which gained a new reply IS re-processed.
 *
 * These tests prove exactly that contract against the pure watermark module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const watermark = require('../../../scripts/gmail-scan-watermark.js');

type Candidate = { threadId: string; messageCount?: number; lastMessageAt?: string };

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-wm-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

/** Simulate one full Gmail scan pass: read watermark, select deltas, fetch. */
function runScanPass(candidates: Candidate[]) {
  const wm = watermark.loadWatermark(repoRoot);
  const { toFetch, skipped } = watermark.selectThreadsToFetch(wm, candidates);
  // The workflow only calls gmail_read_thread on `toFetch`.
  for (const t of toFetch) watermark.recordScanned(wm, t);
  watermark.markScanComplete(wm);
  watermark.saveWatermark(repoRoot, wm);
  return { fetched: toFetch as Candidate[], skipped: skipped as Candidate[] };
}

describe('gmail-scan-watermark incremental rebuild', () => {
  it('first run with no watermark fetches every thread', () => {
    const candidates: Candidate[] = [
      { threadId: 't1', messageCount: 2, lastMessageAt: '2026-05-17T10:00:00Z' },
      { threadId: 't2', messageCount: 1, lastMessageAt: '2026-05-17T11:00:00Z' },
      { threadId: 't3', messageCount: 5, lastMessageAt: '2026-05-17T12:00:00Z' },
    ];
    const { fetched, skipped } = runScanPass(candidates);
    expect(fetched.map((t) => t.threadId).sort()).toEqual(['t1', 't2', 't3']);
    expect(skipped).toHaveLength(0);
  });

  it('second run with no new threads re-fetches ZERO threads', () => {
    const candidates: Candidate[] = [
      { threadId: 't1', messageCount: 2, lastMessageAt: '2026-05-17T10:00:00Z' },
      { threadId: 't2', messageCount: 1, lastMessageAt: '2026-05-17T11:00:00Z' },
      { threadId: 't3', messageCount: 5, lastMessageAt: '2026-05-17T12:00:00Z' },
    ];
    // First pass primes the watermark.
    runScanPass(candidates);
    // Second pass with the identical thread list.
    const second = runScanPass(candidates);
    expect(second.fetched).toHaveLength(0);
    expect(second.skipped.map((t) => t.threadId).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('a thread with a NEW reply IS re-processed on the next run', () => {
    const initial: Candidate[] = [
      { threadId: 't1', messageCount: 2, lastMessageAt: '2026-05-17T10:00:00Z' },
      { threadId: 't2', messageCount: 1, lastMessageAt: '2026-05-17T11:00:00Z' },
    ];
    runScanPass(initial);

    // t1 gained a reply (messageCount 2 -> 3); t2 is unchanged.
    const next: Candidate[] = [
      { threadId: 't1', messageCount: 3, lastMessageAt: '2026-05-18T09:00:00Z' },
      { threadId: 't2', messageCount: 1, lastMessageAt: '2026-05-17T11:00:00Z' },
    ];
    const second = runScanPass(next);
    expect(second.fetched.map((t) => t.threadId)).toEqual(['t1']);
    expect(second.skipped.map((t) => t.threadId)).toEqual(['t2']);
  });

  it('detects new activity by newer lastMessageAt even without a count delta', () => {
    runScanPass([{ threadId: 't1', messageCount: 4, lastMessageAt: '2026-05-17T10:00:00Z' }]);
    // Count unchanged but a newer message timestamp means activity.
    const second = runScanPass([
      { threadId: 't1', messageCount: 4, lastMessageAt: '2026-05-18T08:00:00Z' },
    ]);
    expect(second.fetched.map((t) => t.threadId)).toEqual(['t1']);
  });

  it('a brand-new thread appearing later is fetched while old ones are skipped', () => {
    runScanPass([{ threadId: 't1', messageCount: 1, lastMessageAt: '2026-05-17T10:00:00Z' }]);
    const second = runScanPass([
      { threadId: 't1', messageCount: 1, lastMessageAt: '2026-05-17T10:00:00Z' },
      { threadId: 't2', messageCount: 1, lastMessageAt: '2026-05-18T09:00:00Z' },
    ]);
    expect(second.fetched.map((t) => t.threadId)).toEqual(['t2']);
    expect(second.skipped.map((t) => t.threadId)).toEqual(['t1']);
  });

  it('persists the watermark sidecar to data/agent/gmail-scan-watermark.json', () => {
    runScanPass([{ threadId: 't1', messageCount: 2, lastMessageAt: '2026-05-17T10:00:00Z' }]);
    const p = path.join(repoRoot, 'data', 'agent', 'gmail-scan-watermark.json');
    expect(fs.existsSync(p)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(saved.version).toBe(watermark.WATERMARK_VERSION);
    expect(saved.threads.t1.messageCount).toBe(2);
    expect(typeof saved.lastScanAt).toBe('string');
  });

  it('a corrupt watermark sidecar falls back to a full scan instead of crashing', () => {
    const p = path.join(repoRoot, 'data', 'agent', 'gmail-scan-watermark.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json', 'utf8');
    const wm = watermark.loadWatermark(repoRoot);
    const { toFetch } = watermark.selectThreadsToFetch(wm, [
      { threadId: 't1', messageCount: 1 },
    ]);
    expect(toFetch.map((t: Candidate) => t.threadId)).toEqual(['t1']);
  });

  it('threadNeedsFetch reports an accurate reason for each case', () => {
    const wm = watermark.blankWatermark();
    expect(watermark.threadNeedsFetch(wm, { threadId: 'x', messageCount: 1 }).reason).toBe(
      'new-thread',
    );
    watermark.recordScanned(wm, { threadId: 'x', messageCount: 1, lastMessageAt: '2026-05-17T10:00:00Z' });
    expect(watermark.threadNeedsFetch(wm, { threadId: 'x', messageCount: 1 }).reason).toBe(
      'unchanged',
    );
    expect(watermark.threadNeedsFetch(wm, { threadId: 'x', messageCount: 2 }).reason).toBe(
      'new-reply',
    );
  });
});
