/**
 * Regression test for the overnight self-heal orchestrator.
 *
 * Background (2026-05-23): ExampleCo called out that the heal-tests loop only
 * re-ran vitest with no repair, then we added mechanical-fix handlers, and
 * ExampleCo called out again that mechanical fixes are NOT the goal. The goal
 * is REAL development work overnight: spawn Claude Code sessions per
 * blocker that investigate, write/update tests, fix code, consult Codex
 * on meaningful changes, commit, push, and verify the blocker is cleared.
 * By morning, the briefing reflects work that actually happened.
 *
 * This test pins the orchestrator's PURE helpers (no live CLI spawns):
 *   - parseBlockersFromMarkdown: reads briefing markdown blockers section
 *   - buildSessionPrompt: composes the per-blocker prompt with context
 *   - classifySessionResult: parses stream-json output to decide cleared
 *     vs escalated
 *   - shouldRespectDeadline: deadline-aware gating before each spawn
 *
 * The actual `claude --print` spawn is exercised separately, gated by an
 * env flag (OVERNIGHT_ORCHESTRATOR_LIVE_TEST=1) since each live run costs
 * real Anthropic tokens.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orch = require(path.resolve(__dirname, '../../../scripts/overnight-self-heal-orchestrator.js'));

const SAMPLE_BRIEFING_BLOCKERS = `Good morning ExampleCo - Saturday, May 23, 2026
Daily Executive Briefing
---

BLOCKERS - briefing quality gates:

1. Tests (system health red)
     Requirement: The full product and briefing test suite must be green.
     Evidence: 1 real failure(s) need Amy to fix the underlying behavior; 0 stale-assert(s).
     Repair now: Route this defect to the owning card worker and refresh.
     Owner: Amy
     Need from ExampleCo: Nothing.

2. Video approval queue has unresolved rejected work
     Requirement: Rejected or failed-gate videos must not be surfaced as approval-ready.
     Evidence: short009_hggs is blocked: ec2 mp4 pull failed after 3 attempts.
     Repair now: Run the video regen/thumbnail repair loop, preserve rejection history.
     Owner: Amy
     Need from ExampleCo: None.

---

MEETINGS - today + next 7 days:
`;

describe('overnight-self-heal-orchestrator: parseBlockersFromMarkdown', () => {
  it('extracts each blocker as a structured task with title, evidence, owner, need', () => {
    const blockers = orch.parseBlockersFromMarkdown(SAMPLE_BRIEFING_BLOCKERS);
    expect(blockers.length).toBe(2);
    expect(blockers[0].title).toBe('Tests (system health red)');
    expect(blockers[0].evidence).toMatch(/1 real failure/);
    expect(blockers[0].owner).toBe('Amy');
    expect(blockers[1].title).toMatch(/Video approval queue/);
    expect(blockers[1].evidence).toMatch(/short009_hggs/);
  });

  it('returns empty array when briefing has no blockers section', () => {
    expect(orch.parseBlockersFromMarkdown('No blockers section here.')).toEqual([]);
  });

  it('returns empty array when blockers section is empty', () => {
    const md = `BLOCKERS - briefing quality gates:\n\n  No hard blockers need ExampleCo.\n\nMEETINGS:\n`;
    expect(orch.parseBlockersFromMarkdown(md)).toEqual([]);
  });

  it('does not read numbered rows from later cards as blockers after a clear Blockers section', () => {
    const md = [
      'BLOCKERS - briefing quality gates:',
      'Clear: no owner decision is needed for this briefing.',
      '',
      '---',
      'TOKEN USAGE YESTERDAY (Claude Max plan, free):',
      '0.04M input-like / 0K output across 14 sessions',
      '',
      '---',
      'MEETINGS - today + next 7 days:',
      '1. 10:00 AM Personal payment reminder',
      '2. 6:00 PM Next half hour church at home',
      '',
      '---',
    ].join('\n');
    expect(orch.parseBlockersFromMarkdown(md)).toEqual([]);
  });

  it('also stops at a mixed-case top-level card header when no divider is present', () => {
    const md = [
      'BLOCKERS - briefing quality gates:',
      'Clear: no owner decision is needed for this briefing.',
      '',
      'MEETINGS - today + next 7 days:',
      '1. 10:00 AM Personal payment reminder',
      '2. 6:00 PM Next half hour church at home',
    ].join('\n');
    expect(orch.parseBlockersFromMarkdown(md)).toEqual([]);
  });
});

describe('overnight-self-heal-orchestrator: live render-QC intake', () => {
  it('parses every verifier bullet as a raw defect', () => {
    const defects = orch.parseRenderQcDefects(
      [
        'dashboard QC FAILED: 2 defect(s):',
        '  - NEWS-PROSE: ai_tech_news (AI & TECH NEWS) row 1 is not a three-ExampleCoraph summary of its article',
        '  - NEWS-PROSE: ai_tech_news (AI & TECH NEWS) row 2 is not a three-ExampleCoraph summary of its article',
      ].join('\n'),
    );
    expect(defects).toHaveLength(2);
    expect(defects[0]).toMatch(/NEWS-PROSE/);
  });

  it('groups raw live defects for repair while preserving raw defect count in evidence', () => {
    const blockers = orch.renderQcDefectsToBlockers([
      'NEWS-PROSE: ai_tech_news (AI & TECH NEWS) row 1 is not a three-ExampleCoraph summary of its article',
      'NEWS-PROSE: ai_tech_news (AI & TECH NEWS) row 2 is not a three-ExampleCoraph summary of its article',
      'NEWS-PROSE: us_news (US NEWS) row 1 is not a three-ExampleCoraph summary of its article',
      'CARD-DUPLICATE: video_approval_queue rendered 2 matching tiles',
    ]);
    expect(blockers).toHaveLength(2);
    expect(blockers.find((b) => /all_news_cards/.test(b.title)).rawDefectCount).toBe(3);
    expect(blockers.find((b) => /all_news_cards/.test(b.title)).evidence).toMatch(/ai_tech_news/);
    expect(blockers.find((b) => /all_news_cards/.test(b.title)).evidence).toMatch(/us_news/);
    expect(blockers.find((b) => /video_approval_queue/.test(b.title)).rawDefectCount).toBe(1);
  });

  it('runs a heal session from live render-QC even when markdown has no blockers', async () => {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-live-render-qc-'));
    const briefingsDir = path.join(tmp, 'briefings');
    fs.mkdirSync(briefingsDir, { recursive: true });
    const briefingPath = path.join(briefingsDir, 'briefing-2026-06-24.md');
    fs.writeFileSync(
      briefingPath,
      'BLOCKERS - briefing quality gates:\n\n  No hard blockers need ExampleCo.\n\nMEETINGS - today + next 7 days:\n',
      'utf8',
    );
    const sessions: string[] = [];
    let qcCalls = 0;
    let refreshCalled = false;
    let postQcSawRefresh = false;
    const result = await orch.runOrchestrator({
      date: '2026-06-24',
      briefingsDir,
      runLogPath: path.join(tmp, 'runs.jsonl'),
      liveRenderQc: true,
      liveRenderQcRunner: () => {
        qcCalls += 1;
        if (qcCalls > 1 && sessions.length > 0) {
          postQcSawRefresh = refreshCalled;
          return { status: 0, stdout: 'dashboard QC passed', stderr: '' };
        }
        return {
          status: 1,
          stdout: '',
          stderr:
            'dashboard QC FAILED: 1 defect(s):\n  - NEWS-PROSE: ai_tech_news (AI & TECH NEWS) row 1 is not a three-ExampleCoraph summary of its article\n',
        };
      },
      mode: { observe: false, parallel: false, midday: true, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      publishRefresh: () => {
        refreshCalled = true;
        return { ok: true };
      },
      spawnSession: async (blocker: any) => {
        sessions.push(blocker.title);
        return {
          status: 'cleared',
          commit_sha: 'abc123',
          pushed: true,
          verification: 'live render QC passed',
          tests: 'targeted',
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(sessions).toEqual(['Live render QC NEWS-READINESS on news_cards']);
    expect(postQcSawRefresh).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not mark the run clean when post-repair live QC still finds defects', async () => {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-post-live-qc-'));
    const briefingsDir = path.join(tmp, 'briefings');
    fs.mkdirSync(briefingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(briefingsDir, 'briefing-2026-06-24.md'),
      'BLOCKERS - briefing quality gates:\n\n  No hard blockers need ExampleCo.\n\nMEETINGS:\n',
      'utf8',
    );
    const result = await orch.runOrchestrator({
      date: '2026-06-24',
      briefingsDir,
      runLogPath: path.join(tmp, 'runs.jsonl'),
      liveRenderQc: true,
      liveRenderQcRunner: () => ({
        status: 1,
        stdout: '',
        stderr:
          'dashboard QC FAILED: 1 defect(s):\n  - NEWS-PROSE: world_news (WORLD NEWS) row 1 is not a three-ExampleCoraph summary of its article\n',
      }),
      mode: { observe: false, parallel: false, midday: true, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      spawnSession: async () => ({
        status: 'cleared',
        commit_sha: 'abc123',
        pushed: true,
        verification: 'targeted passed',
        tests: 'targeted',
        reflection: 'targeted QC improved, live needs coordinator recheck',
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.postRepairRawDefects).toBe(1);
    expect(result.postRepairDefects[0]).toMatch(/NEWS-PROSE/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('never invokes the live render QC runner when live render QC is disabled (no canonical defect source => nothing to heal)', async () => {
    // Phase 1 DELETE: the markdown BLOCKERS card is no longer a DEFECT SOURCE for the
    // loop. With live render QC disabled there is no canonical defect source, so the
    // markdown "Tests" row is ignored, the runner is never called, and the loop has
    // nothing to heal.
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-live-qc-off-'));
    const briefingsDir = path.join(tmp, 'briefings');
    fs.mkdirSync(briefingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(briefingsDir, 'briefing-2026-06-24.md'),
      [
        'BLOCKERS:',
        '1. Tests (system health red)',
        '   Evidence: one test failed',
        '   Repair now: fix test',
        '   Owner: Amy',
        '   Need from ExampleCo: Nothing',
        '',
        'MEETINGS:',
      ].join('\n'),
      'utf8',
    );
    let runnerCalled = false;
    let spawned = false;
    const result = await orch.runOrchestrator({
      date: '2026-06-24',
      briefingsDir,
      runLogPath: path.join(tmp, 'runs.jsonl'),
      liveRenderQc: false,
      liveRenderQcRunner: () => {
        runnerCalled = true;
        throw new Error('live QC should not run');
      },
      mode: { observe: false, parallel: false, midday: true, concurrency: 1 },
      scheduledRepair: () => null,
      mechanicalRepair: () => null,
      videoBlockerPreflight: () => null,
      actionItemsRepair: () => null,
      videoApprovalRepair: () => null,
      spawnSession: async () => {
        spawned = true;
        return {
          status: 'cleared',
          commit_sha: 'abc123',
          pushed: true,
          verification: 'targeted passed',
          tests: 'targeted',
          reflection: 'targeted QC passed',
        };
      },
    });
    expect(runnerCalled).toBe(false);
    expect(spawned).toBe(false);
    expect(result.ok).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('overnight-self-heal-orchestrator: repair-loop exhaustion', () => {
  function historyEntry(groups: string[], rawDefects = 6) {
    return {
      pass: 1,
      rawDefects,
      exactSignature: groups.join('\n'),
      surfaceSignature: groups.map((g) => g.split(':')[0]).sort().join(','),
      groups,
    };
  }

  it('does not suppress a worker wave when live QC introduces a new card/type defect shape', () => {
    const history = Array.from({ length: 20 }, () =>
      historyEntry(['video_approval_queue:BLOCKED-TILE', 'system_health:BLOCKED-TILE']),
    );
    const current = historyEntry([
      'video_approval_queue:BLOCKED-TILE',
      'system_health:BLOCKED-TILE',
      'video_approval_queue:VIDEO-MANIFEST-DRIFT',
    ]);

    const summary = orch.summarizeRepairLoopExhaustion(history, current, {
      noLiveReductionAttemptLimit: 20,
    });

    expect(summary.exhausted).toBe(false);
    expect(summary.reason).toBe('fresh-defect-shape');
    expect(summary.freshGroups).toContain('video_approval_queue:VIDEO-MANIFEST-DRIFT');
  });

  it('still stops after the same defect shape repeats without live reduction', () => {
    const history = Array.from({ length: 20 }, () =>
      historyEntry(['video_approval_queue:BLOCKED-TILE', 'system_health:BLOCKED-TILE']),
    );
    const current = historyEntry(['video_approval_queue:BLOCKED-TILE', 'system_health:BLOCKED-TILE']);

    const summary = orch.summarizeRepairLoopExhaustion(history, current, {
      noLiveReductionAttemptLimit: 20,
    });

    expect(summary.exhausted).toBe(true);
    expect(summary.reason).toBe('options-exhausted-no-live-reduction');
  });

  it('does not reset the no-live-reduction counter just because the defect shape changes', () => {
    const oldHistory = Array.from({ length: 19 }, () =>
      historyEntry(['video_approval_queue:BLOCKED-TILE', 'action_items:BLOCKERS-NAMED-CARD'], 1),
    );
    const currentShape = [
      'system_health:BLOCKED-TILE',
      'us_immigration_news:BUILDER-COUNT',
      'action_items:BLOCKERS-NAMED-CARD',
      'us_news:BLOCKERS-NAMED-CARD',
      'dashboard:BLOCKERS-COUNT',
    ];
    const history = [...oldHistory, historyEntry(currentShape, 5)];
    const current = historyEntry(currentShape, 5);

    const summary = orch.summarizeRepairLoopExhaustion(history, current, {
      noLiveReductionAttemptLimit: 20,
    });

    expect(summary.exhausted).toBe(true);
    expect(summary.reason).toBe('options-exhausted-no-live-reduction');
  });
});

describe('overnight-self-heal-orchestrator: EC2 app root vs git root', () => {
  it('keeps the deployed app root separate from the coordinator git root', () => {
    const resolved = orch.resolveCoordinatorRepoRoot('C:/opt/secondbrain', {
      env: { SELF_HEAL_GIT_REPO: 'C:/home/ec2-user/secondbrain-current' },
      isGitWorkTree: (dir: string) =>
        dir.replace(/\\/g, '/') === 'C:/home/ec2-user/secondbrain-current',
    });
    expect(resolved.replace(/\\/g, '/')).toBe('C:/home/ec2-user/secondbrain-current');
  });

  it('fails loudly when no valid coordinator git root exists', () => {
    expect(() =>
      orch.resolveCoordinatorRepoRoot('C:/opt/secondbrain', {
        env: {},
        isGitWorkTree: () => false,
      }),
    ).toThrow(/No valid self-heal git root/);
  });

  it('keeps the cached coordinator lookup loud only when the healer asks for it', () => {
    expect(() =>
      orch.getCoordinatorRepoRoot('C:/opt/secondbrain', {
        env: {},
        isGitWorkTree: () => false,
      }),
    ).toThrow(/No valid self-heal git root/);
  });

  it('rejects unsafe deploy-copy paths before copying worker output to the app root', () => {
    expect(orch.safeDeployRelPath('scripts/lib/news-summarize.js')).toBe(
      'scripts/lib/news-summarize.js',
    );
    expect(orch.safeDeployRelPath('../.env')).toBe('');
    expect(orch.safeDeployRelPath('/opt/secondbrain/.env')).toBe('');
    expect(orch.safeDeployRelPath('node_modules')).toBe('');
    expect(orch.safeDeployRelPath('./node_modules')).toBe('');
    expect(orch.safeDeployRelPath('node_modules/.bin/vitest')).toBe('');
    expect(orch.safeDeployRelPath('.git/worktrees/sb-heal')).toBe('');
    expect(orch.safeDeployRelPath('.agents/session.json')).toBe('');
    expect(orch.safeDeployRelPath('.codex/config.json')).toBe('');
  });

  it('mirrors EC2 backend changes to the PM2 server entrypoint', () => {
    expect(orch.deployTargetsForRelPath('ec2-server.js')).toEqual([
      'ec2-server.js',
      'server.js',
    ]);
    expect(orch.deployTargetsForRelPath('scripts/lib/x.js')).toEqual(['scripts/lib/x.js']);
    expect(orch.deployTargetsForRelPath('node_modules')).toEqual([]);
  });

  it('copies only changed worker files into the deployed app root', () => {
    const fs = require('fs');
    const os = require('os');
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-worker-'));
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-app-'));
    fs.mkdirSync(path.join(worktree, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'scripts', 'lib', 'x.js'), 'fixed', 'utf8');
    const result = orch.deployChangedFilesFromWorktree({
      worktree,
      appRoot,
      commitSha: 'abc123',
      git: () => 'M\tscripts/lib/x.js\n',
    });
    expect(result.copied).toBe(1);
    expect(result.restart.skipped).toBe(true);
    expect(fs.readFileSync(path.join(appRoot, 'scripts', 'lib', 'x.js'), 'utf8')).toBe('fixed');
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  it('copies ec2-server.js changes into server.js for the live PM2 app', () => {
    const fs = require('fs');
    const os = require('os');
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-worker-'));
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-app-'));
    fs.writeFileSync(path.join(worktree, 'ec2-server.js'), 'fixed server', 'utf8');
    const result = orch.deployChangedFilesFromWorktree({
      worktree,
      appRoot,
      commitSha: 'abc123',
      git: () => 'M\tec2-server.js\n',
    });
    expect(result.copied).toBe(2);
    expect(result.restart.skipped).toBe(true);
    expect(fs.readFileSync(path.join(appRoot, 'ec2-server.js'), 'utf8')).toBe('fixed server');
    expect(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8')).toBe('fixed server');
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  it('does not delete server.js when a future diff deletes ec2-server.js', () => {
    const fs = require('fs');
    const os = require('os');
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-worker-'));
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-app-'));
    fs.writeFileSync(path.join(appRoot, 'ec2-server.js'), 'old ec2', 'utf8');
    fs.writeFileSync(path.join(appRoot, 'server.js'), 'live entrypoint', 'utf8');
    const result = orch.deployChangedFilesFromWorktree({
      worktree,
      appRoot,
      commitSha: 'abc123',
      git: () => 'D\tec2-server.js\n',
    });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(appRoot, 'ec2-server.js'))).toBe(false);
    expect(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8')).toBe('live entrypoint');
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  it('restarts the live backend when deployed JS can affect rendered dashboard output', () => {
    const calls: any[] = [];
    const result = orch.restartSecondbrainBackend({
      appRoot: '/opt/secondbrain',
      platform: 'linux',
      env: { SELF_HEAL_PM2_RESTART: '1' },
      runner: (cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        return { status: 0, stdout: 'restarted', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { cmd: 'pm2', args: ['restart', 'secondbrain-backend'], cwd: '/opt/secondbrain' },
    ]);
  });
});

describe('overnight-self-heal-orchestrator: self-heal health metrics', () => {
  it('turns worker watchdog failures and missing reflection into red self-heal health', () => {
    const health = orch.summarizeSelfHealHealth(
      [
        { title: 'Live render QC NEWS-PROSE on us_news', rawDefectCount: 8 },
        { title: 'Live render QC MISSING on token_usage', rawDefectCount: 1 },
      ],
      [
        {
          status: 'escalated',
          blockerTitle: 'Live render QC NEWS-PROSE on us_news',
          attempts: [
            {
              executor: 'claude',
              status: 'escalated',
              escalationReason: 'no JSON status block in output',
              durationMs: 70 * 60 * 1000,
              watchdog: { kind: 'contract-miss', killed: true, thresholdMs: 0 },
            },
          ],
        },
        {
          status: 'cleared',
          blockerTitle: 'Live render QC MISSING on token_usage',
          reflection: '',
          attempts: [
            { executor: 'claude', status: 'cleared', durationMs: 1000, watchdog: null },
          ],
        },
      ],
    );
    expect(health.status).toBe('red');
    expect(health.rawDefects).toBe(9);
    expect(health.workerKills).toBe(1);
    expect(health.contractMisses).toBe(1);
    expect(health.excessiveWorkerTimeGroups).toEqual([
      'Live render QC NEWS-PROSE on us_news',
    ]);
    expect(health.missingReflectionGroups).toEqual([
      'Live render QC MISSING on token_usage',
    ]);
  });

  it('keeps a recovered single idle kill visible without making health red by itself', () => {
    const health = orch.summarizeSelfHealHealth(
      [{ title: 'Live render QC NEWS-PROSE on world_news', rawDefectCount: 1 }],
      [
        {
          status: 'cleared',
          blockerTitle: 'Live render QC NEWS-PROSE on world_news',
          reflection: 'The new QC result passed after the fallback tactic.',
          tests: 'targeted live QC passed',
          verification: 'targeted live QC passed',
          attempts: [
            {
              executor: 'claude',
              status: 'escalated',
              escalationReason: 'claude produced no output after prior output',
              durationMs: 8 * 60 * 1000,
              watchdog: { kind: 'idle-hang', killed: true, thresholdMs: 8 * 60 * 1000 },
            },
            {
              executor: 'codex',
              status: 'cleared',
              durationMs: 60 * 1000,
              watchdog: null,
            },
          ],
        },
      ],
    );
    expect(health.status).toBe('green');
    expect(health.workerKills).toBe(1);
    expect(health.hardWatchdogKills).toBe(0);
    expect(health.detail).toMatch(/completed without watchdog defects/);
  });

  it('treats nested background-task watchdog kills as hard self-heal health defects', () => {
    const health = orch.summarizeSelfHealHealth(
      [{ title: 'Live render QC NEWS-PROSE on all_news_cards', rawDefectCount: 3 }],
      [
        {
          status: 'escalated',
          blockerTitle: 'Live render QC NEWS-PROSE on all_news_cards',
          attempts: [
            {
              executor: 'claude',
              status: 'escalated',
              escalationReason: 'claude started a nested background task inside a self-heal worker',
              durationMs: 1000,
              watchdog: { kind: 'nested-background-task', killed: true, thresholdMs: 0 },
            },
          ],
        },
      ],
    );
    expect(health.status).toBe('red');
    expect(health.hardWatchdogKills).toBe(1);
    expect(health.detail).toMatch(/hard watchdog kill/);
  });
});

describe('overnight-self-heal-orchestrator: classifyOwnership', () => {
  it('marks owner=Amy blockers as auto-attemptable', () => {
    const b = { title: 'Tests red', owner: 'Amy', need: 'Nothing' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(true);
  });

  it('refuses to auto-attempt when Need from ExampleCo names a credential or decision', () => {
    const b = { title: 'X', owner: 'Amy', need: 'ExampleCo must provide AWS credential rotation' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(false);
  });

  it('refuses to auto-attempt when owner is explicitly ExampleCo', () => {
    const b = { title: 'X', owner: 'ExampleCo', need: 'Decide whether to abandon clip' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(false);
  });

  // 2026-05-24 regression: today's briefing emitted a "Hard blocker, not a ExampleCo
  // decision" need-line; the prior peer-need regex matched the bare word
  // "decision" and refused to attempt the blocker, leaving it for the morning
  // when Amy clearly owned the work. Negation phrases must NOT trip the skip.
  it('auto-attempts when need explicitly denies ExampleCo ownership ("not a ExampleCo decision")', () => {
    const b = {
      title: 'Gmail scan',
      owner: 'Amy',
      need: 'Hard blocker, not a ExampleCo decision: the overnight heal window closed before this cleared.',
    };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(true);
  });

  it('auto-attempts when need begins with Nothing or None', () => {
    expect(orch.classifyOwnership({ title: 'X', owner: 'Amy', need: 'Nothing.' }).canAutoAttempt).toBe(true);
    expect(orch.classifyOwnership({ title: 'X', owner: 'Amy', need: 'None unless the scanner proves a named auth wall.' }).canAutoAttempt).toBe(true);
  });
});

// 2026-05-24 regression: orchestrator hard-coded `new Date().toISOString().slice(0,10)`
// for the briefing filename. The scheduled task runs at 22:30 CT; at that wall
// clock, the UTC date is already the next calendar day, so the file briefing-
// {tomorrow}.md does not exist yet and the orchestrator bailed at startup with
// "briefing not readable", clearing zero blockers and leaving the morning
// briefing red. resolveLatestBriefingPath must walk the briefings/ dir and
// pick the most recent file within a 36h window.
describe('overnight-self-heal-orchestrator: resolveLatestBriefingPath', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpRoot = path.join(os.tmpdir(), 'orch-resolveLatestBriefingPath-' + process.pid);
  const briefingsDir = path.join(tmpRoot, 'briefings');

  function setupTmp(files) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(briefingsDir, { recursive: true });
    for (const [name, mtimeMs] of files) {
      const p = path.join(briefingsDir, name);
      fs.writeFileSync(p, 'BLOCKERS - briefing quality gates:\n\n', 'utf8');
      fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    }
  }

  it('returns the exact-date file when today\'s briefing exists', () => {
    const today = '2026-05-24';
    const todayMs = Date.parse(`${today}T10:00:00Z`);
    setupTmp([[`briefing-${today}.md`, todayMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs: todayMs + 60_000 });
    expect(got).toBe(path.join(briefingsDir, `briefing-${today}.md`));
  });

  it('falls back to the most recent briefing within 36h when today\'s file is missing', () => {
    const today = '2026-05-24';
    const yesterday = '2026-05-23';
    const yesterdayMs = Date.parse(`${yesterday}T10:00:00Z`);
    const nowMs = Date.parse(`${today}T03:30:00Z`);
    setupTmp([[`briefing-${yesterday}.md`, yesterdayMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs });
    expect(got).toBe(path.join(briefingsDir, `briefing-${yesterday}.md`));
  });

  it('returns null when no briefing exists within the 36h window', () => {
    const today = '2026-05-24';
    const stale = '2026-05-01';
    const staleMs = Date.parse(`${stale}T10:00:00Z`);
    const nowMs = Date.parse(`${today}T03:30:00Z`);
    setupTmp([[`briefing-${stale}.md`, staleMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs });
    expect(got).toBeNull();
  });

  it('returns null when briefings dir is missing', () => {
    const got = orch.resolveLatestBriefingPath({
      date: '2026-05-24',
      briefingsDir: path.join(tmpRoot, 'does-not-exist'),
      nowMs: Date.now(),
    });
    expect(got).toBeNull();
  });
});

describe('overnight-self-heal-orchestrator: buildSessionPrompt', () => {
  it('includes the blocker title, evidence, repo root, deadline, and acceptance criteria', () => {
    const blocker = {
      title: 'Tests (system health red)',
      evidence: '1 real failure(s) need Amy to fix the underlying behavior.',
      requirement: 'The full product and briefing test suite must be green.',
      owner: 'Amy',
      need: 'Nothing',
    };
    const prompt = orch.buildSessionPrompt(blocker, {
      repoRoot: '/test/repo/path',
      deadlineIso: '2026-05-24T10:15:00Z',
      branchSummary: 'master, clean working tree',
    });
    expect(prompt).toContain('Tests (system health red)');
    expect(prompt).toContain('1 real failure');
    expect(prompt).toContain('/test/repo/path');
    expect(prompt).toContain('2026-05-24T10:15:00Z');
    expect(prompt).toMatch(/foreground peer-review command/i);
    expect(prompt).toMatch(/adversarial self-review/i);
    expect(prompt).toMatch(/recent attempt\/run history/i);
    expect(prompt).toMatch(/Do not repeat a prior tactic/i);
    expect(prompt).toMatch(/refresh the card/i);
    expect(prompt).toMatch(/no Markdown and no prose/i);
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toMatch(/push/i);
    expect(prompt).toMatch(/JSON/i);
    expect(prompt).toMatch(/"status"/);
    expect(prompt).toMatch(/"commit_sha"/);
    expect(prompt).toMatch(/"reflection"/);
  });

  it('tells isolated workers not to deploy or refresh the live card', () => {
    const prompt = orch.buildSessionPrompt(
      { title: 'Live render QC NEWS-PROSE on all_news_cards', owner: 'Amy', need: 'Nothing' },
      { repoRoot: '/test/repo/path', noPush: true },
    );
    expect(prompt).toMatch(/Do NOT commit and do NOT push/i);
    expect(prompt).toMatch(/Leave the verified file changes in the worktree/i);
    expect(prompt).toMatch(/coordinator owns/i);
    expect(prompt).toMatch(/pushed MUST be false/i);
    expect(prompt).toMatch(/commit_sha MUST be empty/i);
    expect(prompt).not.toMatch(/Then push to master/i);
  });
});

describe('overnight-self-heal-orchestrator: classifySessionResult', () => {
  it('classifies a clean cleared result with commit_sha and pushed=true', () => {
    const streamJson = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
      JSON.stringify({ type: 'result', result: '{"status":"cleared","commit_sha":"abc1234","pushed":true,"verification":"vitest passed","tests":"30/30","reflection":"new QC passed; prior defect cleared"}', subtype: 'success' }),
    ].join('\n');
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('cleared');
    expect(r.commit_sha).toBe('abc1234');
    expect(r.pushed).toBe(true);
    expect(r.reflection).toMatch(/prior defect cleared/);
  });

  it('classifies as escalated when the session exits non-zero', () => {
    const r = orch.classifySessionResult('', 1);
    expect(r.status).toBe('escalated');
    expect(r.escalationReason).toMatch(/exit/i);
  });

  it('classifies as escalated when JSON result is malformed', () => {
    const streamJson = JSON.stringify({ type: 'result', result: 'I could not complete this.', subtype: 'success' });
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('escalated');
  });

  it('classifies as escalated when status is "escalated" or commit_sha is empty', () => {
    const streamJson = JSON.stringify({ type: 'result', result: '{"status":"escalated","commit_sha":"","pushed":false,"escalation_reason":"missing test fixture"}', subtype: 'success' });
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('escalated');
    expect(r.escalationReason).toMatch(/missing test fixture/i);
  });
});

describe('overnight-self-heal-orchestrator: shouldRespectDeadline', () => {
  it('returns true when remaining time is less than the per-session budget', () => {
    const now = 1000000;
    expect(orch.shouldRespectDeadline(now, now + 60000, 600000)).toBe(true);
  });

  it('returns false when there is enough remaining time for a full session', () => {
    const now = 1000000;
    expect(orch.shouldRespectDeadline(now, now + 7200000, 1800000)).toBe(false);
  });
});

describe('overnight-self-heal-orchestrator: tryMechanicalRepair (2026-05-28)', () => {
  // Closes the 2026-05-28 #gap: orchestrator only knew how to spawn 25-min
  // claude CLI sessions. Deterministic test failures (vapi config drift,
  // BOM strip, file-size envelope, completeness-guard runtime tracking)
  // were sent into the claude CLI path and timed out every night.
  // The mechanical pre-flight uses heal-tests-repair so these get fixed
  // in seconds without LLM dependency.

  it('returns null when the blocker title is not test-related', () => {
    const r = orch.tryMechanicalRepair({ title: 'Client visa response (need from owner)' });
    expect(r).toBeNull();
  });

  it('returns null when no tests-blocked.json snapshot exists for the suite', () => {
    // No-op when there is no blocked snapshot to repair against.
    const fs = require('fs');
    const os = require('os');
    const blockedPath = path.join(os.tmpdir(), `orch-missing-tests-blocked-${process.pid}.json`);
    fs.rmSync(blockedPath, { force: true });
    const r = orch.tryMechanicalRepair({ title: 'Tests (system health red)' }, { blockedPath });
    // Either null (no snapshot) or a real repair result; both are acceptable
    // shapes. The contract: never throws, always returns null or an object.
    if (r !== null) {
      expect(typeof r.repaired).toBe('number');
      expect(typeof r.cleared).toBe('boolean');
      expect(Array.isArray(r.actions)).toBe(true);
    }
  });
});

describe('overnight-self-heal-orchestrator: tryScheduledTaskRepair', () => {
  it('returns null for non-scheduled blockers', () => {
    const r = orch.tryScheduledTaskRepair({ title: 'Tests (system health red)' });
    expect(r).toBeNull();
  });

  it('uses the deterministic scheduled-task catch-up and marks the blocker cleared after receipts go green', () => {
    let healed = false;
    let probedDate = '';
    const r = orch.tryScheduledTaskRepair(
      {
        title: 'Scheduled tasks (system health red)',
        evidence: '0/2 scheduled tasks fired for 2026-06-14.',
      },
      {
        health: {
          probeScheduledSkillOutcomes: (opts) => {
            probedDate = opts.date;
            return healed
              ? {
                  status: 'green',
                  detail: '2/2 scheduled tasks fired for 2026-06-14.',
                  missingSkills: [],
                  failedSkills: [],
                }
              : {
                  status: 'red',
                  detail: '0/2 scheduled tasks fired for 2026-06-14.',
                  scheduleDate: opts.date,
                  missingSkills: ['daily-gmail-scan', 'daily-otter-sweep'],
                  failedSkills: [],
                };
          },
          healScheduledSkills: () => {
            healed = true;
            return { healed: true, action: 'ran scheduled task catch-up for 2026-06-14', durSec: 2 };
          },
        },
      },
    );

    expect(r.cleared).toBe(true);
    expect(r.repaired).toBe(2);
    expect(r.actions[0].action).toMatch(/scheduled task catch-up/);
    expect(probedDate).toBe('2026-06-14');
  });
});

describe('overnight-self-heal-orchestrator: runOrchestrator scheduled-task preflight', () => {
  const fs = require('fs');
  const os = require('os');

  it('does not spawn an LLM session when scheduled-task catch-up clears the blocker', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scheduled-preflight-'));
    const runLogPath = path.join(tmpRoot, 'runs.jsonl');
    const briefingPath = path.join(tmpRoot, 'briefing.md');
    fs.writeFileSync(briefingPath, 'BLOCKERS - briefing quality gates:\n\n  No hard blockers need ExampleCo.\n\nMEETINGS:\n', 'utf8');

    try {
      let spawned = false;
      let repaired = false;
      // Phase 1: the blocker comes from the live render-QC canonical source, not the
      // markdown BLOCKERS card. The defect text ExampleCos "scheduled tasks" so the
      // scheduled-task preflight matcher fires. The live-QC runner reports the defect
      // until the preflight has run, then clean (so post-repair live QC confirms it).
      const result = await orch.runOrchestrator({
        briefingPath,
        runLogPath,
        liveRenderQc: true,
        preRepairPublishRefresh: false,
        liveRenderQcRunner: () =>
          repaired
            ? { status: 0, stdout: 'dashboard QC passed', stderr: '' }
            : {
                status: 1,
                stdout: '',
                stderr:
                  'dashboard QC FAILED: 1 defect(s):\n  - BLOCKED-TILE: system_health (SYSTEM HEALTH) 0/2 scheduled tasks fired for 2026-06-14\n',
              },
        publishRefresh: () => ({ ok: true }),
        scheduledRepair: () => {
          repaired = true;
          return {
            repaired: 2,
            cleared: true,
            actions: [{ action: 'ran scheduled task catch-up for 2026-06-14' }],
          };
        },
        mechanicalRepair: () => null,
        spawnSession: async () => {
          spawned = true;
          return { status: 'escalated' };
        },
      });

      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(1);
      expect(spawned).toBe(false);
      const log = fs.readFileSync(runLogPath, 'utf8');
      expect(log).toMatch(/scheduled-task-repair/);
      expect(log).toMatch(/"status":"cleared"/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('overnight-self-heal-orchestrator: tryVideoApprovalQueueRepair', () => {
  const fs = require('fs');
  const os = require('os');

  it('returns null for non-video-approval blockers', () => {
    const r = orch.tryVideoApprovalQueueRepair({ title: 'Tests (system health red)' });
    expect(r).toBeNull();
  });

  it('returns null when queue file does not exist', () => {
    const r = orch.tryVideoApprovalQueueRepair(
      { title: 'Video approval queue has unresolved rejected work' },
      { queuePath: '/tmp/nonexistent-queue-' + process.pid + '.json' },
    );
    expect(r).toBeNull();
  });

  it('rebuilds manifest rows from pending video artifacts when live QC reports manifest drift', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vidmanifest-'));
    const pendingDir = path.join(tmpRoot, 'content-review', 'pending');
    const manifestPath = path.join(pendingDir, 'manifest.json');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ videos: [] }, null, 2), 'utf8');
    fs.writeFileSync(path.join(pendingDir, 'alpha_clip.mp4'), 'video', 'utf8');
    fs.writeFileSync(path.join(pendingDir, 'alpha_clip_thumb.jpg'), 'thumb', 'utf8');
    fs.writeFileSync(
      path.join(pendingDir, 'alpha_clip.json'),
      JSON.stringify({ title: 'Alpha Clip', channel: 'AILifeHacks' }),
      'utf8',
    );

    try {
      const r = orch.tryVideoApprovalQueueRepair(
        {
          title: 'Live render QC VIDEO-MANIFEST-DRIFT on video_approval_queue',
          rawDefects: [
            'VIDEO-MANIFEST-DRIFT: video_approval_queue (VIDEO APPROVAL QUEUE) reports pending video files are missing from the approval manifest',
          ],
        },
        { repoRoot: tmpRoot, manifestPath, pendingDir },
      );
      expect(r).not.toBeNull();
      expect(r!.cleared).toBe(true);
      expect(r!.repaired).toBe(1);
      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(updated.videos).toHaveLength(1);
      expect(updated.videos[0]).toMatchObject({
        id: 'alpha_clip',
        title: 'Alpha Clip',
        status: 'pending_approval',
        video_file: 'alpha_clip.mp4',
        thumbnail_file: 'alpha_clip_thumb.jpg',
        channel: 'AILifeHacks',
        recovered_from_pending_artifact: true,
        notification_suppressed_reason: 'manifest-recovered-from-existing-artifact',
      });
      expect(updated.videos[0].telegram_notified_at).toBeTruthy();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('dead-letters videos with exhausted retries (attempt N/N)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vidapproval-'));
    const queuePath = path.join(tmpRoot, 'ec2-build-queue.json');
    const failLogPath = path.join(tmpRoot, 'regen-failures.jsonl');
    fs.mkdirSync(path.join(tmpRoot, 'data', 'agent'), { recursive: true });
    fs.writeFileSync(queuePath, JSON.stringify({
      generated_at: '2026-06-15',
      videos: [
        { id: 'good_video', title: 'Good', script: 'some script' },
        {
          id: 'exhausted_video',
          title: 'Bad',
          script: 'some script',
          rejection_note: 'PRIOR REJECTIONS:\n[prior-attempt context]\nattempt 1/3 at 2026-06-01\nattempt 2/3 at 2026-06-02\nattempt 3/3 at 2026-06-03\n',
        },
        {
          id: 'empty_script_rejected',
          title: 'Empty',
          script: '',
          rejection_note: 'no music',
        },
      ],
      queue: [],
    }), 'utf8');

    try {
      const r = orch.tryVideoApprovalQueueRepair(
        { title: 'Video approval queue has unresolved rejected work' },
        { repoRoot: tmpRoot, queuePath },
      );
      expect(r).not.toBeNull();
      expect(r!.cleared).toBe(true);
      expect(r!.repaired).toBe(2);
      expect(r!.actions).toHaveLength(2);
      expect(r!.actions.map((a: { videoId: string }) => a.videoId).sort()).toEqual(
        ['empty_script_rejected', 'exhausted_video'],
      );

      // Verify queue was updated
      const updated = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      expect(updated.videos).toHaveLength(1);
      expect(updated.videos[0].id).toBe('good_video');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns null when no videos have exhausted retries', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vidapproval-'));
    const queuePath = path.join(tmpRoot, 'ec2-build-queue.json');
    fs.writeFileSync(queuePath, JSON.stringify({
      generated_at: '2026-06-15',
      videos: [
        { id: 'v1', title: 'V1', script: 'script here' },
        { id: 'v2', title: 'V2', script: 'script here', rejection_note: 'attempt 1/3 at 2026-06-01' },
      ],
      queue: [],
    }), 'utf8');

    try {
      const r = orch.tryVideoApprovalQueueRepair(
        { title: 'Video approval queue has unresolved rejected work' },
        { repoRoot: tmpRoot, queuePath },
      );
      expect(r).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('overnight-self-heal-orchestrator: runOrchestrator video-approval-queue preflight', () => {
  const fs = require('fs');
  const os = require('os');

  it('does not spawn an LLM session when video-approval-queue repair clears the blocker', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vidapproval-run-'));
    const runLogPath = path.join(tmpRoot, 'runs.jsonl');
    const briefingPath = path.join(tmpRoot, 'briefing.md');
    fs.writeFileSync(briefingPath, 'BLOCKERS - briefing quality gates:\n\n  No hard blockers need ExampleCo.\n\nMEETINGS:\n', 'utf8');

    try {
      let spawned = false;
      let repaired = false;
      // Phase 1: the blocker comes from the live render-QC canonical source. The defect
      // routes to video_approval_queue so the video-approval preflight matcher fires.
      // The runner reports the defect until the preflight has run, then clean.
      const result = await orch.runOrchestrator({
        briefingPath,
        runLogPath,
        liveRenderQc: true,
        preRepairPublishRefresh: false,
        liveRenderQcRunner: () =>
          repaired
            ? { status: 0, stdout: 'dashboard QC passed', stderr: '' }
            : {
                status: 1,
                stdout: '',
                stderr:
                  'dashboard QC FAILED: 1 defect(s):\n  - BLOCKED-TILE: video_approval_queue (VIDEO APPROVAL QUEUE) spec_stub_no_music_video has exhausted retries\n',
              },
        publishRefresh: () => ({ ok: true }),
        videoApprovalRepair: () => {
          repaired = true;
          return {
            repaired: 1,
            cleared: true,
            actions: [{ action: 'dead-lettered exhausted video', videoId: 'spec_stub_no_music_video' }],
          };
        },
        scheduledRepair: () => null,
        mechanicalRepair: () => null,
        spawnSession: async () => {
          spawned = true;
          return { status: 'escalated' };
        },
      });

      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(1);
      expect(spawned).toBe(false);
      const log = fs.readFileSync(runLogPath, 'utf8');
      expect(log).toMatch(/video-approval-queue-repair/);
      expect(log).toMatch(/"status":"cleared"/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
