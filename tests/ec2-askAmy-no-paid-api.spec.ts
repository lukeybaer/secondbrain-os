/**
 * Contract test for ec2-server.js askAmy() routing.
 *
 * POLICY (2026-06-11 LLM fallback ladder, plan:
 * dev-plans/llm-fallback-ladder-2026-06-11.html, ExampleCo directive: "In all
 * areas, Amy should be able to operate even if claude sub is down"), updated
 * 2026-09-03 (Codex adversarial review): the two subscription rungs run in
 * the order the durable switch (scripts/lib/brain-switch.js resolveBrainOrder)
 * names as leading, not a hardcoded Codex-first order. Charged API floors
 * stay fixed and gated, after both subscription brains fail:
 *
 *     1-2. codex / claude   (switch-ordered subscription rungs, whichever the
 *                            switch names leading tries first; askAmy's own
 *                            body calls runSubscriptionBrainLadder() rather
 *                            than the individual askAmyVia* rungs directly)
 *     3. bedrock        (charged, only if Codex is down and ExampleCo approved)
 *     4. anthropic API  (charged, only if Codex is down and ExampleCo approved)
 *     5. openai API     (charged, only if Codex is down and ExampleCo approved)
 *
 * Charged API rungs are emergency floors only. They must stay behind
 * canUseChargedLlmApi(), which requires Codex-down proof plus ExampleCo approval.
 *
 * Scoping unchanged: Whisper audio transcription elsewhere in ec2-server.js
 * is a separate paid-API surface with no subscription equivalent and is NOT
 * governed by this test.
 *
 * History this test still pins: the 2026-04-20 latent ReferenceError where a
 * bare OPENAI_API_KEY (no top-level const, not via process.env) threw on the
 * first check and silently broke every Telegram dispatch. The reinstated
 * OpenAI rung must read the key via process.env only.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EC2 = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf-8');
const PROXY = fs.readFileSync(path.join(REPO, 'claude-proxy.js'), 'utf-8');

function extractAskAmy(): string {
  // Locate the askAmy signature flexibly: tolerate additional destructured
  // options args (e.g. `{ imagePath } = {}`) so the contract test does not
  // bit-rot every time the signature grows a new optional param.
  const sigMatch = EC2.match(/async function askAmy\s*\(question[^)]*\)/);
  expect(sigMatch).not.toBeNull();
  const start = sigMatch!.index!;
  // Walk forward to the next top-level function definition to bound askAmy
  const candidates = [
    EC2.indexOf('\nasync function ', start + 1),
    EC2.indexOf('\nfunction ', start + 1),
    EC2.indexOf('\n// ── ', start + 1),
  ].filter((i) => i > 0);
  const end = Math.min(...candidates);
  expect(end).toBeGreaterThan(start);
  return EC2.slice(start, end);
}

describe('ec2-server askAmy routing (LLM fallback ladder)', () => {
  it('does not reference bare OPENAI_API_KEY (always via process.env)', () => {
    const lines = EC2.split('\n');
    const offenders: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/OPENAI_API_KEY/.test(line)) continue;
      if (/process\.env\.OPENAI_API_KEY/.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      // legitimate: string literal in a comment-like context
      if (/["']OPENAI_API_KEY["']/.test(line)) continue;
      offenders.push({ line: i + 1, text: line.trim() });
    }
    expect(offenders).toEqual([]);
  });

  it('askAmy() runs the switch-ordered subscription ladder, then bedrock -> anthropic-api -> openai-api', () => {
    const fn = extractAskAmy();

    // Subscription rungs (codex, and claude via checkLocalProxy + CLI) now
    // live behind runSubscriptionBrainLadder(), which resolves the order
    // from the durable switch (scripts/lib/brain-switch.js resolveBrainOrder)
    // instead of a hardcoded Codex-first literal. checkLocalProxy and the
    // individual askAmyVia* rungs are exercised by that shared helper, not
    // inlined in askAmy's own body any more.
    expect(fn).toContain('runSubscriptionBrainLadder');
    expect(fn).not.toContain('askAmyViaCodex(');
    expect(fn).not.toContain('askAmyViaProxy(');
    expect(fn).not.toContain('askAmyViaCLI(');

    const rungOrder = [
      'runSubscriptionBrainLadder',
      'askAmyViaBedrock',
      'askAmyViaAnthropicAPI',
      'askAmyViaOpenAI',
    ];
    const indexes = rungOrder.map((name) => ({ name, idx: fn.indexOf(name) }));
    for (const { name, idx } of indexes) {
      expect(
        idx,
        `${name} rung missing from askAmy(), every ladder rung must be wired`,
      ).toBeGreaterThan(-1);
    }
    for (let i = 1; i < indexes.length; i++) {
      expect(
        indexes[i].idx,
        `${indexes[i].name} must come AFTER ${indexes[i - 1].name} (ladder order is fixed)`,
      ).toBeGreaterThan(indexes[i - 1].idx);
    }
  });

  it('runSubscriptionBrainLadder resolves rung order from the durable brain switch', () => {
    const idx = EC2.indexOf('function runSubscriptionBrainLadder');
    expect(idx).toBeGreaterThan(-1);
    const end = EC2.indexOf('\n}\n', idx);
    const fn = EC2.slice(idx, end > idx ? end : idx + 800);
    expect(fn).toContain('resolveBrainOrder');
    expect(fn).toContain('runCodexBrainRung');
    expect(fn).toContain('runClaudeBrainRung');
  });

  it('charged API rungs are behind Codex-down proof plus ExampleCo approval', () => {
    const fn = extractAskAmy();
    const gateIdx = fn.indexOf('canUseChargedLlmApi');
    const bedrockIdx = fn.indexOf('askAmyViaBedrock');
    const anthropicIdx = fn.indexOf('askAmyViaAnthropicAPI');
    const openaiIdx = fn.indexOf('askAmyViaOpenAI');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(fn).toContain('codexDown: true');
    expect(fn).toContain('explicitApproval: allowChargedLlmApi');
    expect(bedrockIdx).toBeGreaterThan(gateIdx);
    expect(anthropicIdx).toBeGreaterThan(gateIdx);
    expect(openaiIdx).toBeGreaterThan(gateIdx);
  });
});

describe('claude-proxy.js Windows claude.cmd resolution', () => {
  it('auto-resolves CLAUDE_PATH to claude.cmd on Windows when env unset', () => {
    expect(PROXY).toContain('resolveClaudePath');
    expect(PROXY).toContain('claude.cmd');
    expect(PROXY).toContain("process.platform !== 'win32'");
  });

  it('defaults to empty-env-safe resolution (never throws on missing env)', () => {
    const fn = PROXY.slice(
      PROXY.indexOf('function resolveClaudePath'),
      PROXY.indexOf('const CLAUDE_PATH = resolveClaudePath()'),
    );
    // Must guard APPDATA / USERPROFILE with `|| ''` so path.join does not throw
    // on a missing env var on a non-standard Windows setup.
    expect(fn).toMatch(/APPDATA \|\| ['"]/);
    expect(fn).toMatch(/USERPROFILE \|\| ['"]/);
  });
});
