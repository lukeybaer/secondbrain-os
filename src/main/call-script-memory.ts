/**
 * call-script-memory.ts
 *
 * Procedural memory for AI phone calls.
 *
 * Each call type (dental, sales, appointment, etc.) accumulates a JSON file
 * of learned "patterns" — effective openings, objection handlers, and success
 * signals extracted from past transcripts.  Before a new call the agent loads
 * the highest-weight patterns for that call type and injects them into the
 * system prompt so it starts with accumulated experience rather than from
 * scratch.
 *
 * Data lives under:
 *   <dataDir>/agent/call-scripts/<callType>.json
 *
 * Architecture note:
 *   This is the "Tier 2 indexed memory" layer for calls — analogous to the
 *   per-topic Markdown files described in docs/MEMORY_LAYERS.md, but stored
 *   as structured JSON so pattern weights can be sorted and decayed
 *   programmatically without LLM involvement.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single learned pattern for a given call type.
 *
 * Populated by `extractAndStoreCallPattern` in calls.ts after every completed
 * or partially-completed call.
 */
export interface CallPattern {
  /** Broad category of call, e.g. "dental", "appointment_booking", "sales". */
  call_type: string;

  /** Whether the call's goal was fully met ("success") or only partially ("partial"). */
  outcome: 'success' | 'partial';

  /** The opening line / greeting that was used. */
  opening: string;

  /** Lines that successfully deflected objections or pivoted the conversation. */
  objection_handlers: string[];

  /** Phrases or cues in the transcript that indicate the goal was reached. */
  success_signals: string[];

  /** Free-text observation from the post-call reflection step. */
  notes: string;

  /**
   * Hebbian weight in [0, 1].  Higher = more useful.
   * Successful patterns start at 0.7, partial at 0.4.
   * Weights decay slowly over time so stale patterns fade naturally.
   */
  weight: number;

  /** ISO timestamp of when this pattern was recorded. */
  recorded_at?: string;
}

/**
 * The context block returned to the caller for prompt injection.
 * Contains the top patterns ranked by weight.
 */
export interface CallScriptContext {
  call_type: string;
  patterns: CallPattern[];
}

// ── File helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the directory that holds call-script JSON files.
 * Creates the directory on first access.
 *
 * @param dataDir - Root data directory (value of `config.dataDir`).
 * @returns Absolute path to the call-scripts directory.
 */
function callScriptsDir(dataDir: string): string {
  const dir = path.join(dataDir, 'agent', 'call-scripts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Derive the file path for a given call type's pattern store.
 *
 * @param dataDir  - Root data directory.
 * @param callType - Normalised call type string (lower-case, hyphen-separated).
 * @returns Absolute path to the JSON file.
 */
function patternFilePath(dataDir: string, callType: string): string {
  // Sanitise to avoid path traversal
  const safe = callType.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(callScriptsDir(dataDir), `${safe}.json`);
}

/**
 * Load all stored patterns for a call type from disk.
 * Returns an empty array if the file does not yet exist.
 *
 * @param dataDir  - Root data directory.
 * @param callType - Call type to load.
 * @returns Array of `CallPattern` objects (may be empty).
 */
function loadPatterns(dataDir: string, callType: string): CallPattern[] {
  const fp = patternFilePath(dataDir, callType);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as CallPattern[];
  } catch {
    // Corrupted file — return empty rather than crash
    return [];
  }
}

/**
 * Persist the full pattern list for a call type back to disk.
 *
 * @param dataDir  - Root data directory.
 * @param callType - Call type to persist.
 * @param patterns - Updated array of patterns.
 */
function savePatterns(dataDir: string, callType: string, patterns: CallPattern[]): void {
  const fp = patternFilePath(dataDir, callType);
  fs.writeFileSync(fp, JSON.stringify(patterns, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a new learned pattern to the persistent store for the given call type.
 *
 * Patterns are kept sorted by weight descending so the most useful ones are
 * always at the front.  The store is capped at 50 patterns per call type to
 * prevent unbounded growth; the lowest-weight entries are pruned on overflow.
 *
 * Called by `extractAndStoreCallPattern` in calls.ts after every call.
 *
 * @param dataDir - Root data directory (`config.dataDir`).
 * @param pattern - The new pattern to record.
 */
export function appendCallPattern(dataDir: string, pattern: CallPattern): void {
  if (!dataDir) return;

  const patterns = loadPatterns(dataDir, pattern.call_type);

  const entry: CallPattern = {
    ...pattern,
    recorded_at: new Date().toISOString(),
  };

  patterns.push(entry);

  // Sort descending by weight so slicing later returns the best patterns first
  patterns.sort((a, b) => b.weight - a.weight);

  // Cap at 50 entries per call type to keep file sizes manageable
  const capped = patterns.slice(0, 50);

  savePatterns(dataDir, pattern.call_type, capped);
}

/**
 * Retrieve the top learned patterns for a given call type.
 *
 * Only patterns with weight ≥ 0.3 are returned (below that threshold patterns
 * have decayed to the point where they add more noise than signal).
 *
 * Returns `null` when no useful patterns exist yet (first call of a new type).
 *
 * @param dataDir  - Root data directory (`config.dataDir`).
 * @param callType - Call type to look up.
 * @param topN     - Maximum number of patterns to include (default: 5).
 * @returns `CallScriptContext` with the best patterns, or `null` if none exist.
 */
export function getCallScriptContext(
  dataDir: string,
  callType: string,
  topN = 5,
): CallScriptContext | null {
  if (!dataDir) return null;

  const all = loadPatterns(dataDir, callType);

  // Filter out decayed / low-confidence patterns
  const useful = all.filter((p) => p.weight >= 0.3).slice(0, topN);

  if (useful.length === 0) return null;

  return { call_type: callType, patterns: useful };
}

/**
 * Format a `CallScriptContext` as a Markdown block suitable for injection into
 * an LLM system prompt.
 *
 * The block is clearly delimited so the model can distinguish injected memory
 * from the core instruction set.  Patterns are shown in descending weight order
 * with their key phrases surfaced for direct reuse.
 *
 * @param ctx - Context object returned by `getCallScriptContext`.
 * @returns Multi-line string ready to append to a system prompt.
 */
export function formatCallScriptContextBlock(ctx: CallScriptContext): string {
  if (!ctx || ctx.patterns.length === 0) return '';

  const lines: string[] = [
    `## Learned call patterns — ${ctx.call_type}`,
    '',
    'The following patterns were extracted from previous successful calls.',
    'Use them as a starting point; adapt based on the live conversation.',
    '',
  ];

  ctx.patterns.forEach((p, i) => {
    lines.push(`### Pattern ${i + 1} (weight ${p.weight.toFixed(2)}, outcome: ${p.outcome})`);
    lines.push(`**Opening:** ${p.opening}`);

    if (p.objection_handlers.length > 0) {
      lines.push('**Objection handlers:**');
      p.objection_handlers.forEach((h) => lines.push(`  - ${h}`));
    }

    if (p.success_signals.length > 0) {
      lines.push('**Success signals:** ' + p.success_signals.join('; '));
    }

    if (p.notes) {
      lines.push(`**Notes:** ${p.notes}`);
    }

    lines.push('');
  });

  return lines.join('\n');
}
