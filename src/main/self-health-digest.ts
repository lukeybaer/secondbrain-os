/**
 * self-health-digest.ts. One digest that composes Amy's previously-orphaned
 * self-audit modules into a single artifact the runtime can act on.
 *
 * WHY THIS EXISTS (run 109, 2026-06-02). Nightly run 107 discovered that the
 * cycle keeps shipping well-tested PURE modules that no runtime file imports:
 * 71 of 148 src/main modules were orphaned, and run 107 itself then shipped
 * THREE MORE orphans (module-wiring-audit, memory-index-budget-audit,
 * memory-eviction-planner) plus the dead observability-digest aggregator.
 * "Green tests, never wired" is delivered debt, not delivered capability.
 *
 * This module breaks the cycle by USING those modules, and startup-checks.ts
 * then invokes THIS module at every app boot (see self-health-startup-wiring
 * test), so the audit capability finally runs instead of sitting on disk.
 *
 * Pure except persistSelfHealthDigest, which takes an explicit directory so
 * it stays Electron-free and unit-testable.
 */

import fs from 'fs';
import path from 'path';

import {
  buildWiringDigest,
  renderWiringHeadline,
  WiringAudit,
  AuditOptions,
} from './module-wiring-audit';
import {
  auditIndexBudget,
  renderIndexBudgetHeadline,
  IndexBudgetAudit,
} from './memory-index-budget-audit';
import { planEviction, linesFromContent, EvictionPlan } from './memory-eviction-planner';
import { buildObservabilityDigest, ObservabilityDigest } from './observability-digest';
import { buildAutonomyDigest, AutonomyDigest } from './autonomy-digest';
import { readRunSummaries } from './agent-step-loop-ExampleCong';
import {
  buildRetryPressureReport,
  readAttemptRecords,
  summarizeRetryPressure,
  RetryPressureReport,
} from './retry-pressure-report';
import { getCoreBlockHealth, formatCoreBlockHealthForBriefing } from './core-block-health';
import { readLedger, getDailyTotals, DailyTotals } from './tool-cost-ledger';
import {
  auditLedgerIntegrity,
  ClaimedTaskCost,
  TaskCostEntry,
  IntegrityAudit,
} from './tool-cost-integrity';
import { OutcomeTracker, ScopeOutcomeSummary } from './outcome-tracker';
import {
  listCapabilities,
  loadHealthEvents,
  attachHealth,
  overdueCapabilities,
  formatOverdueForBriefing,
  OverdueCapability,
} from './skill-registry';
import { readReflections, detectRecurringFailures, RecurringFailure } from './agent-reflection';
import { DecisionLog, DecisionRecord } from './agent-decision-log';
import { getInboxStats, InboxStats } from './approval-inbox';
import {
  readLedger as readTokenLedger,
  evaluateBudget,
  BudgetPolicy,
  BudgetVerdict,
} from './token-budget-governor';
import { computeTemperatures } from './memory-temperature';
import {
  recommendArchives,
  formatArchivalForBriefing,
  getArchivalStats,
  ArchivalRecommendation,
} from './memory-archival-recommender';
import { queueCounts, QueueState } from './ingest-queue';
import { sweepArchive, SweepSummary } from './task-archive';
import {
  readInjectionFlags,
  type InjectionFlagRecord,
  type InjectionCategory,
} from './untrusted-injection-scan';

/** A core-memory block to check for byte pressure. */
export interface CoreBlockInput {
  name: string;
  content: string;
  /** Hard byte limit for the block. */
  limitBytes: number;
  /** Line indexes (0-based) that are pinned and must never be evicted. */
  pinnedLineIndexes?: number[];
}

/** An eviction plan annotated with which block it belongs to. */
export type BlockEvictionPlan = EvictionPlan & { block: string };

export interface SelfHealthInputs {
  /** Directory scanned for module wiring (typically <repo>/src/main). */
  srcDir: string;
  /** Raw text of the Tier-1 index (memory/MEMORY.md). */
  indexContent: string;
  /** Optional core-memory blocks to check for eviction pressure. */
  coreBlocks?: CoreBlockInput[];
  /** Forwarded to the wiring auditor (extra entrypoint basenames). */
  wiringOptions?: AuditOptions;
  /**
   * Optional path to the tool-trace JSONL. When present, the otherwise-orphaned
   * observability-digest (tool health + error clustering) is folded into this
   * digest so the whole observability tier finally runs.
   */
  tracePath?: string;
  /**
   * Optional path to the agent-loop trace JSONL (agent-step-loop-ExampleCong's
   * LoopTraceRecords). Usually the SAME file as tracePath -- the loop shares
   * data/agent/tool-trace.jsonl with the base IPC tracer. When present the
   * otherwise-orphaned per-run autonomy rollup (summarizeByRun) is folded in as
   * the "Amy autonomy" tier: how many autonomous runs ran, their tool-call and
   * failure counts, and side effects saved by idempotency. readRunSummaries
   * skips the run-less base records that share the file, so this is safe to
   * point straight at the live trace. Any run with a failed call becomes a
   * warning. Reads gracefully empty until the loop writes run-scoped records.
   */
  loopTracePath?: string;
  /**
   * Optional path to the retry-attempts JSONL (model-retry-loop's writer
   * output). When present, per-tool retry pressure is folded in so the
   * otherwise-orphaned retry-pressure-report (run 111) finally runs; flagged
   * tools become self-health warnings. Reads gracefully empty until the
   * producer (model-retry-loop in the dispatch path) is wired.
   */
  retryAttemptsPath?: string;
  /**
   * Optional core-memory block + sleep-trigger-queue dirs. When present, live
   * per-block occupancy health (the otherwise-orphaned core-block-health) is
   * folded in; any FULL block becomes a self-health warning.
   */
  coreBlockHealthDirs?: { blocksDir: string; queueDir: string };
  /**
   * Optional path to the tool-cost ledger JSONL (tool-cost-ledger's writer
   * output). When present the otherwise-orphaned cost ledger is folded in so
   * the Claude-Max-only rule is enforced at runtime, not just in unit tests:
   * any record from a paid provider becomes a hard self-health warning (a
   * "leak"), and the day's spend is surfaced. Reads gracefully empty until a
   * producer (chat / vapi / nightly paths) writes records.
   */
  toolCostLedgerPath?: string;
  /**
   * UTC date (YYYY-MM-DD) the cost fold scopes its daily totals to. Defaults
   * to today. Injectable so tests are not clock-dependent.
   */
  todayUtc?: string;
  /**
   * Optional path to a per-task claimed-cost JSONL (rows shaped like
   * ClaimedTaskCost: {taskId, tokensIn, tokensOut, usd}). When present AND the
   * tool-cost ledger (toolCostLedgerPath) also exists, the otherwise-orphaned
   * tool-cost-integrity verifier is folded in: each task's authoritative claimed
   * total is reconciled against the sum of its captured ledger entries (the
   * ledger is re-keyed by `surface`, which is the per-task scope tag). An
   * undercount (a tool turn never recorded), overcount (a double-recorded or
   * leaked entry), or no-data (claimed spend with zero captured calls) becomes a
   * self-health warning, so the briefing never reports a spend figure the ledger
   * cannot back. This is the Agno issue #2310 lesson (assert
   * claimed == sum(captured), do not trust either number alone). Reads
   * gracefully empty until a producer stamps per-task claimed totals.
   */
  taskCostClaimsPath?: string;
  /**
   * Optional path to the outcome-tracker JSONL. When present the
   * otherwise-orphaned outcome-tracker is folded in: per-scope success rates
   * surface, and any scope failing more than maxOutcomeFailRate (with enough
   * samples) becomes a self-health warning. This is the failure-detection tier
   * (AgentOps 2026). Reads gracefully empty until a producer records outcomes.
   */
  outcomeLogPath?: string;
  /**
   * Only consider outcome records younger than this when summarizing. Defaults
   * to all-time. Injectable (with thresholds.now) for deterministic tests.
   */
  outcomeWindowMs?: number;
  /**
   * Optional path to the scheduled-tasks/ directory. When present the
   * otherwise-orphaned skill-registry is folded in: every SKILL.md with a
   * declared cadence (daily/weekly/...) is checked against its last recorded
   * run, and any capability overdue past cadence x slack becomes a self-health
   * warning. This is the "a scheduled task silently stopped running" detector
   * (the ETIMEDOUT failure class). Reads gracefully empty when the dir is
   * absent.
   */
  capabilitiesDir?: string;
  /**
   * Optional path to a capability health-events JSONL ({task,status,timestamp}).
   * When present, last-run state is joined onto the capabilities so staleness
   * is measured from real runs rather than "never seen." Reads gracefully empty.
   */
  capabilityHealthPath?: string;
  /**
   * Overdue-detection tuning. include_ExampleCo defaults to FALSE here (unlike
   * the library default) so a capability with no health events on record does
   * not flood boot with false "never ran" alarms before a health producer is
   * wired; only capabilities with a recorded-but-stale run warn.
   */
  capabilityOverdueOpts?: { slack_factor?: number; include_ExampleCo?: boolean };
  /**
   * Optional path to the EA reflection JSONL (agent-reflection's writer output,
   * data/agent/ea-reflection-log.jsonl). When present the otherwise-orphaned
   * agent-reflection is folded in: any task whose reflections show >= threshold
   * failure/partial outcomes becomes a recurring-failure warning. Reads
   * gracefully empty (and tolerates legacy call-reflection rows that carry no
   * task field, which detectRecurringFailures skips).
   */
  reflectionLogPath?: string;
  /** Failure/partial count at which a task is flagged recurring. Default 2. */
  reflectionFailureThreshold?: number;
  /**
   * Optional path to the agent-decision JSONL (agent-decision-log's writer
   * output, data/agent/agent-decisions.jsonl). When present the
   * otherwise-orphaned agent-decision-log is folded in: escalations and failed
   * outcomes in the recent window surface so "what Amy decided / where it
   * escalated last night" is visible. Reads gracefully empty until
   * health-self-heal wires the producer.
   */
  decisionLogPath?: string;
  /** Lookback window for the decision fold, in hours. Default 24. */
  decisionWindowHours?: number;
  /**
   * Optional path to the approval-inbox dir (approval-inbox's append-only log).
   * When present the otherwise-orphaned approval ledger is folded in: the count
   * of pending approvals surfaces, and any approval that EXPIRED un-acted (an
   * irreversible action request - send, deploy, delete, call - that aged out
   * without a decision) becomes a self-health warning. This is the 2026 Agent
   * Framework approval-gate pattern (a tool requiring approval emits a pending
   * request that blocks until decided). Reads gracefully empty until a producer
   * enqueues approvals.
   */
  approvalInboxDir?: string;
  /**
   * Optional path to the token-usage ledger JSONL (token-budget-governor's
   * LedgerRecord rows). When present the otherwise-orphaned token-budget-governor
   * is folded in: usage over the rolling window is evaluated against a budget
   * policy, and an 'exceeded' verdict (a runaway loop or unbounded context
   * burning the window) becomes a hard self-health warning. This is the
   * cost/token-governance tier (LangGraph budget caps / Agno run monitoring).
   * Reads gracefully empty until a producer writes usage records.
   */
  tokenUsageLedgerPath?: string;
  /**
   * Budget policy for the token fold. Defaults to a generous daily window
   * (warn 5M tokens, hard cap 20M) so only a genuine runaway trips it.
   */
  tokenBudgetPolicy?: BudgetPolicy;
  /**
   * Optional data dir holding the memory access log (memory-access-log.jsonl,
   * the producer of memory temperatures). When present the otherwise-orphaned
   * memory-archival-recommender is folded in: cold, long-untouched memory keys
   * become archival candidates so working memory stays dense. This is the
   * memory-lifecycle tier (Letta/mem0 forget-after-2-months). Reads gracefully
   * empty until access events are recorded.
   */
  memoryTemperatureDir?: string;
  /** Keys the archival fold must never recommend (canonical always-loaded files). */
  archivalProtectedKeys?: string[];
  /** Confidence at/above which an archival candidate becomes a warning. Default 0.7. */
  archivalMinConfidence?: number;
  /**
   * Optional root dir of the durable ingest queue (ingest-queue's state-subdir
   * layout). When present AND already created, the otherwise-orphaned
   * ingest-queue is folded in: per-state counts surface, and any failed or
   * escalated item (an ingest that broke and needs attention) becomes a
   * self-health warning. This is the durable-task-queue tier (LangGraph durable
   * tasks / Agno run history). Guarded by existsSync so it never creates the
   * queue layout at boot; stays null and silent until a producer enqueues.
   */
  ingestQueueRoot?: string;
  /** Pending backlog at/above which a (non-failure) warning fires. Default 50. */
  ingestPendingWarnAt?: number;
  /**
   * Optional directory of the Task Spine (the live task-store dir, e.g.
   * %APPDATA%/secondbrain/data/tasks). When present, the otherwise-orphaned
   * task-archive sweep runs in DRY-RUN: it counts active-status tasks
   * (queued/running/awaiting-review) whose last activity is older than
   * staleTaskStaleDays and surfaces them as spine-hygiene candidates. Dry-run
   * never mutates a task file or writes a journal, so this is read-only at boot;
   * actually archiving stays an explicit, separate action. Guarded by existsSync
   * so it stays null and silent until the spine dir exists.
   */
  taskSweepDir?: string;
  /** Age (days) past which an active-status task is considered stale. Default 7. */
  taskSweepStaleDays?: number;
  /** Stale-task count at/above which a warning (not just a line) fires. Default 3. */
  staleTaskWarnAt?: number;
  /**
   * Optional path to the injection-flags JSONL (untrusted-injection-scan's
   * writer output, persisted by task-intake.drainIntake). When present, the
   * recent window is folded in as the "instruction-boundary" security tier so
   * the detect->surface loop closes: any HIGH-risk flag becomes a self-health
   * warning naming the source and attack categories, and medium flags are
   * summarized. Reads gracefully empty until a hostile dispatch is flagged.
   */
  injectionFlagsPath?: string;
  /** How many most-recent flag records to consider. Default 200. */
  injectionFlagWindow?: number;
}

export interface SelfHealthThresholds {
  /** Warn when orphaned module count exceeds this. Default 40. */
  maxOrphanModules?: number;
  /** Warn when total orphaned dead-weight lines exceed this. Default 15000. */
  maxOrphanLines?: number;
  /**
   * Warn when the day's estimated tool spend exceeds this many USD. The
   * Claude-Max plan should keep production spend near zero, so this is a low
   * default. Leaks (paid-provider records) warn regardless of dollar amount.
   * Default 1.00.
   */
  maxDailyCostUsd?: number;
  /**
   * Warn when a scope's success rate drops below this (0..1) AND it has at
   * least minOutcomeSamples decided records. Default 0.7.
   */
  maxOutcomeFailRate?: number;
  /** Minimum decided (success+fail) records before a low rate warns. Default 5. */
  minOutcomeSamples?: number;
  /** Override Date.now for the outcome window filter (tests). */
  now?: number;
}

export interface SelfHealthDigest {
  wiring: WiringAudit;
  indexBudget: IndexBudgetAudit;
  /** Only blocks that actually need eviction are included. */
  evictionPlans: BlockEvictionPlan[];
  /** Null when no tool-trace path was supplied or the file is absent. */
  observability: ObservabilityDigest | null;
  /** Null when no loop-trace path supplied or no run-scoped records present. */
  autonomy: AutonomyDigest | null;
  /** Null when no autonomy fold ran; else a one-line autonomous-run summary. */
  autonomyLine: string | null;
  /** Null when no retry-attempts path supplied or the file is absent/empty. */
  retryPressure: RetryPressureReport | null;
  /** Null when no core-block dirs supplied; else a one-line occupancy digest. */
  coreBlockHealthLine: string | null;
  /** Null when no cost-ledger path supplied; else the day's totals + leaks. */
  cost: DailyTotals | null;
  /** Null when no cost fold ran; else a one-line spend/leak summary. */
  costLine: string | null;
  /** Null when no claims+ledger paths supplied; else per-task cost reconciliation. */
  costIntegrity: IntegrityAudit | null;
  /** Null when no integrity fold ran; else a one-line reconciliation summary. */
  costIntegrityLine: string | null;
  /** Null when no outcome-log path supplied; else per-scope success stats. */
  outcomes: ScopeOutcomeSummary[] | null;
  /** Null when no outcome fold ran; else a one-line success-rate summary. */
  outcomeLine: string | null;
  /** Null when no capabilities dir supplied; else the overdue scheduled tasks. */
  overdueCapabilities: OverdueCapability[] | null;
  /** Null when no capability fold ran; else a one-line overdue summary. */
  overdueLine: string | null;
  /** Null when no reflection-log path supplied; else recurring task failures. */
  recurringFailures: RecurringFailure[] | null;
  /** Null when no reflection fold ran; else a one-line recurring-failure line. */
  reflectionLine: string | null;
  /** Null when no decision-log path supplied; else recent escalations/failures. */
  decisions: { total: number; escalations: DecisionRecord[]; failures: DecisionRecord[] } | null;
  /** Null when no decision fold ran; else a one-line decision-activity summary. */
  decisionLine: string | null;
  /** Null when no token-usage path supplied; else the rolling-window verdict. */
  tokenBudget: BudgetVerdict | null;
  /** Null when no token fold ran; else a one-line usage/verdict summary. */
  tokenBudgetLine: string | null;
  /** Null when no memory-temperature dir supplied; else archival candidates. */
  archivalRecommendations: ArchivalRecommendation[] | null;
  /** Null when no archival candidates; else a one-line archive summary. */
  archivalLine: string | null;
  /** Null when no ingest-queue root supplied/present; else per-state counts. */
  ingestQueue: Record<QueueState, number> | null;
  /** Null when no ingest fold ran; else a one-line queue-state summary. */
  ingestQueueLine: string | null;
  /** Null when no spine task dir supplied/present; else the dry-run sweep summary. */
  staleTasks: SweepSummary | null;
  /** Null when no task-sweep fold ran; else a one-line stale-task summary. */
  staleTaskLine: string | null;
  /** Null when no injection-flags path supplied/present; else the flag rollup. */
  injectionFlags: InjectionFlagSummary | null;
  /** Null when no injection fold ran; else a one-line detected-attempt summary. */
  injectionLine: string | null;
  warnings: string[];
  headline: string;
}

/** Rollup of recent prompt-injection flags surfaced by the self-health fold. */
export interface InjectionFlagSummary {
  total: number;
  high: number;
  medium: number;
  /** Distinct attack categories seen in the window, most-recent-first order. */
  categories: InjectionCategory[];
  /** The most recent flag record, for the surfaced excerpt. */
  latest: InjectionFlagRecord | null;
}

/**
 * Pure rollup of injection-flag records. Extracted so it is unit-testable
 * without a digest build. Newest records are assumed last (append order).
 */
export function summarizeInjectionFlags(records: InjectionFlagRecord[]): InjectionFlagSummary {
  const high = records.filter((r) => r.risk === 'high').length;
  const medium = records.filter((r) => r.risk === 'medium').length;
  const categories: InjectionCategory[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    for (const c of records[i].categories ?? []) {
      if (!categories.includes(c)) categories.push(c);
    }
  }
  return {
    total: records.length,
    high,
    medium,
    categories,
    latest: records.length ? records[records.length - 1] : null,
  };
}

const DEFAULT_MAX_ORPHAN_MODULES = 40;
const DEFAULT_MAX_ORPHAN_LINES = 15000;
const DEFAULT_MAX_DAILY_COST_USD = 1.0;
const DEFAULT_MAX_OUTCOME_FAIL_RATE = 0.3;
const DEFAULT_MIN_OUTCOME_SAMPLES = 5;

/** Generous daily token budget: only a genuine runaway trips the hard cap. */
const DEFAULT_TOKEN_BUDGET_POLICY: BudgetPolicy = {
  window_ms: 86_400_000,
  warn_tokens: 5_000_000,
  max_tokens: 20_000_000,
};
const DEFAULT_ARCHIVAL_MIN_CONFIDENCE = 0.7;
const DEFAULT_INGEST_PENDING_WARN_AT = 50;
const DEFAULT_STALE_TASK_WARN_AT = 3;
/** Canonical always-loaded files that must never be archived out from under Amy. */
const DEFAULT_ARCHIVAL_PROTECTED_KEYS = [
  'user_profile',
  'MEMORY',
  'AMY_REQUIREMENTS',
  'AMY_FOUNDATION_REFLECTION',
  'AMY_DEEP_RESEARCH',
  'AMY_REBUILD_PLAN',
  'project_briefing_spec',
  'feedback_no_fabrication_in_briefings',
  'feedback_daily_health_checks',
  'feedback_raw_archival_principle',
];

/**
 * For each core block over its byte limit, produce an eviction plan. Blocks
 * that are within budget are omitted (nothing to do). This is the wiring point
 * for the otherwise-orphaned memory-eviction-planner.
 */
export function recommendEvictions(blocks: CoreBlockInput[] = []): BlockEvictionPlan[] {
  const plans: BlockEvictionPlan[] = [];
  for (const block of blocks) {
    const pinned = new Set(block.pinnedLineIndexes ?? []);
    const lines = linesFromContent(block.content, {}, pinned);
    const plan = planEviction(lines, block.limitBytes);
    if (plan.needsEviction) {
      plans.push({ block: block.name, ...plan });
    }
  }
  return plans;
}

/**
 * Turn the raw audit results into the short, actionable warning lines that the
 * runtime surfaces (one per real problem). Empty array means self-health is
 * clean. Kept separate from buildSelfHealthDigest so callers can re-evaluate
 * with different thresholds without re-scanning the tree.
 */
export function evaluateSelfHealth(
  wiring: WiringAudit,
  indexBudget: IndexBudgetAudit,
  evictionPlans: BlockEvictionPlan[],
  thresholds: SelfHealthThresholds = {},
): string[] {
  const maxOrphanModules = thresholds.maxOrphanModules ?? DEFAULT_MAX_ORPHAN_MODULES;
  const maxOrphanLines = thresholds.maxOrphanLines ?? DEFAULT_MAX_ORPHAN_LINES;

  const warnings: string[] = [];

  if (indexBudget.overBudget) {
    warnings.push(
      `Tier-1 index OVER budget by ${indexBudget.bytesOver} bytes; the session ` +
        `loader is truncating MEMORY.md (${indexBudget.trimmingWouldSuffice ? 'line-trimming would suffice' : 'detail must move to topic files'}).`,
    );
  }

  if (wiring.orphanModules > maxOrphanModules) {
    const tested = wiring.orphans.filter((o) => o.hasTest).length;
    warnings.push(
      `${wiring.orphanModules} orphaned modules (~${wiring.deadWeightLines} dead-weight lines, ` +
        `${tested} tested-but-unwired) exceed the ${maxOrphanModules}-module budget; the nightly cycle is ` +
        `shipping capability that never runs. Top: ${wiring.orphans
          .slice(0, 3)
          .map((o) => o.name)
          .join(', ')}.`,
    );
  } else if (wiring.deadWeightLines > maxOrphanLines) {
    warnings.push(
      `Orphaned dead-weight is ~${wiring.deadWeightLines} lines across ${wiring.orphanModules} modules, ` +
        `over the ${maxOrphanLines}-line budget.`,
    );
  }

  for (const plan of evictionPlans) {
    if (plan.blockedByPins) {
      warnings.push(
        `Core block "${plan.block}" is ${plan.overBy} bytes over limit and STILL over after evicting ` +
          `every non-pinned line; the pins themselves need review.`,
      );
    } else {
      // No per-line reference times are tracked, so the planner ranks by
      // position. Core blocks are append-only, so earliest lines are oldest:
      // "oldest-appended first" is the honest description, not "coldest".
      warnings.push(
        `Core block "${plan.block}" is ${plan.overBy} bytes over limit; archive ${plan.evict.length} ` +
          `oldest-appended line(s) to reclaim ${plan.reclaimedBytes} bytes.`,
      );
    }
  }

  return warnings;
}

/** Compose a single executive headline from the sub-audit renderers. */
export function renderSelfHealthHeadline(digest: SelfHealthDigest): string {
  const parts = [
    renderWiringHeadline(digest.wiring),
    renderIndexBudgetHeadline(digest.indexBudget),
  ];
  if (digest.evictionPlans.length > 0) {
    parts.push(`${digest.evictionPlans.length} core block(s) need eviction.`);
  }
  if (digest.observability) {
    parts.push(digest.observability.tier1);
  }
  if (digest.autonomyLine) {
    parts.push(digest.autonomyLine);
  }
  if (digest.coreBlockHealthLine) {
    parts.push(digest.coreBlockHealthLine);
  }
  if (digest.retryPressure && digest.retryPressure.flagged.length > 0) {
    parts.push(`${digest.retryPressure.flagged.length} tool(s) under retry pressure.`);
  }
  if (digest.costLine) {
    parts.push(digest.costLine);
  }
  if (digest.costIntegrityLine) {
    parts.push(digest.costIntegrityLine);
  }
  if (digest.outcomeLine) {
    parts.push(digest.outcomeLine);
  }
  if (digest.overdueLine) {
    parts.push(digest.overdueLine);
  }
  if (digest.reflectionLine) {
    parts.push(digest.reflectionLine);
  }
  if (digest.decisionLine) {
    parts.push(digest.decisionLine);
  }
  if (digest.tokenBudgetLine) {
    parts.push(digest.tokenBudgetLine);
  }
  if (digest.archivalLine) {
    parts.push(digest.archivalLine);
  }
  if (digest.ingestQueueLine) {
    parts.push(digest.ingestQueueLine);
  }
  if (digest.staleTaskLine) {
    parts.push(digest.staleTaskLine);
  }
  return parts.join(' ');
}

/**
 * Read a per-task claimed-cost JSONL into ClaimedTaskCost rows. Tolerant of a
 * missing/blank file and malformed lines (skipped), mirroring readLedger, so a
 * bad claims file degrades the integrity fold to empty rather than breaking the
 * whole digest. Only rows with a non-empty taskId and numeric totals are kept.
 */
export function readTaskCostClaims(filePath: string): ClaimedTaskCost[] {
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: ClaimedTaskCost[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<ClaimedTaskCost>;
      if (typeof o.taskId === 'string' && o.taskId.length > 0) {
        out.push({
          taskId: o.taskId,
          tokensIn: Number(o.tokensIn) || 0,
          tokensOut: Number(o.tokensOut) || 0,
          usd: Number(o.usd) || 0,
        });
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Run every self-audit and assemble the digest. */
export function buildSelfHealthDigest(
  inputs: SelfHealthInputs,
  thresholds: SelfHealthThresholds = {},
): SelfHealthDigest {
  const wiring = buildWiringDigest(inputs.srcDir, inputs.wiringOptions);
  const indexBudget = auditIndexBudget(inputs.indexContent);
  const evictionPlans = recommendEvictions(inputs.coreBlocks);
  const warnings = evaluateSelfHealth(wiring, indexBudget, evictionPlans, thresholds);

  // Fold in the observability tier (tool health + error clusters) when a trace
  // file is available. Anything needing attention becomes a self-health warning.
  let observability: ObservabilityDigest | null = null;
  if (inputs.tracePath && fs.existsSync(inputs.tracePath)) {
    observability = buildObservabilityDigest(inputs.tracePath);
    if (!observability.all_clear) {
      warnings.push(observability.tier1, ...observability.tier2);
    }
  }

  // Fold in the autonomy tier (per-run rollup of the agent loop). This wires the
  // otherwise-orphaned summarizeByRun: "what did Amy DO autonomously" -- run,
  // call, and failure counts plus idempotency savings. readRunSummaries skips the
  // run-less base records that share the trace file, so any run that surfaces is
  // real; a run with a failed call becomes a warning. Stays null and silent until
  // the loop writes run-scoped records.
  let autonomy: AutonomyDigest | null = null;
  let autonomyLine: string | null = null;
  if (inputs.loopTracePath && fs.existsSync(inputs.loopTracePath)) {
    const runSummaries = readRunSummaries(inputs.loopTracePath);
    if (runSummaries.length > 0) {
      autonomy = buildAutonomyDigest(runSummaries);
      autonomyLine = autonomy.tier1;
      if (!autonomy.all_clear) {
        warnings.push(...autonomy.tier2);
      }
    }
  }

  // Fold in per-tool retry pressure (the run-111 model-retry-loop consumer).
  // Flagged tools -- schemas the model keeps having to correct -- become
  // warnings. readAttemptRecords tolerates a missing/blank file, so this stays
  // null and silent until the producer writes records.
  let retryPressure: RetryPressureReport | null = null;
  if (inputs.retryAttemptsPath && fs.existsSync(inputs.retryAttemptsPath)) {
    const records = readAttemptRecords(inputs.retryAttemptsPath);
    if (records.length > 0) {
      retryPressure = buildRetryPressureReport(records);
      warnings.push(...summarizeRetryPressure(retryPressure));
    }
  }

  // Fold in prompt-injection flags (the instruction-boundary security tier).
  // task-intake.drainIntake persists medium+ hits from untrusted-injection-scan;
  // this closes the detect->surface loop so a hostile #amy dispatch body reaches
  // the morning digest. Any HIGH-risk flag is an actionable warning naming the
  // source + attack categories; a run of medium flags is summarized. Reads
  // gracefully empty until a hostile dispatch is actually flagged.
  let injectionFlags: InjectionFlagSummary | null = null;
  let injectionLine: string | null = null;
  if (inputs.injectionFlagsPath && fs.existsSync(inputs.injectionFlagsPath)) {
    const records = readInjectionFlags(
      inputs.injectionFlagsPath,
      inputs.injectionFlagWindow ?? 200,
    );
    if (records.length > 0) {
      injectionFlags = summarizeInjectionFlags(records);
      const cats = injectionFlags.categories.join(', ');
      injectionLine =
        `Injection watch: ${injectionFlags.total} flagged dispatch(es) ` +
        `(${injectionFlags.high} high, ${injectionFlags.medium} medium)` +
        `${cats ? ` [${cats}]` : ''}.`;
      if (injectionFlags.high > 0) {
        const latest = injectionFlags.latest;
        const src = latest?.source ?? 'ExampleCo';
        const excerpt = latest?.excerpt ? ` e.g. "${latest.excerpt}"` : '';
        warnings.push(
          `${injectionFlags.high} HIGH-risk prompt-injection attempt(s) flagged in ` +
            `untrusted dispatch bodies (latest source: ${src}; categories: ${cats})${excerpt}. ` +
            `Review before acting on the held dispatch(es).`,
        );
      }
    }
  }

  // Fold in live core-memory block occupancy. The one-line digest always feeds
  // the headline; only a FULL writable block (over the hard limit) is an
  // actionable warning. A missing queue dir just leaves refinementPending false.
  let coreBlockHealthLine: string | null = null;
  if (inputs.coreBlockHealthDirs && fs.existsSync(inputs.coreBlockHealthDirs.blocksDir)) {
    const { blocksDir, queueDir } = inputs.coreBlockHealthDirs;
    coreBlockHealthLine = formatCoreBlockHealthForBriefing(blocksDir, queueDir);
    for (const row of getCoreBlockHealth(blocksDir, queueDir)) {
      if (row.status === 'full') {
        warnings.push(
          `Core block "${row.name}" is ${Math.round(row.ratio * 100)}% full` +
            `${row.refinementPending ? ', refinement queued' : ', recompress not queued'}.`,
        );
      }
    }
  }

  // Fold in the tool-cost ledger. The Claude-Max-only rule is the point: any
  // record from a paid provider (anything outside CLAUDE_MAX_ONLY_ALLOWLIST) is
  // a leak and a hard warning regardless of dollar amount; spend over the daily
  // budget is a softer warning. readLedger tolerates a missing/blank file, so
  // this stays null and silent until a producer writes records.
  let cost: DailyTotals | null = null;
  let costLine: string | null = null;
  if (inputs.toolCostLedgerPath && fs.existsSync(inputs.toolCostLedgerPath)) {
    const records = readLedger(inputs.toolCostLedgerPath);
    if (records.length > 0) {
      const dateUtc = inputs.todayUtc ?? new Date().toISOString().slice(0, 10);
      cost = getDailyTotals(records, dateUtc);
      const maxDaily = thresholds.maxDailyCostUsd ?? DEFAULT_MAX_DAILY_COST_USD;
      costLine =
        `Tool spend ${dateUtc}: $${cost.total_cost_usd.toFixed(2)} over ` +
        `${cost.total_calls} call(s)` +
        (cost.leaks.length > 0 ? `, ${cost.leaks.length} LEAK(s)` : '') +
        '.';
      if (cost.leaks.length > 0) {
        const byLeakProvider: Record<string, number> = {};
        for (const r of cost.leaks) {
          byLeakProvider[r.provider] = (byLeakProvider[r.provider] || 0) + 1;
        }
        const detail = Object.entries(byLeakProvider)
          .map(([p, n]) => `${p} x${n}`)
          .join(', ');
        warnings.push(
          `CLAUDE-MAX-ONLY LEAK: ${cost.leaks.length} paid-provider call(s) on ` +
            `${dateUtc} (${detail}). Production must route through Claude Max; ` +
            `audit the producing surface.`,
        );
      }
      if (cost.total_cost_usd > maxDaily) {
        warnings.push(
          `Tool spend on ${dateUtc} is $${cost.total_cost_usd.toFixed(2)}, over ` +
            `the $${maxDaily.toFixed(2)} daily budget.`,
        );
      }
    }
  }

  // Fold in tool-cost-integrity (the spend-reconciliation tier). When a per-task
  // claimed-cost file exists AND the ledger exists, each task's authoritative
  // claimed total is reconciled against the sum of its captured ledger entries
  // (the ledger is re-keyed by `surface`, the per-task scope tag). Any task that
  // UNDERCOUNTS (a turn never recorded), OVERCOUNTS (a double-record / leaked
  // entry), or claims spend with NO captured calls becomes a warning, so the
  // briefing never reports a total the ledger cannot back. This is the Agno
  // issue #2310 lesson. Reads gracefully empty until a claims producer writes.
  let costIntegrity: IntegrityAudit | null = null;
  let costIntegrityLine: string | null = null;
  if (
    inputs.taskCostClaimsPath &&
    fs.existsSync(inputs.taskCostClaimsPath) &&
    inputs.toolCostLedgerPath &&
    fs.existsSync(inputs.toolCostLedgerPath)
  ) {
    const claims = readTaskCostClaims(inputs.taskCostClaimsPath);
    if (claims.length > 0) {
      const entries: TaskCostEntry[] = readLedger(inputs.toolCostLedgerPath).map((r) => ({
        taskId: r.surface,
        tokensIn: r.input_tokens ?? 0,
        tokensOut: r.output_tokens ?? 0,
        usd: r.est_cost_usd,
      }));
      costIntegrity = auditLedgerIntegrity(claims, entries);
      const s = costIntegrity.summary;
      costIntegrityLine =
        `Cost integrity: ${s.ok}/${s.total} task(s) reconcile` +
        (s.undercount > 0 ? `, ${s.undercount} undercount` : '') +
        (s.overcount > 0 ? `, ${s.overcount} overcount` : '') +
        (s.noData > 0 ? `, ${s.noData} no-data` : '') +
        '.';
      for (const r of costIntegrity.reports) {
        if (r.status !== 'ok') {
          warnings.push(`Tool-cost integrity: ${r.message}.`);
        }
      }
    }
  }

  // Fold in the outcome-tracker (failure-detection tier). Per-scope success
  // rates surface, and any scope failing more than the threshold with enough
  // samples becomes a warning. OutcomeTracker.readAll tolerates a missing file,
  // so this stays null and silent until a producer records outcomes.
  let outcomes: ScopeOutcomeSummary[] | null = null;
  let outcomeLine: string | null = null;
  if (inputs.outcomeLogPath && fs.existsSync(inputs.outcomeLogPath)) {
    const tracker = new OutcomeTracker(inputs.outcomeLogPath);
    const summaries = tracker.summarizeAllScopes({
      windowMs: inputs.outcomeWindowMs,
      now: thresholds.now,
    });
    if (summaries.length > 0) {
      outcomes = summaries;
      const maxFailRate = thresholds.maxOutcomeFailRate ?? DEFAULT_MAX_OUTCOME_FAIL_RATE;
      const minSamples = thresholds.minOutcomeSamples ?? DEFAULT_MIN_OUTCOME_SAMPLES;
      const totalCalls = summaries.reduce((n, s) => n + s.stats.total, 0);
      const worst = [...summaries].sort((a, b) => a.stats.success_rate - b.stats.success_rate)[0];
      outcomeLine =
        `Outcomes: ${summaries.length} scope(s), ${totalCalls} call(s)` +
        (worst ? `; worst ${worst.scope} ${Math.round(worst.stats.success_rate * 100)}% ok` : '') +
        '.';
      for (const s of summaries) {
        const decided = s.stats.success + s.stats.fail;
        if (decided >= minSamples && s.stats.success_rate < 1 - maxFailRate) {
          const topErr = Object.entries(s.stats.by_error_class).sort((a, b) => b[1] - a[1])[0];
          warnings.push(
            `Scope "${s.scope}" success rate ${Math.round(s.stats.success_rate * 100)}% ` +
              `(${s.stats.fail}/${decided} failing)` +
              (topErr ? `, mostly ${topErr[0]}` : '') +
              `; below the ${Math.round((1 - maxFailRate) * 100)}% floor.`,
          );
        }
      }
    }
  }

  // Fold in the skill-registry. Every scheduled-tasks/<name>/SKILL.md with a
  // declared cadence is checked against its last recorded run; anything overdue
  // past cadence x slack becomes a warning. This is the "a scheduled task
  // silently stopped" detector (the ETIMEDOUT failure class this very task's
  // LESSONS records). include_ExampleCo defaults FALSE so a never-seen capability
  // does not cry wolf before a health-events producer is wired. listCapabilities
  // tolerates a missing dir, so this stays null and silent until then.
  let overdue: OverdueCapability[] | null = null;
  let overdueLine: string | null = null;
  if (inputs.capabilitiesDir && fs.existsSync(inputs.capabilitiesDir)) {
    let caps = listCapabilities(inputs.capabilitiesDir);
    if (inputs.capabilityHealthPath && fs.existsSync(inputs.capabilityHealthPath)) {
      const events = loadHealthEvents(inputs.capabilityHealthPath);
      const now = thresholds.now != null ? new Date(thresholds.now) : new Date();
      caps = attachHealth(caps, events, now);
    }
    overdue = overdueCapabilities(caps, {
      slack_factor: inputs.capabilityOverdueOpts?.slack_factor,
      include_ExampleCo: inputs.capabilityOverdueOpts?.include_ExampleCo ?? false,
    });
    if (overdue.length > 0) {
      const top = formatOverdueForBriefing(overdue, 3).join('; ');
      overdueLine = `${overdue.length} scheduled capability(ies) overdue: ${top}.`;
      warnings.push(
        `${overdue.length} scheduled capability(ies) overdue past their cadence: ` +
          `${top}. A capability that stopped running silently scores green on stale ` +
          `state; treat an overdue cadence as a dead scheduled task until proven otherwise.`,
      );
    }
  }

  // Fold in agent-reflection (the self-improvement loop). A task whose EA
  // reflections show repeated failure/partial outcomes is the strongest signal
  // for a regression that keeps recurring. readReflections tolerates a missing
  // file and skips rows with no task field, so legacy call-reflection rows are
  // ignored and this stays null/silent until task-scoped reflections are written.
  let recurringFailures: RecurringFailure[] | null = null;
  let reflectionLine: string | null = null;
  if (inputs.reflectionLogPath && fs.existsSync(inputs.reflectionLogPath)) {
    const records = readReflections(inputs.reflectionLogPath, 500);
    if (records.length > 0) {
      const threshold = inputs.reflectionFailureThreshold ?? 2;
      recurringFailures = detectRecurringFailures(records, threshold);
      if (recurringFailures.length > 0) {
        const names = recurringFailures
          .slice(0, 3)
          .map((f) => `${f.task} (${f.failure_count}/${f.total_runs})`)
          .join(', ');
        reflectionLine = `${recurringFailures.length} task(s) with recurring failures: ${names}.`;
        for (const f of recurringFailures) {
          warnings.push(
            `Task "${f.task}" has failed ${f.failure_count} of ${f.total_runs} recorded ` +
              `run(s) (last ${f.last_outcome})` +
              (f.sample_learnings.length > 0 ? `; e.g. "${f.sample_learnings[0]}"` : '') +
              `; feed the prior failure modes into the next attempt.`,
          );
        }
      }
    }
  }

  // Fold in agent-decision-log. Recent escalations and failed outcomes in the
  // heal/routing decision log surface so "where Amy escalated last night" is
  // visible. summarizeSince tolerates a missing file (readAll returns []), so
  // this stays null/silent until health-self-heal wires the producer.
  let decisions: SelfHealthDigest['decisions'] = null;
  let decisionLine: string | null = null;
  if (inputs.decisionLogPath && fs.existsSync(inputs.decisionLogPath)) {
    const windowHours = inputs.decisionWindowHours ?? 24;
    const summary = new DecisionLog(inputs.decisionLogPath).summarizeSince(windowHours);
    if (summary.total > 0) {
      decisions = {
        total: summary.total,
        escalations: summary.escalations,
        failures: summary.failures,
      };
      decisionLine =
        `Decisions ${windowHours}h: ${summary.total} total` +
        (summary.escalations.length > 0 ? `, ${summary.escalations.length} escalated` : '') +
        (summary.failures.length > 0 ? `, ${summary.failures.length} failed` : '') +
        '.';
      for (const e of summary.escalations) {
        warnings.push(
          `Decision escalated: ${e.task}/${e.probe} - ${e.reason} ` + `(outcome ${e.outcome}).`,
        );
      }
    }
  }

  // Fold in token-budget-governor (the cost/token-governance tier). Usage in the
  // rolling window is evaluated against a budget policy; an 'exceeded' verdict --
  // a runaway loop or unbounded context burning the window -- is a hard warning,
  // a 'warn' verdict is soft. readTokenLedger tolerates a missing/blank file, so
  // this stays null and silent until a producer writes usage records.
  let tokenBudget: BudgetVerdict | null = null;
  let tokenBudgetLine: string | null = null;
  if (inputs.tokenUsageLedgerPath && fs.existsSync(inputs.tokenUsageLedgerPath)) {
    const records = readTokenLedger(inputs.tokenUsageLedgerPath);
    if (records.length > 0) {
      const policy = inputs.tokenBudgetPolicy ?? DEFAULT_TOKEN_BUDGET_POLICY;
      const now = thresholds.now != null ? new Date(thresholds.now) : new Date();
      tokenBudget = evaluateBudget(records, policy, now);
      const snap = tokenBudget.snapshot;
      const windowHours = Math.round(policy.window_ms / 3_600_000);
      tokenBudgetLine =
        `Token budget ${windowHours}h: ${snap.total_tokens} tok over ` +
        `${snap.records_in_window} call(s) [${tokenBudget.verdict}].`;
      if (tokenBudget.verdict === 'exceeded') {
        warnings.push(
          `TOKEN BUDGET EXCEEDED: ${tokenBudget.reason}. A runaway loop or ` +
            `unbounded context is burning the window; cap or compact the producing surface.`,
        );
      } else if (tokenBudget.verdict === 'warn') {
        warnings.push(`Token budget warning: ${tokenBudget.reason}.`);
      }
    }
  }

  // Fold in memory-archival-recommender (the memory-lifecycle tier). Cold,
  // long-untouched memory keys become archival candidates so working memory
  // stays dense (the Letta/mem0 forget-after-2-months discipline). Canonical
  // always-loaded files are protected. computeTemperatures tolerates a missing
  // access log, so this stays null and silent until access events are recorded.
  let archivalRecommendations: ArchivalRecommendation[] | null = null;
  let archivalLine: string | null = null;
  if (inputs.memoryTemperatureDir && fs.existsSync(inputs.memoryTemperatureDir)) {
    const temps = computeTemperatures(inputs.memoryTemperatureDir);
    if (temps.length > 0) {
      const recs = recommendArchives(temps, {
        protectedKeys: inputs.archivalProtectedKeys ?? DEFAULT_ARCHIVAL_PROTECTED_KEYS,
        now: thresholds.now != null ? new Date(thresholds.now) : undefined,
      });
      archivalRecommendations = recs;
      if (recs.length > 0) {
        archivalLine = formatArchivalForBriefing(recs);
        const minConf = inputs.archivalMinConfidence ?? DEFAULT_ARCHIVAL_MIN_CONFIDENCE;
        const highConf = recs.filter((r) => r.confidence >= minConf);
        if (highConf.length > 0) {
          const top = highConf
            .slice(0, 3)
            .map((r) => `${r.memoryKey} (${Math.round(r.confidence * 100)}%)`)
            .join(', ');
          warnings.push(
            `${highConf.length} memory key(s) are cold archival candidates ` +
              `(confidence >= ${minConf}): ${top}. Archiving keeps working memory ` +
              `dense; this is the Letta/mem0 forget-after-2-months discipline.`,
          );
        }
      }
    }
  }

  // Fold in ingest-queue (the durable-task-queue tier). Per-state counts surface,
  // and any failed or escalated item -- an ingest that broke and needs attention --
  // is a hard warning; a large pending backlog is a softer one. Guarded by
  // existsSync so queueCounts (which would otherwise mkdir the layout) never
  // creates the queue at boot: stays null and silent until a producer enqueues.
  let ingestQueue: Record<QueueState, number> | null = null;
  let ingestQueueLine: string | null = null;
  if (inputs.ingestQueueRoot && fs.existsSync(inputs.ingestQueueRoot)) {
    const counts = queueCounts(inputs.ingestQueueRoot);
    ingestQueue = counts;
    ingestQueueLine =
      `Ingest queue: ${counts.pending} pending, ${counts['in-progress']} in-progress, ` +
      `${counts.failed} failed, ${counts.escalated} escalated.`;
    if (counts.failed > 0 || counts.escalated > 0) {
      warnings.push(
        `Ingest queue has ${counts.failed} failed and ${counts.escalated} escalated ` +
          `item(s); a broken ingest sits durable until drained or escalated. Triage ` +
          `the failed/escalated items before they age out.`,
      );
    }
    const pendingWarnAt = inputs.ingestPendingWarnAt ?? DEFAULT_INGEST_PENDING_WARN_AT;
    if (counts.pending >= pendingWarnAt) {
      warnings.push(
        `Ingest queue pending backlog is ${counts.pending} (>= ${pendingWarnAt}); ` +
          `the drain worker is behind or stalled.`,
      );
    }
  }

  // Fold in task-archive (the spine-hygiene tier). DRY-RUN sweep of the live
  // Task Spine: active-status tasks (queued/running/awaiting-review) that have
  // not been touched in taskSweepStaleDays are almost always leaked/zombie
  // sessions (the orphan-leak-thrashes-briefing failure mode). Surfacing the
  // count makes spine rot visible without mutating anything; archiving stays an
  // explicit action. Guarded by existsSync; sweepArchive in dryRun never writes.
  let staleTasks: SweepSummary | null = null;
  let staleTaskLine: string | null = null;
  if (inputs.taskSweepDir && fs.existsSync(inputs.taskSweepDir)) {
    const nowMs = thresholds.now != null ? thresholds.now : Date.now();
    staleTasks = sweepArchive(
      inputs.taskSweepDir,
      nowMs,
      path.join(inputs.taskSweepDir, '.archive-journal-dryrun.jsonl'),
      {
        staleDays: inputs.taskSweepStaleDays,
        dryRun: true,
      },
    );
    staleTaskLine =
      `Spine: ${staleTasks.scanned} task(s), ${staleTasks.archived} stale active ` +
      `(>${inputs.taskSweepStaleDays ?? 7}d, archivable).`;
    const warnAt = inputs.staleTaskWarnAt ?? DEFAULT_STALE_TASK_WARN_AT;
    if (staleTasks.archived >= warnAt) {
      const sample = staleTasks.archivedIds.slice(0, 3).join(', ');
      warnings.push(
        `${staleTasks.archived} active-status spine task(s) are stale ` +
          `(>${inputs.taskSweepStaleDays ?? 7}d untouched, >= ${warnAt}); these are ` +
          `almost always leaked/zombie sessions. Sweep them to 'archived' so the ` +
          `spine reflects real work${sample ? ` (e.g. ${sample})` : ''}.`,
      );
    }
  }

  const digest: SelfHealthDigest = {
    wiring,
    indexBudget,
    evictionPlans,
    observability,
    autonomy,
    autonomyLine,
    retryPressure,
    coreBlockHealthLine,
    cost,
    costLine,
    costIntegrity,
    costIntegrityLine,
    outcomes,
    outcomeLine,
    overdueCapabilities: overdue,
    overdueLine,
    recurringFailures,
    reflectionLine,
    decisions,
    decisionLine,
    tokenBudget,
    tokenBudgetLine,
    archivalRecommendations,
    archivalLine,
    ingestQueue,
    ingestQueueLine,
    staleTasks,
    staleTaskLine,
    injectionFlags,
    injectionLine,
    warnings,
    headline: '',
  };
  digest.headline = renderSelfHealthHeadline(digest);
  return digest;
}

/**
 * Persist the digest to a stable artifact the briefing / health surface can
 * read. dir is an explicit path (no Electron coupling); returns the file
 * path written. Throws only if the directory cannot be created or written,
 * which the caller wraps so a self-audit failure never blocks boot.
 */
export function persistSelfHealthDigest(
  dir: string,
  digest: SelfHealthDigest,
  generatedAt: string,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'self-health-digest.json');
  const payload = {
    generated_at: generatedAt,
    headline: digest.headline,
    warnings: digest.warnings,
    wiring: {
      totalModules: digest.wiring.totalModules,
      wiredModules: digest.wiring.wiredModules,
      orphanModules: digest.wiring.orphanModules,
      deadWeightLines: digest.wiring.deadWeightLines,
      topOrphans: digest.wiring.orphans.slice(0, 10).map((o) => ({
        name: o.name,
        lineCount: o.lineCount,
        hasTest: o.hasTest,
      })),
    },
    indexBudget: {
      totalBytes: digest.indexBudget.totalBytes,
      budgetBytes: digest.indexBudget.budgetBytes,
      overBudget: digest.indexBudget.overBudget,
      bytesOver: digest.indexBudget.bytesOver,
    },
    evictionPlans: digest.evictionPlans.map((p) => ({
      block: p.block,
      overBy: p.overBy,
      evictLines: p.evict.length,
      reclaimedBytes: p.reclaimedBytes,
      blockedByPins: p.blockedByPins,
    })),
    observability: digest.observability
      ? {
          tier1: digest.observability.tier1,
          tier2: digest.observability.tier2,
          all_clear: digest.observability.all_clear,
          total_calls: digest.observability.tier3.total_calls,
          total_failures: digest.observability.tier3.total_failures,
        }
      : null,
    autonomy: digest.autonomy
      ? {
          tier1: digest.autonomy.tier1,
          tier2: digest.autonomy.tier2,
          all_clear: digest.autonomy.all_clear,
          total_runs: digest.autonomy.tier3.total_runs,
          total_calls: digest.autonomy.tier3.total_calls,
          total_failures: digest.autonomy.tier3.total_failures,
          total_idempotent_short_circuits: digest.autonomy.tier3.total_idempotent_short_circuits,
          by_side_effect: digest.autonomy.tier3.by_side_effect,
        }
      : null,
    retryPressure: digest.retryPressure
      ? {
          totalCalls: digest.retryPressure.totalCalls,
          totalCorrections: digest.retryPressure.totalCorrections,
          flagged: digest.retryPressure.flagged.map((t) => ({
            toolName: t.toolName,
            avgCorrectionsPerCall: t.avgCorrectionsPerCall,
            exhaustionRate: t.exhaustionRate,
          })),
        }
      : null,
    coreBlockHealth: digest.coreBlockHealthLine,
    cost: digest.cost
      ? {
          date: digest.cost.date,
          total_calls: digest.cost.total_calls,
          total_cost_usd: digest.cost.total_cost_usd,
          by_provider: digest.cost.by_provider,
          leak_count: digest.cost.leaks.length,
          line: digest.costLine,
        }
      : null,
    costIntegrity: digest.costIntegrity
      ? {
          line: digest.costIntegrityLine,
          total: digest.costIntegrity.summary.total,
          ok: digest.costIntegrity.summary.ok,
          undercount: digest.costIntegrity.summary.undercount,
          overcount: digest.costIntegrity.summary.overcount,
          noData: digest.costIntegrity.summary.noData,
          clean: digest.costIntegrity.summary.clean,
          problems: digest.costIntegrity.reports
            .filter((r) => r.status !== 'ok')
            .slice(0, 10)
            .map((r) => ({
              taskId: r.taskId,
              status: r.status,
              deltaTokens: r.deltaTokens,
              deltaUsd: r.deltaUsd,
            })),
        }
      : null,
    outcomes: digest.outcomes
      ? {
          line: digest.outcomeLine,
          scopes: digest.outcomes.map((s) => ({
            scope: s.scope,
            total: s.stats.total,
            success_rate: s.stats.success_rate,
            fail: s.stats.fail,
            p95_latency_ms: s.stats.p95_latency_ms,
          })),
        }
      : null,
    overdueCapabilities: digest.overdueCapabilities
      ? {
          line: digest.overdueLine,
          rows: digest.overdueCapabilities.slice(0, 10).map((o) => ({
            name: o.cap.name,
            cadence_hours: o.cadence_hours,
            staleness_hours: o.staleness_hours,
            overdue_ratio: o.overdue_ratio,
            reason: o.reason,
          })),
        }
      : null,
    recurringFailures: digest.recurringFailures
      ? {
          line: digest.reflectionLine,
          tasks: digest.recurringFailures.slice(0, 10).map((f) => ({
            task: f.task,
            failure_count: f.failure_count,
            total_runs: f.total_runs,
            last_outcome: f.last_outcome,
            last_timestamp: f.last_timestamp,
          })),
        }
      : null,
    decisions: digest.decisions
      ? {
          line: digest.decisionLine,
          total: digest.decisions.total,
          escalations: digest.decisions.escalations.map((e) => ({
            task: e.task,
            probe: e.probe,
            reason: e.reason,
            outcome: e.outcome,
            timestamp: e.timestamp,
          })),
          failure_count: digest.decisions.failures.length,
        }
      : null,
    tokenBudget: digest.tokenBudget
      ? {
          line: digest.tokenBudgetLine,
          verdict: digest.tokenBudget.verdict,
          total_tokens: digest.tokenBudget.snapshot.total_tokens,
          total_cost_usd: digest.tokenBudget.snapshot.total_cost_usd,
          records_in_window: digest.tokenBudget.snapshot.records_in_window,
          reason: digest.tokenBudget.reason,
        }
      : null,
    archival: digest.archivalRecommendations
      ? {
          line: digest.archivalLine,
          stats: getArchivalStats(digest.archivalRecommendations),
          top: digest.archivalRecommendations.slice(0, 10).map((r) => ({
            memoryKey: r.memoryKey,
            reason: r.reason,
            confidence: r.confidence,
            daysSinceLastAccess: r.daysSinceLastAccess,
          })),
        }
      : null,
    ingestQueue: digest.ingestQueue
      ? {
          line: digest.ingestQueueLine,
          counts: digest.ingestQueue,
        }
      : null,
    staleTasks: digest.staleTasks
      ? {
          line: digest.staleTaskLine,
          scanned: digest.staleTasks.scanned,
          stale: digest.staleTasks.archived,
          staleIds: digest.staleTasks.archivedIds.slice(0, 10),
        }
      : null,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}
