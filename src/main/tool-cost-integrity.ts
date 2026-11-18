/**
 * Tool Cost Integrity (run 105)
 *
 * An agent run stamps an authoritative per-task token/dollar total (the figure
 * the briefing reports) while a ledger records per-call cost. Those two numbers
 * should agree. When they silently diverge, the briefing reports the wrong
 * spend.
 *
 * The most common failure is undercounting: a tool turn or an intermediate
 * assistant message is never written to the ledger, so the rolled-up sum comes
 * in under the authoritative total. Agno hit exactly this (issue #2310) and the
 * lesson is to assert `authoritative_total == sum(every captured call)` rather
 * than trust either number alone. The opposite, overcount, means a call was
 * double-recorded or a stray entry leaked from another task.
 *
 * This module is a pure verifier. It is deliberately self-contained: it takes
 * the run's claimed total plus the captured per-call entries (each tagged with
 * its taskId) and returns a structured report the briefing / observability
 * digest can surface or block on. Nothing here writes.
 */

/** One captured tool/LLM call, tagged with the task it belongs to. */
export interface TaskCostEntry {
  taskId: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export interface ClaimedTaskCost {
  taskId: string;
  /** Authoritative totals stamped by the agent run for this task. */
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export type IntegrityStatus = "ok" | "undercount" | "overcount" | "no-data";

export interface IntegrityReport {
  taskId: string;
  status: IntegrityStatus;
  /** Number of captured entries attributed to this task. */
  capturedCalls: number;
  claimed: { tokens: number; usd: number };
  captured: { tokens: number; usd: number };
  /** claimed - captured (positive means the ledger is missing spend). */
  deltaTokens: number;
  deltaUsd: number;
  message: string;
}

export interface IntegrityTolerance {
  /** Relative tolerance as a fraction of the claimed total. Default 0.01 (1%). */
  relative?: number;
  /** Absolute token floor below which a delta is treated as noise. Default 50. */
  absoluteTokens?: number;
  /** Absolute USD floor below which a delta is treated as noise. Default 0.01. */
  absoluteUsd?: number;
}

const DEFAULT_TOLERANCE: Required<IntegrityTolerance> = {
  relative: 0.01,
  absoluteTokens: 50,
  absoluteUsd: 0.01,
};

function withinTolerance(
  claimed: number,
  captured: number,
  absFloor: number,
  relative: number,
): boolean {
  const delta = Math.abs(claimed - captured);
  if (delta <= absFloor) return true;
  const allowed = Math.abs(claimed) * relative;
  return delta <= allowed;
}

/**
 * Verify one task's claimed totals against the captured entries. `entries` may
 * be the full ledger; only rows whose `taskId` matches are used.
 */
export function verifyTaskCostIntegrity(
  claimed: ClaimedTaskCost,
  entries: TaskCostEntry[],
  tolerance: IntegrityTolerance = {},
): IntegrityReport {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const mine = entries.filter((e) => e.taskId === claimed.taskId);

  const capturedTokens = mine.reduce((s, e) => s + e.tokensIn + e.tokensOut, 0);
  const capturedUsd = mine.reduce((s, e) => s + e.usd, 0);
  const claimedTokens = claimed.tokensIn + claimed.tokensOut;

  const deltaTokens = claimedTokens - capturedTokens;
  const deltaUsd = claimed.usd - capturedUsd;

  const base = {
    taskId: claimed.taskId,
    capturedCalls: mine.length,
    claimed: { tokens: claimedTokens, usd: claimed.usd },
    captured: { tokens: capturedTokens, usd: capturedUsd },
    deltaTokens,
    deltaUsd,
  };

  if (mine.length === 0 && claimedTokens > tol.absoluteTokens) {
    return {
      ...base,
      status: "no-data",
      message: `task ${claimed.taskId} claims ${claimedTokens} tokens but has zero captured entries, tool cost recording is not wired for this path`,
    };
  }

  const tokensOk = withinTolerance(claimedTokens, capturedTokens, tol.absoluteTokens, tol.relative);
  const usdOk = withinTolerance(claimed.usd, capturedUsd, tol.absoluteUsd, tol.relative);

  if (tokensOk && usdOk) {
    return { ...base, status: "ok", message: `task ${claimed.taskId} cost reconciles` };
  }

  // A positive delta on either axis means the ledger captured less than claimed.
  if (deltaTokens > 0 || deltaUsd > 0) {
    return {
      ...base,
      status: "undercount",
      message: `task ${claimed.taskId} ledger UNDERCOUNTS by ${deltaTokens} tokens / $${deltaUsd.toFixed(4)} across ${mine.length} captured calls, a tool turn or intermediate message was not recorded`,
    };
  }

  return {
    ...base,
    status: "overcount",
    message: `task ${claimed.taskId} ledger OVERCOUNTS by ${-deltaTokens} tokens / $${(-deltaUsd).toFixed(4)}, a call was double-recorded or a stray entry leaked in`,
  };
}

export interface IntegrityAudit {
  reports: IntegrityReport[];
  summary: {
    total: number;
    ok: number;
    undercount: number;
    overcount: number;
    noData: number;
    /** True when every task reconciled, safe for the briefing to trust totals. */
    clean: boolean;
  };
}

/** Audit many tasks at once and produce a briefing-ready summary. */
export function auditLedgerIntegrity(
  claims: ClaimedTaskCost[],
  entries: TaskCostEntry[],
  tolerance: IntegrityTolerance = {},
): IntegrityAudit {
  const reports = claims.map((c) => verifyTaskCostIntegrity(c, entries, tolerance));
  const summary = {
    total: reports.length,
    ok: reports.filter((r) => r.status === "ok").length,
    undercount: reports.filter((r) => r.status === "undercount").length,
    overcount: reports.filter((r) => r.status === "overcount").length,
    noData: reports.filter((r) => r.status === "no-data").length,
    clean: false,
  };
  summary.clean = summary.ok === summary.total && summary.total > 0;
  return { reports, summary };
}
