// claim-verifier.ts
//
// Artifact-level claim verifier. Closes the anti-fabrication gap one level
// above maybe-extract.ts (which validates citations per-extraction) and
// output-critic.ts (which runs structural regex/presence rules over the
// final text). This module takes a generated artifact -- a briefing draft,
// Gmail draft, call script, dashboard tile body, anything Amy is about to
// surface -- plus a "source bundle" (the evidence Amy actually has) and
// returns a per-claim verdict: verified, unsupported, or partial.
//
// Pattern sources (2026 OSS + research):
//   - Anthropic Verify-in-Artifact (Skills SDK 2026-03 guidance) -- claims
//     must be checkable against the artifact itself or a provided evidence
//     bundle, not against the model's prior. Output of a verifier is a
//     citation map, not a yes/no.
//   - DSPy ChainOfThought + Verify (Khattab et al, dspy.Verify primitive,
//     Stanford 2024/2025) -- decompose generation into draft + verify pass,
//     verify is a typed signature returning {supports: bool, span: str}.
//   - RAGAS faithfulness metric (Es et al, EMNLP 2024) -- decompose answer
//     into atomic claims, score per-claim entailment against retrieved
//     context.
//   - SelfCheckGPT (Manakul et al, EMNLP 2023) -- consistency check over
//     multiple samples; we ship the simpler single-pass evidence-grounding
//     variant since the cost story matters for the nightly briefing.
//   - Bespoke-Minicheck-7B (Bespoke Labs, 2024-08) -- fact-check decomposed
//     claims against documents at sentence granularity.
//
// Why SecondBrain needs this on top of existing modules:
//   - feedback_anti_fabrication_is_foundation_not_rules.md says the
//     prevention path is "build summary + drill tool", not more prompt
//     rules. A deterministic verifier IS that drill tool.
//   - feedback_briefing_copy_must_match_state.md is enforced today by
//     ad-hoc per-section tests; a generic verifier gives every surface
//     (briefing, gmail, telegram, call script) the same gate.
//   - maybe-extract handles "did the extractor cite its source?" per
//     single extraction. It does not handle "the generated paragraph says
//     three things; are all three things in the evidence?"
//   - output-critic handles structural rules (em dashes, CT not UTC,
//     length caps). It does not handle semantic grounding.
//
// Design:
//   - Pure module. No fs. No network. Deterministic for the same
//     {artifact, sources, options} tuple.
//   - extractClaims(text, opts) splits into sentences and keeps only
//     sentences that LOOK factual: contain a digit, a capitalized non-
//     sentence-start token (proper noun heuristic), a path/URL/id, or a
//     status verb. Non-factual sentences ("here is a summary", "I think
//     X is interesting") are filtered out -- they are opinions, not
//     verifiable claims, and surfacing them as "unsupported" is noise.
//   - verifyClaim(claim, sources, opts) returns a verdict per claim:
//     'verified' if every key token of the claim appears in at least
//     one source within a small adjacency window; 'partial' if some
//     key tokens match but not all; 'unsupported' otherwise.
//   - verifyArtifact(artifact, sources, opts) is the top-level entry:
//     extracts claims, verifies each, returns a structured report plus
//     a one-line summary suitable for a briefing system-health tile.
//
// LLM-agnostic: callers can wrap a Claude / GPT-OSS pass on top by
// substituting verifyClaim with an entailment model. Default
// implementation is pure JS so tests run without network.

import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClaimVerdict = 'verified' | 'partial' | 'unsupported';

export interface SourceDoc {
  id: string;
  text: string;
  kind?: string; // optional tag, e.g. 'gmail', 'briefing-state', 'ledger'
}

export interface Claim {
  id: string;                  // sha256(text).slice(0,12) for stable refs
  text: string;                // original sentence
  key_tokens: string[];        // normalized tokens worth grounding
  signals: ClaimSignal[];      // why this was classified as factual
  span: { start: number; end: number }; // char offsets into the artifact
}

export type ClaimSignal =
  | 'has_digit'
  | 'has_proper_noun'
  | 'has_path_or_url'
  | 'has_status_verb'
  | 'has_identifier';

export interface ClaimEvidence {
  source_id: string;
  matched_tokens: string[];
  missing_tokens: string[];
  span_snippet: string;        // first 160 chars around the match in the source
}

export interface ClaimReport {
  claim: Claim;
  verdict: ClaimVerdict;
  evidence: ClaimEvidence[];   // best matches, sorted by matched-token count desc
  reason: string;              // human-readable explanation
}

export interface VerifyReport {
  artifact_hash: string;
  total_claims: number;
  verified: number;
  partial: number;
  unsupported: number;
  claims: ClaimReport[];
  summary: string;             // one-line for the briefing tile
}

export interface VerifyOptions {
  /**
   * Minimum fraction of key tokens that must match a single source for a
   * verdict of 'verified'. Default 1.0 (every token must match somewhere
   * in the same source).
   */
  full_match_threshold?: number;
  /**
   * Minimum fraction for a 'partial' verdict. Below this threshold the
   * claim is 'unsupported'. Default 0.5.
   */
  partial_match_threshold?: number;
  /**
   * Stop-words removed from key_tokens before matching. Defaults to a
   * small English stoplist. Pass [] to disable.
   */
  stopwords?: string[];
  /**
   * Status verbs treated as factual markers. Default covers the briefing
   * vocabulary ("is", "was", "shipped", "failed", "passed", etc.).
   */
  status_verbs?: string[];
  /**
   * Max claims to return. Default 200 (briefings rarely exceed 100 atomic
   * claims; a runaway extractor should not blow up downstream callers).
   */
  max_claims?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this',
  'that', 'these', 'those', 'it', 'its', 'with', 'for', 'of', 'in', 'on',
  'at', 'to', 'from', 'by', 'about', 'into', 'over', 'under', 'after',
  'before', 'between', 'than', 'then', 'there', 'here', 'when', 'where',
  'which', 'while', 'who', 'whom', 'what', 'how', 'i', 'you', 'we', 'they',
  'he', 'she', 'them', 'us', 'our', 'their', 'his', 'her', 'my', 'your',
]);

const DEFAULT_STATUS_VERBS = [
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'shipped', 'failed',
  'passed', 'completed', 'sent', 'received', 'posted', 'deployed',
  'pushed', 'merged', 'broke', 'broken', 'fixed', 'increased', 'decreased',
  'rose', 'fell', 'jumped', 'dropped', 'cost', 'costs', 'returned',
  'returns', 'happened', 'occurred', 'began', 'started', 'ended',
  'finished',
];

// ── Tokenization + signals ────────────────────────────────────────────────────

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

const TOKEN_SPLIT = /[^A-Za-z0-9_./:#$%@-]+/;

const PATH_OR_URL = /(?:https?:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.[A-Za-z]{2,5}\b)/;

// Word-boundary semantics in JS exclude transitions between two non-word chars
// (e.g. " " then "#"), so we anchor identifier candidates explicitly on the
// preceding character class instead of `\b`.
const IDENTIFIER = /(?:^|[\s(\[,;:])(?:[A-Z]{2,}-\d+|#\d+|[A-Z0-9]{6,}|run\s*\d+)\b/;

const DIGIT = /\d/;

function hasProperNoun(sentence: string): boolean {
  // Skip the first token (sentence-start capitalisation is not a signal).
  const tokens = sentence.split(/\s+/);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].replace(/[^A-Za-z]/g, '');
    if (t.length >= 2 && t[0] === t[0].toUpperCase() && t[0] !== t[0].toLowerCase()) {
      return true;
    }
  }
  return false;
}

function detectSignals(sentence: string, statusVerbs: Set<string>): ClaimSignal[] {
  const sigs: ClaimSignal[] = [];
  if (DIGIT.test(sentence)) sigs.push('has_digit');
  if (hasProperNoun(sentence)) sigs.push('has_proper_noun');
  if (PATH_OR_URL.test(sentence)) sigs.push('has_path_or_url');
  if (IDENTIFIER.test(sentence)) sigs.push('has_identifier');
  const lower = sentence.toLowerCase();
  for (const verb of statusVerbs) {
    // word-boundary match (avoid matching "was" in "wasabi"); cheap enough.
    const re = new RegExp(`\\b${verb}\\b`, 'i');
    if (re.test(lower)) {
      sigs.push('has_status_verb');
      break;
    }
  }
  return sigs;
}

// Strip leading/trailing punctuation but preserve internal structure (paths,
// URLs, identifiers like `dba21f77-2da6` keep their hyphens).
const TRIM_PUNCT = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

function tokenize(text: string): string[] {
  return text
    .split(TOKEN_SPLIT)
    .map((t) => t.replace(TRIM_PUNCT, '').toLowerCase())
    .filter((t) => t.length > 0);
}

function keyTokensFor(sentence: string, stopwords: Set<string>): string[] {
  const tokens = tokenize(sentence);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (stopwords.has(t)) continue;
    if (t.length < 2) continue;
    // Keep digits + tokens with structure (paths, urls, identifiers, names).
    const meaningful =
      /\d/.test(t) ||
      /[.:/_-]/.test(t) ||
      t.length >= 4 ||
      /[A-Z]/.test(sentence.match(new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i'))?.[0] ?? '');
    if (!meaningful) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Claim extraction ──────────────────────────────────────────────────────────

export function extractClaims(artifact: string, opts: VerifyOptions = {}): Claim[] {
  if (!artifact || typeof artifact !== 'string') return [];
  const stopwords = new Set(opts.stopwords ?? Array.from(DEFAULT_STOPWORDS));
  const statusVerbs = new Set(opts.status_verbs ?? DEFAULT_STATUS_VERBS);
  const maxClaims = opts.max_claims ?? 200;

  // Track char offsets while splitting so callers can highlight the source span.
  const claims: Claim[] = [];
  let cursor = 0;
  const sentences = splitSentencesWithSpans(artifact);
  for (const { text, start, end } of sentences) {
    cursor = end;
    const trimmed = text.trim();
    if (trimmed.length < 4) continue;
    const signals = detectSignals(trimmed, statusVerbs);
    if (signals.length === 0) continue;
    // Require at least one "concrete" signal (digit / id / path / proper noun)
    // -- a sentence with only "has_status_verb" is often opinion ("this is
    // important").
    const hasConcrete = signals.some(
      (s) => s !== 'has_status_verb'
    );
    if (!hasConcrete) continue;
    const keyTokens = keyTokensFor(trimmed, stopwords);
    if (keyTokens.length === 0) continue;
    const id = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
    claims.push({
      id,
      text: trimmed,
      key_tokens: keyTokens,
      signals,
      span: { start, end },
    });
    if (claims.length >= maxClaims) break;
  }
  void cursor;
  return claims;
}

function splitSentencesWithSpans(
  text: string
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  // First split on common sentence boundaries while tracking offsets.
  const parts = text.split(SENTENCE_SPLIT);
  let cursor = 0;
  for (const p of parts) {
    const start = text.indexOf(p, cursor);
    const end = start + p.length;
    out.push({ text: p, start, end });
    cursor = end;
  }
  // Drop any zero-length artefacts.
  return out.filter((s) => s.text.trim().length > 0);
}

// ── Per-claim verification ────────────────────────────────────────────────────

export function verifyClaim(
  claim: Claim,
  sources: SourceDoc[],
  opts: VerifyOptions = {}
): ClaimReport {
  const fullThreshold = opts.full_match_threshold ?? 1.0;
  const partialThreshold = opts.partial_match_threshold ?? 0.5;

  const matches: ClaimEvidence[] = [];
  let bestRatio = 0;

  for (const src of sources) {
    if (!src || !src.text) continue;
    const srcLower = src.text.toLowerCase();
    const matched: string[] = [];
    const missing: string[] = [];
    let firstHitIdx = -1;
    for (const tok of claim.key_tokens) {
      const idx = srcLower.indexOf(tok);
      if (idx >= 0) {
        matched.push(tok);
        if (firstHitIdx < 0) firstHitIdx = idx;
      } else {
        missing.push(tok);
      }
    }
    if (matched.length === 0) continue;
    const snippetStart = Math.max(0, firstHitIdx - 40);
    const snippetEnd = Math.min(src.text.length, firstHitIdx + 120);
    matches.push({
      source_id: src.id,
      matched_tokens: matched,
      missing_tokens: missing,
      span_snippet: src.text.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim(),
    });
    const ratio = matched.length / claim.key_tokens.length;
    if (ratio > bestRatio) bestRatio = ratio;
  }

  // Sort matches by descending matched-token count for predictable evidence
  // ordering in reports.
  matches.sort((a, b) => b.matched_tokens.length - a.matched_tokens.length);

  let verdict: ClaimVerdict;
  let reason: string;
  if (bestRatio >= fullThreshold) {
    verdict = 'verified';
    reason = `all ${claim.key_tokens.length} key tokens grounded in a single source`;
  } else if (bestRatio >= partialThreshold) {
    verdict = 'partial';
    const top = matches[0];
    const missingCount = top ? top.missing_tokens.length : claim.key_tokens.length;
    reason = `${Math.round(bestRatio * 100)}% of key tokens grounded; ${missingCount} unsupported`;
  } else {
    verdict = 'unsupported';
    reason =
      matches.length === 0
        ? 'no source contained any key token from this claim'
        : `best source covered only ${Math.round(bestRatio * 100)}% of key tokens (below ${Math.round(partialThreshold * 100)}% threshold)`;
  }

  return { claim, verdict, evidence: matches.slice(0, 5), reason };
}

// ── Artifact-level verification ───────────────────────────────────────────────

export function verifyArtifact(
  artifact: string,
  sources: SourceDoc[],
  opts: VerifyOptions = {}
): VerifyReport {
  const claims = extractClaims(artifact, opts);
  const claimReports = claims.map((c) => verifyClaim(c, sources, opts));
  const counts = { verified: 0, partial: 0, unsupported: 0 };
  for (const r of claimReports) counts[r.verdict]++;
  const hash = crypto
    .createHash('sha256')
    .update(artifact)
    .digest('hex')
    .slice(0, 12);
  const summary =
    claimReports.length === 0
      ? 'no factual claims detected'
      : `${counts.verified}/${claimReports.length} verified, ${counts.partial} partial, ${counts.unsupported} unsupported`;
  return {
    artifact_hash: hash,
    total_claims: claimReports.length,
    verified: counts.verified,
    partial: counts.partial,
    unsupported: counts.unsupported,
    claims: claimReports,
    summary,
  };
}

// ── Convenience: gate predicate for output critics ────────────────────────────

/**
 * Returns true if the artifact passes verification at the given pass rate.
 * Default: every claim must be at least 'partial' AND at least 90% of
 * claims must be 'verified'. Suitable as a hard-block gate on outbound
 * artifacts (briefing render, Gmail send, Telegram dispatch).
 */
export function passesGate(
  report: VerifyReport,
  opts: { min_verified_ratio?: number; allow_partial?: boolean } = {}
): boolean {
  const minRatio = opts.min_verified_ratio ?? 0.9;
  const allowPartial = opts.allow_partial ?? true;
  if (report.total_claims === 0) return true;
  if (report.unsupported > 0) return false;
  if (!allowPartial && report.partial > 0) return false;
  const verifiedRatio = report.verified / report.total_claims;
  return verifiedRatio >= minRatio;
}
