/**
 * Regression guard: 2026-04-16 Luke-requested briefing reshape.
 *
 * 1. Drop INNER CIRCLE "5+ days since last logged activity" block — not helpful.
 * 2. Drop COMMUNICATIONS SUMMARY (exec-level) — no signal over §6 action items.
 * 3. LinkedIn section must be drafted reach-outs capped at 5 per contact dedupe.
 * 4. Upload queue must flag stale (>=3d) items so a silent pipeline fails loud.
 * 5. Reputation scan must actively query Google News with negative-sentiment
 *    terms, not rely on a non-existent reputation-mentions.jsonl.
 *
 * Pure string checks on the script source so the test runs fast and requires
 * no live dependencies.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js section reshape (2026-04-16)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('does not emit an "INNER CIRCLE" neglect block', () => {
    expect(src).not.toMatch(/INNER CIRCLE.*5\+ days/);
    expect(src).not.toMatch(/None neglected/);
  });

  it('does not emit a "COMMUNICATIONS SUMMARY" block', () => {
    expect(src).not.toMatch(/COMMUNICATIONS SUMMARY/);
    expect(src).not.toMatch(/NEEDS ATTENTION:/);
  });

  it('LinkedIn section surfaces drafted strategic reach-outs, not raw events', () => {
    expect(src).toMatch(/LINKEDIN .* REACH-OUTS/);
    expect(src).toContain('draft: ');
    // Old per-event dump shape must be gone.
    expect(src).not.toMatch(/for \(const ev of linkedIn\.events\.slice\(0, 10\)\)/);
  });

  it('content pipeline flags stale upload queue items', () => {
    expect(src).toContain('staleCount');
    expect(src).toContain('oldestAgeDays');
    expect(src).toMatch(/upload queue item\(s\) stuck/);
  });

  it('reputation scan actively queries google news with negative terms', () => {
    expect(src).toContain('REPUTATION RISK SCAN');
    expect(src).toContain('REP_NEG_TERMS');
    expect(src).toContain('REP_TARGETS');
    // Must include at least a handful of canonical negative cues.
    for (const term of ['lawsuit', 'fraud', 'scandal', 'investigation', 'breach']) {
      expect(src).toContain(term);
    }
    // Must list at least 4 reputation targets in the REP_TARGETS array. We
    // don't assert the literal names here so the public-sync PII scan stays
    // clean; the script itself holds the canonical list.
    const m = src.match(/const REP_TARGETS = \[([^\]]+)\]/);
    expect(m, 'REP_TARGETS array must be declared').toBeTruthy();
    const items = (m![1].match(/'[^']+'/g) || []).length;
    expect(items).toBeGreaterThanOrEqual(4);
  });
});
