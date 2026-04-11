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
