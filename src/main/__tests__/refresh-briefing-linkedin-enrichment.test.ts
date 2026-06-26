/**
 * Regression test for refresh-briefing-generated-sections.js LinkedIn enrichment.
 *
 * ExampleCo 2026-05-23 dashboard report: "linkedin is not working it doesn't share
 * context/etc." The dashboard was rendering "Context:" empty and every draft
 * was the same generic "Hi <name>, It has been too long since we connected.
 * You came to mind this week." template.
 *
 * Root cause: refresh-briefing-generated-sections.js renderLinkedInGreenSection
 * emitted only (1) name (2) when: (3) post: lines per pick. The dashboard
 * parser in ec2-server.js parseLinkedInBody expects (a) context: line, (b)
 * draft: line, (c) profile: line, (d) "Why this note" block with four bullets
 * (Their post / Target / Mutual goals / Relationship history). Missing lines
 * trigger the EC2 fallback draft builder which emits the generic template.
 *
 * Locked contract: refresh-briefing-generated-sections.js MUST emit, for every
 * green-section pick with a matching contact file, all four enrichment lines
 * plus the four whyThisNote bullets, derived deterministically from the
 * contact file (no claude required at refresh time).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const enricher = require(path.resolve(__dirname, '../../../scripts/lib/linkedin-pick-enricher.js'));

const SAMPLE_CONTACT_FILE = `---
name: Sample Contact
description: Sample fintech Chief People Officer, ex-tech HR leader, responded to an outreach message
type: user
category: sample-category
linkedin: https://www.linkedin.com/in/sample-contact/
---

## Professional
- **Title**: Chief People Officer at SampleCo
- **Previous**: Head of HR at PriorCo, multi-year tech HR leadership

## What They Post About
- AI and ML transforming HR
- HR process automation
- Data consolidation as prerequisite for AI in HR

## History

- 2026-05-23 (sample bulk-scan): 4 recent post(s) found.
- 2026-04-10: Responded to an outreach about CHRO conversations.
`;

const SAMPLE_EVENT = {
  contactName: 'Sample Contact',
  detectedAt: '2026-05-23T09:42:00.000Z',
  eventType: 'engagement',
  headline: 'Sample Contact reposted a post on People and Talent leadership in fast-growth tech.',
};

describe('linkedin-pick-enricher', () => {
  it('parses contact file frontmatter and sections', () => {
    const parsed = enricher.parseContactFile(SAMPLE_CONTACT_FILE);
    expect(parsed.description).toContain('Sample');
    expect(parsed.linkedin).toBe('https://www.linkedin.com/in/sample-contact/');
    expect(parsed.professional).toContain('Chief People Officer');
    expect(parsed.postsAbout).toContain('HR');
    expect(parsed.history).toContain('outreach');
  });

  it('builds a non-empty context line from contact description and event headline', () => {
    const cf = enricher.parseContactFile(SAMPLE_CONTACT_FILE);
    const ctx = enricher.buildContext(SAMPLE_EVENT, cf);
    expect(ctx).toBeTruthy();
    expect(ctx.length).toBeGreaterThan(20);
    expect(ctx).toContain('Sample');
  });

  it('builds a deterministic non-template draft (never the "too long since" generic)', () => {
    const cf = enricher.parseContactFile(SAMPLE_CONTACT_FILE);
    const draft = enricher.buildDraft(SAMPLE_EVENT, cf);
    expect(draft).toBeTruthy();
    expect(draft.length).toBeGreaterThan(40);
    expect(draft).not.toMatch(/too long since we connected/i);
    expect(draft).not.toMatch(/came to mind this week/i);
    // First name salutation
    expect(draft).toMatch(/^Sample[,\s]/);
  });

  it('builds whyThisNote with four non-empty fields, none containing template placeholder text', () => {
    const cf = enricher.parseContactFile(SAMPLE_CONTACT_FILE);
    const w = enricher.buildWhyThisNote(SAMPLE_EVENT, cf);
    expect(w.theirPost.length).toBeGreaterThan(10);
    expect(w.target.length).toBeGreaterThan(10);
    expect(w.mutualGoals.length).toBeGreaterThan(10);
    expect(w.relationshipHistory.length).toBeGreaterThan(10);
    const all = [w.theirPost, w.target, w.mutualGoals, w.relationshipHistory].join(' ');
    expect(all).not.toMatch(/Contact enriched but/i);
    expect(all).not.toMatch(/not yet generated/i);
    expect(all).not.toMatch(/pending full contact enrichment/i);
  });

  it('emits the canonical line block consumed by ec2-server parseLinkedInBody', () => {
    const cf = enricher.parseContactFile(SAMPLE_CONTACT_FILE);
    const block = enricher.renderPickBlock(1, SAMPLE_EVENT, cf);
    // Must contain all six structural lines the dashboard parser walks.
    expect(block).toMatch(/^\s*1\.\s+Sample Contact/m);
    expect(block).toMatch(/^\s+when:/m);
    expect(block).toMatch(/^\s+post:/m);
    expect(block).toMatch(/^\s+context:/m);
    expect(block).toMatch(/^\s+draft:/m);
    expect(block).toMatch(/^\s+profile:\s*https?:\/\//m);
    expect(block).toMatch(/^\s+Why this note:/m);
    expect(block).toMatch(/^\s+•\s+Their post:/m);
    expect(block).toMatch(/^\s+•\s+Target:/m);
    expect(block).toMatch(/^\s+•\s+Mutual goals:/m);
    expect(block).toMatch(/^\s+•\s+Relationship history:/m);
  });

  it('emits a CONTACT_FILE_MISSING marker when no contact file is provided', () => {
    const block = enricher.renderPickBlock(1, SAMPLE_EVENT, null);
    expect(block).toMatch(/CONTACT_FILE_MISSING/);
    // Even without a contact file we still emit context and draft so the
    // dashboard does not fall back to the generic "too long since" template.
    expect(block).toMatch(/^\s+context:/m);
    expect(block).toMatch(/^\s+draft:/m);
  });
});
