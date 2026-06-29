/**
 * Category guard (overnight self-heal RED, 2026-06-28): before spawning the heal
 * worker fan-out, the orchestrator must run one authenticated probe. If auth is
 * dead even after a forced token refresh, it must spawn ZERO workers and surface
 * exactly one named auth System Health defect instead of firing N sessions that
 * each hit "API Error: 401". When the probe passes, it must proceed to spawn.
 *
 * This encodes the CATEGORY (known-dead auth state => no fan-out, one named
 * defect; healthy auth => proceed), not the single 401 incident. The probe and
 * refresh are injected so no real CLI or network is hit.
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

const BLOCKER_MD = [
  'BLOCKERS - briefing quality gates:',
  '',
  '1. Tests (system health red)',
  '   Requirement: The full product and briefing test suite must be green.',
  '   Evidence: 1 real failure needs Amy to fix the underlying behavior.',
  '   Repair now: Route this defect to the owning card worker and refresh.',
  '   Owner: Amy',
  '   Need from ExampleCo: Nothing.',
  '',
  'MEETINGS:',
].join('\n');

function makeBriefing(): { tmp: string; briefingsDir: string; runLogPath: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auth-preflight-'));
  const briefingsDir = path.join(tmp, 'briefings');
  fs.mkdirSync(briefingsDir, { recursive: true });
  fs.writeFileSync(path.join(briefingsDir, 'briefing-2026-06-28.md'), BLOCKER_MD, 'utf8');
  return { tmp, briefingsDir, runLogPath: path.join(tmp, 'runs.jsonl') };
}

describe('overnight-self-heal auth preflight', () => {
  it('spawns ZERO workers and surfaces one named auth defect when auth stays dead', async () => {
    const { tmp, briefingsDir, runLogPath } = makeBriefing();
    const sessions: string[] = [];
    let refreshCalls = 0;
    let probeCalls = 0;
    const result = await orch.runOrchestrator({
      date: '2026-06-28',
      briefingsDir,
      runLogPath,
      liveRenderQc: false,
      mode: { observe: false, parallel: false, midday: false, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      authProbe: () => {
        probeCalls += 1;
        return { ok: false, detail: 'simulated 401' };
      },
      tokenRefresh: async () => {
        refreshCalls += 1;
        return { ok: true, refreshed: true };
      },
      spawnSession: async (blocker: any) => {
        sessions.push(blocker.title);
        return { status: 'cleared', commit_sha: 'abc', pushed: true };
      },
    });
    // No worker was spawned into the dead-auth state.
    expect(sessions).toEqual([]);
    // Exactly one forced refresh attempt, then a re-probe (two probe calls total).
    expect(refreshCalls).toBe(1);
    expect(probeCalls).toBe(2);
    // The run stopped cleanly, flagged auth, and produced the single named defect.
    expect(result.ok).toBe(false);
    expect(result.authFailed).toBe(true);
    expect(result.authBlocker).toBeTruthy();
    expect(result.authBlocker.title).toBe('Self-Heal Executor: auth failed');
    expect(result.authBlocker.source).toBe('self-heal-health');
    expect(result.authBlocker.repair).toMatch(/claude \/login/);
    expect(result.authBlocker.repair).toMatch(/claude-token-refresh\.jsonl/);
    // The run log recorded the auth failure and a clean stop.
    const log = fs.readFileSync(runLogPath, 'utf8');
    expect(log).toMatch(/"authFailed":true/);
    expect(log).toMatch(/self-heal-executor-auth-failed/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers after one refresh and proceeds to spawn when the re-probe passes', async () => {
    const { tmp, briefingsDir, runLogPath } = makeBriefing();
    const sessions: string[] = [];
    let probeCalls = 0;
    let refreshCalls = 0;
    const result = await orch.runOrchestrator({
      date: '2026-06-28',
      briefingsDir,
      runLogPath,
      liveRenderQc: false,
      mode: { observe: false, parallel: false, midday: false, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      authProbe: () => {
        probeCalls += 1;
        // First probe dead, refresh, second probe healthy.
        return probeCalls === 1 ? { ok: false, detail: 'expired' } : { ok: true };
      },
      tokenRefresh: async () => {
        refreshCalls += 1;
        return { ok: true, refreshed: true };
      },
      spawnSession: async (blocker: any) => {
        sessions.push(blocker.title);
        return { status: 'cleared', commit_sha: 'abc', pushed: false };
      },
    });
    expect(refreshCalls).toBe(1);
    expect(probeCalls).toBe(2);
    // Auth recovered, so the survivor was spawned.
    expect(sessions.length).toBe(1);
    expect(result.authFailed).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('proceeds straight to spawn when the first probe already passes (no refresh)', async () => {
    const { tmp, briefingsDir, runLogPath } = makeBriefing();
    const sessions: string[] = [];
    let probeCalls = 0;
    let refreshCalls = 0;
    const result = await orch.runOrchestrator({
      date: '2026-06-28',
      briefingsDir,
      runLogPath,
      liveRenderQc: false,
      mode: { observe: false, parallel: false, midday: false, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      authProbe: () => {
        probeCalls += 1;
        return { ok: true };
      },
      tokenRefresh: async () => {
        refreshCalls += 1;
        return { ok: true };
      },
      spawnSession: async (blocker: any) => {
        sessions.push(blocker.title);
        return { status: 'cleared', commit_sha: 'abc', pushed: false };
      },
    });
    expect(probeCalls).toBe(1);
    expect(refreshCalls).toBe(0);
    expect(sessions.length).toBe(1);
    expect(result.authFailed).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('overnight-self-heal auth preflight unit', () => {
  it('preflightHealAuth returns ok without refreshing when the first probe passes', async () => {
    let refreshed = false;
    const r = await orch.preflightHealAuth({
      authProbe: () => ({ ok: true }),
      tokenRefresh: async () => {
        refreshed = true;
        return { ok: true };
      },
    });
    expect(r.ok).toBe(true);
    expect(refreshed).toBe(false);
  });

  it('preflightHealAuth refreshes once then surfaces a named blocker when auth stays dead', async () => {
    let refreshCalls = 0;
    const r = await orch.preflightHealAuth({
      authProbe: () => ({ ok: false, detail: 'dead' }),
      tokenRefresh: async () => {
        refreshCalls += 1;
        return { ok: false, detail: 'refresh token expired' };
      },
    });
    expect(r.ok).toBe(false);
    expect(refreshCalls).toBe(1);
    expect(r.blocker.title).toBe('Self-Heal Executor: auth failed');
    expect(r.blocker.owner).toBe('ExampleCo');
  });
});
