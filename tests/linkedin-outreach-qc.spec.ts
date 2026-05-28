/**
 * Regression guard: every outbound LinkedIn draft must pass the QC gate
 * (length, voice, signal, no fabrication, ask). Same principle as the
 * video QC gate: nothing public ships without rubric approval.
 *
 * Luke 2026-04-28 #learn: "No linkedin reachouts? where's the QC #learn".
 * See feedback_linkedin_outreach_qc.md.
 */

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { qcDraft, BANNED_PHRASES } = require('../scripts/linkedin-outreach-qc.js');

describe('LinkedIn outreach QC', () => {
  const goodDraft = {
    recipient: 'Jane Doe',
    recipientHandle: 'janedoe',
    theirRecentPost: 'Building a Rust HTTP framework that prioritises tail-latency.',
    draftBody: 'Saw your post on Rust tail-latency tradeoffs. Curious -- did you benchmark against tokio with axum, or a custom executor? I shipped something similar last quarter and the executor choice was the load-bearing decision for us.',
    signalRefs: ['post:abc123'],
    ts: '2026-04-28T22:00:00Z',
  };

  it('approves a strong draft tied to a real signal with a real ask', () => {
    const v = qcDraft(goodDraft);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('rejects a draft with banned filler phrases', () => {
    const bad = { ...goodDraft, draftBody: 'I hope this finds you well. Let us circle back about synergy?' };
    const v = qcDraft(bad);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f: any) => f.rule === 'voice')).toBe(true);
  });

  it('rejects a draft with no signal reference', () => {
    const bad = { ...goodDraft, signalRefs: [], theirRecentPost: '' };
    const v = qcDraft(bad);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f: any) => f.rule === 'signal')).toBe(true);
  });

  it('rejects a draft with unfilled placeholders', () => {
    const bad = { ...goodDraft, draftBody: 'Hi {{firstName}}, saw your work on {{topic}}. Would love to hear more?' };
    const v = qcDraft(bad);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f: any) => f.rule === 'noFabrication')).toBe(true);
  });

  it('rejects a draft over 600 chars', () => {
    const bad = { ...goodDraft, draftBody: 'X'.repeat(601) + '?' };
    const v = qcDraft(bad);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f: any) => f.rule === 'length')).toBe(true);
  });

  it('rejects a draft with no concrete ask AND no "no ask" disclaimer', () => {
    const bad = { ...goodDraft, draftBody: 'Saw your post on Rust tail-latency. Cool stuff. I shipped something similar.' };
    const v = qcDraft(bad);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f: any) => f.rule === 'ask')).toBe(true);
  });

  it('accepts a draft with explicit "no ask, just" phrase', () => {
    const passive = { ...goodDraft, draftBody: 'Saw your Rust tail-latency post. No ask, just resonated -- shipped something similar last quarter and the executor choice was load-bearing.' };
    const v = qcDraft(passive);
    expect(v.passed).toBe(true);
  });

  it('exposes the banned phrases list for inspection', () => {
    expect(Array.isArray(BANNED_PHRASES)).toBe(true);
    expect(BANNED_PHRASES.length).toBeGreaterThan(3);
  });
});
