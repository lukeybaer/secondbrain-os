/**
 * 2026-05-26 the owner: migration safety. The new planner + executor land
 * behind a USE_PLANNER_PIPELINE env flag. The OLD path stays default
 * for at least one week. During the migration week, the legacy path
 * MUST consume the niche YAML via niche-to-legacy-spec.js so daily
 * generation does not drift from the craft contract.
 *
 * Per Codex review issue #4. regenVideoOnLocalEc2Build is extracted from
 * scripts/auto-regen-rejected-videos.js and RUN with a recording spawnSync
 * and stubbed filesystem, so the commands it issues (and their order) are
 * observed, not read from source text.
 *
 * Plan ref: ~/.claude/plans/example-plan.md (Category 10)
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'scripts', 'auto-regen-rejected-videos.js'), 'utf8');

type Spawn = { bin: string; args: string[] };

function load(opts: {
  nicheThrows?: boolean;
  plannerStatus?: number;
  execStatus?: number;
  legacyStatus?: number;
}) {
  const spawns: Spawn[] = [];
  const written: Record<string, string> = {};
  const events: string[] = [];
  const start = SRC.indexOf('function regenVideoOnLocalEc2Build(');
  expect(start).toBeGreaterThan(-1);
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  const stubFs = {
    mkdirSync: () => {},
    existsSync: (p: string) => !/thumb/i.test(String(p)),
    rmSync: () => {},
    copyFileSync: () => {},
    writeFileSync: (p: string, c: string) => {
      written[p] = c;
    },
    statSync: () => ({ size: 10 }),
  };
  const spawnSync = (bin: string, args: string[]) => {
    spawns.push({ bin, args });
    events.push(`spawn:${args.find((a) => /plan-cli|build-from-plan|ec2-build-from-queue/.test(a)) || bin}`);
    if (bin === 'node') return { status: opts.plannerStatus ?? 0, stdout: '', stderr: 'plan err' };
    if (args.some((a) => /build-from-plan/.test(a))) return { status: opts.execStatus ?? 0, stdout: 'built', stderr: '' };
    return { status: opts.legacyStatus ?? 0, stdout: 'legacy built', stderr: '' };
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs',
    'path',
    'os',
    'spawnSync',
    'deps',
    `const { loadNiche, stampNicheOntoSpec, quarantineGoodOutput, dropQuarantineBackup,
             restoreGoodOutput, shouldRegenerateVoice, ec2BuildFailureReason, checkVideoContent } = deps;
     const HIDDEN_PROCESS = {};
     const REPO = '/repo';
     const PLAN_VIDEO_BUILD_CLI = '/x/plan-cli.js';
     const BUILD_FROM_PLAN_PY = '/x/build-from-plan.py';
     ${body}
     return regenVideoOnLocalEc2Build;`,
  );
  const fn = factory(stubFs, path.posix, os, spawnSync, {
    loadNiche: (channel: string) => {
      if (opts.nicheThrows) throw new Error('NICHE_NOT_FOUND ' + channel);
      return { id: channel, craft: 'x' };
    },
    stampNicheOntoSpec: (v: any, niche: any) => ({ ...v, niche_stamped: niche.id }),
    quarantineGoodOutput: () => ({ q: 1 }),
    dropQuarantineBackup: () => events.push('dropBackup'),
    restoreGoodOutput: () => events.push('restore'),
    shouldRegenerateVoice: () => false,
    ec2BuildFailureReason: (_log: string, fallback: string) => fallback,
    checkVideoContent: () => ({ ok: true }),
  });
  return { fn, spawns, written, events };
}

const video = () => ({ id: 'vid7', title: 'T', channel: 'examplechannel', script: 's' });

describe('auto-regen migration wiring', () => {
  let saved: string | undefined;
  let warnings: string[];
  const realWarn = console.warn;
  const realLog = console.log;
  beforeEach(() => {
    saved = process.env.USE_PLANNER_PIPELINE;
    delete process.env.USE_PLANNER_PIPELINE;
    warnings = [];
    console.warn = (...a: any[]) => warnings.push(a.join(' '));
    console.log = () => {};
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.USE_PLANNER_PIPELINE;
    else process.env.USE_PLANNER_PIPELINE = saved;
    console.warn = realWarn;
    console.log = realLog;
  });

  it('with the flag unset the legacy ec2-build-from-queue.py runs and the planner never does', () => {
    const { fn, spawns } = load({});
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(true);
    expect(res.plan_path).toBeNull();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].bin).toBe('python3');
    expect(spawns[0].args).toContain('scripts/ec2-build-from-queue.py');
    expect(spawns[0].args[spawns[0].args.indexOf('--id') + 1]).toBe('vid7');
    expect(spawns.some((s) => s.bin === 'node')).toBe(false);
  });

  it('any value other than "1" keeps the planner OFF', () => {
    for (const val of ['0', 'true', '']) {
      process.env.USE_PLANNER_PIPELINE = val;
      const { fn, spawns } = load({});
      fn(video(), 'out.mp4', 'thumb.jpg');
      expect(spawns.map((s) => s.bin)).toEqual(['python3']);
    }
  });

  it('the legacy path consumes the niche YAML: the spec file handed to the build is niche-stamped', () => {
    const { fn, written } = load({});
    fn(video(), 'out.mp4', 'thumb.jpg');
    const specs = Object.entries(written).filter(([p]) => /regen-spec-vid7/.test(p));
    expect(specs).toHaveLength(1);
    expect(JSON.parse(specs[0][1]).niche_stamped).toBe('examplechannel');
  });

  it('a missing niche YAML warns loudly but does NOT crash the legacy build', () => {
    const { fn, spawns, written } = load({ nicheThrows: true });
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/niche YAML missing or invalid for examplechannel/);
    const spec = JSON.parse(Object.entries(written).find(([p]) => /regen-spec-vid7/.test(p))![1]);
    expect(spec.niche_stamped).toBeUndefined();
  });

  it('a failing legacy build restores the prior good output and reports failure', () => {
    const { fn, events } = load({ legacyStatus: 2 });
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/local ec2 build exit 2/);
    expect(events).toContain('restore');
    expect(events).not.toContain('dropBackup');
  });
});

describe('the planner+executor branch is structurally separable', () => {
  let saved: string | undefined;
  const realLog = console.log;
  beforeEach(() => {
    saved = process.env.USE_PLANNER_PIPELINE;
    process.env.USE_PLANNER_PIPELINE = '1';
    console.log = () => {};
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.USE_PLANNER_PIPELINE;
    else process.env.USE_PLANNER_PIPELINE = saved;
    console.log = realLog;
  });

  it('plans first, then executes that same plan path with build-from-plan.py, and exposes plan_path', () => {
    const { fn, spawns, events } = load({});
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(true);
    expect(spawns.map((s) => s.bin)).toEqual(['node', 'python3']);
    // order of effects: planner before executor, legacy never
    expect(events.filter((e) => e.startsWith('spawn:'))).toEqual([
      'spawn:/x/plan-cli.js',
      'spawn:/x/build-from-plan.py',
    ]);
    const planOut = spawns[0].args[spawns[0].args.indexOf('--out') + 1];
    expect(spawns[0].args[spawns[0].args.indexOf('--niche') + 1]).toBe('examplechannel');
    expect(spawns[1].args[spawns[1].args.indexOf('--plan') + 1]).toBe(planOut);
    expect(res.plan_path).toBe(planOut);
  });

  it('fails closed (no spawn, prior output restored) when the niche profile is missing', () => {
    const { fn, spawns, events } = load({ nicheThrows: true });
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/niche YAML missing for channel examplechannel/);
    expect(spawns).toHaveLength(0);
    expect(events).toContain('restore');
  });

  it('a planner failure stops before the executor and restores the good output', () => {
    const { fn, spawns, events } = load({ plannerStatus: 1 });
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/planner CLI exit 1/);
    expect(spawns).toHaveLength(1);
    expect(events).toContain('restore');
  });

  it('an executor failure reports the plan_path so the outer gates can inspect it', () => {
    const { fn } = load({ execStatus: 3 });
    const res = fn(video(), 'out.mp4', 'thumb.jpg');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/build-from-plan exit 3/);
    expect(res.plan_path).toMatch(/vid7\.plan\.json$/);
  });
});
