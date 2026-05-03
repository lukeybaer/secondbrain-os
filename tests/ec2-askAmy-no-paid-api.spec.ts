/**
 * Regression test for ec2-server.js askAmy() routing.
 *
 * Fixes from 2026-04-20 after the owner reported Telegram dispatch silently
 * falling to "On it." for natural-language queries:
 *
 *  1. askAmy() used to try Anthropic API -> OpenAI -> proxy -> CLI. The
 *     Anthropic path violated the Claude-Max-only rule
 *     (secondbrain/memory/MEMORY.md key rules). The OpenAI path violated it
 *     AND had a latent ReferenceError: it referenced bare OPENAI_API_KEY
 *     with no top-level `const OPENAI_API_KEY = ...` declaration, so the
 *     first `if (OPENAI_API_KEY)` check threw, the Telegram handler caught
 *     null, and the owner saw a useless command-queue fallback instead of a
 *     real answer.
 *  2. claude-proxy.js on Windows used to spawn "claude" with no .cmd
 *     resolution, so the supervisor-spawned proxy was ENOENT even though
 *     /health returned ok. The proxy now auto-resolves claude.cmd.
 *
 * This test pins the shape of both files so the regression cannot recur
 * silently.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EC2 = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf-8');
const PROXY = fs.readFileSync(path.join(REPO, 'claude-proxy.js'), 'utf-8');

describe('ec2-server askAmy routing (Claude Max only)', () => {
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

  // NOTE: we do NOT forbid api.anthropic.com globally , the Vapi custom-llm
  // path (around line 1944) still needs it because the claude-proxy does not
  // yet translate Claude's tool_use blocks into OpenAI tool_calls for Vapi.
  // That is tracked separately in memory/reference_claude_proxy_windows.md.
  // The askAmy (Telegram) path below is the one that must stay Max-only.

  it('askAmy() prefers proxy + CLI and contains no paid-API branches', () => {
    const start = EC2.indexOf('async function askAmy(question)');
    expect(start).toBeGreaterThan(0);
    // Walk forward to the next top-level function definition to bound askAmy
    const candidates = [
      EC2.indexOf('\nasync function ', start + 1),
      EC2.indexOf('\nfunction ', start + 1),
      EC2.indexOf('\n// ── ', start + 1),
    ].filter((i) => i > 0);
    const end = Math.min(...candidates);
    expect(end).toBeGreaterThan(start);
    const fn = EC2.slice(start, end);

    expect(fn).toContain('checkLocalProxy');
    expect(fn).toContain('askAmyViaProxy');
    expect(fn).toContain('askAmyViaCLI');
    expect(fn).not.toContain('api.anthropic.com');
    expect(fn).not.toContain('api.openai.com');
    expect(fn).not.toContain('askAmyViaOpenAI');
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
