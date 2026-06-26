// agent-step-loop-doomloop.ts
//
// Intra-session doom-loop detector for agent-step-loop. Returns a DoomVerdict
// when the step history shows a stuck pattern, otherwise null. Designed to
// plug into the loop's optional `monitor` hook with zero glue.
//
// Backlog id doom-loop-detection (priority 98, 2026-05-29). The closest cousin
// in the codebase is pipeline-heartbeat.ts which detects cross-process stuck
// pipelines (same video_id, same error_type, N times consecutively). That
// only fires AFTER a video pipeline has spent real money on a bad regen.
// The doom monitor catches the same pattern class WITHIN a single agent
// session before the next LLM turn burns more tokens.
//
// Pattern sources (from research 2026-05-29):
//   - OpenHands StuckDetector (All-Hands-AI/OpenHands) ships four detectors:
//     repeated_action (same action + args N times), repeated_action_observation
//     (same action then same observation N times), repeated_error (same error
//     class M times in a row), and no_progress (output unchanged for N steps).
//   - Letta v1 explicitly states "termination is the agent architecture's
//     responsibility". Letta itself dropped the heartbeats default but the
//     consequence is each integrator must ship their own guard. SecondBrain's
//     loop has max_steps as the unconditional rail; this module adds the
//     smart rail.
//   - Agno open issue 7133 asks for a default tool_call_limit because absent
//     it agents call tools repeatedly and burn tokens. Same pattern, different
//     framework.
//
// What this ships:
//   - Three independent detectors, each a pure function over the steps
//     array: repeated_tool_call, repeated_error, no_progress.
//   - `detectDoomLoop(steps, opts) => DoomVerdict | null` runs all three
//     in a fixed order (repeated_tool_call > repeated_error > no_progress)
//     so the first hit wins and the verdict is deterministic.
//   - `composeMonitor(detectors)` lets callers add their own detectors
//     without forking this file. Mirrors the trace-writer composition
//     pattern from agent-step-loop-ExampleCong.ts.
//
// Pure module: no fs, no electron, no network. The loop calls the monitor
// after every step boundary; the monitor is best-effort and a thrown
// exception is swallowed (see agent-step-loop.ts safeMonitor).

import * as crypto from 'crypto';
import type { StepRecord, DoomVerdict, DoomMonitor } from './agent-step-loop';

// ── Options ──────────────────────────────────────────────────────────────────

export interface DoomLoopOptions {
  /**
   * Consecutive (tool, args_hash) repeats that trip the repeated_tool_call
   * detector. Default 3. Set higher for surfaces that legitimately retry
   * (e.g. polling); set to 0 to disable.
   */
  repeatedToolCallThreshold?: number;
  /**
   * Consecutive tool errors that trip the repeated_error detector. Default 3.
   * Counts step records whose tool_calls include at least one .error field.
   */
  repeatedErrorThreshold?: number;
  /**
   * Number of consecutive steps whose normalized assistant_content matches
   * before no_progress fires. Default 3. Whitespace-collapsed lowercase
   * compare; empty content never counts as a match.
   */
  noProgressThreshold?: number;
  /**
   * Minimum step count before any detector fires. Default 2. Guards against
   * tripping on a single retried step or a one-shot answer.
   */
  warmupSteps?: number;
}

const DEFAULT_OPTS: Required<DoomLoopOptions> = {
  repeatedToolCallThreshold: 3,
  repeatedErrorThreshold: 3,
  noProgressThreshold: 3,
  warmupSteps: 2,
};

// ── Detectors ────────────────────────────────────────────────────────────────

type Detector = (
  steps: ReadonlyArray<StepRecord>,
  opts: Required<DoomLoopOptions>,
) => DoomVerdict | null;

/**
 * repeated_tool_call: the last N steps each invoked the same (tool, args)
 * pair (N = repeatedToolCallThreshold). Detected by hashing each step's
 * canonicalized tool-call signature and comparing the trailing window.
 */
export const repeatedToolCallDetector: Detector = (steps, opts) => {
  const N = opts.repeatedToolCallThreshold;
  if (N <= 0 || steps.length < N) return null;

  const tail = steps.slice(-N);
  const sigs = tail.map(stepCallSignature).filter((s): s is string => s !== null);
  if (sigs.length < N) return null;

  const first = sigs[0];
  if (!sigs.every((s) => s === first)) return null;

  const example = tail[tail.length - 1].tool_calls[0];
  return {
    pattern: 'repeated_tool_call',
    detail: `tool "${example?.name ?? '?'}" called ${N} steps in a row with the same arguments`,
  };
};

/**
 * repeated_error: the last M consecutive step records contained at least one
 * tool call with an error field (M = repeatedErrorThreshold). Matches the
 * "tool keeps failing, model keeps retrying" failure mode.
 */
export const repeatedErrorDetector: Detector = (steps, opts) => {
  const M = opts.repeatedErrorThreshold;
  if (M <= 0 || steps.length < M) return null;

  const tail = steps.slice(-M);
  if (!tail.every(stepHasError)) return null;

  // Surface the most common error category in the window so the briefing
  // log can group similar incidents.
  const errs = tail
    .flatMap((s) => s.tool_calls.map((c) => c.error).filter(Boolean) as string[])
    .map((e) => e.slice(0, 80));
  const top = mostCommon(errs) ?? errs[0] ?? 'ExampleCo';

  return {
    pattern: 'repeated_error',
    detail: `${M} consecutive steps errored; example: ${top}`,
  };
};

/**
 * no_progress: the last K assistant messages are identical (after whitespace
 * collapse + lowercase). Catches the "model says the same thing every step"
 * failure mode that does not show up as repeated_tool_call when the model
 * varies its tool arguments slightly but adds no new content.
 */
export const noProgressDetector: Detector = (steps, opts) => {
  const K = opts.noProgressThreshold;
  if (K <= 0 || steps.length < K) return null;

  const tail = steps.slice(-K);
  const normalized = tail.map((s) => normalize(s.assistant_content));
  if (normalized.some((n) => n.length === 0)) return null;

  const first = normalized[0];
  if (!normalized.every((n) => n === first)) return null;

  return {
    pattern: 'no_progress',
    detail: `assistant content unchanged across ${K} steps`,
  };
};

const ORDERED_DETECTORS: Detector[] = [
  repeatedToolCallDetector,
  repeatedErrorDetector,
  noProgressDetector,
];

// ── Composer ─────────────────────────────────────────────────────────────────

/**
 * Run the standard detector triple and return the first hit. The order
 * (repeated_tool_call > repeated_error > no_progress) is fixed so the verdict
 * for a given step history is deterministic and reproducible across runs.
 */
export function detectDoomLoop(
  steps: ReadonlyArray<StepRecord>,
  opts?: DoomLoopOptions,
): DoomVerdict | null {
  const merged: Required<DoomLoopOptions> = { ...DEFAULT_OPTS, ...(opts ?? {}) };
  if (steps.length < merged.warmupSteps) return null;
  for (const det of ORDERED_DETECTORS) {
    const v = det(steps, merged);
    if (v) return v;
  }
  return null;
}

/**
 * Compose extra caller-supplied detectors with the standard triple. Custom
 * detectors run AFTER the standard ones in the order provided, so adding
 * one cannot mask a built-in verdict.
 */
export function composeMonitor(
  extra: Detector[] = [],
  opts?: DoomLoopOptions,
): DoomMonitor {
  const merged: Required<DoomLoopOptions> = { ...DEFAULT_OPTS, ...(opts ?? {}) };
  return (steps) => {
    if (steps.length < merged.warmupSteps) return null;
    for (const det of ORDERED_DETECTORS) {
      const v = det(steps, merged);
      if (v) return v;
    }
    for (const det of extra) {
      const v = det(steps, merged);
      if (v) return v;
    }
    return null;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stepCallSignature(step: StepRecord): string | null {
  if (!step.tool_calls || step.tool_calls.length === 0) return null;
  // Sorted by name then by canonical args so step order inside a step does
  // not affect the signature (model may emit a parallel tool call in any
  // order).
  const parts = step.tool_calls
    .map((c) => `${c.name} ${canonicalize(c.arguments ?? {})}`)
    .sort();
  return crypto.createHash('sha1').update(parts.join('')).digest('hex');
}

function stepHasError(step: StepRecord): boolean {
  return (step.tool_calls ?? []).some((c) => typeof c.error === 'string' && c.error.length > 0);
}

function normalize(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function canonicalize(value: ExampleCo): string {
  // Deterministic JSON: keys sorted recursively. Plain stringify is enough
  // because args are already JSON-ish (numbers, strings, booleans, arrays,
  // and plain objects). Anything fancier comes out as the same value across
  // calls so the equality check holds.
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, ExampleCo>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function mostCommon(items: string[]): string | null {
  if (items.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}
