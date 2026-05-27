import { describe, it, expect } from 'vitest';
import {
  extractClaims,
  verifyClaim,
  verifyArtifact,
  passesGate,
  type SourceDoc,
} from '../claim-verifier';

describe('claim-verifier: extractClaims', () => {
  it('filters opinion sentences with no factual signal', () => {
    const text = 'This is great. I think we should do it. We shipped run 53 last night.';
    const claims = extractClaims(text);
    // Only the third sentence has both a digit and a status verb.
    expect(claims.length).toBe(1);
    expect(claims[0].text).toContain('run 53');
    expect(claims[0].signals).toContain('has_digit');
  });

  it('keeps sentences with digits, paths, urls, or identifiers', () => {
    const text =
      'Briefing build pushed 1234 lines. ' +
      'See https://example.com/x for the dashboard. ' +
      'The file src/main/claim-verifier.ts is new. ' +
      'PR #482 landed.';
    const claims = extractClaims(text);
    // All four sentences carry concrete signals.
    expect(claims.length).toBe(4);
    expect(claims[0].signals).toContain('has_digit');
    expect(claims[1].signals).toContain('has_path_or_url');
    expect(claims[2].signals).toContain('has_path_or_url');
    expect(claims[3].signals).toContain('has_identifier');
  });

  it('drops sentences with only a status verb and no concrete signal', () => {
    const text = 'this is fine. the work was satisfying.';
    const claims = extractClaims(text);
    // Status verb alone is opinion, not verifiable.
    expect(claims.length).toBe(0);
  });

  it('treats proper-noun sentences as factual even without digits', () => {
    const text = 'My morning was quiet. John Smith asked Amy about Vapi.';
    const claims = extractClaims(text);
    expect(claims.length).toBe(1);
    expect(claims[0].text).toContain('John Smith');
    expect(claims[0].signals).toContain('has_proper_noun');
  });

  it('assigns stable ids across runs for identical sentences', () => {
    const t = 'Amy shipped run 57 on 2026-05-13.';
    const a = extractClaims(t);
    const b = extractClaims(t);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id.length).toBe(12);
  });

  it('extracts key_tokens that skip stopwords but keep numeric and structured tokens', () => {
    const text = 'The briefing shipped 17 SKILL.md packages today.';
    const claims = extractClaims(text);
    expect(claims.length).toBe(1);
    // Stopwords like "the" and "today" should be filtered; "17", "skill.md",
    // "packages", "briefing", "shipped" should survive.
    const toks = claims[0].key_tokens;
    expect(toks).not.toContain('the');
    expect(toks).toContain('17');
    expect(toks.some((t) => t.includes('skill.md'))).toBe(true);
  });

  it('respects max_claims cap', () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Run ${i} shipped today.`).join(' ');
    const claims = extractClaims(sentences, { max_claims: 5 });
    expect(claims.length).toBe(5);
  });

  it('returns empty array for empty or non-string input', () => {
    expect(extractClaims('')).toEqual([]);
    // @ts-expect-error -- testing defensive path
    expect(extractClaims(null)).toEqual([]);
  });

  it('records character spans into the original artifact', () => {
    const text = 'Hello world. Run 12 shipped.';
    const claims = extractClaims(text);
    expect(claims.length).toBe(1);
    const span = claims[0].span;
    expect(text.slice(span.start, span.end)).toContain('Run 12');
  });
});

describe('claim-verifier: verifyClaim', () => {
  const sources: SourceDoc[] = [
    {
      id: 'gmail-2026-05-13',
      text: 'Reminder: the briefing rendered 10 news tiles and ran for 23 minutes on 2026-05-13.',
    },
    {
      id: 'tool-trace',
      text: 'tool: video-pipeline ok=1 duration_ms=87412 run=57',
    },
  ];

  it('returns verified when every key token appears in one source', () => {
    const [claim] = extractClaims('The briefing rendered 10 news tiles in 23 minutes on 2026-05-13.');
    const report = verifyClaim(claim, sources);
    expect(report.verdict).toBe('verified');
    expect(report.evidence[0].source_id).toBe('gmail-2026-05-13');
    expect(report.evidence[0].missing_tokens.length).toBe(0);
  });

  it('returns partial when some but not all key tokens match', () => {
    const [claim] = extractClaims('The briefing rendered 50 news tiles on Mars.');
    const report = verifyClaim(claim, sources, { partial_match_threshold: 0.3 });
    expect(report.verdict).toBe('partial');
    expect(report.evidence[0].missing_tokens.length).toBeGreaterThan(0);
  });

  it('returns unsupported when no source contains any key token', () => {
    const [claim] = extractClaims('The dolphins migrated 4000 miles in March.');
    const report = verifyClaim(claim, sources);
    expect(report.verdict).toBe('unsupported');
    expect(report.evidence.length).toBe(0);
    expect(report.reason).toContain('no source');
  });

  it('respects custom full_match_threshold for partial mode', () => {
    const [claim] = extractClaims('Run 57 shipped 3 new modules with 75 passing tests.');
    const partialSources: SourceDoc[] = [
      { id: 's1', text: 'run 57 shipped 3 new modules with passing tests today.' },
      // Missing "75".
    ];
    const strict = verifyClaim(claim, partialSources, { full_match_threshold: 1.0 });
    // "75" is missing from any source.
    expect(strict.verdict).not.toBe('verified');
    const lenient = verifyClaim(claim, partialSources, { full_match_threshold: 0.7 });
    expect(lenient.verdict).toBe('verified');
  });

  it('keeps a short evidence snippet around the first hit', () => {
    const longSource: SourceDoc = {
      id: 'big',
      text: 'a'.repeat(200) + ' the special phrase run 57 happened here ' + 'b'.repeat(200),
    };
    const [claim] = extractClaims('Run 57 happened.');
    const report = verifyClaim(claim, [longSource]);
    expect(report.evidence[0].span_snippet.length).toBeLessThanOrEqual(165);
    expect(report.evidence[0].span_snippet.toLowerCase()).toContain('run');
  });

  it('returns evidence sorted by matched-token count descending', () => {
    const claim = extractClaims('Vapi assistant dba21f77 ran the call.')[0];
    const partial: SourceDoc = { id: 'partial', text: 'vapi assistant called.' };
    const full: SourceDoc = {
      id: 'full',
      text: 'the vapi assistant dba21f77 ran the call yesterday.',
    };
    const report = verifyClaim(claim, [partial, full]);
    expect(report.evidence[0].source_id).toBe('full');
  });

  it('handles empty / malformed source bundles defensively', () => {
    const [claim] = extractClaims('Run 1 shipped.');
    const report = verifyClaim(claim, [
      { id: 'broken', text: '' },
      // @ts-expect-error -- testing defensive path
      null,
    ]);
    expect(report.verdict).toBe('unsupported');
  });
});

describe('claim-verifier: verifyArtifact', () => {
  it('aggregates per-claim verdicts into a summary', () => {
    const artifact =
      'Run 57 shipped 3 modules. ' +
      'The dolphins flew to Mars. ' +
      'The briefing ran for 23 minutes.';
    const sources: SourceDoc[] = [
      { id: 'log', text: 'run 57 shipped 3 modules ok' },
      { id: 'time', text: 'the briefing ran for 23 minutes' },
    ];
    const report = verifyArtifact(artifact, sources);
    expect(report.total_claims).toBe(3);
    expect(report.verified).toBe(2);
    expect(report.unsupported).toBe(1);
    expect(report.summary).toContain('verified');
    expect(report.artifact_hash.length).toBe(12);
  });

  it('returns total_claims=0 and a benign summary for opinion-only text', () => {
    const report = verifyArtifact('This is interesting. I think we should try.', []);
    expect(report.total_claims).toBe(0);
    expect(report.summary).toBe('no factual claims detected');
  });

  it('produces deterministic artifact_hash for identical artifacts', () => {
    const a = verifyArtifact('Run 57 shipped 3 modules.', []);
    const b = verifyArtifact('Run 57 shipped 3 modules.', []);
    expect(a.artifact_hash).toBe(b.artifact_hash);
  });
});

describe('claim-verifier: passesGate', () => {
  it('passes when there are no claims (nothing to check)', () => {
    const report = verifyArtifact('This is interesting.', []);
    expect(passesGate(report)).toBe(true);
  });

  it('fails when there is any unsupported claim', () => {
    const report = verifyArtifact(
      'Run 57 shipped. The dolphins migrated 4000 miles in March.',
      [{ id: 'log', text: 'run 57 shipped today' }]
    );
    // Two claims, one verified, one unsupported -> gate must fail.
    expect(report.unsupported).toBeGreaterThan(0);
    expect(passesGate(report)).toBe(false);
  });

  it('fails when verified ratio is below threshold', () => {
    // Two claims, only one verified -> 50% verified, below default 0.9.
    const report = verifyArtifact(
      'Run 57 shipped 3 modules. Run 58 shipped 2 modules.',
      [{ id: 'log', text: 'run 57 shipped 3 modules ok' }]
    );
    expect(passesGate(report)).toBe(false);
  });

  it('allow_partial=false blocks even with partial verdicts', () => {
    const report = verifyArtifact('Run 57 shipped 4 modules on Tuesday.', [
      { id: 'log', text: 'run 57 shipped on tuesday' }, // missing "4 modules"
    ]);
    // Will be partial.
    const blocked = passesGate(report, { allow_partial: false, min_verified_ratio: 0 });
    expect(blocked).toBe(false);
  });
});
