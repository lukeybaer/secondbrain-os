/**
 * amy-versions-persona-loading.test.ts
 *
 * Regression: every Vapi system prompt must include the canonical Amy
 * persona from memory/AMY.md. The "one Amy, not five" non-negotiable
 * need from MEMORY.md depends on this — if the Vapi voice persona
 * drifts from Tier 1 memory, Amy's identity splits across surfaces
 * and the #gap protected by plans/dazzling-rolling-moler.md recurs.
 *
 * This test calls buildVersionedSystemPrompt with a minimal version and
 * asserts that AMY.md content is present in the output.
 *
 * Commit 12 of 18 in plans/dazzling-rolling-moler.md.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock Electron's app module so amy-versions.ts and its transitive imports
// can load in a vitest worker. vi.mock is hoisted above all imports, so we
// cannot reference a module-scope const in the factory. Resolve the repo
// root inline instead.
vi.mock('electron', () => {
  const p = require('path');
  const repoRoot = p.resolve(__dirname, '..', '..', '..');
  return {
    app: {
      getPath: (_name: string) => repoRoot,
      getAppPath: () => repoRoot,
    },
  };
});

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AMY_MD_PATH = path.join(REPO_ROOT, 'memory', 'AMY.md');

vi.mock('../agent-memory', () => ({
  getAgentMemory: () => ({
    buildSystemPrompt: async (base: string) => base,
  }),
}));

vi.mock('../caller-id', () => ({
  identifyCaller: () => ({
    systemPromptSection: '## Caller Identification: UNKNOWN',
    identified: false,
  }),
  loadContactsStore: () => ({ keyword: 'testword', contacts: [] }),
}));

vi.mock('../personas', () => ({ listPersonas: () => [] }));
vi.mock('../projects', () => ({ listProjects: () => [] }));
vi.mock('../todos', () => ({ listTodos: () => [] }));
vi.mock('../calls', () => ({ listCallRecords: () => [] }));

import { buildVersionedSystemPrompt, __resetAmyPersonaCache } from '../amy-versions';
import type { AmyVersion } from '../amy-versions';

function minimalVersion(): AmyVersion {
  return {
    version: 99,
    name: 'test-version',
    createdAt: '2026-01-01T00:00:00Z',
    description: 'minimal test version',
    llm: { provider: 'custom-llm', model: 'claude-test' },
    voice: { provider: 'test', voiceId: 'test' },
    proactive: { enabled: false, channels: [], onlyWhenExplicitlyAsked: true },
    identity: 'FALLBACK_IDENTITY_MARKER',
    rules: [],
    skills: [],
    tools: [],
  } as unknown as AmyVersion;
}

describe('buildVersionedSystemPrompt loads memory/AMY.md canonical persona', () => {
  beforeEach(() => {
    __resetAmyPersonaCache();
  });

  it('AMY.md is tracked and non-empty', () => {
    expect(fs.existsSync(AMY_MD_PATH)).toBe(true);
    const content = fs.readFileSync(AMY_MD_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(500);
    expect(content).toMatch(/Amy/);
  });

  it('system prompt includes the canonical persona header', async () => {
    const prompt = await buildVersionedSystemPrompt(minimalVersion(), {
      callDirection: 'inbound',
    });
    expect(prompt).toContain('Canonical Amy persona');
    expect(prompt).toContain('memory/AMY.md');
  });

  it('system prompt includes identity markers that come from AMY.md', async () => {
    const amyRaw = fs.readFileSync(AMY_MD_PATH, 'utf-8');
    const stripped = amyRaw.replace(/^---\n[\s\S]*?\n---\n/, '');
    // Pull a distinctive line from the persona file to verify it's in the prompt
    const externalNameLine = stripped.match(/External name.*Amy/i);
    expect(externalNameLine, 'AMY.md should declare external name Amy').toBeTruthy();

    const prompt = await buildVersionedSystemPrompt(minimalVersion(), {
      callDirection: 'inbound',
    });
    expect(prompt).toMatch(/External name.*Amy/i);
  });

  it('system prompt declares same-brain-as-Claude-Code identity', async () => {
    const prompt = await buildVersionedSystemPrompt(minimalVersion(), {
      callDirection: 'inbound',
    });
    expect(prompt).toMatch(/same brain as Claude Code/i);
  });

  it('YAML frontmatter is stripped before injection', async () => {
    const prompt = await buildVersionedSystemPrompt(minimalVersion(), {
      callDirection: 'outbound',
    });
    // Frontmatter keys should not leak into the prompt
    expect(prompt).not.toMatch(/^name:\s*Amy/m);
    expect(prompt).not.toMatch(/^canonical:\s*true/m);
    expect(prompt).not.toMatch(/^level:\s*1/m);
  });

  it('persona is injected BEFORE version.identity so AMY.md anchors', async () => {
    const prompt = await buildVersionedSystemPrompt(minimalVersion(), {
      callDirection: 'inbound',
    });
    const personaIdx = prompt.indexOf('Canonical Amy persona');
    const fallbackIdx = prompt.indexOf('FALLBACK_IDENTITY_MARKER');
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(fallbackIdx).toBeGreaterThan(personaIdx);
  });
});
