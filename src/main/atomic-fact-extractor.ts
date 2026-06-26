// atomic-fact-extractor.ts
//
// Heuristic rule pack that converts inbound natural-language text (Otter
// snippets, Gmail bodies, Telegram messages, transcript turns) into a
// stream of structured MemoryFact candidates ready to feed
// memory-lifecycle-engine.tick().
//
// Backlog id auto-fact-extraction-pipeline (priority 81, 2026-05-29).
// Today each surface (intent-extractor, maybe-extract, agent-memory)
// inlines its own ad-hoc fact-finding code with a different output
// shape, so the lifecycle engine can't dedupe across surfaces. This
// module emits a single canonical shape (subject, predicate, object,
// asOf, confidence, source) regardless of surface.
//
// Heuristic-first by design. The lifecycle engine handles dedup +
// contradiction + retention deterministically; the extractor only
// needs to convert text into candidates. A heuristic pass:
//   - runs without a paid LLM call so the nightly enhancement / test
//     suites stay deterministic and free
//   - leaves an obvious extension seam (extra rule packs) for an
//     optional LLM pass later
//   - is fast enough that the briefing pipeline can run it inline on
//     every Otter snippet without budgeting a second pass
//
// Pattern sources (research 2026-05-29):
//   - Mem0 USER_MEMORY_EXTRACTION_PROMPT (mem0/configs/prompts.py):
//     only user-channel content becomes a fact; the prompt extracts
//     "personal preferences, relationships, plans, professional info".
//     We borrow the *categories* and code each as a rule.
//   - Letta core_memory_replace (letta/functions): the granularity is
//     (block, key, value), the equivalent of (subject, predicate,
//     object). Same atomic shape.
//   - 2026-05 mem0 redesign: single-pass ADD-only extraction with
//     hybrid retrieval. The extractor is now ADD-only here too
//     (UPDATE/SKIP belong to the lifecycle engine, not the extractor).
//
// Pure module: no fs, no electron, no network. The caller streams text
// in, gets candidates out, hands them to memory-lifecycle-engine.

import * as crypto from 'crypto';
import type { MemoryFact } from './memory-contradiction-detector';

// ── Types ────────────────────────────────────────────────────────────────────

export type FactSource = 'gmail' | 'otter' | 'telegram' | 'sms' | 'call' | 'manual' | 'other';

export interface InboundChunk {
  /** Raw text of the chunk. One ExampleCoraph or one transcript turn. */
  text: string;
  /** Origin channel. Threaded into every emitted fact's `source`. */
  source: FactSource;
  /** Stable id for the chunk (gmail msgId, otter snippetId). Forms part of
   * the fact id so re-ingestion of the same chunk produces the same fact ids
   * and dedup at the engine layer holds. */
  chunkId: string;
  /** ISO timestamp of the chunk. Used as the fact's asOf. */
  timestamp: string;
  /** Optional subject hint when the channel knows it (e.g. Gmail from-address
   * mapped to a contact id, Otter speaker label). When absent the extractor
   * defaults to "ExampleCo" since most inbound text references ExampleCo. */
  subjectHint?: string;
}

export interface ExtractionOptions {
  /** Override the default subject when subjectHint is not provided. */
  defaultSubject?: string;
  /** Skip rules below this confidence floor. Default 0.5. */
  minConfidence?: number;
  /** Cap on candidates per chunk. Default 5. Caller's lifecycle engine
   * still dedupes, but capping at the source keeps memory ingest cheap. */
  maxPerChunk?: number;
}

const DEFAULT_OPTIONS: Required<ExtractionOptions> = {
  defaultSubject: 'ExampleCo',
  minConfidence: 0.5,
  maxPerChunk: 5,
};

// ── Rule pack ────────────────────────────────────────────────────────────────

interface RuleHit {
  predicate: string;
  object: string;
  confidence: number;
  matchedRule: string;
}

type Rule = (text: string) => RuleHit | null;

// All rules use the `i` flag so they fire on either "I" or "i", "My" or "my",
// since inbound chunks include both sentence-initial and mid-sentence forms.

// Lives-in / location facts. "I live in Springfield" / "I moved to Plano"
// Name slot is case-sensitive so "I moved to Springfield last month" does NOT
// pull "last" into the place name. "I" by English convention is always
// capital so the leading "I" is also case-sensitive.
const livesInRule: Rule = (text) => {
  const m = text.match(/\bI(?:'ve|'m| have)? (?:live|moved|relocated)d?(?: to| in)? ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)\b/);
  if (!m) return null;
  return {
    predicate: 'lives_in',
    object: m[1].toLowerCase(),
    confidence: 0.7,
    matchedRule: 'lives_in.first_person',
  };
};

// Job title / employer facts. "I work at Acme" / "I'm a VP at X"
const employerRule: Rule = (text) => {
  const m = text.match(/\bI(?:'m| am)?(?: a)? (?:work(?:ing)? at|employed by|VP at|Director at|Manager at) ([A-Z][A-Za-z0-9& ]{2,40})/i);
  if (!m) return null;
  return {
    predicate: 'employer',
    object: m[1].trim().replace(/\s+(and|we|but|so).*$/i, ''),
    confidence: 0.7,
    matchedRule: 'employer.first_person',
  };
};

// Relationship facts. "My wife Sarah" / "my son" / "my brother PRIVATE_NAME"
// Case-sensitive name part so "my wife is" does NOT match the name slot;
// only proper-noun names with leading capital qualify. Leading [Mm]y
// gives sentence-initial flexibility without polluting the name slot.
const relationshipRule: Rule = (text) => {
  const m = text.match(/\b[Mm]y (wife|husband|son|daughter|mother|father|brother|sister|partner) ([A-Z][a-z]+(?:[ -][A-Z][a-z]+)?)\b/);
  if (!m) return null;
  return {
    predicate: `relation.${m[1].toLowerCase()}`,
    object: m[2],
    confidence: 0.75,
    matchedRule: 'relationship.first_person',
  };
};

// Preference facts. "I prefer X" / "I'd rather Y" / "I like Z"
const preferenceRule: Rule = (text) => {
  const m = text.match(/\bI(?:'d| would)? (?:prefer|rather|like|love|hate|dislike) (?:to )?([a-z][a-z0-9 ,.-]{4,60})/i);
  if (!m) return null;
  return {
    predicate: 'preference',
    object: m[1].trim().toLowerCase(),
    confidence: 0.55,
    matchedRule: 'preference.first_person',
  };
};

// Plan / commitment facts. "I'm going to Houston Friday" / "I'll call PRIVATE_NAME tomorrow"
const planRule: Rule = (text) => {
  const m = text.match(/\bI(?:'ll| will| am going to)?(?:'m going to)? ([a-z][a-z0-9 ,.-]{3,60}? (?:on|by|tomorrow|next|this) [a-z]+(?: [0-9]+)?)/i);
  if (!m) return null;
  return {
    predicate: 'plan',
    object: m[1].trim().toLowerCase(),
    confidence: 0.5,
    matchedRule: 'plan.first_person',
  };
};

// Birthday / anniversary facts. "My birthday is March 12" / "anniversary is July 4"
const birthdayRule: Rule = (text) => {
  const m = text.match(/\b(?:my )?(birthday|anniversary)(?: is| on)? ((?:January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{1,2}(?:,? [0-9]{4})?)/i);
  if (!m) return null;
  return {
    predicate: m[1].toLowerCase(),
    object: m[2].trim(),
    confidence: 0.85,
    matchedRule: 'date.first_person',
  };
};

// Phone / contact facts. "My number is 555-123-4567"
const phoneRule: Rule = (text) => {
  const m = text.match(/\b(?:my (?:phone )?(?:number|cell) is )([0-9 .+()-]{10,20})/i);
  if (!m) return null;
  return {
    predicate: 'phone',
    object: m[1].replace(/[^0-9]/g, ''),
    confidence: 0.9,
    matchedRule: 'phone.first_person',
  };
};

// Health / status facts. "I'm sick" / "I tested positive" / "I had surgery"
const healthRule: Rule = (text) => {
  const m = text.match(/\bI(?:'m| am| was| have been)? (sick|tested positive|recovering|in the hospital|on antibiotics|cleared)/i);
  if (!m) return null;
  return {
    predicate: 'health_status',
    object: m[1].toLowerCase(),
    confidence: 0.6,
    matchedRule: 'health.first_person',
  };
};

const RULES: Rule[] = [
  livesInRule,
  employerRule,
  relationshipRule,
  birthdayRule,
  phoneRule,
  healthRule,
  preferenceRule,
  planRule,
];

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Extract atomic facts from one inbound chunk. Returns a MemoryFact array
 * where every entry is ready to hand to memory-lifecycle-engine.tick().
 * Deterministic given identical inputs.
 */
export function extractFacts(
  chunk: InboundChunk,
  options: ExtractionOptions = {},
): MemoryFact[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const subject = (chunk.subjectHint ?? opts.defaultSubject).trim().toLowerCase();
  const out: MemoryFact[] = [];
  const seenKey = new Set<string>();

  for (const rule of RULES) {
    if (out.length >= opts.maxPerChunk) break;
    const hit = rule(chunk.text);
    if (!hit) continue;
    if (hit.confidence < opts.minConfidence) continue;
    const key = `${subject}|${hit.predicate}|${hit.object.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push({
      id: factIdFor(chunk.chunkId, subject, hit.predicate, hit.object),
      subject,
      predicate: hit.predicate,
      object: hit.object,
      asOf: chunk.timestamp,
      confidence: hit.confidence,
      source: chunk.source,
    });
  }
  return out;
}

/**
 * Apply extractFacts to a stream of chunks. Returns the flat candidate
 * array in chunk order (stable). Useful when the briefing pipeline wants
 * to ingest the last N Otter snippets in one pass.
 */
export function extractBatch(
  chunks: InboundChunk[],
  options: ExtractionOptions = {},
): MemoryFact[] {
  return chunks.flatMap((c) => extractFacts(c, options));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function factIdFor(chunkId: string, subject: string, predicate: string, object: string): string {
  // Stable id: hash chunkId + subject + predicate + object so re-ingestion
  // of the same chunk produces an identical fact id. The lifecycle
  // engine's dedup classifier handles the SKIP / UPDATE decision; the id
  // is only here so re-ingest does not generate visibly-different facts.
  const h = crypto
    .createHash('sha1')
    .update(`${chunkId}|${subject}|${predicate}|${object.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `f_${h}`;
}

/**
 * Introspection helper: list the rule pack. Lets the briefing / debugger
 * show which categories the extractor can recognize today, and lets a
 * future test confirm the rule list grew without reading the file.
 */
export function listRuleCategories(): string[] {
  return [
    'lives_in',
    'employer',
    'relationship',
    'birthday',
    'anniversary',
    'phone',
    'health_status',
    'preference',
    'plan',
  ];
}
