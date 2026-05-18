/**
 * Regression guard: 2026-04-20 — proposals must draw on contact history, not
 * just the LinkedIn bio string.
 *
 * Luke flagged the 2026-04-20 briefing's Friedrich and Adi proposals as
 * "out of touch" because they read like the generator had never met either
 * person. Root cause: getLinkedInIntel() in manual-briefing-v3.js built its
 * prompt from (contactName + cleanedDetail from the scraper) only, with no
 * call to load secondbrain/memory/contacts/<slug>.md. Bio-derived strings
 * like "Occasionally Flying Planes" and "Data Science @ Meta" were the only
 * signal reaching the LLM.
 *
 * Memory: secondbrain/memory/feedback_proposals_must_use_contact_history.md
 *
 * This test locks in:
 *   1. getLinkedInIntel loads each contact file before drafting
 *   2. The prompt has a RELATIONSHIP CONTEXT block with History + Goal
 *      Overlaps + Open Threads
 *   3. The prompt instructs the model to ground in contact context FIRST and
 *      only reference the post if it connects naturally
 *   4. A missing contact file surfaces as an enrichment task instead of a
 *      generic draft (the draft line must say enrich, not pretend)
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js proposals ground in contact history (2026-04-20)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('loads the contact file for each LinkedIn candidate before drafting', () => {
    expect(src).toContain('loadContactContext');
    expect(src).toMatch(/const\s+CONTACTS_DIR\s*=\s*path\.join\([^)]*'memory',\s*'contacts'\)/);
    expect(src).toMatch(/readdirSync\(CONTACTS_DIR\)/);
  });

  it('extracts History, Goal Overlaps and Open Threads sections from contact file', () => {
    expect(src).toContain("section('History')");
    expect(src).toMatch(/section\('Goal Overlaps'\)|section\('Overlaps'\)/);
    expect(src).toMatch(/section\('Open Threads'\)|section\('Threads'\)/);
  });

  it('prompt has a RELATIONSHIP CONTEXT block above the post excerpt', () => {
    expect(src).toContain('RELATIONSHIP CONTEXT');
    // RELATIONSHIP CONTEXT must appear BEFORE the post excerpt in the prompt.
    const relIdx = src.indexOf('RELATIONSHIP CONTEXT');
    const postIdx = src.indexOf('Recent LinkedIn post');
    expect(relIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(-1);
    expect(relIdx).toBeLessThan(postIdx);
  });

  it('instructs model to ground in context FIRST, post only if it connects', () => {
    expect(src).toMatch(/RELATIONSHIP CONTEXT first/i);
    expect(src).toMatch(/only mention the LinkedIn post if it connects naturally/i);
  });

  it('handles missing contact file as enrichment task not generic draft', () => {
    expect(src).toContain('CONTACT_FILE_MISSING');
    expect(src).toMatch(/contact file missing/i);
    expect(src).toMatch(/enrich/i);
  });

  it('acknowledges dormancy instead of faking continuity', () => {
    expect(src).toMatch(/dormant|acknowledge the gap/i);
  });
});
