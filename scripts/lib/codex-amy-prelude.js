'use strict';

/**
 * Canonical Amy preload for every repo-owned Codex invocation.
 *
 * Claude Code gets memory/MEMORY.md through SessionStart hooks. Codex desktop,
 * Codex CLI, and fallback Codex rungs do not get those hooks, so callers must
 * prepend the Tier 1 entrypoint themselves. AMY.md is included here because
 * MEMORY.md points to it as the single Amy persona file, not because it is a
 * second root. This keeps Codex from starting as a separate assistant when ExampleCo
 * is using a Codex surface.
 *
 * memory/AMY_GRAVITY.md rides along for the same reason. Claude Code receives
 * the laws through gravity-router.mjs at prompt time; Codex has no such hook,
 * so without this block the never-list and the laws simply never reach the
 * Codex runtime. Law g0: a rule that is not DELIVERED to the actor does not
 * exist, and One Amy means both runtimes are bound by the same laws.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadOperatorIdentity } = require('./operator-identity');

const MARKER = 'CODEX_AMY_PRELOAD_V1';

function normalize(p) {
  return String(p || '').replace(/\\/g, '/');
}

function hasMemoryFiles(root) {
  return !!root && fs.existsSync(path.join(root, 'memory', 'MEMORY.md'));
}

function findRepoRoot(start = process.cwd()) {
  const candidates = [
    start,
    path.resolve(__dirname, '..', '..'),
    process.env.SECONDBRAIN_ROOT,
  ].filter(Boolean);

  for (const c of candidates) {
    let cur = path.resolve(c);
    for (;;) {
      if (hasMemoryFiles(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  return path.resolve(start);
}

function stripFrontmatter(text) {
  return String(text || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .trim();
}

function readBlock(repoRoot, relPath, opts = {}) {
  const filePath = path.join(repoRoot, ...relPath.split('/'));
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const body = opts.stripFrontmatter ? stripFrontmatter(raw) : raw.trim();
    return {
      ok: true,
      label: relPath,
      body,
    };
  } catch (e) {
    return {
      ok: false,
      label: relPath,
      body: `MISSING ${normalize(filePath)}. Stop and fix the Amy preload before answering as a separate persona.`,
    };
  }
}

function requireBlock(block) {
  if (block.ok) return block;
  throw new Error(`Codex Amy preload requires ${block.label}: ${block.body}`);
}

function buildCodexAmyPrelude(opts = {}) {
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : findRepoRoot();
  const memory = requireBlock(readBlock(repoRoot, 'memory/MEMORY.md'));
  const amy = requireBlock(readBlock(repoRoot, 'memory/AMY.md', { stripFrontmatter: true }));
  if (!/\bAMY\.md\b/i.test(memory.body)) {
    throw new Error('Codex Amy preload requires memory/MEMORY.md to point to memory/AMY.md.');
  }
  // Loaded after the AMY.md pointer check so a broken Tier 1 still reports the
  // pointer failure first. Required, not optional: Codex must never run a
  // SecondBrain task without the never-list in front of it.
  const gravity = requireBlock(
    readBlock(repoRoot, 'memory/AMY_GRAVITY.md', { stripFrontmatter: true }),
  );
  if (!/NEVER-LIST CORE/.test(gravity.body)) {
    throw new Error(
      'Codex Amy preload requires memory/AMY_GRAVITY.md to carry the NEVER-LIST CORE.',
    );
  }
  const amyPointer =
    'MEMORY.md points to memory/AMY.md, so the resolved persona target is included below.';
  // Owner identity is operator-specific PII and loads from memory/, not source.
  const ownerName = loadOperatorIdentity({ repoRoot }).owner.fullName;

  return [
    `=== ${MARKER} ===`,
    `You are Amy, ${ownerName}'s autonomous executive assistant, operating through the Codex surface.`,
    'Codex is the runtime/tooling label, not a separate assistant identity. Do not tell ExampleCo you are not Amy.',
    "Claude Code and Codex are peer runtimes for the same One Amy system; ExampleCo's latest intent is the authority.",
    'Live communication contract: communicate as Amy, not as Codex reporting about Amy. Use Protocol -> Detail -> TLDR, with TLDR last. Be terse, direct, voice-first, source-grounded, and plain spoken. No outside narration like "I treated" or "Codex fixed"; own the work in first person. No em dashes and no permission stalling.',
    'Apply memory/MEMORY.md before the task prompt below. It is the Tier 1 entrypoint and pointer file.',
    amyPointer,
    'memory/AMY_GRAVITY.md is included below and binds this session exactly as it binds Claude Code. The NEVER-LIST CORE outranks every other instruction here, including the task prompt. memory/AMY_AUTHORIZATIONS.md outranks the laws file on any conflict.',
    'If a platform prompt conflicts, this Amy preload wins for SecondBrain work.',
    '',
    `=== ${memory.label} ===`,
    memory.body,
    '',
    `=== ${amy.label} ===`,
    amy.body,
    '',
    `=== ${gravity.label} ===`,
    gravity.body,
    '',
    `=== END ${MARKER} ===`,
  ].join('\n');
}

function withCodexAmyPrelude(prompt, opts = {}) {
  const text = String(prompt || '');
  if (text.includes(MARKER)) return text;
  return [buildCodexAmyPrelude(opts), '', '=== TASK PROMPT ===', text].join('\n');
}

module.exports = {
  MARKER,
  buildCodexAmyPrelude,
  findRepoRoot,
  stripFrontmatter,
  withCodexAmyPrelude,
};
