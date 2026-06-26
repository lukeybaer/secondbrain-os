import { describe, it, expect } from "vitest";
import {
  verifyTaskCostIntegrity,
  auditLedgerIntegrity,
  type ClaimedTaskCost,
  type TaskCostEntry,
} from "../tool-cost-integrity";

function entry(taskId: string, tokensIn: number, tokensOut: number, usd: number): TaskCostEntry {
  return { taskId, tokensIn, tokensOut, usd };
}

describe("verifyTaskCostIntegrity", () => {
  it("reports ok when the ledger sum reconciles with the claimed total", () => {
    const claimed: ClaimedTaskCost = { taskId: "t1", tokensIn: 1000, tokensOut: 500, usd: 0.45 };
    const entries = [entry("t1", 600, 300, 0.27), entry("t1", 400, 200, 0.18)];
    const r = verifyTaskCostIntegrity(claimed, entries);
    expect(r.status).toBe("ok");
    expect(r.capturedCalls).toBe(2);
    expect(r.captured.tokens).toBe(1500);
  });

  it("flags an undercount when a tool turn was never recorded (the #2310 bug)", () => {
    const claimed: ClaimedTaskCost = { taskId: "t1", tokensIn: 1000, tokensOut: 500, usd: 0.45 };
    // Only one of two real calls made it into the ledger.
    const entries = [entry("t1", 600, 300, 0.27)];
    const r = verifyTaskCostIntegrity(claimed, entries);
    expect(r.status).toBe("undercount");
    expect(r.deltaTokens).toBe(600);
    expect(r.message).toMatch(/UNDERCOUNTS/);
  });

  it("flags an overcount when an entry was double-recorded", () => {
    const claimed: ClaimedTaskCost = { taskId: "t1", tokensIn: 600, tokensOut: 300, usd: 0.27 };
    const entries = [entry("t1", 600, 300, 0.27), entry("t1", 600, 300, 0.27)];
    const r = verifyTaskCostIntegrity(claimed, entries);
    expect(r.status).toBe("overcount");
    expect(r.deltaTokens).toBe(-900);
  });

  it("reports no-data when a claimed task has zero ledger entries", () => {
    const claimed: ClaimedTaskCost = { taskId: "t9", tokensIn: 1000, tokensOut: 0, usd: 0.3 };
    const r = verifyTaskCostIntegrity(claimed, []);
    expect(r.status).toBe("no-data");
  });

  it("ignores other tasks' entries when scoping a single task", () => {
    const claimed: ClaimedTaskCost = { taskId: "t1", tokensIn: 600, tokensOut: 300, usd: 0.27 };
    const entries = [entry("t1", 600, 300, 0.27), entry("t2", 9999, 9999, 9.99)];
    expect(verifyTaskCostIntegrity(claimed, entries).status).toBe("ok");
  });

  it("treats sub-tolerance rounding noise as ok, not a divergence", () => {
    const claimed: ClaimedTaskCost = { taskId: "t1", tokensIn: 1000, tokensOut: 500, usd: 0.45 };
    // 20-token shortfall is under the 50-token absolute floor.
    const entries = [entry("t1", 990, 490, 0.45)];
    expect(verifyTaskCostIntegrity(claimed, entries).status).toBe("ok");
  });
});

describe("auditLedgerIntegrity", () => {
  it("summarizes many tasks and only reports clean when all reconcile", () => {
    const claims: ClaimedTaskCost[] = [
      { taskId: "a", tokensIn: 100, tokensOut: 0, usd: 0.01 },
      { taskId: "b", tokensIn: 1000, tokensOut: 0, usd: 0.3 },
    ];
    const entries = [entry("a", 100, 0, 0.01), entry("b", 400, 0, 0.12)];
    const audit = auditLedgerIntegrity(claims, entries);
    expect(audit.summary.total).toBe(2);
    expect(audit.summary.ok).toBe(1);
    expect(audit.summary.undercount).toBe(1);
    expect(audit.summary.clean).toBe(false);
  });

  it("is clean when every task reconciles", () => {
    const claims: ClaimedTaskCost[] = [{ taskId: "a", tokensIn: 100, tokensOut: 0, usd: 0.01 }];
    const audit = auditLedgerIntegrity(claims, [entry("a", 100, 0, 0.01)]);
    expect(audit.summary.clean).toBe(true);
  });
});
