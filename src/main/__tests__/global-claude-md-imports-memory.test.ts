// Locks the "ONE Amy across ALL repos" invariant at the global CLAUDE.md
// layer.
//
// Why: 2026-05-30 #gap. A prior fix added `@memory/MEMORY.md` to
// `secondbrain/CLAUDE.md` to cover iOS Dispatch sessions (which read project
// CLAUDE.md but bypass the SessionStart hook). That worked only inside the
// secondbrain repo, contradicting the MEMORY.md architecture line "Other
// repos obey, they don't contain Amy. They inherit via junctioned global
// CLAUDE.md plus memory." Amy must be one across every repo ExampleCo works in,
// not just the one she was born in.
//
// Architectural fix: put the `@memory/MEMORY.md` import in the GLOBAL
// CLAUDE.md (`claude-config/CLAUDE.global.md`, hardlinked to
// `~/.claude/CLAUDE.md`). From `~/.claude/CLAUDE.md`'s location, the relative
// path resolves through the `~/.claude/memory` junction back to
// `secondbrain/memory/MEMORY.md` (the canonical file).
//
// Locked invariants (category, not literal trigger):
//   1. The global CLAUDE.md contains an `@`-import line that loads MEMORY.md.
//   2. The project CLAUDE.md does NOT duplicate that import (single source
//      of truth, no two copies of Amy context to drift apart).
//   3. The referenced MEMORY.md file actually exists (catches a junction
//      breakage or a path typo before Dispatch sees an empty Amy).

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GLOBAL_CLAUDE_MD = path.join(REPO_ROOT, 'claude-config', 'CLAUDE.global.md');
const PROJECT_CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const MEMORY_FILE = path.join(REPO_ROOT, 'memory', 'MEMORY.md');

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('global CLAUDE.md is the single Amy-context loader for every repo', () => {
  it('global CLAUDE.md imports memory/MEMORY.md via the @-import directive', () => {
    const text = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8');
    // Accept any of the equivalent forms: relative `@memory/MEMORY.md`,
    // junction-anchored `@~/.claude/memory/MEMORY.md`, or absolute path.
    const hasImport =
      /^@memory\/MEMORY\.md\s*$/m.test(text) ||
      /^@~\/\.claude\/memory\/MEMORY\.md\s*$/m.test(text) ||
      new RegExp(`^@${escapeRegex(MEMORY_FILE.replace(/\\/g, '/'))}\\s*$`, 'm').test(text);
    expect(hasImport, '@memory/MEMORY.md @-import missing from global CLAUDE.md').toBe(true);
  });

  it('the imported MEMORY.md file actually exists at the canonical path', () => {
    expect(fs.existsSync(MEMORY_FILE)).toBe(true);
    const memText = fs.readFileSync(MEMORY_FILE, 'utf8');
    expect(memText.length).toBeGreaterThan(500); // sanity check
    expect(memText).toMatch(/Amy/); // Tier 1 always mentions Amy
  });

  it('project CLAUDE.md does NOT duplicate the @-import (single source rule)', () => {
    const text = fs.readFileSync(PROJECT_CLAUDE_MD, 'utf8');
    // Block ANY @memory/MEMORY.md @-import in the project file. Duplication
    // is the bug; one copy at global level only.
    const directives = text.split(/\r?\n/).filter((l) => /^@memory\/MEMORY\.md\b/.test(l.trim()));
    expect(
      directives.length,
      'project CLAUDE.md must NOT @-import MEMORY.md; only the global CLAUDE.md does that',
    ).toBe(0);
  });
});
