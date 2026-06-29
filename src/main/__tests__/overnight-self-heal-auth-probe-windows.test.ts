/**
 * Phase 0 corrections (Codex HOLD, 2026-06-28) for the pre-spawn auth probe.
 * Encodes the CATEGORY, not one incident:
 *
 *   ISSUE 1: on win32 a .cmd shim must be routed through cmd.exe /c with shell:false,
 *            or spawnSync sets res.error on a HEALTHY run and the probe falsely reports
 *            auth-failed, blocking the whole loop. A real spawn error and a real 401
 *            auth sentinel must be distinguished: only an actual auth sentinel blocks.
 *   ISSUE 2: when auth stays dead the single named auth-failed defect must be appended
 *            to the run-log JSONL the briefing reads, not just returned in memory.
 *
 * The spawn is injected so no real CLI runs.
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

describe('Phase 0 ISSUE 1: defaultClaudeAuthProbe Windows cmd.exe routing', () => {
  it('routes the win32 probe through cmd.exe /c <claude.cmd>, not the .cmd directly', () => {
    let capturedFile = '';
    let capturedArgs: string[] = [];
    const probe = orch.defaultClaudeAuthProbe({
      platform: 'win32',
      spawnSync: (file: string, args: string[]) => {
        capturedFile = file;
        capturedArgs = args;
        return { status: 0, stdout: 'pong', stderr: '', error: null };
      },
    });
    expect(probe.ok).toBe(true);
    expect(capturedFile).toBe('cmd.exe');
    expect(capturedArgs[0]).toBe('/c');
    expect(capturedArgs[1]).toMatch(/claude\.cmd$/i);
    // the actual probe flags follow the bin
    expect(capturedArgs).toContain('--print');
    expect(capturedArgs).toContain('ping');
  });

  it('calls the claude binary directly on non-win32 (no cmd.exe wrapper)', () => {
    let capturedFile = '';
    const probe = orch.defaultClaudeAuthProbe({
      platform: 'linux',
      spawnSync: (file: string) => {
        capturedFile = file;
        return { status: 0, stdout: 'pong', stderr: '', error: null };
      },
    });
    expect(probe.ok).toBe(true);
    expect(capturedFile).toBe('claude');
  });

  it('distinguishes a healthy run from a 401: only a real auth sentinel reports failure', () => {
    // Healthy: status 0, no error, real output -> ok
    const healthy = orch.defaultClaudeAuthProbe({
      platform: 'win32',
      spawnSync: () => ({ status: 0, stdout: 'pong', stderr: '', error: null }),
    });
    expect(healthy.ok).toBe(true);

    // A real spawn error (the bug class) is a failure, but it is reported as a spawn
    // error, distinct from a 401 sentinel.
    const spawnErr = orch.defaultClaudeAuthProbe({
      platform: 'win32',
      spawnSync: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn EINVAL') }),
    });
    expect(spawnErr.ok).toBe(false);
    expect(spawnErr.detail).toMatch(/spawn error/i);

    // A real 401 sentinel in the output is the auth failure that must block.
    const authFail = orch.defaultClaudeAuthProbe({
      platform: 'win32',
      spawnSync: () => ({ status: 0, stdout: 'API Error: 401', stderr: '', error: null }),
    });
    expect(authFail.ok).toBe(false);
    expect(authFail.detail).toMatch(/auth\/quota failure/i);
  });
});

describe('Phase 0 ISSUE 2: auth-failed defect is persisted to the run log', () => {
  it('appends the single named auth-failed defect row to the run-log JSONL', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auth-defect-log-'));
    const briefingsDir = path.join(tmp, 'briefings');
    fs.mkdirSync(briefingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(briefingsDir, 'briefing-2026-06-28.md'),
      [
        'BLOCKERS - briefing quality gates:',
        '',
        '1. Tests (system health red)',
        '   Requirement: The suite must be green.',
        '   Evidence: 1 real failure needs Amy.',
        '   Repair now: route to the owning card worker.',
        '   Owner: Amy',
        '   Need from ExampleCo: Nothing.',
        '',
        'MEETINGS:',
      ].join('\n'),
      'utf8',
    );
    const runLogPath = path.join(tmp, 'runs.jsonl');
    const result = await orch.runOrchestrator({
      date: '2026-06-28',
      briefingsDir,
      runLogPath,
      // a markdown-only run would have no canonical defect; feed the survivor via live QC
      liveRenderQc: true,
      preRepairPublishRefresh: false,
      liveRenderQcRunner: () => ({
        status: 1,
        stdout: '',
        stderr:
          'dashboard QC FAILED: 1 defect(s):\n  - NEWS-PROSE: us_news (US NEWS) row 1 is not a three-ExampleCoraph summary of its article\n',
      }),
      mode: { observe: false, parallel: false, midday: false, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      // auth stays dead even after a forced refresh
      authProbe: () => ({ ok: false, detail: 'API Error: 401' }),
      tokenRefresh: async () => ({ ok: false, detail: 'refresh token expired' }),
      spawnSession: async () => ({ status: 'cleared', commit_sha: 'x', pushed: true }),
    });
    expect(result.authFailed).toBe(true);
    const log = fs.readFileSync(runLogPath, 'utf8');
    // The named defect row is durably written for the briefing to read.
    expect(log).toMatch(/"stage":"self-heal-defect"/);
    expect(log).toMatch(/"defectType":"SELF-HEAL-AUTH-FAILED"/);
    expect(log).toMatch(/Self-Heal Executor: auth failed/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
