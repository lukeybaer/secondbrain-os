// conversation-compressor.ts
//
// TaskWeaver-inspired round compression for Amy's interaction history.
//
// TaskWeaver's RoundCompressor keeps the last N rounds verbatim and incrementally
// compresses older rounds into a chained previous_summary field. Each compression
// pass produces a new summary from: previous_summary + oldest uncompressed rounds.
// The result: unbounded history at O(1) token cost, with recency preserved verbatim.
//
// Amy adaptation: "rounds" = reflection log entries (nightly tasks, Vapi calls,
// Gmail dispatches). When the log grows > KEEP_RECENT, compress the tail using Haiku.
// The compressed context is injected into Vapi calls and the daily briefing to give
// Amy continuity across sessions without flooding the token window.
//
// Distinct from sleep-time-consolidation (which handles core-memory-block byte
// overflow). This module handles *interaction history* -- what Amy did, what
// happened, what she learned -- across all surfaces.
//
// Run 22 of the nightly enhancement cycle.
// Reference: https://github.com/microsoft/TaskWeaver/blob/main/taskweaver/memory/round.py

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RoundEntry {
  timestamp: string;
  task: string;
  goal: string;
  outcome: string;
  learnings: string[];
}

export interface CompressedContext {
  previous_summary: string;    // accumulated Haiku summary of all compressed rounds
  recent_rounds: RoundEntry[]; // last KEEP_RECENT rounds verbatim (uncompressed)
  rounds_compressed: number;   // total rounds folded into previous_summary
  rounds_kept: number;         // how many recent rounds are uncompressed
  last_compressed_at: string;  // ISO timestamp of last compression pass
  version: number;             // monotonically increasing, for cache invalidation
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const KEEP_RECENT = 5;   // rounds to keep uncompressed
export const COMPRESS_THRESHOLD = 10; // trigger compression when total exceeds this

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Returns the default state file path. Can be overridden for tests. */
export function defaultStatePath(dataDir: string): string {
  return path.join(dataDir, 'conversation-compressed-context.json');
}

// ── I/O ───────────────────────────────────────────────────────────────────────

export function readState(statePath: string): CompressedContext | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as CompressedContext;
  } catch {
    return null;
  }
}

export function writeState(statePath: string, ctx: CompressedContext): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(ctx, null, 2), 'utf8');
}

// ── Read reflection log ───────────────────────────────────────────────────────

export function readReflectionLog(logPath: string, limit = 200): RoundEntry[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  const entries: RoundEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const j = JSON.parse(line);
      if (j.timestamp && j.task) {
        entries.push({
          timestamp: j.timestamp,
          task: j.task,
          goal: j.goal ?? '',
          outcome: j.outcome ?? '',
          learnings: Array.isArray(j.learnings) ? j.learnings : [],
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ── Compression ───────────────────────────────────────────────────────────────

function formatRoundsForPrompt(rounds: RoundEntry[]): string {
  return rounds
    .map(
      (r) =>
        `[${r.timestamp}] ${r.task}: ${r.goal}. Outcome: ${r.outcome}. Learned: ${r.learnings.join('; ') || 'nothing new'}`,
    )
    .join('\n');
}

/**
 * Compress a batch of old rounds into an updated summary using Claude Haiku.
 * Chains previous_summary + new rounds -> new summary.
 */
export async function compressRounds(
  previousSummary: string,
  roundsToCompress: RoundEntry[],
  apiKey: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const roundsText = formatRoundsForPrompt(roundsToCompress);

  const prompt = previousSummary
    ? `You are summarizing Amy's (AI executive assistant) interaction history for context injection.

PREVIOUS SUMMARY:
${previousSummary}

NEW ROUNDS TO FOLD IN:
${roundsText}

Produce an updated summary that merges both. Keep it under 400 words. Preserve: key outcomes, lessons learned, patterns, open items. Omit: timestamps, redundancy, routine successes with no learnings. Write in third-person past tense ("Amy completed...", "The system learned...").`
    : `Summarize Amy's (AI executive assistant) interaction history for context injection.

ROUNDS:
${roundsText}

Summarize in under 400 words. Preserve: key outcomes, lessons learned, patterns, open items. Omit: timestamps, routine successes with no learnings. Third-person past tense.`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = msg.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text.trim() : previousSummary;
}

// ── Main API ──────────────────────────────────────────────────────────────────

export interface CompressorOptions {
  reflectionLogPath: string;
  statePath: string;
  apiKey?: string;
  keepRecent?: number;
  compressThreshold?: number;
}

/**
 * Run a compression pass over the reflection log.
 * Returns the updated CompressedContext.
 * If total rounds <= compressThreshold, no compression occurs.
 */
export async function runCompressionPass(opts: CompressorOptions): Promise<CompressedContext> {
  const keep = opts.keepRecent ?? KEEP_RECENT;
  const threshold = opts.compressThreshold ?? COMPRESS_THRESHOLD;

  const allRounds = readReflectionLog(opts.reflectionLogPath);
  const existing = readState(opts.statePath);

  const prevSummary = existing?.previous_summary ?? '';
  const prevCompressed = existing?.rounds_compressed ?? 0;
  const prevVersion = existing?.version ?? 0;

  // Determine which rounds are new (not yet compressed or kept from last pass)
  const alreadyKept = existing?.recent_rounds ?? [];
  const alreadyKeptTimes = new Set(alreadyKept.map((r) => r.timestamp));

  // All rounds not already in previous recent_rounds
  const newRounds = allRounds.filter((r) => !alreadyKeptTimes.has(r.timestamp));

  // Pool: old kept rounds + new rounds
  const poolRounds = [...alreadyKept, ...newRounds];

  // If under threshold, just update the recent_rounds without compression
  if (poolRounds.length <= threshold) {
    const ctx: CompressedContext = {
      previous_summary: prevSummary,
      recent_rounds: poolRounds.slice(-keep),
      rounds_compressed: prevCompressed,
      rounds_kept: Math.min(poolRounds.length, keep),
      last_compressed_at: existing?.last_compressed_at ?? new Date().toISOString(),
      version: prevVersion,
    };
    writeState(opts.statePath, ctx);
    return ctx;
  }

  // Need compression: fold oldest rounds into summary
  const roundsToCompress = poolRounds.slice(0, poolRounds.length - keep);
  const recentRounds = poolRounds.slice(-keep);

  const apiKey = opts.apiKey ?? getConfig().anthropicApiKey;
  if (!apiKey) {
    // No API key: skip compression, keep recent only
    const ctx: CompressedContext = {
      previous_summary: prevSummary,
      recent_rounds: recentRounds,
      rounds_compressed: prevCompressed + roundsToCompress.length,
      rounds_kept: recentRounds.length,
      last_compressed_at: new Date().toISOString(),
      version: prevVersion + 1,
    };
    writeState(opts.statePath, ctx);
    return ctx;
  }

  const newSummary = await compressRounds(prevSummary, roundsToCompress, apiKey);

  const ctx: CompressedContext = {
    previous_summary: newSummary,
    recent_rounds: recentRounds,
    rounds_compressed: prevCompressed + roundsToCompress.length,
    rounds_kept: recentRounds.length,
    last_compressed_at: new Date().toISOString(),
    version: prevVersion + 1,
  };
  writeState(opts.statePath, ctx);
  return ctx;
}

/**
 * Get the compressed context string for injection into Vapi system prompts or briefing.
 * Format:
 *   [AMY HISTORY SUMMARY]
 *   {previous_summary}
 *   [RECENT ACTIVITY]
 *   {recent_rounds formatted}
 *   [END HISTORY]
 */
export function formatContextForInjection(ctx: CompressedContext): string {
  const parts: string[] = [];

  if (ctx.previous_summary) {
    parts.push(`[AMY HISTORY SUMMARY]\n${ctx.previous_summary}`);
  }

  if (ctx.recent_rounds.length > 0) {
    const recent = ctx.recent_rounds
      .map((r) => `- ${r.task} (${r.outcome}): ${r.learnings.join('; ') || 'no new learnings'}`)
      .join('\n');
    parts.push(`[RECENT ACTIVITY]\n${recent}`);
  }

  if (parts.length === 0) return '';

  return parts.join('\n\n') + '\n[END HISTORY]';
}

/**
 * Convenience: read current state and return formatted injection string.
 * Returns empty string if no state exists.
 */
export function getCompressedContext(statePath: string): string {
  const ctx = readState(statePath);
  if (!ctx) return '';
  return formatContextForInjection(ctx);
}
