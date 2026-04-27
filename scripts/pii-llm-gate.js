#!/usr/bin/env node
/**
 * pii-llm-gate.js
 *
 * Layer 3 of the 3-layer PII screen. Final semantic check on the public-sync
 * payload using Claude Haiku via the `claude` CLI subprocess (Claude Max plan,
 * zero per-call cost). Catches the class of leak that Layers 1 and 2 miss:
 * sentences that don't contain a denylisted token but still reveal personal
 * context about the owner -- the implication that the owner has a specific
 * relationship, employer, or location, even when no name appears verbatim.
 *
 * Strategy:
 *   - Sample up to 200 prose lines from .md files in the payload that are
 *     NOT obviously generic doc content (READMEs, code blocks, config samples)
 *   - Send the sample as a single batch to Claude Haiku with a strict
 *     "block / pass" decision prompt
 *   - Block if Claude flags any line as personal-identifying
 *
 * Usage:   node scripts/pii-llm-gate.js [target_dir]
 *
 * Exit codes:
 *   0 = pass (no semantic PII leak detected)
 *   1 = block (Claude flagged at least one line)
 *   2 = setup error (claude CLI missing or runtime failure)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TEXT_EXTS = new Set(['.md', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.claude']);
const MAX_LINES = 200;
const MAX_FILE_BYTES = 200_000;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXTS.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

function stripCodeBlocks(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    out.push(line.replace(/`[^`]+`/g, ''));
  }
  return out.join('\n');
}

function sampleProseLines(target) {
  const files = walk(target);
  const samples = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (content.length > MAX_FILE_BYTES) continue;
    const stripped = stripCodeBlocks(content);
    const rel = path.relative(target, f).split(path.sep).join('/');
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.length < 30) continue;
      if (l.startsWith('#') || l.startsWith('|') || l.startsWith('-')) continue;
      samples.push({ file: rel, line: i + 1, text: l.slice(0, 240) });
      if (samples.length >= MAX_LINES) return samples;
    }
  }
  return samples;
}

function buildPrompt(samples) {
  const numbered = samples.map((s, i) => `${i + 1}. [${s.file}:${s.line}] ${s.text}`).join('\n');
  return `You are auditing prose lines from an open-source codebase before they are pushed to a public repository. The repo is a generic AI executive assistant ("SecondBrain"). It must NOT contain identifying details about its private maintainer (names, family relationships, employer names, residence, religion, specific financial accounts, specific contact emails or phones).

Public-figure mentions are fine (Sam Altman, Anthropic, Meta, etc.). Generic example names (John Doe, Jane Doe, "the user", "the owner") are fine. Generic technology references (Claude, GPT, FFmpeg, Vapi, etc.) are fine.

Block ONLY if a line reveals private identifying information about the maintainer. Do not block on generic prose, marketing copy, or technical documentation.

For each numbered line below, reply with one line in the format:
  N: BLOCK <one-sentence reason>
  N: PASS

Be strict but not paranoid. If unsure, PASS.

Lines:
${numbered}`;
}

function callClaude(prompt) {
  const claude = process.env.CLAUDE_BIN || 'claude';
  // Windows requires shell:true for .cmd/.bat shims; harmless on Unix.
  // CLAUDECODE/CLAUDE_CODE_ENTRYPOINT are set when running inside a Claude
  // Code session; the CLI refuses to nest. Strip them so this gate can run
  // both interactively and in CI.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const res = spawnSync(claude, ['--print', '--model', 'claude-haiku-4-5-20251001'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    shell: process.platform === 'win32',
    env,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      console.error('[pii-llm-gate] claude CLI not found. Set CLAUDE_BIN or install claude-code.');
      return { ok: false, code: 2 };
    }
    console.error('[pii-llm-gate] claude error:', res.error.message);
    return { ok: false, code: 2 };
  }
  if (res.status !== 0) {
    console.error('[pii-llm-gate] claude exit', res.status, res.stderr.slice(0, 500));
    return { ok: false, code: 2 };
  }
  return { ok: true, text: res.stdout };
}

function parseDecisions(text, samples) {
  const blocked = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*:\s*BLOCK\s*(.*)$/i);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < samples.length) {
        blocked.push({ ...samples[idx], reason: m[2].trim() });
      }
    }
  }
  return blocked;
}

function main() {
  const target = path.resolve(process.argv[2] || REPO);
  const samples = sampleProseLines(target);
  if (samples.length === 0) {
    console.log('[pii-llm-gate] CLEAN — no prose lines to check');
    process.exit(0);
  }
  const prompt = buildPrompt(samples);
  const res = callClaude(prompt);
  if (!res.ok) process.exit(res.code);

  const blocked = parseDecisions(res.text, samples);
  if (blocked.length === 0) {
    console.log(`[pii-llm-gate] CLEAN — Claude Haiku passed all ${samples.length} lines`);
    process.exit(0);
  }

  console.log(`[pii-llm-gate] ${blocked.length} line(s) flagged by Claude Haiku:`);
  for (const b of blocked) {
    console.log(`  ${b.file}:${b.line}`);
    console.log(`    reason: ${b.reason}`);
    console.log(`    text:   ${b.text.slice(0, 140)}`);
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { sampleProseLines, buildPrompt, parseDecisions };
