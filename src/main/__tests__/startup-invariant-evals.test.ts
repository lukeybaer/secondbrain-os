// startup-invariant-evals.test.ts
//
// Run-128 wiring: the boot invariant eval suite is the first runtime consumer
// of agent-eval-harness. This test exercises runInvariantEvals(facts) directly
// (passing a fixed fact snapshot so no Electron / live env is needed) and locks
// that the harness scores all-true facts as a 100% pass and a failing fact as a
// named failure. electron is mocked because startup-checks imports it at module
// load even though runInvariantEvals(facts) never touches it.

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/${k}` },
  protocol: { registerSchemesAsPrivileged: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { runInvariantEvals, type BootInvariantFacts } from '../startup-checks';

const ALL_GOOD: BootInvariantFacts = {
  anthropicKeyPresent: true,
  notRunningFromWorktree: true,
  userDataResolvable: true,
};

describe('boot invariant evals (run 128)', () => {
  it('scores an all-true fact snapshot at 100% with no failures', async () => {
    const report = await runInvariantEvals(ALL_GOOD);
    expect(report.total).toBe(3);
    expect(report.passRate).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it('names the specific failing invariant', async () => {
    const report = await runInvariantEvals({
      ...ALL_GOOD,
      anthropicKeyPresent: false,
    });
    expect(report.failures).toEqual(['anthropic-key-present']);
    expect(report.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('a worktree boot surfaces the worktree invariant as failing', async () => {
    const report = await runInvariantEvals({
      ...ALL_GOOD,
      notRunningFromWorktree: false,
    });
    expect(report.failures).toContain('not-running-from-worktree');
  });
});
