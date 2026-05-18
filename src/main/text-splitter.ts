// text-splitter.ts
// Recursive, token-aware text splitter for Graphiti ingest.
//
// Replaces the prior `slice(0, 3000)` pattern across the codebase. Long
// transcripts/messages are now split into multiple coherent chunks at natural
// boundaries (paragraph → line → sentence → word) instead of being truncated
// mid-sentence with the tail dropped.
//
// Each chunk targets ~1500 tokens with ~150 tokens (~10%) of overlap. Overlap
// catches entities and relationships that straddle a chunk boundary — without
// it, a fact like "Sarah agreed to ship Friday. [chunk boundary] Then John
// pushed back…" would lose the Sarah↔Friday↔John relationship.
//
// Token counting uses the same o200k_base encoding used by chat.ts, matching
// the gpt-4o family models Graphiti's entity extractor most likely runs on.

import { encode, decode } from 'gpt-tokenizer/model/gpt-4o-mini';

const DEFAULT_TARGET_TOKENS = 1500;
const DEFAULT_OVERLAP_TOKENS = 150;

// Priority order: prefer paragraph breaks, fall back through line, sentence,
// word. The recursive splitter only descends to a finer separator when the
// current one fails to produce sub-budget pieces.
const SEPARATORS = ['\n\n', '\n', '. ', ' '];

export interface SplitOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/**
 * Truncate `text` to roughly `targetTokens` tokens, breaking at the cleanest
 * available boundary (paragraph → line → sentence → word). Use this for
 * single-LLM-call prompt budgets where splitting into multiple chunks isn't
 * an option — e.g. prompt context capped to fit alongside other content.
 * Returns the original text unchanged if it already fits.
 */
export function truncateAtBoundary(text: string, targetTokens: number): string {
  const trimmed = text.trim();
  if (countTokens(trimmed) <= targetTokens) return trimmed;
  // splitText respects the same separator priority as a normal split, so the
  // first chunk is the largest natural-boundary prefix that fits the budget.
  const chunks = recursiveSplit(trimmed, SEPARATORS, targetTokens);
  return chunks[0] ?? trimmed.slice(0, targetTokens * 4); // crude fallback (~4 chars/token)
}

/**
 * Split `text` into chunks of roughly `targetTokens` tokens each, with
 * `overlapTokens` of overlap between adjacent chunks. Returns the original
 * text as a single-element array if it already fits the budget.
 */
export function splitText(text: string, opts: SplitOptions = {}): string[] {
  const target = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlap = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (countTokens(trimmed) <= target) return [trimmed];
  const chunks = recursiveSplit(trimmed, SEPARATORS, target);
  return applyOverlap(chunks, overlap);
}

function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function recursiveSplit(text: string, seps: string[], target: number): string[] {
  if (countTokens(text) <= target) return [text];
  if (seps.length === 0) return sliceByTokens(text, target);

  const [sep, ...rest] = seps;
  const pieces = text.split(sep);
  if (pieces.length === 1) return recursiveSplit(text, rest, target);

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? current + sep + piece : piece;
    if (countTokens(candidate) <= target) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (countTokens(piece) > target) {
      chunks.push(...recursiveSplit(piece, rest, target));
    } else {
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Last-resort splitter when no natural separator works — slice by token id.
// Safe because we encode → slice → decode rather than splitting on bytes.
function sliceByTokens(text: string, target: number): string[] {
  const tokens = encode(text);
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += target) {
    chunks.push(decode(tokens.slice(i, i + target)));
  }
  return chunks;
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (chunks.length <= 1 || overlap <= 0) return chunks;
  const out: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prevTokens = encode(chunks[i - 1]);
    const tail = decode(prevTokens.slice(-overlap));
    out.push(tail + ' ' + chunks[i]);
  }
  return out;
}
