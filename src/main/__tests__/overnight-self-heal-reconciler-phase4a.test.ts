/**
 * Stay-Green Phase 4a wiring guards: the desired-state reconciler pieces are wired into
 * runOrchestrator. Each test encodes the CATEGORY, not a single incident, and injects all
 * spawn/probe seams so no real CLI/network/EC2 is hit:
 *
 *   item 2 NO-REPEAT TACTIC: a survivor whose SAME tactic + SAME input already failed for
 *          its defect (recorded in the injected per-defect repair ledger) is NOT spawned;
 *          it escalates "tactic exhausted".
 *   item 1+3 LEDGER + BLOCKERS: a worker result writes a per-defect ledger row, and the
 *          returned ledgerBlockers are generated from open rows (shrink when a defect clears).
 *   item 4 EXECUTOR-HEALTH -> SYSTEM HEALTH: an auth-failed executor yields exactly ONE
 *          executorHealthRow on the result (not N card defects).
 *   item 5 MODE-EQUIVALENCE: when the overnight/attended paths diverge, the run exits
 *          nonzero (modeEquivalenceFailed) BEFORE spawning anything.
 *   item 6 ERROR BUDGET: an exhausted repair phase publishes a named RED (budgetRed) and
 *          never spawns.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orch = require(
  path.resolve(__dirname, '../../../scripts/overnight-self-heal-orchestrator.js'),
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ledger = require(
  path.resolve(__dirname, '../../../scripts/self-heal/briefing-repair-ledger.js'),
);

const DATE = '2026-06-29';
const QC_DEFECT =
  'dashboard QC FAILED: 1 defect(s):\n  - NEWS-PROSE: us_news (US NEWS) row 1 is not a three-ExampleCoraph summary of its article\n';

function makeWorktree(): {
  tmp: string;
  briefingsDir: string;
  runLogPath: string;
  dataDir: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase4a-'));
  const briefingsDir = path.join(tmp, 'briefings');
  fs.mkdirSync(briefingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(briefingsDir, `briefing-${DATE}.md`),
    'BLOCKERS - briefing quality gates:\n\nMEETINGS:\n',
    'utf8',
  );
  return {
    tmp,
    briefingsDir,
    runLogPath: path.join(tmp, 'runs.jsonl'),
    dataDir: path.join(tmp, 'data'),
  };
}

const BASE = (overrides: any) => ({
  date: DATE,
  liveRenderQc: true,
  preRepairPublishRefresh: false,
  maxPasses: 1,
  liveRenderQcRunner: () => ({ status: 1, stdout: '', stderr: QC_DEFECT }),
  mode: { observe: false, parallel: false, midday: false, concurrency: 1 },
  scheduledRepair: () => null,
  mechanicalRepair: () => null,
  videoBlockerPreflight: () => null,
  actionItemsRepair: () => null,
  videoApprovalRepair: () => null,
  authProbe: () => ({ ok: true }),
  tokenRefresh: async () => ({ ok: true }),
  publishRefresh: () => ({ ok: true, skipped: false, status: 0 }),
  ...overrides,
});

describe('Phase 4a orchestrator wiring', () => {
  it('item 5: exits nonzero before spawning when the heal run-graphs diverge', async () => {
    const { tmp, briefingsDir, runLogPath } = makeWorktree();
    const sessions: string[] = [];
    const g = orch.loadRunGraph();
    const result = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        // overnight reads the authority graph; attended drops a stage -> divergence
        overnightStages: g.stages,
        attendedStages: g.stages.filter((s: string) => s !== 'auth-preflight'),
        spawnSession: async (b: any) => {
          sessions.push(b.title);
          return { status: 'cleared', commit_sha: 'abc', pushed: false };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.modeEquivalenceFailed).toBe(true);
    expect(result.divergence).toBeTruthy();
    expect(sessions).toEqual([]); // nothing spawned
    const log = fs.readFileSync(runLogPath, 'utf8');
    expect(log).toMatch(/mode-equivalence-divergence/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('item 5: proceeds to spawn when both paths read the same run-graph', async () => {
    const { tmp, briefingsDir, runLogPath, dataDir } = makeWorktree();
    const sessions: string[] = [];
    const result = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        repairLedgerOpts: { dataDir },
        spawnSession: async (b: any) => {
          sessions.push(b.title);
          return { status: 'cleared', commit_sha: 'abc', pushed: false };
        },
        // post-repair QC clean so the worker clears
        postRepairLiveRenderQcRunner: undefined,
      }),
    );
    expect(result.modeEquivalenceFailed).toBeUndefined();
    expect(sessions.length).toBe(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('item 4: an auth-failed executor surfaces exactly one executorHealthRow, no spawn', async () => {
    const { tmp, briefingsDir, runLogPath } = makeWorktree();
    const sessions: string[] = [];
    const result = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        authProbe: () => ({ ok: false, detail: 'API Error: 401' }),
        tokenRefresh: async () => ({ ok: false, detail: 'refresh token expired' }),
        spawnSession: async (b: any) => {
          sessions.push(b.title);
          return { status: 'cleared', commit_sha: 'abc', pushed: false };
        },
      }),
    );
    expect(sessions).toEqual([]);
    expect(result.authFailed).toBe(true);
    expect(result.executorHealthRow).toBeTruthy();
    expect(result.executorHealthRow.label).toBe('Self-Heal Executor');
    expect(result.executorHealthRow.status).toBe('red');
    // exactly one such row recorded in the run log (not N per-card defects)
    const rows = fs
      .readFileSync(runLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l))
      .filter((r: any) => r.stage === 'system-health-row' && r.source === 'executor-health');
    expect(rows.length).toBe(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('item 6: an exhausted repair error-budget publishes a named RED and never spawns', async () => {
    const { tmp, briefingsDir, runLogPath, dataDir } = makeWorktree();
    const sessions: string[] = [];
    // Inject a budget whose repair phase is already past its deadline at nowMs.
    const budget = orch.createBudget({ totalBudgetMs: 1000, startMs: 0 });
    const result = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        repairLedgerOpts: { dataDir },
        errorBudget: budget,
        nowMs: budget.hardDeadlineMs + 5000,
        spawnSession: async (b: any) => {
          sessions.push(b.title);
          return { status: 'cleared', commit_sha: 'abc', pushed: false };
        },
      }),
    );
    expect(sessions).toEqual([]);
    expect(result.errorBudgetExhausted).toBe(true);
    expect(result.budgetExhaustedPhase).toBe('repair');
    expect(result.budgetRed.row.status).toBe('red');
    expect(result.budgetRed.row.detail).toMatch(/HEAL-ERROR-BUDGET-EXHAUSTED/);
    const log = fs.readFileSync(runLogPath, 'utf8');
    expect(log).toMatch(/error-budget-exhausted/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('item 2: a survivor whose same tactic+input already failed is not spawned (tactic exhausted)', async () => {
    const { tmp, briefingsDir, runLogPath, dataDir } = makeWorktree();
    const ledgerOpts = { dataDir };
    // The orchestrator builds the defect key from the live render-QC card id. Pre-seed the
    // ledger with a FAILED attempt for that defect using the SAME tactic + input the
    // orchestrator will compute, so the no-repeat guard must reject the re-run.
    // Compute the exact input hash the wiring uses (evidence + rawDefects of the blocker).
    // The blocker is built by renderQcDefectsToBlockers; its tactic is the blocker.repair.
    // We discover the actual key/tactic/hash from a first dry observe pass, then seed.
    const observe = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath: path.join(tmp, 'observe.jsonl'),
        mode: { observe: true, parallel: false, midday: false, concurrency: 1 },
      }),
    );
    expect(observe.sessionsPlanned).toBe(1);

    const sessions: string[] = [];
    // First real run: worker "clears" locally but post-repair QC still shows the defect,
    // so the per-worker gate marks it survived and the ledger records a FAILED-equivalent
    // (qcResult 'survived') attempt for this defect+tactic+input.
    await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        repairLedgerOpts: ledgerOpts,
        spawnSession: async (b: any) => {
          sessions.push(b.title);
          return { status: 'cleared', commit_sha: '', pushed: false };
        },
      }),
    );
    expect(sessions.length).toBe(1);

    // Second run with the SAME inputs: the no-repeat guard must reject the identical move.
    const secondSessions: string[] = [];
    const second = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath: path.join(tmp, 'second.jsonl'),
        repairLedgerOpts: ledgerOpts,
        spawnSession: async (b: any) => {
          secondSessions.push(b.title);
          return { status: 'cleared', commit_sha: '', pushed: false };
        },
      }),
    );
    expect(secondSessions).toEqual([]); // identical tactic+input was not re-dispatched
    expect(second.escalatedCount).toBeGreaterThan(0);
    const log = fs.readFileSync(path.join(tmp, 'second.jsonl'), 'utf8');
    expect(log).toMatch(/no-repeat-tactic/);
    expect(log).toMatch(/tactic exhausted/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('item 1+3: a cleared worker writes a ledger row and ledgerBlockers reflect open defects', async () => {
    const { tmp, briefingsDir, runLogPath, dataDir } = makeWorktree();
    const ledgerOpts = { dataDir };
    // Worker survives post-repair QC -> defect stays OPEN -> one ledger row, one blocker.
    const survived = await orch.runOrchestrator(
      BASE({
        briefingsDir,
        runLogPath,
        repairLedgerOpts: ledgerOpts,
        spawnSession: async () => ({ status: 'cleared', commit_sha: '', pushed: false }),
      }),
    );
    expect(Array.isArray(survived.ledgerBlockers)).toBe(true);
    expect(survived.ledgerBlockers.length).toBe(1);
    const rows = ledger.attemptRows(DATE, ledgerOpts);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1].qcResult).toBe('survived');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
