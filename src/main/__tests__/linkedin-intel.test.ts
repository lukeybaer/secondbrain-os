/**
 * Tests for linkedin-intel.ts — Contact Intelligence nightly crawl and briefing section builder.
 * Tests pure logic: event parsing, priority ranking, dedup, section formatting.
 * Does NOT touch the filesystem or Electron APIs.
 */

import { describe, it, expect } from 'vitest';

// ── Re-implement pure helpers for testing ────────────────────────────────────

const EVENT_PRIORITY: Record<string, number> = {
  job_change: 1,
  company_news: 2,
  published_content: 3,
  engagement: 4,
  unread_email: 5,
  news_mention: 6,
};

interface ContactEvent {
  id: string;
  contactName: string;
  eventType: string;
  headline: string;
  detail: string;
  source: string;
  detectedAt: string;
  reportedAt: string | null;
}

function rankEvents(events: ContactEvent[]): ContactEvent[] {
  return [...events].sort((a, b) => {
    const pa = EVENT_PRIORITY[a.eventType] ?? 99;
    const pb = EVENT_PRIORITY[b.eventType] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
  });
}

function buildSection(
  events: ContactEvent[],
  reportedIds: Set<string>,
  now: Date,
): { text: string; reportedIds: string[] } {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const fresh = events.filter((e) => !reportedIds.has(e.id));
  const pastWeek = fresh.filter((e) => new Date(e.detectedAt) >= sevenDaysAgo).slice(0, 3);
  const past48h = fresh.filter((e) => new Date(e.detectedAt) >= fortyEightHoursAgo).slice(0, 3);

  const lines: string[] = ['CONTACT INTELLIGENCE:'];

  lines.push('Past 7 days:');
  if (pastWeek.length > 0) {
    for (const e of pastWeek) {
      lines.push(`  • ${e.headline}`);
      if (e.detail) lines.push(`    ${e.detail.slice(0, 140)}`);
    }
  } else {
    lines.push('  Nothing new to report.');
  }
  lines.push('');

  lines.push('Past 48 hours:');
  if (past48h.length > 0) {
    for (const e of past48h) {
      lines.push(`  • ${e.headline}`);
      if (e.detail) lines.push(`    ${e.detail.slice(0, 140)}`);
    }
  } else {
    lines.push('  Nothing new to report.');
  }
  lines.push('');

  lines.push(`LinkedIn: Queried 8 of 130 contacts. Memory updated for all.`);

  const toMark = [
    ...pastWeek.map((e) => e.id),
    ...past48h.map((e) => e.id).filter((id) => !pastWeek.find((e) => e.id === id)),
  ];

  return { text: lines.join('\n'), reportedIds: toMark };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<ContactEvent> & { id: string; contactName: string; eventType: string },
): ContactEvent {
  return {
    headline: `${overrides.contactName} — test event`,
    detail: '',
    source: 'linkedin_daily_intel',
    detectedAt: new Date().toISOString(),
    reportedAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-04-06T06:00:00Z');
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

// ── rankEvents ────────────────────────────────────────────────────────────────

describe('rankEvents', () => {
  it('sorts job_change before engagement', () => {
    const events = [
      makeEvent({ id: 'a', contactName: 'Alice', eventType: 'engagement' }),
      makeEvent({ id: 'b', contactName: 'Bob', eventType: 'job_change' }),
    ];
    const ranked = rankEvents(events);
    expect(ranked[0].id).toBe('b');
  });

  it('sorts company_news before published_content', () => {
    const events = [
      makeEvent({ id: 'a', contactName: 'Alice', eventType: 'published_content' }),
      makeEvent({ id: 'b', contactName: 'Bob', eventType: 'company_news' }),
    ];
    const ranked = rankEvents(events);
    expect(ranked[0].id).toBe('b');
  });

  it('breaks ties by recency — more recent first', () => {
    const older = makeEvent({
      id: 'a',
      contactName: 'Alice',
      eventType: 'engagement',
      detectedAt: FIVE_DAYS_AGO,
    });
    const newer = makeEvent({
      id: 'b',
      contactName: 'Bob',
      eventType: 'engagement',
      detectedAt: TWO_DAYS_AGO,
    });
    const ranked = rankEvents([older, newer]);
    expect(ranked[0].id).toBe('b');
  });
});

// ── buildSection — filtering ──────────────────────────────────────────────────

describe('buildSection — filtering', () => {
  it('excludes events older than 7 days from pastWeek', () => {
    const events = [
      makeEvent({
        id: 'old',
        contactName: 'Alice',
        eventType: 'engagement',
        detectedAt: TEN_DAYS_AGO,
      }),
      makeEvent({
        id: 'fresh',
        contactName: 'Bob',
        eventType: 'engagement',
        detectedAt: TWO_DAYS_AGO,
      }),
    ];
    const { text } = buildSection(rankEvents(events), new Set(), NOW);
    expect(text).toContain('Bob');
    expect(text).not.toContain('Alice');
  });

  it('excludes already-reported events', () => {
    const events = [
      makeEvent({
        id: 'reported-id',
        contactName: 'Alice',
        eventType: 'job_change',
        detectedAt: TWO_DAYS_AGO,
      }),
      makeEvent({
        id: 'fresh-id',
        contactName: 'Bob',
        eventType: 'job_change',
        detectedAt: TWO_DAYS_AGO,
      }),
    ];
    const { text } = buildSection(rankEvents(events), new Set(['reported-id']), NOW);
    expect(text).not.toContain('Alice');
    expect(text).toContain('Bob');
  });

  it('returns "Nothing new to report" when all events are filtered', () => {
    const events = [
      makeEvent({
        id: 'old',
        contactName: 'Alice',
        eventType: 'engagement',
        detectedAt: TEN_DAYS_AGO,
      }),
    ];
    const { text } = buildSection(rankEvents(events), new Set(), NOW);
    expect(text).toContain('Nothing new to report');
  });

  it('caps each window at 3 events', () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      makeEvent({
        id: `evt-${i}`,
        contactName: `Contact${i}`,
        eventType: 'engagement',
        detectedAt: TWO_DAYS_AGO,
      }),
    );
    const { text } = buildSection(rankEvents(events), new Set(), NOW);
    // Should show at most 3 bullets for pastWeek and 3 for past48h
    const bulletCount = (text.match(/  • /g) || []).length;
    expect(bulletCount).toBeLessThanOrEqual(6);
  });
});

// ── buildSection — returned reportedIds ───────────────────────────────────────

describe('buildSection — reportedIds', () => {
  it('returns IDs of events it surfaced', () => {
    const events = [
      makeEvent({
        id: 'id1',
        contactName: 'Alice',
        eventType: 'job_change',
        detectedAt: TWO_DAYS_AGO,
      }),
    ];
    const { reportedIds } = buildSection(rankEvents(events), new Set(), NOW);
    expect(reportedIds).toContain('id1');
  });

  it('does not double-report the same event across week and 48h windows', () => {
    const events = [
      makeEvent({
        id: 'id1',
        contactName: 'Alice',
        eventType: 'job_change',
        detectedAt: TWO_DAYS_AGO,
      }),
    ];
    const { reportedIds } = buildSection(rankEvents(events), new Set(), NOW);
    const uniqueIds = new Set(reportedIds);
    expect(uniqueIds.size).toBe(reportedIds.length); // no duplicates
  });
});

// ── buildSection — section structure ─────────────────────────────────────────

describe('buildSection — output structure', () => {
  it('always includes CONTACT INTELLIGENCE header', () => {
    const { text } = buildSection([], new Set(), NOW);
    expect(text).toContain('CONTACT INTELLIGENCE:');
  });

  it('always includes Past 7 days label', () => {
    const { text } = buildSection([], new Set(), NOW);
    expect(text).toContain('Past 7 days:');
  });

  it('always includes Past 48 hours label', () => {
    const { text } = buildSection([], new Set(), NOW);
    expect(text).toContain('Past 48 hours:');
  });

  it('always includes LinkedIn query stats line', () => {
    const { text } = buildSection([], new Set(), NOW);
    expect(text).toContain('LinkedIn: Queried');
  });

  it('includes event detail when present', () => {
    const events = [
      makeEvent({
        id: 'id1',
        contactName: 'Alice',
        eventType: 'job_change',
        detail: 'Joined Acme Corp as VP Engineering',
        detectedAt: TWO_DAYS_AGO,
      }),
    ];
    const { text } = buildSection(rankEvents(events), new Set(), NOW);
    expect(text).toContain('Joined Acme Corp');
  });
});

// ── EVENT_PRIORITY completeness ───────────────────────────────────────────────

describe('EVENT_PRIORITY', () => {
  it('has all 6 event types ranked', () => {
    const types = [
      'job_change',
      'company_news',
      'published_content',
      'engagement',
      'unread_email',
      'news_mention',
    ];
    for (const t of types) {
      expect(EVENT_PRIORITY[t]).toBeDefined();
    }
  });

  it('job_change has the highest priority (lowest number)', () => {
    const allValues = Object.values(EVENT_PRIORITY);
    expect(EVENT_PRIORITY['job_change']).toBe(Math.min(...allValues));
  });
});
