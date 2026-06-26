// task-context-builder.ts
//
// CrewAI-style "output of task A becomes input of task B" wiring for the
// Task Spine. CrewAI lets a task declare `context: [taskA, taskB]` and the
// framework automatically renders those tasks' completed outputs into the
// follow-on task's prompt, so a research task can hand its findings to a
// writing task without any caller plumbing.
//
// SecondBrain has the spine (task-store.ts) and a `parentId` field, but
// parentId is just a back-pointer for the briefing tree view. Nothing
// renders prior task outputs into a follow-on prompt. Today, every
// place that wants chained context (the briefing pipeline handing dossier
// research into a draft writer, the regen loop handing rejection feedback
// into a re-generator) inlines its own boilerplate to fetch the upstream
// task's resultSummary and string-concat it onto the new prompt.
//
// This module ships one pure builder that any caller can use:
//
//   const prefix = buildTaskContextPrefix({
//     upstreamTaskIds: ['abc-uuid', 'def-uuid'],
//     getTask: (id) => taskStore.getTask(id),
//     maxCharsPerTask: 800,
//     maxTotalChars: 4000,
//   });
//   const promptWithContext = prefix ? `${prefix}\n\n${userPrompt}` : userPrompt;
//
// Pure module: no fs, no electron, no task-store import. The caller
// supplies a getTask(id) lookup, which makes this testable without
// booting the spine.

// ── Types ───────────────────────────────────────────────────────────────

/**
 * The minimal shape we read off a Task. Mirrors task-store.Task fields
 * but kept narrow so this module does not have to import task-store and
 * pick up its electron + fs side effects.
 */
export interface UpstreamTaskShape {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  resultSummary?: string;
  completedAt?: string;
  error?: string;
}

export type GetTaskFn = (id: string) => UpstreamTaskShape | null | undefined;

export interface BuildContextOpts {
  upstreamTaskIds: string[];
  getTask: GetTaskFn;
  /**
   * Per-task character cap on the rendered resultSummary. Keeps a single
   * verbose upstream from eating the whole budget. Default 800.
   */
  maxCharsPerTask?: number;
  /**
   * Overall character cap across all tasks. Truncates at the boundary
   * between tasks (does not split mid-summary). Default 4000.
   */
  maxTotalChars?: number;
  /**
   * If true, include tasks that ended in failure (with their error text
   * instead of resultSummary). Useful for regen-from-rejection flows.
   * Default false.
   */
  includeFailed?: boolean;
}

export interface UpstreamBlock {
  id: string;
  title: string;
  kind: string;
  status: string;
  completedAt: string;
  body: string;
}

export interface BuildContextResult {
  prefix: string;
  blocks: UpstreamBlock[];
  /** Ids the caller asked for that were not findable or not usable. */
  skipped: Array<{ id: string; reason: 'not_found' | 'no_output' | 'wrong_status' | 'truncated_off_end' }>;
}

// ── Builder ─────────────────────────────────────────────────────────────

/**
 * Render a "Prior context:" prompt prefix from a list of upstream task ids.
 *
 * A task is INCLUDED when its status is 'done' or 'awaiting-review' AND it
 * has a resultSummary. A task in 'failed' status is included only when
 * `includeFailed` is true, with its error text in place of resultSummary.
 *
 * Returns an empty prefix and a populated `skipped` list when nothing
 * usable was found, so the caller can decide whether to abort or proceed
 * with no context.
 */
export function buildTaskContext(opts: BuildContextOpts): BuildContextResult {
  const maxPer = Math.max(50, opts.maxCharsPerTask ?? 800);
  const maxTotal = Math.max(maxPer, opts.maxTotalChars ?? 4000);
  const includeFailed = opts.includeFailed === true;

  const blocks: UpstreamBlock[] = [];
  const skipped: BuildContextResult['skipped'] = [];

  for (const id of opts.upstreamTaskIds) {
    const t = opts.getTask(id);
    if (!t) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    const status = t.status ?? '';
    const isUsableStatus =
      status === 'done' ||
      status === 'awaiting-review' ||
      (includeFailed && status === 'failed');
    if (!isUsableStatus) {
      skipped.push({ id, reason: 'wrong_status' });
      continue;
    }
    const rawBody =
      status === 'failed'
        ? (t.error ?? '').trim()
        : (t.resultSummary ?? '').trim();
    if (!rawBody) {
      skipped.push({ id, reason: 'no_output' });
      continue;
    }
    const body = truncate(rawBody, maxPer);
    blocks.push({
      id: t.id,
      title: t.title ?? '(no title)',
      kind: t.kind ?? 'ExampleCo',
      status,
      completedAt: t.completedAt ?? '',
      body,
    });
  }

  // Total-budget pass: keep blocks in order until the budget is hit, then
  // drop any remaining ones with reason 'truncated_off_end' so the caller
  // sees what got dropped vs what got included.
  const kept: UpstreamBlock[] = [];
  let running = 0;
  for (const b of blocks) {
    const rendered = renderBlock(b);
    if (running + rendered.length > maxTotal && kept.length > 0) {
      skipped.push({ id: b.id, reason: 'truncated_off_end' });
      continue;
    }
    kept.push(b);
    running += rendered.length;
  }

  if (kept.length === 0) {
    return { prefix: '', blocks: [], skipped };
  }

  const header =
    kept.length === 1
      ? 'Prior context from 1 upstream task:'
      : `Prior context from ${kept.length} upstream tasks:`;
  const body = kept.map(renderBlock).join('\n\n');

  return {
    prefix: `${header}\n\n${body}`,
    blocks: kept,
    skipped,
  };
}

/**
 * Convenience wrapper for callers that only want the prefix string. Equal
 * to `buildTaskContext(opts).prefix`. Returns '' when nothing usable.
 */
export function buildTaskContextPrefix(opts: BuildContextOpts): string {
  return buildTaskContext(opts).prefix;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function renderBlock(b: UpstreamBlock): string {
  const titleLine = `[${b.kind}] ${b.title} (${b.status})`;
  return `${titleLine}\n${b.body}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const suffix = ' ... [trimmed]';
  const headLen = Math.max(0, max - suffix.length);
  return `${s.slice(0, headLen).trimEnd()}${suffix}`;
}
