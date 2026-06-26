import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  enqueueApproval,
  listPending,
  getApproval,
  decideApproval,
  expireStale,
  formatPendingForBriefing,
  getInboxStats,
} from '../approval-inbox';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'approval-inbox-'));
}

describe('approval-inbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTmp();
  });

  it('enqueueApproval persists a pending request with id + timestamp', () => {
    const req = enqueueApproval(dir, {
      surface: 'telegram',
      action: 'send-email',
      reason: 'Outbound email to BAI client requires sign-off',
    });
    expect(req.id).toMatch(/^appr_/);
    expect(req.status).toBe('pending');
    expect(new Date(req.createdAt).toString()).not.toBe('Invalid Date');

    const log = fs.readFileSync(path.join(dir, 'approval-inbox.jsonl'), 'utf8');
    expect(log).toContain(req.id);
  });

  it('listPending returns oldest-first pending requests', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    const t1 = new Date('2026-05-22T05:05:00Z');
    const t2 = new Date('2026-05-22T05:10:00Z');

    enqueueApproval(dir, { surface: 'telegram', action: 'A', reason: 'r', now: t1 });
    enqueueApproval(dir, { surface: 'telegram', action: 'B', reason: 'r', now: t0 });
    enqueueApproval(dir, { surface: 'briefing', action: 'C', reason: 'r', now: t2 });

    const pending = listPending(dir);
    expect(pending).toHaveLength(3);
    expect(pending.map((r) => r.action)).toEqual(['B', 'A', 'C']);
  });

  it('listPending filters by surface when requested', () => {
    enqueueApproval(dir, { surface: 'telegram', action: 'A', reason: 'r' });
    enqueueApproval(dir, { surface: 'briefing', action: 'B', reason: 'r' });
    const telegramOnly = listPending(dir, { surface: 'telegram' });
    expect(telegramOnly.map((r) => r.action)).toEqual(['A']);
  });

  it('decideApproval marks a request approved and records decidedBy + decidedAt', () => {
    const req = enqueueApproval(dir, {
      surface: 'tasks-tab',
      action: 'call-dentist',
      reason: 'Outbound call to clinic',
    });
    const decided = decideApproval(dir, req.id, {
      decision: 'approved',
      decidedBy: 'ExampleCo',
      notes: 'go ahead',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('ExampleCo');
    expect(decided.notes).toBe('go ahead');
    expect(listPending(dir)).toHaveLength(0);
    expect(getApproval(dir, req.id)?.status).toBe('approved');
  });

  it('decideApproval throws when the request is already decided', () => {
    const req = enqueueApproval(dir, { surface: 'telegram', action: 'A', reason: 'r' });
    decideApproval(dir, req.id, { decision: 'approved', decidedBy: 'ExampleCo' });
    expect(() =>
      decideApproval(dir, req.id, { decision: 'rejected', decidedBy: 'ExampleCo' }),
    ).toThrow(/already approved/);
  });

  it('decideApproval throws for ExampleCo id', () => {
    expect(() =>
      decideApproval(dir, 'nope', { decision: 'approved', decidedBy: 'ExampleCo' }),
    ).toThrow(/not found/);
  });

  it('expireStale sweeps pending requests past their TTL', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    const req = enqueueApproval(dir, {
      surface: 'briefing',
      action: 'A',
      reason: 'r',
      ttlMinutes: 5,
      now: t0,
    });
    expect(req.expiresAt).toBe('2026-05-22T05:05:00.000Z');

    const stillFresh = expireStale(dir, new Date('2026-05-22T05:04:00Z'));
    expect(stillFresh).toHaveLength(0);

    const expired = expireStale(dir, new Date('2026-05-22T05:06:00Z'));
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe('expired');
    expect(expired[0].decidedBy).toBe('system:ttl-sweep');
    expect(listPending(dir, { now: new Date('2026-05-22T05:06:00Z') })).toHaveLength(0);
  });

  it('listPending hides expired-by-ttl requests even before expireStale runs', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    enqueueApproval(dir, {
      surface: 'briefing', action: 'A', reason: 'r', ttlMinutes: 5, now: t0,
    });
    expect(listPending(dir, { now: new Date('2026-05-22T05:06:00Z') })).toHaveLength(0);
  });

  it('formatPendingForBriefing yields a tier-1 CEO line', () => {
    expect(formatPendingForBriefing(dir)).toBe('Approval inbox: 0 pending.');
    enqueueApproval(dir, { surface: 'telegram', action: 'send-email', reason: 'r' });
    enqueueApproval(dir, { surface: 'tasks-tab', action: 'call-dentist', reason: 'r' });
    enqueueApproval(dir, { surface: 'briefing', action: 'deploy', reason: 'r' });
    enqueueApproval(dir, { surface: 'gmail', action: 'send-reply', reason: 'r' });

    const line = formatPendingForBriefing(dir);
    expect(line).toMatch(/^Approval inbox: 4 pending/);
    expect(line).toContain('+1 more');
  });

  it('getInboxStats aggregates statuses including ttl-effective expired', () => {
    const t0 = new Date('2026-05-22T05:00:00Z');
    const a = enqueueApproval(dir, { surface: 'telegram', action: 'A', reason: 'r', now: t0 });
    const b = enqueueApproval(dir, { surface: 'telegram', action: 'B', reason: 'r', now: t0, ttlMinutes: 5 });
    const c = enqueueApproval(dir, { surface: 'telegram', action: 'C', reason: 'r', now: t0 });
    decideApproval(dir, a.id, { decision: 'approved', decidedBy: 'ExampleCo' });
    decideApproval(dir, c.id, { decision: 'rejected', decidedBy: 'ExampleCo' });

    const stats = getInboxStats(dir, new Date('2026-05-22T05:10:00Z'));
    expect(stats.total).toBe(3);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.expired).toBe(1);
    expect(stats.pending).toBe(0);
    expect(b.id).toBeDefined();
  });

  it('audit log preserves every event (enqueue + decision rows side by side)', () => {
    const req = enqueueApproval(dir, { surface: 'telegram', action: 'A', reason: 'r' });
    decideApproval(dir, req.id, { decision: 'approved', decidedBy: 'ExampleCo' });

    const lines = fs.readFileSync(path.join(dir, 'approval-inbox.jsonl'), 'utf8')
      .trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].status).toBe('pending');
    expect(events[1].status).toBe('approved');
  });
});
