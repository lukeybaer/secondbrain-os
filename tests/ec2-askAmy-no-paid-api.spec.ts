/**
 * Behavior contract for ec2-server.js askAmy() routing (LLM fallback ladder,
 * owner decision; updated 2026-09-03): the subscription brains run first
 * (via runSubscriptionBrainLadder), and the charged API rungs
 * (bedrock -> anthropic API -> openai API) are emergency floors that run only
 * behind canUseChargedLlmApi() with Codex-down proof plus the owner's approval.
 *
 * ec2-server.js boots a server on load and has no exports, so askAmy is
 * extracted and evaluated with its collaborators stubbed; the test records
 * which rungs actually ran and in what order.
 *
 * Also: claude-proxy.js resolveClaudePath() is run with a stubbed platform/env.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadWithAutoStubs, loadFunctions } = require('./helpers/extract-source-function.cjs');
const REPO = path.resolve(__dirname, '..');

function harness({ subscription = null, bedrock = '', anthropic = '', openai = '', chargedAllowed = true } = {}) {
  const calls: string[] = [];
  const gateArgs: any[] = [];
  const overrides: Record<string, unknown> = {
    crypto: require('crypto'),
    console: { log() {}, warn() {}, error() {} },
    beginGraphitiConsult: () => ({ finalize: async () => null }),
    createDispositionReceipt: () => ({}),
    attachGraphitiImpact: (a: string) => a,
    formatGraphitiImpact: () => '',
    attachReviewLine: (a: string) => a,
    recordDispositionReceipt: () => {},
    buildAdvisorPromptBlock: () => '',
    selectConversationWindow: () => [],
    loadRecentTurns: () => [],
    telegramSpineProvider: { getActiveTasks: () => [] },
    buildSpineContextBlock: () => '',
    isStatusIntent: () => false,
    formatRecentLifeFastPathAnswer: () => '',
    runSubscriptionBrainLadder: async () => {
      calls.push('subscription');
      return subscription;
    },
    canUseChargedLlmApi: (args: any) => {
      gateArgs.push(args);
      return chargedAllowed;
    },
    askAmyViaBedrock: async () => (calls.push('bedrock'), bedrock),
    askAmyViaAnthropicAPI: async () => (calls.push('anthropic'), anthropic),
    askAmyViaOpenAI: async () => (calls.push('openai'), openai),
  };
  const { askAmy } = loadWithAutoStubs(path.join(REPO, 'ec2-server.js'), ['askAmy'], overrides);
  return { askAmy, calls, gateArgs };
}

describe('ec2-server askAmy routing (LLM fallback ladder)', () => {
  it('a working subscription brain answers and no charged API rung runs', async () => {
    const h = harness({ subscription: 'subscription answer' });
    const out = await h.askAmy('hello', { history: [] });
    expect(out).toContain('subscription answer');
    expect(h.calls).toEqual(['subscription']);
    expect(h.gateArgs).toEqual([]);
  });

  it('subscription failure falls through bedrock -> anthropic-api -> openai-api in fixed order', async () => {
    const h = harness({ subscription: null, bedrock: '', anthropic: '  ', openai: 'openai floor answer' });
    const out = await h.askAmy('hello', { history: [] });
    expect(h.calls).toEqual(['subscription', 'bedrock', 'anthropic', 'openai']);
    expect(out).toContain('openai floor answer');
  });

  it('stops at the first charged rung that answers', async () => {
    const h = harness({ bedrock: 'bedrock answer', openai: 'never used' });
    const out = await h.askAmy('hello', { history: [] });
    expect(h.calls).toEqual(['subscription', 'bedrock']);
    expect(out).toContain('bedrock answer');
  });

  it('charged API rungs are gated on Codex-down proof plus the owner approval', async () => {
    const approved = harness({ openai: 'x' });
    await approved.askAmy('hello', { history: [], allowChargedLlmApi: true });
    expect(approved.gateArgs).toHaveLength(1);
    expect(approved.gateArgs[0]).toMatchObject({ codexDown: true, explicitApproval: true });

    const unapproved = harness({ chargedAllowed: false, bedrock: 'b', anthropic: 'a', openai: 'o' });
    const out = await unapproved.askAmy('hello', { history: [] });
    expect(unapproved.gateArgs[0]).toMatchObject({ codexDown: true, explicitApproval: false });
    // Gate refused: no charged rung ran, the owner gets the clear error instead.
    expect(unapproved.calls).toEqual(['subscription']);
    expect(out).toMatch(/couldn't reach my subscription brain/);
  });
});

describe('runSubscriptionBrainLadder', () => {
  function ladder(order: string[], answers: Record<string, string | null>) {
    const ran: string[] = [];
    const { runSubscriptionBrainLadder } = loadFunctions(path.join(REPO, 'ec2-server.js'), ['runSubscriptionBrainLadder'], {
      resolveBrainOrder: () => order,
      runCodexBrainRung: async () => (ran.push('codex'), answers.codex),
      runClaudeBrainRung: async () => (ran.push('claude'), answers.claude),
    });
    return { runSubscriptionBrainLadder, ran };
  }

  it('tries rungs in the order the durable brain switch names', async () => {
    const a = ladder(['claude', 'codex'], { claude: null, codex: 'from codex' });
    expect(await a.runSubscriptionBrainLadder('q', {}, 'askAmy')).toBe('from codex');
    expect(a.ran).toEqual(['claude', 'codex']);

    const b = ladder(['codex', 'claude'], { codex: 'from codex', claude: 'from claude' });
    expect(await b.runSubscriptionBrainLadder('q', {}, 'askAmy')).toBe('from codex');
    expect(b.ran).toEqual(['codex']);
  });

  it('returns null when every subscription rung fails', async () => {
    const c = ladder(['codex', 'claude'], { codex: null, claude: '' });
    expect(await c.runSubscriptionBrainLadder('q', {}, 'askAmy')).toBeNull();
  });
});

describe('claude-proxy.js resolveClaudePath', () => {
  function resolve(platform: string, env: Record<string, string | undefined>) {
    const seen: string[] = [];
    const { resolveClaudePath } = loadFunctions(path.join(REPO, 'claude-proxy.js'), ['resolveClaudePath'], {
      process: { platform, env },
      path: path.win32,
      resolveClaudeExecutableCandidates: (c: string[]) => {
        seen.push(...c);
        return 'resolved:' + c.length;
      },
    });
    return { out: resolveClaudePath(), seen };
  }

  it('uses the bare claude command off Windows', () => {
    expect(resolve('linux', {}).out).toBe('claude');
  });

  it('on Windows with empty env it never throws and still offers claude.cmd candidates', () => {
    const r = resolve('win32', {});
    expect(r.out).toMatch(/^resolved:/);
    expect(r.seen.some((c) => c && c.endsWith('claude.cmd'))).toBe(true);
  });

  it('on Windows an explicit CLAUDE_PATH is tried first', () => {
    const r = resolve('win32', { CLAUDE_PATH: 'D:/x/claude.cmd' });
    expect(r.seen[0]).toBe('D:/x/claude.cmd');
  });
});
