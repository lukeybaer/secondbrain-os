/**
 * Regression guards for the 2026-05-17 briefing overhaul (Items 6, 7, 9, SPINE)
 * in scripts/manual-briefing-v3.js.
 *
 *   Item 6  - non-green health probes get Luke's one-of-three answer
 *             (tried-and-stuck / mid-heal / heal-broke), never future-repair
 *             language; the first card lists every briefing defect.
 *   Item 7  - news recency gate: stale articles are dropped.
 *   Item 9  - LinkedIn "why this note" rationale parsing.
 *   SPINE   - Task Spine grouping by status.
 *
 * These exercise the PURE helpers exported from the script. The script's Main
 * IIFE is guarded on require.main so importing it here does not run a briefing.
 */

import { describe, it, expect } from 'vitest';

const {
  filterRecent,
  parseLinkedInDraft,
  formatNonGreenStatus,
  collectBriefingDefects,
  groupTasksByStatus,
} = require('../../../scripts/manual-briefing-v3.js');

// ── Item 7: news recency ─────────────────────────────────────────────────────
describe('filterRecent (Item 7 news freshness)', () => {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000).toUTCString();

  it('keeps articles inside the window', () => {
    const items = [
      { title: 'fresh', dateRaw: hoursAgo(2) },
      { title: 'also fresh', dateRaw: hoursAgo(20) },
    ];
    expect(filterRecent(items, 24).length).toBe(2);
  });

  it('drops articles older than the window (the 2021 archive bug)', () => {
    const items = [
      { title: 'fresh', dateRaw: hoursAgo(5) },
      { title: 'a 2021 archive', dateRaw: 'Mon, 01 Mar 2021 10:00:00 GMT' },
    ];
    const out = filterRecent(items, 72);
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('fresh');
  });

  it('drops articles with an unparseable date (dead feed)', () => {
    const items = [
      { title: 'no date', dateRaw: '' },
      { title: 'garbage date', dateRaw: 'not-a-date' },
      { title: 'fresh', dateRaw: hoursAgo(1) },
    ];
    const out = filterRecent(items, 24);
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('fresh');
  });

  it('enforces a tighter 24h gate for AI/tech', () => {
    const items = [{ title: 'two days old', dateRaw: hoursAgo(48) }];
    expect(filterRecent(items, 24).length).toBe(0);
    expect(filterRecent(items, 72).length).toBe(1);
  });
});

// ── Item 9: LinkedIn why this note ───────────────────────────────────────────
describe('parseLinkedInDraft (Item 9 why this note)', () => {
  it('splits a labelled WHY / NOTE response', () => {
    const raw = 'WHY: He just posted about scaling AI teams, aligns with your CTO path.\nNOTE: Saw your post on scaling AI teams, would love to compare notes.';
    const r = parseLinkedInDraft(raw);
    expect(r.missing).toBe(false);
    expect(r.why).toContain('CTO path');
    expect(r.note).toContain('compare notes');
  });

  it('strips wrapping quotes', () => {
    const r = parseLinkedInDraft('WHY: "reason here"\nNOTE: "message here"');
    expect(r.why).toBe('reason here');
    expect(r.note).toBe('message here');
  });

  it('flags CONTACT_FILE_MISSING', () => {
    expect(parseLinkedInDraft('CONTACT_FILE_MISSING').missing).toBe(true);
    expect(parseLinkedInDraft('"CONTACT_FILE_MISSING"').missing).toBe(true);
  });

  it('treats an unlabelled response as a bare note, rationale absent', () => {
    const r = parseLinkedInDraft('Just a plain message with no labels.');
    expect(r.missing).toBe(false);
    expect(r.why).toBe('');
    expect(r.note).toBe('Just a plain message with no labels.');
  });

  it('handles empty input', () => {
    const r = parseLinkedInDraft('');
    expect(r.why).toBe('');
    expect(r.note).toBe('');
    expect(r.missing).toBe(false);
  });
});

// ── Item 6: non-green status normalization ──────────────────────────────────
describe('formatNonGreenStatus (Item 6 non-green reporting)', () => {
  const BANNED = [
    /will fix/i,
    /next action:\s*(heal|fix|rerun|restart|refresh|build)/i,
  ];
  const assertNoFutureRepair = (lines: string[]) => {
    const joined = lines.join('\n');
    for (const re of BANNED) expect(joined).not.toMatch(re);
  };

  it('answer (1): heal attempted, still not green, names the human ask', () => {
    const healResults = {
      available: true,
      heals: [{ target: 'ec2', action: 'restarted pm2', outcome: 'ok' }],
      healed: [],
    };
    const lines = formatNonGreenStatus(
      { name: 'ec2', status: 'red', detail: 'curl failed', lukeAction: 'confirm the instance is running' },
      healResults,
      false,
    );
    expect(lines.join('\n')).toMatch(/tried to self-heal/i);
    expect(lines.join('\n')).toMatch(/what I need from you/i);
    assertNoFutureRepair(lines);
  });

  it('answer (3): heal ran and broke, explains how', () => {
    const healResults = {
      available: true,
      heals: [{ target: 'llm', action: 'restarted proxy', outcome: 'failed', error: 'port already bound' }],
      healed: [],
    };
    const lines = formatNonGreenStatus(
      { name: 'llm', status: 'red', detail: 'proxy down' },
      healResults,
      false,
    );
    expect(lines.join('\n')).toMatch(/self-heal ran and broke/i);
    expect(lines.join('\n')).toMatch(/how it broke/i);
    expect(lines.join('\n')).toMatch(/port already bound/);
    assertNoFutureRepair(lines);
  });

  it('answer (2): overnight, no heal logged, gives a proposal not a promise', () => {
    const lines = formatNonGreenStatus(
      { name: 'backups', status: 'red', detail: 'S3 list failed' },
      { available: false, heals: [], healed: [] },
      true,
    );
    expect(lines.join('\n')).toMatch(/what I propose/i);
    assertNoFutureRepair(lines);
  });

  it('healed-overnight probe records HOW it recovered', () => {
    const healResults = {
      available: true,
      heals: [],
      healed: [{ probe: 'ec2', healAction: 'restarted the instance' }],
    };
    const lines = formatNonGreenStatus(
      { name: 'ec2', status: 'green', detail: 'ok' },
      healResults,
      false,
    );
    expect(lines.join('\n')).toMatch(/self-heal recovered it/i);
    assertNoFutureRepair(lines);
  });
});

describe('collectBriefingDefects (Item 6 first card)', () => {
  it('lists non-green health probes', () => {
    const defects = collectBriefingDefects({
      health: {
        ec2: { status: 'red', detail: 'down' },
        backups: { status: 'green', detail: 'ok' },
        tests: { status: 'unknown', detail: 'skipped' },
      },
      linkedIn: { available: true, staleness: 'fresh', picks: [] },
    });
    expect(defects.some((d: string) => d.includes('ec2'))).toBe(true);
    expect(defects.some((d: string) => d.includes('tests'))).toBe(true);
    expect(defects.some((d: string) => d.includes('backups'))).toBe(false);
  });

  it('flags an unavailable LinkedIn section', () => {
    const defects = collectBriefingDefects({
      health: {},
      linkedIn: { available: false, reason: 'linkedin-intel.json missing' },
    });
    expect(defects.some((d: string) => /LinkedIn.*unavailable/i.test(d))).toBe(true);
  });

  it('flags reach-outs that lost the why-this-note rationale', () => {
    const defects = collectBriefingDefects({
      health: {},
      linkedIn: {
        available: true,
        staleness: 'fresh',
        picks: [{ contactFileFound: true, why: '(rationale unavailable)' }],
      },
    });
    expect(defects.some((d: string) => /why this note/i.test(d))).toBe(true);
  });

  it('returns empty when everything is clean', () => {
    const defects = collectBriefingDefects({
      health: { ec2: { status: 'green', detail: 'ok' } },
      linkedIn: { available: true, staleness: 'fresh', picks: [{ contactFileFound: true, why: 'good reason' }] },
    });
    expect(defects.length).toBe(0);
  });
});

// ── SPINE: Task Spine grouping ──────────────────────────────────────────────
describe('groupTasksByStatus (Task Spine)', () => {
  it('buckets tasks by status', () => {
    const tasks = [
      { id: 'a', status: 'queued', createdAt: '2026-05-17T01:00:00Z' },
      { id: 'b', status: 'running', createdAt: '2026-05-17T02:00:00Z' },
      { id: 'c', status: 'awaiting-review', createdAt: '2026-05-17T03:00:00Z' },
      { id: 'd', status: 'done', createdAt: '2026-05-17T00:00:00Z' },
      { id: 'e', status: 'failed', createdAt: '2026-05-17T04:00:00Z' },
      { id: 'f', status: 'cancelled', createdAt: '2026-05-17T05:00:00Z' },
    ];
    const g = groupTasksByStatus(tasks);
    expect(g.queued.map((t: any) => t.id)).toEqual(['a']);
    expect(g.running.map((t: any) => t.id)).toEqual(['b']);
    expect(g['awaiting-review'].map((t: any) => t.id)).toEqual(['c']);
    expect(g.done.map((t: any) => t.id)).toEqual(['d']);
    expect(g.failed.map((t: any) => t.id)).toEqual(['e']);
    expect(g.cancelled.map((t: any) => t.id)).toEqual(['f']);
  });

  it('sorts each bucket newest-first by createdAt', () => {
    const tasks = [
      { id: 'old', status: 'running', createdAt: '2026-05-17T01:00:00Z' },
      { id: 'new', status: 'running', createdAt: '2026-05-17T09:00:00Z' },
      { id: 'mid', status: 'running', createdAt: '2026-05-17T05:00:00Z' },
    ];
    expect(groupTasksByStatus(tasks).running.map((t: any) => t.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('routes an unknown status into the unknown bucket', () => {
    const g = groupTasksByStatus([{ id: 'x', status: 'weird' }]);
    expect(g.unknown.map((t: any) => t.id)).toEqual(['x']);
  });

  it('handles an empty or missing task list', () => {
    expect(groupTasksByStatus([]).running.length).toBe(0);
    expect(groupTasksByStatus(undefined as any).queued.length).toBe(0);
  });
});
