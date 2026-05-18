/**
 * Tests for the briefing parser. Exercises:
 *  - Section header detection (uppercase with colon, em-dash variants)
 *  - Greeting + metadata extraction
 *  - 3-day retention pruning (date-based, not mtime-based)
 *
 * The briefing dashboard depends on correct parsing; a drift here means
 * right-click dispatch (feedback_amy_email_dispatch_convention.md) would
 * target the wrong section text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseBriefing, pruneOldBriefings, listBriefingFiles } from '../briefing-parser';

const SAMPLE = `Good morning Luke -- Monday, April 20, 2026
Daily Executive Briefing
Generated: 2026-04-20T10:46:12.862Z
LLM: claude-haiku-4-5 via Claude Max plan (claude CLI subprocess)

---

ACTION ITEMS -- unanswered asks (verified by reading each thread):
1. Progressive -- eSign required
2. NM State Tax -- $67 owed

OPEN COMMITMENTS -- you promised but have not done:
- Follow up with Wendi Till
- Send proof of insurance to FNBET

FEATURE BACKLOG (10 items, updated 2026-04-20 00:00Z):
  Video pipeline (5):
    1. [76] Multi-shot B-roll composition

SYSTEM HEALTH:
  Backups: ok
  EC2: ok
`;

describe('briefing-parser', () => {
  it('extracts generatedAt and llm from header', () => {
    const p = parseBriefing(SAMPLE, '2026-04-20', 'briefing-2026-04-20.md');
    expect(p.generatedAt).toBe('2026-04-20T10:46:12.862Z');
    expect(p.llm).toContain('claude-haiku-4-5');
  });

  it('detects the 4 expected uppercase-header sections', () => {
    const p = parseBriefing(SAMPLE, '2026-04-20', 'briefing-2026-04-20.md');
    const titles = p.sections.map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ACTION ITEMS'),
        expect.stringContaining('OPEN COMMITMENTS'),
        expect.stringContaining('FEATURE BACKLOG'),
        expect.stringContaining('SYSTEM HEALTH'),
      ]),
    );
    expect(p.sections.length).toBeGreaterThanOrEqual(4);
  });

  it('each section body contains its own content', () => {
    const p = parseBriefing(SAMPLE, '2026-04-20', 'briefing-2026-04-20.md');
    const action = p.sections.find((s) => /ACTION ITEMS/.test(s.title));
    expect(action).toBeDefined();
    expect(action!.body).toContain('Progressive');
    expect(action!.body).toContain('NM State Tax');

    const health = p.sections.find((s) => /SYSTEM HEALTH/.test(s.title));
    expect(health).toBeDefined();
    expect(health!.body).toContain('Backups');
  });

  it('preserves raw markdown unchanged', () => {
    const p = parseBriefing(SAMPLE, '2026-04-20', 'briefing-2026-04-20.md');
    expect(p.raw).toBe(SAMPLE);
  });
});

describe('pruneOldBriefings 3-day retention', () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-prune-test-'));
    fs.mkdirSync(path.join(tmpRoot, 'data', 'briefings'), { recursive: true });
    originalCwd = process.env.SECONDBRAIN_ROOT || '';
    process.env.SECONDBRAIN_ROOT = tmpRoot;
  });

  afterEach(() => {
    if (originalCwd) process.env.SECONDBRAIN_ROOT = originalCwd;
    else delete process.env.SECONDBRAIN_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeBriefing(date: string): void {
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'briefings', `briefing-${date}.md`),
      `stub briefing for ${date}`,
    );
  }

  it('keeps last 3 days, deletes older', () => {
    writeBriefing('2026-04-15');
    writeBriefing('2026-04-16');
    writeBriefing('2026-04-17');
    writeBriefing('2026-04-18');
    writeBriefing('2026-04-19');
    writeBriefing('2026-04-20');

    const now = new Date('2026-04-20T12:00:00');
    const r = pruneOldBriefings(3, now);

    expect(r.kept.sort()).toEqual([
      'briefing-2026-04-18.md',
      'briefing-2026-04-19.md',
      'briefing-2026-04-20.md',
    ]);
    expect(r.deleted.sort()).toEqual([
      'briefing-2026-04-15.md',
      'briefing-2026-04-16.md',
      'briefing-2026-04-17.md',
    ]);
    const remaining = listBriefingFiles().map((f) => f.filename);
    expect(remaining.sort()).toEqual([
      'briefing-2026-04-18.md',
      'briefing-2026-04-19.md',
      'briefing-2026-04-20.md',
    ]);
  });

  it('no-op when all briefings are fresh', () => {
    writeBriefing('2026-04-18');
    writeBriefing('2026-04-19');
    writeBriefing('2026-04-20');
    const now = new Date('2026-04-20T12:00:00');
    const r = pruneOldBriefings(3, now);
    expect(r.kept.length).toBe(3);
    expect(r.deleted.length).toBe(0);
  });

  it('does not match files that are not briefing-YYYY-MM-DD.md', () => {
    writeBriefing('2026-04-20');
    fs.writeFileSync(path.join(tmpRoot, 'data', 'briefings', 'notes.md'), 'random file');
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'briefings', 'briefing-monday.md'),
      'malformed name',
    );
    const now = new Date('2026-04-20T12:00:00');
    const r = pruneOldBriefings(3, now);
    expect(r.deleted.length).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, 'data', 'briefings', 'notes.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'data', 'briefings', 'briefing-monday.md'))).toBe(true);
  });
});
