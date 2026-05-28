/**
 * Tests for scripts/skill-metrics-rollup.js: produces per-skill quality
 * metrics in the shape that check-harness-regressions.js expects.
 *
 * Frugal: isolated tmp dir, no real artifacts touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFresh() {
  const p = require.resolve('../../../scripts/skill-metrics-rollup.js');
  delete require.cache[p];
  return require('../../../scripts/skill-metrics-rollup.js');
}

function mkdirp(p: string) { fs.mkdirSync(p, { recursive: true }); }

function writeFile(p: string, body: string) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body);
}

function setMtime(p: string, hoursAgo: number) {
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000);
  fs.utimesSync(p, t, t);
}

describe('skill-metrics-rollup', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-metrics-rollup-'));
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rollupAll returns an entry for every priority skill even when artifacts are absent', () => {
    const out = mod.rollupAll();
    for (const skill of ['video-aurora', 'captions-aurora', 'thumbnail-aurora', 'daily-briefing', 'daily-linkedin-scan']) {
      expect(out[skill]).toBeDefined();
      expect(typeof out[skill].quality).toBe('number');
    }
  });

  it('video-aurora quality reflects publishedCount24h minus rejectionsCount24h', () => {
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
      const f = path.join(tmpRoot, 'content-review', 'published', name);
      writeFile(f, 'x');
      setMtime(f, 2); // 2h ago, within 24h
    }
    const rej = path.join(tmpRoot, 'content-review', 'rejections.jsonl');
    writeFile(rej, JSON.stringify({ timestamp: new Date().toISOString(), video: 'd', reason: 'blank' }) + '\n');
    const out = mod.rollupAll();
    expect(out['video-aurora'].publishedCount24h).toBe(3);
    expect(out['video-aurora'].rejectionsCount24h).toBe(1);
    expect(out['video-aurora'].approvalRate).toBeCloseTo(3 / 4, 5);
  });

  it('daily-briefing detects todays briefing existence and counts blockers', () => {
    const today = new Date().toISOString().slice(0, 10);
    const briefing = path.join(tmpRoot, 'data', 'briefings', `briefing-${today}.md`);
    writeFile(briefing, [
      `Good morning Luke -- ${today}`,
      'BLOCKERS / NEEDS FROM LUKE:',
      '  1. LinkedIn auth',
      '  2. Snack Dude AWS',
      '',
      'OK section here',
    ].join('\n'));
    const out = mod.rollupAll();
    expect(out['daily-briefing'].briefingExists).toBe(1);
    expect(out['daily-briefing'].blockersCount).toBe(2);
    expect(out['daily-briefing'].quality).toBeGreaterThan(0);
  });

  it('daily-briefing quality drops when briefing is missing entirely', () => {
    const out = mod.rollupAll();
    expect(out['daily-briefing'].briefingExists).toBe(0);
    expect(out['daily-briefing'].quality).toBe(0);
  });

  it('daily-linkedin-scan reads contacts count and scanSuccess from snapshot file when present', () => {
    const snap = path.join(tmpRoot, 'data', 'agent', 'linkedin-scan-summary.json');
    writeFile(snap, JSON.stringify({
      lastRunAt: new Date().toISOString(),
      success: true,
      contactsScraped: 95,
    }));
    const out = mod.rollupAll();
    expect(out['daily-linkedin-scan'].scanSuccess).toBe(1);
    expect(out['daily-linkedin-scan'].contactsScraped).toBe(95);
    expect(out['daily-linkedin-scan'].quality).toBeGreaterThan(50);
  });

  it('daily-linkedin-scan flags failure when no recent scan exists', () => {
    const out = mod.rollupAll();
    expect(out['daily-linkedin-scan'].scanSuccess).toBe(0);
    expect(out['daily-linkedin-scan'].quality).toBeLessThan(40);
  });

  it('thumbnail-aurora counts _thumb.jpg files in last 24h', () => {
    for (const name of ['a_thumb.jpg', 'b_thumb.jpg']) {
      const f = path.join(tmpRoot, 'content-review', 'published', name);
      writeFile(f, 'x');
      setMtime(f, 1);
    }
    const out = mod.rollupAll();
    expect(out['thumbnail-aurora'].thumbCount24h).toBe(2);
  });

  it('writeMetricsFile produces a JSON usable by check-harness-regressions', () => {
    const file = mod.writeMetricsFile();
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data['video-aurora']).toBeDefined();
    expect(typeof data['video-aurora'].quality).toBe('number');
  });

  it('only counts files within the last 24h window', () => {
    const recent = path.join(tmpRoot, 'content-review', 'published', 'fresh.mp4');
    writeFile(recent, 'x');
    setMtime(recent, 2);
    const stale = path.join(tmpRoot, 'content-review', 'published', 'stale.mp4');
    writeFile(stale, 'x');
    setMtime(stale, 48);
    const out = mod.rollupAll();
    expect(out['video-aurora'].publishedCount24h).toBe(1);
  });
});
