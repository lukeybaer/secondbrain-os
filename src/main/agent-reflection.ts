// agent-reflection.ts
//
// CrewAI/AutoGen inspired reflection records. After a multi-step task Amy
// appends a structured reflection entry: goal, steps, outcome, learnings.
// This is intentionally minimal — one function, one record type, one file.
//
// The reflection log already exists at data/agent/ea-reflection-log.jsonl.
// This module adds a typed append so the nightly briefing can aggregate
// "what Amy learned last night" as a first-class section without scraping
// free-form markdown.

import * as fs from 'fs';
import * as path from 'path';

export type ReflectionOutcome = 'success' | 'partial' | 'failure' | 'dry-run';

export interface ReflectionRecord {
  timestamp: string;
  task: string;
  goal: string;
  steps: string[];
  outcome: ReflectionOutcome;
  learnings: string[];
  related_files?: string[];
}

export function buildReflection(
  task: string,
  goal: string,
  steps: string[],
  outcome: ReflectionOutcome,
  learnings: string[],
  related_files?: string[],
): ReflectionRecord {
  return {
    timestamp: new Date().toISOString(),
    task,
    goal,
    steps,
    outcome,
    learnings,
    ...(related_files && related_files.length > 0 ? { related_files } : {}),
  };
}

export function appendReflection(logPath: string, record: ReflectionRecord): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

export function readReflections(logPath: string, limit = 50): ReflectionRecord[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const slice = lines.slice(-limit);
  const records: ReflectionRecord[] = [];
  for (const line of slice) {
    try {
      records.push(JSON.parse(line) as ReflectionRecord);
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}

// Reflection digest
//
// summarizeReflections() collapses a batch of reflection records into one
// typed digest so the 5:30 AM briefing can render a "what Amy learned" card
// without scraping free-form JSONL. Mirrors CrewAI/AutoGen reflection-record
// aggregation and AgentOps run summaries: counts by outcome, a scorable
// success rate, distinct tasks touched, and the most recent de-duplicated
// learnings.

export interface ReflectionSummary {
  total: number;
  by_outcome: Record<ReflectionOutcome, number>;
  // distinct task names, sorted alphabetically
  tasks: string[];
  // success / (success + partial + failure). dry-run rows are excluded
  // because they are not scorable attempts. 0 when nothing is scorable.
  success_rate: number;
  // de-duplicated learnings, most recent first, capped at maxLearnings
  top_learnings: string[];
  // ISO timestamps of the earliest and latest record, null when empty
  window_start: string | null;
  window_end: string | null;
}

const OUTCOMES: ReflectionOutcome[] = ['success', 'partial', 'failure', 'dry-run'];

export function summarizeReflections(
  records: ReadonlyArray<ReflectionRecord>,
  maxLearnings = 10,
): ReflectionSummary {
  const by_outcome: Record<ReflectionOutcome, number> = {
    success: 0,
    partial: 0,
    failure: 0,
    'dry-run': 0,
  };
  const taskSet = new Set<string>();
  // walk newest-first so the first time we see a learning is its latest use
  const seenLearnings = new Set<string>();
  const top_learnings: string[] = [];
  let window_start: string | null = null;
  let window_end: string | null = null;

  for (const r of records) {
    if (OUTCOMES.includes(r.outcome)) by_outcome[r.outcome] += 1;
    if (r.task) taskSet.add(r.task);
    if (r.timestamp) {
      if (window_start === null || r.timestamp < window_start) window_start = r.timestamp;
      if (window_end === null || r.timestamp > window_end) window_end = r.timestamp;
    }
  }

  for (let i = records.length - 1; i >= 0; i--) {
    for (const learning of records[i].learnings ?? []) {
      const key = learning.trim();
      if (key.length === 0 || seenLearnings.has(key)) continue;
      seenLearnings.add(key);
      top_learnings.push(key);
      if (top_learnings.length >= maxLearnings) break;
    }
    if (top_learnings.length >= maxLearnings) break;
  }

  const scorable = by_outcome.success + by_outcome.partial + by_outcome.failure;
  const success_rate = scorable === 0 ? 0 : by_outcome.success / scorable;

  return {
    total: records.length,
    by_outcome,
    tasks: [...taskSet].sort(),
    success_rate,
    top_learnings,
    window_start,
    window_end,
  };
}

// Recurring-failure detection
//
// detectRecurringFailures() groups reflections by task and flags any task
// that landed on `failure` or `partial` at least `threshold` times. This is
// the signal feed for the MemGPT-style self-improvement loop: a task failing
// repeatedly is a defect that should escalate from a memory note to a real
// fix (Luke's rule: "same rule violated twice auto-escalates to hook/test").
// dry-run outcomes never count as failures.

export interface RecurringFailure {
  task: string;
  // count of failure + partial outcomes for this task
  failure_count: number;
  // total reflection records for this task (any outcome)
  total_runs: number;
  // outcome of the most recent record for this task
  last_outcome: ReflectionOutcome;
  last_timestamp: string;
  // up to 3 learnings drawn from this task's failing records, newest first
  sample_learnings: string[];
}

// buildSelfCorrectionHint
//
// detectRecurringFailures() flags a task that has failed at least N times.
// But Amy's actual self-improvement loop needs to do something with that
// signal at the start of the NEXT attempt: inject the prior failure modes
// into the prompt so the agent does not repeat them. That is what this
// helper produces, a single ready-to-paste block.
//
// Pattern source: pydantic-ai durable_exec + retries.py (2026-04-27 commit
// b3688db on openai/openai-agents-python) wraps a failed run's structured
// error and re-prompts with that context inlined. The TaskWeaver
// `ask_self_cnt` + `revise_message` pattern is the same shape: append the
// validation error as `AttachmentType.invalid_response` before the next
// generation. SecondBrain's version is plain text because the prompts are
// already plain text and we keep this module dependency-free.
//
// Heuristics worth knowing:
//   - If only one prior failure exists we still produce a hint: "you ran
//     this once and it failed, here is the learning" is useful at attempt
//     two even though detectRecurringFailures defaults to threshold 2.
//   - Caller decides the lookback window by what they pass in; this
//     function does not filter by timestamp.
//   - Learnings de-duplicate, newest first. Empty-string learnings are
//     dropped.

export interface SelfCorrectionHintOpts {
  /**
   * Maximum number of distinct learnings to include in the hint block.
   * Defaults to 5 so the prompt overhead stays small. Pass 0 to omit the
   * learnings section entirely.
   */
  max_learnings?: number;
}

export interface SelfCorrectionHint {
  /** Whether the hint should actually be injected. False when there are
   * no failure records for the task and no dry-run notes to surface. */
  applicable: boolean;
  /** Task name copied verbatim from the input. */
  task: string;
  /** Count of failure + partial outcomes seen for this task. */
  failure_count: number;
  /** Total reflections seen for this task. */
  total_runs: number;
  /** Outcome of the most recent record, or null when nothing matches. */
  last_outcome: ReflectionOutcome | null;
  /** Deduped learnings newest-first, capped at max_learnings. */
  learnings: string[];
  /** Pre-rendered prompt block ready to paste in front of the next attempt. */
  hint_block: string;
}

const EMPTY_HINT_BLOCK = '';

export function buildSelfCorrectionHint(
  task: string,
  records: ReadonlyArray<ReflectionRecord>,
  opts: SelfCorrectionHintOpts = {},
): SelfCorrectionHint {
  const maxLearnings = Math.max(0, opts.max_learnings ?? 5);
  const taskRecords = records.filter((r) => r.task === task);

  if (taskRecords.length === 0) {
    return {
      applicable: false,
      task,
      failure_count: 0,
      total_runs: 0,
      last_outcome: null,
      learnings: [],
      hint_block: EMPTY_HINT_BLOCK,
    };
  }

  const chronological = [...taskRecords].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  const latest = chronological[chronological.length - 1];
  const failing = taskRecords.filter(
    (r) => r.outcome === 'failure' || r.outcome === 'partial',
  );

  // Newest first dedup of learnings drawn from failing records. If no
  // failing records exist (e.g. only success / dry-run) we still surface
  // learnings drawn from the latest record so the next attempt at least
  // sees what changed.
  const sourceForLearnings = failing.length > 0 ? failing : taskRecords;
  const sorted = [...sourceForLearnings].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
  const seen = new Set<string>();
  const learnings: string[] = [];
  if (maxLearnings > 0) {
    outer: for (const r of sorted) {
      for (const raw of r.learnings ?? []) {
        const l = raw.trim();
        if (l.length === 0 || seen.has(l)) continue;
        seen.add(l);
        learnings.push(l);
        if (learnings.length >= maxLearnings) break outer;
      }
    }
  }

  // Hint is applicable when there is at least one prior failure OR there
  // is at least one learning to carry forward. Pure dry-run history with
  // no learnings produces an empty applicable=false hint.
  const applicable = failing.length > 0 || learnings.length > 0;

  if (!applicable) {
    return {
      applicable: false,
      task,
      failure_count: failing.length,
      total_runs: taskRecords.length,
      last_outcome: latest.outcome,
      learnings,
      hint_block: EMPTY_HINT_BLOCK,
    };
  }

  const lines: string[] = [];
  lines.push(`## Prior attempts at "${task}"`);
  if (failing.length > 0) {
    lines.push(
      `You have run this task ${taskRecords.length} time(s) recently; ${failing.length} ended in failure or partial completion. Last outcome: ${latest.outcome}.`,
    );
  } else {
    lines.push(
      `You have run this task ${taskRecords.length} time(s) recently. Last outcome: ${latest.outcome}. Carry the prior learnings forward.`,
    );
  }
  if (learnings.length > 0) {
    lines.push('Apply these learnings before acting:');
    for (const l of learnings) lines.push(`- ${l}`);
  }
  lines.push('Do not repeat the prior failure mode. If the same root cause is about to recur, stop and escalate instead.');

  return {
    applicable: true,
    task,
    failure_count: failing.length,
    total_runs: taskRecords.length,
    last_outcome: latest.outcome,
    learnings,
    hint_block: lines.join('\n'),
  };
}

export function detectRecurringFailures(
  records: ReadonlyArray<ReflectionRecord>,
  threshold = 2,
): RecurringFailure[] {
  const byTask = new Map<string, ReflectionRecord[]>();
  for (const r of records) {
    if (!r.task) continue;
    const list = byTask.get(r.task);
    if (list) list.push(r);
    else byTask.set(r.task, [r]);
  }

  const out: RecurringFailure[] = [];
  for (const [task, list] of byTask) {
    const failing = list.filter(
      (r) => r.outcome === 'failure' || r.outcome === 'partial',
    );
    if (failing.length < threshold) continue;

    const chronological = [...list].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
    const latest = chronological[chronological.length - 1];

    const sample_learnings: string[] = [];
    for (let i = failing.length - 1; i >= 0 && sample_learnings.length < 3; i--) {
      for (const l of failing[i].learnings ?? []) {
        const key = l.trim();
        if (key.length > 0 && !sample_learnings.includes(key)) {
          sample_learnings.push(key);
          if (sample_learnings.length >= 3) break;
        }
      }
    }

    out.push({
      task,
      failure_count: failing.length,
      total_runs: list.length,
      last_outcome: latest.outcome,
      last_timestamp: latest.timestamp,
      sample_learnings,
    });
  }

  return out.sort((a, b) => b.failure_count - a.failure_count);
}
