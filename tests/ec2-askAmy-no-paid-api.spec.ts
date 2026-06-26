/**
 * Contract test for ec2-server.js askAmy() routing.
 *
 * POLICY (2026-06-11 LLM fallback ladder, plan:
 * dev-plans/llm-fallback-ladder-2026-06-11.html, ExampleCo directive: "In all
 * areas, Amy should be able to operate even if claude sub is down"):
 *
 *   askAmy() must descend a fixed rung ladder, subscriptions first, paid
 *   API floors last:
 *
 *     1. codex          (OpenAI subscription via Codex CLI)
 *     2. claude proxy   (Claude Max via laptop SSH-tunnel proxy)
 *     3. claude CLI     (Claude Max via EC2-local `claude -p`)
 *     4. bedrock        (AWS Bedrock funded $20/mo lane)
 *     5. anthropic API  (key floor, only when ANTHROPIC_API_KEY set)
 *     6. openai API     (key floor, SOFT-capped $20/mo, warn-never-block)
 *
 * The OpenAI API rung is the FLOOR: it must exist (no surface dead when the
 * Claude subscription is down) and it must come LAST (never ahead of a
 * subscription rung). This supersedes the old 2026-04-20 "Claude Max only /
 * no paid API branches" assertion that used to live in this file.
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

  it('askAmy() descends the full ladder in order: codex -> proxy -> CLI -> bedrock -> anthropic-api -> openai-api', () => {
    const fn = extractAskAmy();

    // Subscription rungs first.
    expect(fn).toContain('checkLocalProxy');
    const rungOrder = [
      'askAmyViaCodex',
      'askAmyViaProxy',
      'askAmyViaCLI',
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

  it('the OpenAI API rung is the LAST rung (paid floor, never ahead of a subscription rung)', () => {
    const fn = extractAskAmy();
    const openaiIdx = fn.indexOf('askAmyViaOpenAI');
    expect(openaiIdx, 'askAmyViaOpenAI floor rung missing from askAmy()').toBeGreaterThan(-1);
    for (const earlier of [
      'askAmyViaCodex',
      'askAmyViaProxy',
      'askAmyViaCLI',
      'askAmyViaBedrock',
      'askAmyViaAnthropicAPI',
    ]) {
      expect(openaiIdx, `openai rung must come after ${earlier}`).toBeGreaterThan(
        fn.indexOf(earlier),
      );
    }
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
