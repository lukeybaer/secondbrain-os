/**
 * Tests for breadcrumb signal extraction from transcripts.
 *
 * We can't import otter-ingest directly (Electron app dependency),
 * so we duplicate the pure function here for testing. The source of
 * truth is otter-ingest.ts -- keep these in sync.
 */
import { describe, it, expect } from 'vitest';

function extractBreadcrumbs(transcript: string | undefined): string | null {
  if (!transcript) return null;

  const goodbyePatterns = [
    /\b(bye|see ya|talk to you|take care|have a good|alright\s*,?\s*thanks)\b/gi,
  ];

  let lastGoodbyeIndex = -1;
  for (const pattern of goodbyePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(transcript)) !== null) {
      if (match.index > lastGoodbyeIndex) {
        lastGoodbyeIndex = match.index;
      }
    }
  }

  if (lastGoodbyeIndex === -1) return null;

  const postGoodbye = transcript.slice(lastGoodbyeIndex).trim();
  if (postGoodbye.length < 80) return null;

  const breadcrumbSignals = [
    /the most important thing/i,
    /the key takeaway/i,
    /what matters (here|most|is)/i,
    /what('s| is) important (about|here|is)/i,
    /the big (thing|deal|takeaway)/i,
    /i (need to|should|want to) remember/i,
    /note to self/i,
    /between .+ and .+ is/i,
  ];

  const hasBreadcrumbSignal = breadcrumbSignals.some((pattern) => pattern.test(postGoodbye));
  if (!hasBreadcrumbSignal) return null;

  const lines = postGoodbye.split('\n');
  const breadcrumbText = lines.slice(1).join('\n').trim();
  return breadcrumbText.length > 20 ? breadcrumbText : null;
}

describe('extractBreadcrumbs', () => {
  it('returns null for undefined transcript', () => {
    expect(extractBreadcrumbs(undefined)).toBeNull();
  });

  it('returns null for transcript with no goodbye', () => {
    const transcript = 'Just a normal conversation about data science and models.';
    expect(extractBreadcrumbs(transcript)).toBeNull();
  });

  it('returns null for transcript with goodbye but no breadcrumb signal', () => {
    const transcript =
      'We talked about the project timeline.\n' +
      'Alright, thanks everyone. Bye.\n' +
      'Some random noise after the call ended.';
    expect(extractBreadcrumbs(transcript)).toBeNull();
  });

  it('returns null for transcript with goodbye and short post-content', () => {
    const transcript = 'Good discussion.\nBye.\nShort.';
    expect(extractBreadcrumbs(transcript)).toBeNull();
  });

  it('extracts breadcrumb with "the most important thing" signal', () => {
    const transcript =
      'We had a great conversation about AI and startups.\n' +
      'Alright, thanks Luke. Bye.\n' +
      'The most important thing that happened in that meeting with Evgeny is we made a lasting connection. ' +
      'He and Addie are really close friends and he wants to come to the farm and meet Yanli.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('lasting connection');
    expect(result).toContain('farm');
  });

  it('extracts breadcrumb with "the key takeaway" signal', () => {
    const transcript =
      'So that wraps up our discussion.\n' +
      'See ya later.\n' +
      'The key takeaway from that call was the pricing needs to be between 15k and 20k per month ' +
      'and we need to get MSR values from Kramer before the pitch.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('pricing');
  });

  it('extracts breadcrumb with "what matters" signal', () => {
    const transcript =
      'Great chat. Talk to you later.\n' +
      'What matters most here is the relationship with the credit union. ' +
      'They have 29 billion in assets and Eric runs everything.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('credit union');
  });

  it('extracts breadcrumb with "between X and Y" signal', () => {
    const transcript =
      'Okay bye bye.\n' +
      'The conversation between Luke and Evgeny is about building AI agents ' +
      'and the self reinforcement learning pattern that makes them smarter over time.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('AI agents');
  });

  it('extracts breadcrumb with "note to self" signal', () => {
    const transcript =
      'Alright take care man.\n' +
      'Note to self the farm meetup needs to happen by end of May ' +
      'and I should loop in Addie to make it a three person mastermind session.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('farm meetup');
  });

  it('finds the LAST goodbye for breadcrumb extraction', () => {
    const transcript =
      'Bye Marcus, talk later.\n' +
      'Now back to the real meeting.\n' +
      'Okay everyone, thanks. See ya.\n' +
      'The most important thing is we closed the deal for 50k per month ' +
      'and the contract signing is next Tuesday.';
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('closed the deal');
  });

  it('handles real-world Evgeny transcript pattern', () => {
    const transcript =
      'Okay, awesome, Luke, thank you for your time. I really enjoyed chatting with you.\n' +
      'Bye. The most important thing that happened in that meeting\n' +
      'with Evgeny, between Luke and Evgeny\n' +
      'is we made a lasting, long term connection. He and Addie are really close friends, ' +
      'and he wants to come to the farm, and he wants to come and meet me and Yan Lee,\n' +
      "and he's an AI builder just like me, and he thinks deeply and philosophically just like me.";
    const result = extractBreadcrumbs(transcript);
    expect(result).not.toBeNull();
    expect(result).toContain('lasting');
    expect(result).toContain('Evgeny');
    expect(result).toContain('farm');
  });
});
