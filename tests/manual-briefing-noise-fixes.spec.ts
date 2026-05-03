/**
 * Regression guard: 2026-04-17 owner-requested noise fixes.
 *
 * 1. ProjectC invoice section must be DROPPED (not shown as raw error text)
 *    when the DDB scan fails. A raw "DDB scan failed: ..." line is briefing
 *    noise the owner does not understand.
 * 2. News articles where the LLM returned a refusal sentinel ("I cannot write
 *    this summary" etc.) must be dropped entirely -- headlines without real
 *    summaries are useless.
 * 3. Feature backlog must split into Video pipeline vs Amy / EA agent groups
 *    and rank each group against its own kind. Mixing the two produces a
 *    meaningless global ranking across incomparable categories.
 *
 * Pure string checks on the script source so the test runs fast and needs
 * no live dependencies.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js noise fixes (2026-04-17)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('drops the ProjectC invoice section entirely when DDB scan fails', () => {
    // Old behaviour unconditionally pushed the header and then the raw error.
    expect(src).not.toMatch(/msg4Parts\.push\('PROJECTC INVOICE ACTIVITY[^)]*\);\s*\n\s*if \(snack\.error\)/);
    // New behaviour guards the whole block behind !snack.error.
    expect(src).toMatch(/if \(!snack\.error\)/);
    expect(src).not.toContain("'  DDB scan failed: '");
  });

  it('returns null for LLM refusal sentinels so the article is dropped', () => {
    expect(src).toContain('refusalPatterns');
    // A representative subset of sentinels must be guarded.
    for (const s of [
      'i cannot write',
      'article content is not provided',
      'article content provided contains only',
      'article content provided is truncated',
    ]) {
      expect(src).toContain(s);
    }
    // Must return null, not a placeholder string, so the existing null filter
    // at the render site drops the item cleanly.
    expect(src).toMatch(/refusalPatterns\.some[^;]+return null/);
  });

  it('feature backlog splits into Video pipeline and Amy / EA agent groups', () => {
    expect(src).toContain("f.category === 'video-pipeline'");
    expect(src).toContain("'Video pipeline'");
    expect(src).toContain("'Amy / EA agent'");
    // Each group is sorted by score independently.
    expect(src).toContain('videoFeatures.sort');
    expect(src).toContain('amyFeatures.sort');
  });
});
