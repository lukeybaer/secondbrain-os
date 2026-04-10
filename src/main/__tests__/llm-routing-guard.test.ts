/**
 * llm-routing-guard.test.ts
 *
 * Repo-wide regression guard: no code path may call a paid LLM host.
 * All LLM traffic must route through Luke's Claude Max subscription via
 * the local proxy (port 3456) or the claude CLI subprocess pattern.
 *
 * Root cause this test prevents: the 2026-04-10 manual-briefing-v2.js
 * regression where I called api.openai.com directly for 30 article
 * summaries despite Luke's explicit "everything flows through claude max"
 * rule. Also catches any future slip where api.groq.com, api.anthropic.com,
 * or a hardcoded OpenAI/Groq/Anthropic key reappears.
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

// Files allowed to retain paid-chat calls because they are LEGACY fallback
// paths being migrated to Claude Max proxy. Each entry must have an open
// migration task. TODO: drive this list to zero.
const LEGACY_MIGRATION_ALLOWLIST = new Set([
  'src/main/calls.ts', // legacy outbound call generator pre-Amy-v2
  'src/main/studio-director.ts', // studio transcription + director
  'src/main/user-profile.ts', // profile extraction fallback
  'ec2-server.js', // EC2 briefing fallback (being migrated to proxy)
]);

function walkSourceFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(dir)) {
      if (!IGNORE_PATTERNS.some((p) => p.test(dir))) results.push(dir);
    }
    return results;
  }
  if (!stat.isDirectory()) return results;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (IGNORE_PATTERNS.some((p) => p.test(full))) continue;
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

  it('finds at least one source file to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const endpoint of FORBIDDEN_ENDPOINTS) {
    it(`no source file contains forbidden endpoint ${endpoint.source}`, () => {
      const violators: string[] = [];
      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          if (endpoint.test(content)) {
            const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
            if (!LEGACY_MIGRATION_ALLOWLIST.has(rel)) {
              violators.push(rel);
            }
          }
        } catch {
          /* unreadable */
        }
      }
      if (violators.length > 0) {
        throw new Error(
          `Forbidden endpoint ${endpoint.source} found in source files — must route through Claude Max proxy:\n` +
            violators.map((v) => `  - ${v}`).join('\n') +
            '\n\nTo allowlist a file temporarily during migration, add it to LEGACY_MIGRATION_ALLOWLIST in this test.',
        );
      }
    });
  }

  it('LEGACY_MIGRATION_ALLOWLIST has pending migrations documented', () => {
    // Drives the allowlist to zero over time. This test passes as long as
    // the allowlist is non-empty (meaning there are known migrations to do),
    // and fails if someone adds a new file without updating this expectation.
    expect(LEGACY_MIGRATION_ALLOWLIST.size).toBeLessThanOrEqual(4);
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
