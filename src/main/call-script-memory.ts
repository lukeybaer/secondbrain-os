// call-script-memory.ts
//
// Procedural memory for Amy's call scripts, inspired by mem0's procedural memory
// pattern (mem0.ai/blog/state-of-ai-agent-memory-2026). Stores learned call
// patterns (openings, objection handlers, success signals) indexed by call_type.
// After each call completes, Amy extracts what worked. On the next call of the
// same type, these patterns are injected into her pre-call context window.
//
// Storage: file-based JSONL, one entry per extraction, in the existing
// data/agent/ directory. In-memory index is rebuilt on first read.
//
// Call types are free-form strings (e.g. "dentist", "vendor", "contact-warmup").
// The schema is intentionally loose so it evolves without code changes.

import * as fs from 'fs';
import * as path from 'path';

export interface CallScriptPattern {
  id: string;
  call_type: string;
  extracted_at: string;
  outcome: 'success' | 'partial' | 'failure';
  opening: string;
  objection_handlers: string[];
  success_signals: string[];
  notes: string;
  weight: number; // 0..1, decays over time, boosts on repeated success
}

export interface CallScriptContext {
  call_type: string;
  top_patterns: CallScriptPattern[];
  synthesized_opening: string;
  synthesized_objections: string[];
  pattern_count: number;
}

const PATTERN_FILE_NAME = 'call-script-patterns.jsonl';
const MAX_PATTERNS_PER_TYPE = 20;
const MIN_WEIGHT_TO_SURFACE = 0.2;

function patternFilePath(userData: string): string {
  return path.join(userData, 'data', 'agent', PATTERN_FILE_NAME);
}

function loadAllPatterns(userData: string): CallScriptPattern[] {
  const fp = patternFilePath(userData);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf-8').trim().split('\n').filter(Boolean);
  const patterns: CallScriptPattern[] = [];
  for (const line of lines) {
    try {
      patterns.push(JSON.parse(line) as CallScriptPattern);
    } catch {
      /* skip malformed */
    }
  }
  return patterns;
}

/**
 * Append a new learned pattern after a call completes.
 */
export function appendCallPattern(
  userData: string,
  pattern: Omit<CallScriptPattern, 'id' | 'extracted_at'>,
): void {
  const fp = patternFilePath(userData);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const record: CallScriptPattern = {
    ...pattern,
    id: `csp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    extracted_at: new Date().toISOString(),
  };
  fs.appendFileSync(fp, JSON.stringify(record) + '\n');
}

/**
 * Boost the weight of a pattern (called when a similar opening led to success).
 * Rewrites the file — only called once per call completion so perf is fine.
 */
export function boostPattern(userData: string, patternId: string, delta = 0.15): void {
  const fp = patternFilePath(userData);
  if (!fs.existsSync(fp)) return;
  const patterns = loadAllPatterns(userData);
  const updated = patterns.map((p) =>
    p.id === patternId ? { ...p, weight: Math.min(1, p.weight + delta) } : p,
  );
  fs.writeFileSync(fp, updated.map((p) => JSON.stringify(p)).join('\n') + '\n');
}

/**
 * Retrieve a synthesized context block for a given call type.
 * Returns the top patterns plus a ready-to-inject text summary.
 * Returns null if no useful patterns exist yet.
 */
export function getCallScriptContext(userData: string, callType: string): CallScriptContext | null {
  const all = loadAllPatterns(userData);
  const relevant = all
    .filter(
      (p) =>
        p.call_type.toLowerCase() === callType.toLowerCase() && p.weight >= MIN_WEIGHT_TO_SURFACE,
    )
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_PATTERNS_PER_TYPE);

  if (relevant.length === 0) return null;

  // Synthesize the top opening (highest-weight success pattern)
  const successPatterns = relevant.filter((p) => p.outcome === 'success');
  const synthesizedOpening =
    successPatterns.length > 0 ? successPatterns[0].opening : relevant[0].opening;

  // Collect unique objection handlers across top patterns, deduplicated
  const allHandlers = relevant.flatMap((p) => p.objection_handlers);
  const synthesizedObjections = [...new Set(allHandlers)].slice(0, 6);

  return {
    call_type: callType,
    top_patterns: relevant.slice(0, 5),
    synthesized_opening: synthesizedOpening,
    synthesized_objections: synthesizedObjections,
    pattern_count: relevant.length,
  };
}

/**
 * Format a CallScriptContext into a text block suitable for injection into
 * Amy's pre-call system prompt or live-call-control context injection.
 */
export function formatCallScriptContextBlock(ctx: CallScriptContext): string {
  const lines: string[] = [
    `## Learned Call Patterns (${ctx.call_type}, ${ctx.pattern_count} samples)`,
    '',
    `**Proven opening:** ${ctx.synthesized_opening}`,
  ];

  if (ctx.synthesized_objections.length > 0) {
    lines.push('', '**Objection handlers that worked:**');
    ctx.synthesized_objections.forEach((h) => lines.push(`- ${h}`));
  }

  const notes = ctx.top_patterns
    .filter((p) => p.notes.trim().length > 0)
    .map((p) => `- ${p.notes}`);
  if (notes.length > 0) {
    lines.push('', '**Field notes:**');
    lines.push(...notes.slice(0, 3));
  }

  return lines.join('\n');
}

/**
 * Apply time-based weight decay across all patterns. Call once per nightly pass.
 * Patterns below MIN_WEIGHT_TO_SURFACE remain in the file but are not surfaced.
 */
export function decayCallPatterns(userData: string, decayRate = 0.03): void {
  const fp = patternFilePath(userData);
  if (!fs.existsSync(fp)) return;
  const patterns = loadAllPatterns(userData);
  const decayed = patterns.map((p) => ({ ...p, weight: Math.max(0, p.weight - decayRate) }));
  fs.writeFileSync(fp, decayed.map((p) => JSON.stringify(p)).join('\n') + '\n');
}
