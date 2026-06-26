// maybe-extract.ts
//
// Instructor-style "Maybe" wrapper for calibrated structured extraction.
//
// Pattern source: instructor-ai/instructor MaybeUser pattern. Wrapping a
// schema with `{ result: T | null, confidence, abstain_reason, citations }`
// gives the model an explicit "I don't know" channel, so structured
// extraction stops fabricating fields when the source text is ambiguous.
//
// Why SecondBrain needs this:
//   - intent-extractor.ts, briefing-parser.ts, linkedin-intel.ts, tagger.ts
//     extract entities under schema pressure with no abstain channel
//   - feedback_no_fabrication_in_briefings.md is enforced post-hoc by review,
//     not pre-emptively at the extraction site
//   - no confidence score travels with the extracted fact
//
// The module is LLM-agnostic: callers inject `runExtractor(prompt, sourceText)`
// which returns a JSON string. This file owns the schema wrapping, parsing,
// confidence threshold, citation grounding, and abstention logging. Below the
// confidence floor, result becomes null and we append to abstentions.jsonl so
// the nightly compiler (prompt-compiler.ts) can use the abstention as
// trainset signal for the next compile.

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MaybeRaw {
  result: ExampleCo;
  confidence: number;
  abstain_reason?: string;
  citations?: string[];
}

export interface MaybeResult<T> {
  /** Validated result, or null if the model abstained or confidence was below floor. */
  result: T | null;
  /** True when result is non-null AND confidence >= minConfidence. */
  confident: boolean;
  /** Self-reported confidence in [0, 1]. */
  confidence: number;
  /** Reason the model gave for abstaining, if any. */
  reason?: string;
  /** Quoted spans from the source text the model cited. */
  citations: string[];
}

export interface MaybeExtractOptions<T> {
  /**
   * Caller-supplied validator. Take the raw extracted JSON value and return
   * a validated T, or null if it fails validation.
   */
  validate: (raw: ExampleCo) => T | null;
  /** What we're trying to extract, plain English. Used in the prompt envelope. */
  description: string;
  /** Source text the model is allowed to extract from. */
  sourceText: string;
  /**
   * Inject the LLM. Receives a fully-built prompt and the source text and
   * must return a JSON string conforming to the Maybe envelope.
   */
  runExtractor: (prompt: string, sourceText: string) => Promise<string> | string;
  /** Default 0.6. Below this we flip result to null and log an abstention. */
  minConfidence?: number;
  /**
   * If true and a citation is not found verbatim in sourceText, we
   * downgrade the result. Default true — ExampleCo's no-fabrication rule.
   */
  requireGroundedCitations?: boolean;
  /**
   * Override the abstentions log path. Default
   * `${cwd}/data/agent/abstentions.jsonl`.
   */
  abstentionsLogPath?: string;
  /** Optional tag so the briefing can group abstentions by extractor. */
  extractorTag?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.6;

export async function maybeExtract<T>(
  opts: MaybeExtractOptions<T>,
): Promise<MaybeResult<T>> {
  const {
    validate,
    description,
    sourceText,
    runExtractor,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    requireGroundedCitations = true,
    abstentionsLogPath,
    extractorTag,
  } = opts;

  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`maybeExtract: minConfidence must be in [0, 1], got ${minConfidence}`);
  }

  const prompt = buildMaybePrompt(description);

  let rawString: string;
  try {
    rawString = await runExtractor(prompt, sourceText);
  } catch (err) {
    return logAbstention<T>(
      {
        result: null,
        confident: false,
        confidence: 0,
        reason: `extractor failed: ${err instanceof Error ? err.message : String(err)}`,
        citations: [],
      },
      { description, sourceText, extractorTag, abstentionsLogPath },
    );
  }

  let parsed: MaybeRaw;
  try {
    parsed = parseMaybeJson(rawString);
  } catch (err) {
    return logAbstention<T>(
      {
        result: null,
        confident: false,
        confidence: 0,
        reason: `unparseable extractor output: ${err instanceof Error ? err.message : String(err)}`,
        citations: [],
      },
      { description, sourceText, extractorTag, abstentionsLogPath },
    );
  }

  const confidence = clamp01(parsed.confidence);
  const citations = Array.isArray(parsed.citations) ? parsed.citations.filter((c) => typeof c === 'string') : [];

  // Citation grounding check.
  if (requireGroundedCitations && citations.length > 0) {
    const ungrounded = citations.filter((c) => !sourceText.includes(c));
    if (ungrounded.length > 0) {
      return logAbstention<T>(
        {
          result: null,
          confident: false,
          confidence,
          reason: `ungrounded citations: ${ungrounded.length}/${citations.length} not found in source`,
          citations,
        },
        { description, sourceText, extractorTag, abstentionsLogPath },
      );
    }
  }

  // Explicit model abstention.
  if (parsed.result === null || parsed.result === undefined) {
    return logAbstention<T>(
      {
        result: null,
        confident: false,
        confidence,
        reason: parsed.abstain_reason ?? 'model returned null',
        citations,
      },
      { description, sourceText, extractorTag, abstentionsLogPath },
    );
  }

  // Validate against caller's schema.
  const validated = validate(parsed.result);
  if (validated === null) {
    return logAbstention<T>(
      {
        result: null,
        confident: false,
        confidence,
        reason: 'extracted value failed validation',
        citations,
      },
      { description, sourceText, extractorTag, abstentionsLogPath },
    );
  }

  // Confidence floor.
  if (confidence < minConfidence) {
    return logAbstention<T>(
      {
        result: null,
        confident: false,
        confidence,
        reason: `confidence ${confidence.toFixed(2)} < floor ${minConfidence}`,
        citations,
      },
      { description, sourceText, extractorTag, abstentionsLogPath },
    );
  }

  return {
    result: validated,
    confident: true,
    confidence,
    citations,
    reason: parsed.abstain_reason,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Wrap any extraction prompt with the Maybe envelope. Public for testing. */
export function buildMaybePrompt(description: string): string {
  return [
    `You are extracting structured data: ${description}.`,
    '',
    'Return a single JSON object with this shape:',
    '{',
    '  "result":         T | null,        // null if unsure or not present in source',
    '  "confidence":     number in [0,1], // your calibrated certainty',
    '  "abstain_reason": string?,         // populated when result is null or low-confidence',
    '  "citations":      string[]         // verbatim quoted spans from the source supporting result',
    '}',
    '',
    'Rules:',
    '- If the source does not clearly answer the question, set result to null and explain in abstain_reason.',
    '- Every citation MUST appear character-for-character in the source. Do not paraphrase quotes.',
    '- Calibrate confidence honestly. Below 0.6 means "I would not bet on this."',
    '- Output ONLY the JSON object. No prose, no markdown fence.',
  ].join('\n');
}

/**
 * Parse the model's output as a Maybe envelope. Tolerates a leading markdown
 * fence and surrounding whitespace, since models often emit ```json blocks
 * even when told not to.
 */
export function parseMaybeJson(raw: string): MaybeRaw {
  const trimmed = raw.trim();
  // Strip ```json ... ``` if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  const parsed = JSON.parse(candidate) as Record<string, ExampleCo>;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('extractor output is not a JSON object');
  }
  if (typeof parsed.confidence !== 'number') {
    throw new Error('missing or non-numeric "confidence"');
  }
  return {
    result: parsed.result,
    confidence: parsed.confidence,
    abstain_reason: typeof parsed.abstain_reason === 'string' ? parsed.abstain_reason : undefined,
    citations: Array.isArray(parsed.citations) ? (parsed.citations as string[]) : [],
  };
}

interface LogContext {
  description: string;
  sourceText: string;
  extractorTag?: string;
  abstentionsLogPath?: string;
}

function logAbstention<T>(out: MaybeResult<T>, ctx: LogContext): MaybeResult<T> {
  const logPath = ctx.abstentionsLogPath ?? defaultAbstentionsPath();
  const entry = {
    timestamp: new Date().toISOString(),
    extractor_tag: ctx.extractorTag,
    description: ctx.description,
    confidence: out.confidence,
    reason: out.reason,
    citations: out.citations,
    source_excerpt: ctx.sourceText.slice(0, 500),
  };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* abstention logging must never break the caller */
  }
  return out;
}

function clamp01(n: ExampleCo): number {
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function defaultAbstentionsPath(): string {
  return path.join(process.cwd(), 'data', 'agent', 'abstentions.jsonl');
}
