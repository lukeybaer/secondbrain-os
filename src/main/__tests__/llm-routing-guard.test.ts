/**
 * llm-routing-guard.test.ts
 *
 * Repo-wide regression guard: no code path may call a paid LLM chat host
 * DIRECTLY. LLM traffic must route through the fallback ladder (2026-06-11
 * policy, plan: dev-plans/llm-fallback-ladder-2026-06-11.html): OpenAI sub
 * (codex CLI) -> Claude sub (proxy port 3456 / claude CLI) -> paid API
 * floors (Bedrock/Anthropic where wired -> OpenAI API soft-capped). Paid
 * floor calls are only legal inside sanctioned ladder implementations,
 * where they sit BELOW the subscription rungs.
 *
 * Root cause this test prevents: the 2026-04-10 manual-briefing-v2.js
 * regression where I called api.openai.com directly for 30 article
 * summaries without trying the subscriptions first. Also catches any
 * future slip where api.groq.com (no rung, banned outright) or a direct
 * paid-chat call reappears in a non-ladder source file.
 *
 * Allow-list: briefing-bodies.jsonl and comments/docstrings/memory files
 * may contain the literal strings as references, but no executable
 * source file (.ts, .js, .py, .mjs, .cjs) may.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const SCAN_DIRS = ['src', 'scripts', 'ec2-server.js', 'claude-proxy.js'];

// 2026-07-0x fix: this test itself now commonly RUNS from inside a worktree
// (isolated-worktree workflow, feedback_branch_cleanliness_isolated_worktrees.md),
// so REPO_ROOT itself contains ".claude/worktrees/<id>" as a path segment.
// IGNORE_PATTERNS used to be tested against the absolute path, so that
// segment matched every single file under REPO_ROOT and silently zeroed out
// the scan (walkSourceFiles filtered everything, "finds at least one source
// file to scan" failed with files.length === 0). The intent was only to skip
// a worktree accidentally NESTED inside the scanned tree (e.g.
// REPO_ROOT/src/.claude/worktrees/foo), never to reject when the repo root
// itself lives under a worktrees path. Fix: test patterns against the path
// RELATIVE to REPO_ROOT, so a worktree segment that is part of the common
// prefix (REPO_ROOT itself) never appears in the string being matched.
const IGNORE_PATTERNS = [
  /node_modules/,
  /[\\/]\.claude[\\/]worktrees/,
  /openclaw-archive/,
  /[\\/]dist[\\/]/,
  /[\\/]out[\\/]/,
  /[\\/]__tests__[\\/]llm-routing-guard\.test\.ts/, // this file
  /[\\/]__tests__[\\/]briefing-no-groq\.test\.ts/, // that file
  /[\\/]__tests__[\\/]manual-briefing\.test\.ts/, // and that one
  /\.d\.ts$/,
  /\.map$/,
];

function isIgnored(absPath: string): boolean {
  const rel = path.relative(REPO_ROOT, absPath);
  return IGNORE_PATTERNS.some((p) => p.test(rel));
}

// Forbidden: chat/completion endpoints that have a free Claude Max equivalent.
// ALLOWED (intentionally not in this list): audio transcription (Whisper),
// embeddings, and image generation endpoints — those have no Claude Max
// equivalent so they must use a paid API.
const FORBIDDEN_ENDPOINTS = [
  /api\.openai\.com\/v1\/chat\/completions/,
  /api\.groq\.com\/openai\/v1\/chat\/completions/,
  /api\.groq\.com\/v1\/chat\/completions/,
  /api\.anthropic\.com\/v1\/messages/,
];

// Sanctioned ladder implementations: these files ARE the fallback ladder,
// so they may carry paid API floor calls (the floors sit below the
// subscription rungs by construction). Groq is still banned here too.
const LADDER_ALLOWLIST = new Set([
  'scripts/lib/ask-ai.js', // universal askAI ladder (paid floors last)
  'ec2-server.js', // askAmy six-rung ladder (subscriptions first)
]);

// Files allowed to retain paid-chat calls because they are LEGACY fallback
// paths being migrated to the askAI ladder. Each entry must have an open
// migration task. TODO: drive this list to zero.
const LEGACY_MIGRATION_ALLOWLIST = new Set([
  'src/main/calls.ts', // legacy outbound call generator pre-Amy-v2
  'src/main/studio-director.ts', // studio transcription + director
  'src/main/user-profile.ts', // profile extraction fallback
]);

function walkSourceFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(dir)) {
      if (!isIgnored(dir)) results.push(dir);
    }
    return results;
  }
  if (!stat.isDirectory()) return results;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (isIgnored(full)) continue;
      walkSourceFiles(full, results);
    }
  } catch {
    /* skip unreadable dirs */
  }
  return results;
}

describe('LLM routing guard — no paid hosts in source', () => {
  const files: string[] = [];

  for (const entry of SCAN_DIRS) {
    const full = path.join(REPO_ROOT, entry);
    walkSourceFiles(full, files);
  }

  // Read each file once and cache the content. Without this, the four
  // FORBIDDEN_ENDPOINTS tests below read every file four times, and when
  // the full suite runs in parallel on Windows the disk contention pushes
  // each test over the 5000ms default timeout. 117ms in isolation, flaky
  // under parallel load. Cache once, regex many times, flake goes away.
  const fileContents: Array<{ rel: string; content: string }> = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      fileContents.push({ rel, content });
    } catch {
      /* unreadable */
    }
  }

  it('finds at least one source file to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const endpoint of FORBIDDEN_ENDPOINTS) {
    const isGroq = /groq/.test(endpoint.source);
    it(`no source file contains forbidden endpoint ${endpoint.source}`, () => {
      const violators: string[] = [];
      for (const { rel, content } of fileContents) {
        // Groq has no ladder rung: banned everywhere, no exemptions.
        const exempt =
          !isGroq && (LADDER_ALLOWLIST.has(rel) || LEGACY_MIGRATION_ALLOWLIST.has(rel));
        if (endpoint.test(content) && !exempt) {
          violators.push(rel);
        }
      }
      if (violators.length > 0) {
        throw new Error(
          `Forbidden endpoint ${endpoint.source} found in source files. Route through the askAI ladder (scripts/lib/ask-ai.js, subscriptions first, paid floors last):\n` +
            violators.map((v) => `  - ${v}`).join('\n') +
            '\n\nTo allowlist a file temporarily during migration, add it to LEGACY_MIGRATION_ALLOWLIST in this test.',
        );
      }
    });
  }

  it('LADDER_ALLOWLIST contains exactly the sanctioned ladder implementations', () => {
    expect([...LADDER_ALLOWLIST].sort()).toEqual(['ec2-server.js', 'scripts/lib/ask-ai.js']);
  });

  it('LEGACY_MIGRATION_ALLOWLIST has pending migrations documented', () => {
    // Drives the allowlist to zero over time. This test passes as long as
    // the allowlist is non-empty (meaning there are known migrations to do),
    // and fails if someone adds a new file without updating this expectation.
    expect(LEGACY_MIGRATION_ALLOWLIST.size).toBeLessThanOrEqual(3);
  });

  it('claude-proxy.js exists and is the local Claude Max routing endpoint', () => {
    const proxy = path.join(REPO_ROOT, 'claude-proxy.js');
    expect(fs.existsSync(proxy)).toBe(true);
    const src = fs.readFileSync(proxy, 'utf-8');
    expect(src).toMatch(/claude.{0,10}-p|claude.{0,10}--print/);
    expect(src).toMatch(/3456|CLAUDE_PROXY_PORT/);
  });

  it('claude-runner.ts uses spawnClaude pattern with CLAUDECODE unset', () => {
    const runner = path.join(REPO_ROOT, 'src', 'main', 'claude-runner.ts');
    expect(fs.existsSync(runner)).toBe(true);
    const src = fs.readFileSync(runner, 'utf-8');
    expect(src).toContain('CLAUDECODE');
    expect(src).toMatch(/delete.{0,20}CLAUDECODE/);
  });
});
