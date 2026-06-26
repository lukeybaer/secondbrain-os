import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, isAbsolute } from 'path';
import { createHash } from 'crypto';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HOOK = join(REPO_ROOT, 'scripts', 'claude-hooks', 'session-coordination.mjs');

let tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-coordination-test-'));
  tempRoots.push(root);
  return root;
}

function repoId(): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const resolved = isAbsolute(common) ? common : resolve(REPO_ROOT, common);
  return createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 12);
}

function runHook(
  event: string,
  args: string[],
  envRoot: string,
  input?: ExampleCo,
): string {
  return execFileSync('node', [HOOK, event, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: input ? JSON.stringify(input) : undefined,
    env: {
      ...process.env,
      SECONDBRAIN_COORDINATION_DIR: envRoot,
    },
  });
}

function readSession(envRoot: string, sessionId: string): any {
  const p = join(envRoot, repoId(), `${sessionId}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe('shared agent coordination hook', () => {
  it('states that ExampleCo intent is the only authority and Claude Code and Codex are peers', () => {
    const envRoot = makeTempRoot();
    const out = runHook(
      'session-start',
      ['--agent', 'codex', '--session-id', 'codex-1'],
      envRoot,
      { cwd: REPO_ROOT },
    );

    expect(out).toContain('Shared agent coordination');
    expect(out).toContain('ExampleCo latest intent is the only authority');
    expect(out).toContain('Claude Code and Codex are peers');
    expect(out).toContain('No agent gets priority because of identity');
    expect(out).toContain('Test-first for behavior changes');
    expect(out).toContain('record takeover, then claim and push');
    expect(out).toContain('leaves dev_notes with advice');
    expect(out).toContain('No false done claims');
  }, 60000);

  it('blocks claimed files with a fast-path takeover instruction instead of agent hierarchy', () => {
    const envRoot = makeTempRoot();

    runHook(
      'claim',
      [
        '--agent',
        'claude-code',
        '--session-id',
        'claude-slow',
        '--topic',
        'acme load test slow path',
        '--file',
        'src/main/example.ts',
      ],
      envRoot,
    );

    let stderr = '';
    try {
      runHook(
        'pre-edit',
        [],
        envRoot,
        {
          cwd: REPO_ROOT,
          session_id: 'codex-fast',
          agent: 'codex',
          tool_input: { file_path: 'src/main/example.ts' },
        },
      );
    } catch (err: any) {
      stderr = err.stderr?.toString() || '';
    }

    expect(stderr).toContain('BLOCKED by shared agent coordination');
    expect(stderr).toContain('Options, in ExampleCo-intent order');
    expect(stderr).toContain('record takeover and proceed');
    expect(stderr).toContain('--agent codex');
    expect(stderr).toContain('--session-id codex-fast');
  }, 60000);

  it('takeover removes the previous file claim and writes advisory dev notes', () => {
    const envRoot = makeTempRoot();

    runHook(
      'claim',
      [
        '--agent',
        'claude-code',
        '--session-id',
        'claude-slow',
        '--topic',
        'acme load test slow path',
        '--file',
        'src/main/example.ts',
      ],
      envRoot,
    );

    runHook(
      'takeover',
      [
        '--agent',
        'codex',
        '--session-id',
        'codex-fast',
        '--topic',
        'acme load test fast path',
        '--file',
        'src/main/example.ts',
        '--reason',
        'Codex has executable plan and Claude is slow',
      ],
      envRoot,
    );

    const claude = readSession(envRoot, 'claude-slow');
    const codex = readSession(envRoot, 'codex-fast');
    const claudeNote = claude.dev_notes[claude.dev_notes.length - 1];
    const codexNote = codex.dev_notes[codex.dev_notes.length - 1];

    expect(claude.files).toHaveLength(0);
    expect(claudeNote).toMatchObject({
      type: 'takeover',
      from_agent: 'codex',
      reason: 'Codex has executable plan and Claude is slow',
    });
    expect(claudeNote.message).toContain('Stop editing them and leave advisory notes');

    expect(codex.files).toHaveLength(1);
    expect(codexNote).toMatchObject({
      type: 'takeover-record',
      from_agent: 'codex',
    });
  }, 60000);

  it('rejects done without proof and records done only with evidence', () => {
    const envRoot = makeTempRoot();

    let stderr = '';
    try {
      runHook(
        'done',
        ['--agent', 'codex', '--session-id', 'codex-fast'],
        envRoot,
      );
    } catch (err: any) {
      stderr = err.stderr?.toString() || '';
    }

    expect(stderr).toContain('DONE REJECTED');
    expect(stderr).toContain('No proof supplied');

    const out = runHook(
      'done',
      [
        '--agent',
        'codex',
        '--session-id',
        'codex-fast',
        '--proof',
        'vitest session-coordination-protocol passed',
      ],
      envRoot,
    );

    const codex = readSession(envRoot, 'codex-fast');

    expect(out).toContain('DONE RECORDED');
    expect(codex.status).toBe('done');
    expect(codex.proofs).toHaveLength(1);
    expect(codex.proofs[0]).toMatchObject({
      from_agent: 'codex',
      proof: 'vitest session-coordination-protocol passed',
    });
  }, 60000);
});
