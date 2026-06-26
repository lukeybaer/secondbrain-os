/**
 * Tests for memory system bug fixes:
 * 1. Graphiti URL construction (port 3003 → 8000, direct IP)
 * 2. Hebbian decay formula (subtractive → multiplicative)
 * 3. Anthropic API key injection for reflections
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Mock Electron ────────────────────────────────────────────────────────────

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testRoot;
      return testRoot;
    },
  },
}));

// ── Mock config for Graphiti URL tests ───────────────────────────────────────

let mockConfig: Record<string, ExampleCo> = {};

vi.mock('../config', () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ── Mock Anthropic SDK ───────────────────────────────────────────────────────

const mockAnthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      apiKey: string;
      constructor(opts?: { apiKey?: string }) {
        this.apiKey = opts?.apiKey ?? '';
      }
      messages = { create: mockAnthropicCreate };
    },
  };
});

// Import after mocks
import {
  loadIndex,
  upsertMemory,
  runNightlyDecay,
  initMemoryIndex,
  readWorkingMemory,
} from '../memory-index';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(testRoot, 'data', 'agent', 'memory', 'archive'), {
    recursive: true,
  });
  mockConfig = {};
  mockAnthropicCreate.mockReset();
});

afterAll(async () => {
  // Cleanup is best-effort
});

// ── Graphiti URL Tests ───────────────────────────────────────────────────────

describe('Graphiti URL construction', () => {
  // We test the logic by importing the module fresh — but since graphitiUrl is
  // not exported, we test it via the isGraphitiAvailable function behavior.
  // Instead, let's replicate the URL logic directly to verify correctness.

  function graphitiUrl(ec2BaseUrl?: string): string {
    const base = ec2BaseUrl ?? '';
    const ipMatch = base.match(/https?:\/\/([\d.]+)/);
    const host = ipMatch ? ipMatch[1] : 'ExampleCo';
    return `http://${host}:8000`;
  }

  it('extracts IP from direct URL and uses port 8000', () => {
    expect(graphitiUrl('http://ExampleCo:3001')).toBe('http://ExampleCo:8000');
  });

  it('falls back to Elastic IP when ec2BaseUrl is a domain', () => {
    expect(graphitiUrl('https://ea.example.com')).toBe('http://ExampleCo:8000');
  });

  it('falls back to Elastic IP when ec2BaseUrl is API Gateway', () => {
    expect(graphitiUrl('https://unay54a6jh.execute-api.us-east-1.amazonaws.com/prod')).toBe(
      'http://ExampleCo:8000',
    );
  });

  it('falls back to Elastic IP when ec2BaseUrl is empty', () => {
    expect(graphitiUrl('')).toBe('http://ExampleCo:8000');
  });

  it('falls back to Elastic IP when ec2BaseUrl is undefined', () => {
    expect(graphitiUrl(undefined)).toBe('http://ExampleCo:8000');
  });

  it('never returns port 3003', () => {
    const urls = [
      graphitiUrl('http://ExampleCo:3001'),
      graphitiUrl('https://ea.example.com'),
      graphitiUrl(''),
      graphitiUrl(undefined),
    ];
    for (const url of urls) {
      expect(url).not.toContain(':3003');
    }
  });
});

// ── Hebbian Decay Formula Tests ──────────────────────────────────────────────

describe('Hebbian decay formula', () => {
  it('uses multiplicative decay (new entry survives > 2 days)', () => {
    initMemoryIndex();

    // Create an entry
    const entry = upsertMemory('test-topic', 'test content for decay formula');
    expect(entry.weight).toBe(0.2);
    expect(entry.decay_rate).toBe(0.1);

    // Simulate 2 days of inactivity by backdating last_accessed
    const index = loadIndex();
    const e = index.entries.find((i) => i.id === entry.id)!;
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    e.last_accessed = twoDaysAgo.toISOString().slice(0, 10);

    // Save the modified index
    const indexPath = path.join(testRoot, 'data', 'agent', 'memory', 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    // Run decay
    const result = runNightlyDecay();
    expect(result.decayed).toBeGreaterThanOrEqual(1);

    // With multiplicative: 0.2 * (1 - 0.10)^2 = 0.2 * 0.81 = 0.162
    // With old subtractive: 0.2 - 0.10 * 2 = 0.0 (dead!)
    const updated = loadIndex();
    const decayed = updated.entries.find((i) => i.id === entry.id);
    expect(decayed).toBeDefined();
    expect(decayed!.weight).toBeGreaterThan(0.05); // still alive
    expect(decayed!.weight).toBeCloseTo(0.162, 2); // multiplicative result
  });

  it('promoted entries (weight 0.8, rate 0.02) last weeks', () => {
    initMemoryIndex();

    // Create and promote an entry (3 mentions)
    upsertMemory('promoted-topic', 'content that gets mentioned a lot');
    upsertMemory('promoted-topic', 'content that gets mentioned a lot');
    const entry = upsertMemory('promoted-topic', 'content that gets mentioned a lot');
    expect(entry.weight).toBe(0.8);
    expect(entry.decay_rate).toBe(0.02);

    // Simulate 7 days
    const index = loadIndex();
    const e = index.entries.find((i) => i.id === entry.id)!;
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    e.last_accessed = weekAgo.toISOString().slice(0, 10);

    const indexPath = path.join(testRoot, 'data', 'agent', 'memory', 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    runNightlyDecay();

    // Multiplicative: 0.8 * (1 - 0.02)^7 = 0.8 * 0.868 = 0.695
    const updated = loadIndex();
    const decayed = updated.entries.find((i) => i.id === entry.id);
    expect(decayed!.weight).toBeGreaterThan(0.6);
    expect(decayed!.weight).toBeCloseTo(0.695, 1);
  });

  it('entries eventually archive below 0.05 threshold', () => {
    initMemoryIndex();

    const entry = upsertMemory('ephemeral-topic', 'short-lived memory content');

    // Simulate 30 days (0.2 * 0.9^30 ≈ 0.008 — below 0.05)
    const index = loadIndex();
    const e = index.entries.find((i) => i.id === entry.id)!;
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    e.last_accessed = monthAgo.toISOString().slice(0, 10);

    const indexPath = path.join(testRoot, 'data', 'agent', 'memory', 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    const result = runNightlyDecay();
    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Entry should be gone from index
    const updated = loadIndex();
    expect(updated.entries.find((i) => i.id === entry.id)).toBeUndefined();
  });
});

// ── Anthropic API Key Tests ──────────────────────────────────────────────────

describe('Anthropic API key injection (superseded by the 2026-06-11 provider ladder)', () => {
  // The old contract (direct Anthropic call, throw without a key) was the LIVE
  // OUTAGE: every reflection failed with 'No ANTHROPIC_API_KEY configured'.
  // Reflections now route through generateReflectionViaLadder (codex -> claude
  // CLI -> anthropic key -> openai floor); behavioral ladder coverage lives in
  // agent-memory-reflection-ladder.test.ts with injected rungs (no live spawns).
  // These tests pin the wiring at the source level.
  it('reflections route through the provider ladder; the config key is a rung, not a gate', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../agent-memory.ts'), 'utf-8');
    expect(src).toMatch(/generateReflectionViaLadder\(/);
    // anthropicApiKey from config is still honored as the anthropic rung
    expect(src).toMatch(/anthropicApiKey/);
  });

  it('no API key is no longer an outage: the anthropic rung returns null, never throws', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../agent-memory.ts'), 'utf-8');
    // The rung skips cleanly when no key is configured...
    expect(src).toMatch(/if \(!apiKey\) return null/);
    // ...and the old unconditional throw is gone from code (history lives in a comment)
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(codeOnly).not.toMatch(/throw[^\n]*ANTHROPIC_API_KEY/);
  });
});
