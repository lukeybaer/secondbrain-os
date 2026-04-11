/**
 * Regression guard for 2026-04-11 #gap: the daily briefing silently did not
 * appear on Luke's desktop because no local scheduled task existed for it and
 * the EC2 path was unreachable. Prevention is layered:
 *   1. daily-briefing scheduled task (scheduled-tasks.json) — fires 5:30 AM CT
 *   2. manual-briefing-v3.js now writes both .md and .docx to the Desktop
 *   3. THIS test — asserts the briefing script is wired to produce both file
 *      types and that today's artifacts exist when run locally in CI
 *
 * This test is deliberately shallow: it asserts wiring, not content. Content
 * quality is covered by briefing-no-groq.test.ts and manual-briefing.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'manual-briefing-v3.js');
const DOCX_SCRIPT = join(REPO_ROOT, 'scripts', 'briefing-to-docx.py');

const todayIso = new Date().toISOString().slice(0, 10);
const desktopMd = join(homedir(), 'Desktop', `briefing-${todayIso}.md`);
const desktopDocx = join(homedir(), 'Desktop', `briefing-${todayIso}.docx`);

describe('briefing output wiring', () => {
  it('manual-briefing-v3.js exists and writes to Desktop', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('C:/Users/luked/Desktop/briefing-');
    expect(src).toContain('secondbrain/data/briefings/briefing-');
  });

  it('manual-briefing-v3.js invokes briefing-to-docx.py (docx delivery)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('briefing-to-docx.py');
    expect(src).toContain('.docx');
  });

  it('briefing-to-docx.py exists in scripts dir', () => {
    expect(existsSync(DOCX_SCRIPT)).toBe(true);
  });

  // 2026-04-11 #gap round 2: the briefing silently omitted section 10
  // "Overnight agent activity" from project_briefing_spec.md. The
  // manual-briefing-v3.js script had no code reading nightly-enhancements.jsonl
  // at all. These assertions lock the section in place.
  it('manual-briefing-v3.js has an overnight enhancements section', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('getOvernightEnhancements');
    expect(src).toContain('nightly-enhancements.jsonl');
    expect(src).toContain('OVERNIGHT ENHANCEMENTS');
  });

  it('latest briefing .md on disk contains OVERNIGHT ENHANCEMENTS header', () => {
    const briefingsDir = join(REPO_ROOT, 'data', 'briefings');
    if (!existsSync(briefingsDir)) return; // dev machine without generated briefing
    const latest = join(briefingsDir, `briefing-${todayIso}.md`);
    if (!existsSync(latest)) return; // briefing not yet generated today
    const content = readFileSync(latest, 'utf8');
    expect(content).toContain('OVERNIGHT ENHANCEMENTS');
  });

  // 2026-04-11 #gap round 3: the briefing silently omitted FOUR spec sections
  // (7 LinkedIn, 8 Communications, 11 Reputation, 13 Weekly Sermon Saturdays).
  // These assertions lock every numbered section from project_briefing_spec.md
  // in place. When a new section is added to the spec, add it here too.
  //
  // Spec sections 1-6, 9, 12 use headers from other parts of the script
  // (Good morning / NEWS / ONITY / ACTION ITEMS / SNACK DUDE / SYSTEM HEALTH)
  // which are already implicitly covered by the news and Snack Dude tests
  // elsewhere. Sections 7, 8, 10, 11, 13 are the ones that regressed.
  const SPEC_SECTIONS = [
    { n: 7, header: 'LINKEDIN NETWORK INTELLIGENCE', fn: 'getLinkedInIntel' },
    { n: 8, header: 'COMMUNICATIONS SUMMARY', fn: 'getCommunicationsSummary' },
    { n: 10, header: 'OVERNIGHT ENHANCEMENTS', fn: 'getOvernightEnhancements' },
    { n: 11, header: 'REPUTATION MENTIONS', fn: 'getReputationMentions' },
    { n: 13, header: 'WEEKLY SERMON BRIEFING', fn: 'getWeeklySermonBriefing' },
  ];

  for (const sec of SPEC_SECTIONS) {
    it(`manual-briefing-v3.js implements spec section ${sec.n} (${sec.header})`, () => {
      const src = readFileSync(SCRIPT, 'utf8');
      expect(src).toContain(sec.fn);
      expect(src).toContain(sec.header);
    });
  }

  // Saturday-only contract: when today is Saturday, the disk briefing must
  // contain the sermon section. On non-Saturdays it must NOT contain the
  // section header (so it's a real conditional, not a literal string).
  it('briefing sermon section fires on Saturdays only', () => {
    const briefingsDir = join(REPO_ROOT, 'data', 'briefings');
    if (!existsSync(briefingsDir)) return;
    const latest = join(briefingsDir, `briefing-${todayIso}.md`);
    if (!existsSync(latest)) return;
    const content = readFileSync(latest, 'utf8');
    const isSaturday = new Date().getDay() === 6;
    if (isSaturday) {
      expect(content).toContain('WEEKLY SERMON BRIEFING');
    } else {
      expect(content).not.toContain('WEEKLY SERMON BRIEFING');
    }
  });

  // 2026-04-11 #gap round 4: news sections were above personal/ops, contrary
  // to Luke's preference. Reorder locked: ACTION ITEMS must appear before
  // AI & TECH NEWS, and news blocks must appear after REPUTATION MENTIONS.
  it('briefing ships personal/ops sections before news blocks', () => {
    const briefingsDir = join(REPO_ROOT, 'data', 'briefings');
    if (!existsSync(briefingsDir)) return;
    const latest = join(briefingsDir, `briefing-${todayIso}.md`);
    if (!existsSync(latest)) return;
    const content = readFileSync(latest, 'utf8');
    const actionIdx = content.indexOf('ACTION ITEMS');
    const reputationIdx = content.indexOf('REPUTATION MENTIONS');
    const techIdx = content.indexOf('AI & TECH NEWS');
    const worldIdx = content.indexOf('WORLD NEWS');
    expect(actionIdx).toBeGreaterThan(-1);
    expect(techIdx).toBeGreaterThan(-1);
    expect(worldIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeLessThan(techIdx);
    expect(reputationIdx).toBeLessThan(techIdx);
    expect(reputationIdx).toBeLessThan(worldIdx);
  });

  it('manual-briefing-v3.js wires a self-heal for stale overnight jsonl', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('triggerOvernightSelfHeal');
    expect(src).toContain('selfheal-');
    expect(src).toContain('detached');
  });

  it('claude-proxy-supervisor.js exists and start-claude-proxy.vbs invokes it', () => {
    const supervisorPath = join(REPO_ROOT, 'scripts', 'claude-proxy-supervisor.js');
    expect(existsSync(supervisorPath)).toBe(true);
    const vbsPath = join(REPO_ROOT, 'start-claude-proxy.vbs');
    if (existsSync(vbsPath)) {
      const vbs = readFileSync(vbsPath, 'utf8');
      expect(vbs).toContain('claude-proxy-supervisor.js');
    }
  });

  // Run-time gate: when CI env var BRIEFING_FRESHNESS_CHECK=1 is set (or run
  // on Luke's PC after the scheduled task fires), the two Desktop artifacts
  // for today's date must exist. Off by default so dev runs aren't red.
  const shouldCheckFreshness =
    process.env.BRIEFING_FRESHNESS_CHECK === '1' || process.env.CLAUDE_DAILY_CHECK === '1';

  it.skipIf(!shouldCheckFreshness)("today's briefing .md exists on the Desktop", () => {
    expect(existsSync(desktopMd)).toBe(true);
    const size = statSync(desktopMd).size;
    expect(size).toBeGreaterThan(5000);
  });

  it.skipIf(!shouldCheckFreshness)("today's briefing .docx exists on the Desktop", () => {
    expect(existsSync(desktopDocx)).toBe(true);
    const size = statSync(desktopDocx).size;
    expect(size).toBeGreaterThan(10000);
  });
});
