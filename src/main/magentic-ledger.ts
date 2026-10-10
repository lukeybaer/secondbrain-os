// magentic-ledger.ts
//
// Bounded stall-recovery loop for multi-step agent work. A pure, deterministic
// reducer modeled on AutoGen / Microsoft Agent Framework's Magentic-One
// Orchestrator (the most-cited innovation in that line of work).
//
// THE GAP THIS FILLS
//   agent-step-loop-doomloop.ts *detects* stuck patterns (repeated_tool_call,
//   repeated_error, no_progress) but the loop's only response to a verdict is to
//   halt with haltReason='doom_loop'. max_steps is the other rail. Both are
//   dead-ends: a stuck session either spins to the step cap or trips the doom
//   monitor and dies. Neither RECOVERS. There is no notion of "we stalled, so
//   revise the plan and try a fresh approach a bounded number of times."
//
//   The Magentic Orchestrator is exactly that missing recovery layer. It runs
//   an inner dispatch loop guarded by a stall counter; when stalls exceed a
//   threshold it breaks the inner loop, REPLANS (rewrites its task ledger), and
//   increments a reset counter capped separately. max_rounds is the absolute
//   rail behind both.
//
// SOURCES (research 2026-06-16)
//   - Magentic-One: A Generalist Multi-Agent System, §Orchestrator
//     https://arxiv.org/html/2411.04468v1  (Task Ledger + Progress Ledger,
//     stall counter, replan-on-stall, paper default max_stalls=2)
//   - Microsoft Agent Framework, Magentic orchestration
//     https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
//     (WithMaxStalls default 3, WithMaxResets default 2, WithMaxRounds)
//
// DESIGN
//   This module is a PURE reducer. It makes NO LLM calls and does NO I/O. The
//   caller is responsible for producing a ProgressLedger each round (one LLM
//   turn answering the five fixed questions) and for executing the dispatch /
//   replan that `advance` returns. That keeps the recovery policy unit-testable
//   in isolation, matching the agent-step-loop-doomloop.ts / branch-fanout.ts
//   house style (pure functions, deterministic, composable).
//
//   It plugs into the existing doom detector: pass detectDoomLoop()'s verdict
//   (non-null => stuck) as `doomOverride` to coerce isInLoop=true, so the LLM's
//   self-assessment cannot lie its way past a real loop.

import type { DoomVerdict } from './agent-step-loop';

// ── Ledgers ────────────────────────────────────────────────────────────────

/**
 * The outer-loop plan. Rewritten wholesale on each replan; `revision` bumps so
 * callers can tell which plan a dispatch belongs to.
 */
export interface TaskLedger {
  facts: {
    given: string[]; // facts stated in the request
    toLookUp: string[]; // facts that must be retrieved
    toDerive: string[]; // facts that must be computed/reasoned
  };
  plan: string[]; // ordered subtasks
  revision: number; // bumped each replan, starts at 0
}

/**
 * The inner-loop self-assessment the caller produces each round (the five fixed
 * Magentic questions). Pure input to `advance`.
 */
export interface ProgressLedger {
  isRequestSatisfied: boolean;
  isInLoop: boolean; // team repeating itself
  isProgressBeingMade: boolean; // forward motion since last round
  nextSpeaker: string | null; // participant/agent id to dispatch
  instruction: string; // what to ask nextSpeaker
}

export interface MagenticState {
  task: TaskLedger;
  stallCount: number; // consecutive non-progress rounds since last real progress
  resetCount: number; // replans performed so far
  roundCount: number; // total rounds (absolute rail)
}

export interface MagenticLimits {
  maxRounds: number; // absolute rail
  maxStalls: number; // consecutive stalls tolerated before a replan
  maxResets: number; // replans tolerated before halting
}

export const DEFAULT_LIMITS: MagenticLimits = {
  maxRounds: 10,
  maxStalls: 3,
  maxResets: 2,
};

// ── Decision ─────────────────────────────────────────────────────────────────

export type StepDecision =
  | { kind: 'dispatch'; speaker: string; instruction: string }
  | { kind: 'replan'; reason: 'stalled' }
  | { kind: 'done' }
  | { kind: 'halt'; reason: 'max_rounds' | 'max_resets' | 'no_speaker' };

export interface AdvanceResult {
  decision: StepDecision;
  next: MagenticState;
}

// ── Construction ───────────────────────────────────────────────────────────

export function initState(task: TaskLedger): MagenticState {
  return { task, stallCount: 0, resetCount: 0, roundCount: 0 };
}

export function emptyTaskLedger(plan: string[] = []): TaskLedger {
  return { facts: { given: [], toLookUp: [], toDerive: [] }, plan, revision: 0 };
}

// ── Core reducer ───────────────────────────────────────────────────────────

/**
 * Advance the orchestration one round given the caller's ProgressLedger.
 *
 * Evaluation order (deterministic, matches the Magentic paper):
 *   1. satisfied        -> done
 *   2. round cap        -> halt(max_rounds)
 *   3. stalled?         -> isInLoop OR !isProgressBeingMade OR doomOverride present.
 *                          On a stall, bump stallCount; on real progress, reset to 0.
 *   4. stalls exceeded  -> replan if resets remain, else halt(max_resets)
 *   5. otherwise        -> dispatch nextSpeaker (halt(no_speaker) if none given)
 *
 * `doomOverride` lets the existing detectDoomLoop verdict force isInLoop=true so
 * a self-reported "making progress" cannot mask a mechanically-detected loop.
 */
export function advance(
  state: MagenticState,
  ledger: ProgressLedger,
  limits: MagenticLimits = DEFAULT_LIMITS,
  doomOverride?: DoomVerdict | null,
): AdvanceResult {
  const next: MagenticState = {
    ...state,
    roundCount: state.roundCount + 1,
  };

  if (ledger.isRequestSatisfied) {
    return { decision: { kind: 'done' }, next };
  }

  if (next.roundCount > limits.maxRounds) {
    return { decision: { kind: 'halt', reason: 'max_rounds' }, next };
  }

  const stalled = ledger.isInLoop || !ledger.isProgressBeingMade || Boolean(doomOverride);
  next.stallCount = stalled ? state.stallCount + 1 : 0;

  if (next.stallCount > limits.maxStalls) {
    if (next.resetCount + 1 > limits.maxResets) {
      return { decision: { kind: 'halt', reason: 'max_resets' }, next };
    }
    return {
      decision: { kind: 'replan', reason: 'stalled' },
      next: { ...next, resetCount: next.resetCount + 1, stallCount: 0 },
    };
  }

  if (!ledger.nextSpeaker) {
    return { decision: { kind: 'halt', reason: 'no_speaker' }, next };
  }

  return {
    decision: {
      kind: 'dispatch',
      speaker: ledger.nextSpeaker,
      instruction: ledger.instruction,
    },
    next,
  };
}

/**
 * Apply a replanned TaskLedger to the state, bumping its revision. Call this
 * after the caller's LLM rewrites the plan in response to a 'replan' decision.
 */
export function applyReplan(
  state: MagenticState,
  replanned: Omit<TaskLedger, 'revision'>,
): MagenticState {
  return {
    ...state,
    task: { ...replanned, revision: state.task.revision + 1 },
  };
}
