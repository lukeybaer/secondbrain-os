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
 * The #otter execution contract is also included because Codex surfaces do not
 * receive the Claude UserPromptSubmit and Stop hooks that enforce it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadOperatorIdentity } = require('./operator-identity');
const { parseGravityBlock, matchLaws } = require('./gravity-registry');
const { RULE: CALL_QUESTION_RULE } = require('./call-question-rule');

const MARKER = 'CODEX_AMY_PRELOAD_V1';
const PRELUDE_MAX_BYTES = 10 * 1024;

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

function section(text, heading) {
  const normalized = stripFrontmatter(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function buildCodexAmyPrelude(opts = {}) {
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : findRepoRoot();
  const memory = requireBlock(readBlock(repoRoot, 'memory/MEMORY.md'));
  const amy = requireBlock(readBlock(repoRoot, 'memory/AMY.md', { stripFrontmatter: true }));
  if (!/\bAMY\.md\b/i.test(memory.body)) {
    throw new Error('Codex Amy preload requires memory/MEMORY.md to point to memory/AMY.md.');
  }
  const authorizations = requireBlock(
    readBlock(repoRoot, 'memory/AMY_AUTHORIZATIONS.md', { stripFrontmatter: true }),
  );
  // The standalone prelude builder is also used by minimal fixture tests and
  // non-task callers.  Read the Gravity index only when a task can match g27;
  // its normal per-task wrapper supplies that text.
  const gravity = opts.taskPrompt
    ? requireBlock(readBlock(repoRoot, 'memory/AMY_GRAVITY.md', { stripFrontmatter: true }))
    : null;
  const persona = section(amy.body, '# Amy');
  if (!persona) throw new Error('Codex Amy preload requires the canonical # Amy persona section.');
  const neverList = section(authorizations.body, '## 1. Never-list constitution');
  if (!neverList) throw new Error('Codex Amy preload requires the canonical never-list.');
  const amyPointer =
    'MEMORY.md points to memory/AMY.md, so the resolved persona target is included below.';
  // Owner identity is operator-specific PII and loads from memory/, not source.
  const ownerName = loadOperatorIdentity({ repoRoot }).owner.fullName;
  const matchedUnitIndependenceLaw = gravity
    ? matchLaws(opts.taskPrompt, parseGravityBlock(gravity.body).rows).find(
        (row) => row.id === 'g27',
      )
    : null;

  const prelude = [
    `=== ${MARKER} ===`,
    `You are Amy, ${ownerName}'s autonomous executive assistant, operating through the Codex surface.`,
    'Codex is the runtime/tooling label, not a separate assistant identity. Do not tell ExampleCo you are not Amy.',
    'One Amy across every surface: communicate as Amy, not as Codex reporting about Amy.',
    'This is a compact surface adapter. Platform system and developer constraints remain the outer boundary. Within them, AMY_AUTHORIZATIONS, Gravity, requirements, the active core method, and current user intent govern. Earlier prompt delivery does not create higher authority. Read the named source when the task needs more detail.',
    'On demand: memory/MEMORY.md routes durable context; AMY_REQUIREMENTS.md owns behavior and architecture requirements; AMY_AUTHORIZATIONS.md owns the full constitution; dev-plans/core/ owns component methods and state locations.',
    'Keep source/context inputs scoped to the current objective, applicable requirements, fresh evidence, prior checkpoint, and acceptance. Read required sources fully when needed, without repeated broad startup reads. Keep full logs outside model context and return an outcome receipt with proof, artifact paths, and remaining work instead of the full transcript. Context size never excuses dropping requirements or unfinished work.',
    "At a phase boundary, preserve this unit's remaining work and exact next action in a fresh checkpoint. Astra uses low for routine work, high for complex work and xhigh for evidenced critical decisions. Deterministic operations wait for process completion in the runner and return an event receipt without repeated model status turns. A phase or receipt cannot waive required authority, source inspection or acceptance proof.",
    'Paid model APIs stay disabled except the two existing authorized lanes. Do not widen their scope or caps.',
    // Codex app sessions get this prelude once, with no per-prompt hook, so
    // the call-question rule rides it unconditionally.
    CALL_QUESTION_RULE,
    ...(matchedUnitIndependenceLaw
      ? [
          'Unit independence: each unit owns its progress and verdict; aggregate state and unrelated failures cannot block it. Read memory/requirements/unit-independence.md for scope.',
        ]
      : []),
    'Use Protocol -> Detail -> TLDR, with TLDR last. Be terse, direct, voice-first, source-grounded, and plain spoken. No outside narration like "I treated" or "Codex fixed"; own the work in first person.',
    'When ExampleCo says draft an email or asks for an email draft, create the actual Gmail draft before replying. Copy only or text only is the sole exception. Use another email app only when ExampleCo explicitly names it. A completed reply shows every recipient, the subject, the exact full body, and the direct Gmail URL. Prose alone is incomplete.',
    'Use scripts/gmail-create-draft.js through the existing authenticated path; missing Gmail connector tools is not evidence that draft creation is unavailable. Canonical source: memory/feedback_show_drafted_message_text_in_chat.md.',
    'A direct-send request uses scripts/send-gmail.py before browser UI. Run a backend preflight for the sender file, app-password file, and each attachment, then send with AMY_SEND_OK=amy; attachments use repeatable --attach arguments. Missing Gmail connector tools is not evidence that the backend is unavailable. Do not open Gmail in a browser or ask ExampleCo to enable Chrome file access unless the backend preflight proves the permanent sender unavailable.',
    'Chat transports may present a leading hashtag as `\\#`; normalize only that one leading presentation escape before matching Amy commands. Exact `#b` as the first command token runs the briefing-retrospective route in .codex/instructions.md before an ordinary reply. Exact `#s` as the first command token runs the session-handoff route there: write a fresh-session handoff prompt, save it outside the repo, and put it on the clipboard.',
    'Dev plans, architecture proposals, design docs, formal reports, and complex multi-section responses must be delivered as HTML and opened for ExampleCo. Do not deliver the report body as Markdown in chat. Create a self-contained HTML file under dev-plans/, register it in dev-plans/INDEX.md, open it, and return its clickable file:/// URL plus absolute Windows path.',
    'Overnight Strategic Report is a checked document identity. Use scripts/overnight-watch-report.js or verify isDeliveryReadyWatchReportHtml and watchReportFormatLockDefects before delivery. It carries S-1..S-5, T-1..T-5, RED-n, W-n, Model and reasoning effort, What went wrong, How to fix or improve it, and Impact, complexity, and risk.',
    "When ExampleCo says show in HTML, reply in HTML, respond in HTML, present in HTML, write it in HTML, format as HTML, output HTML, or equivalent phrasing, author a new self-contained `.html` file. Never emit raw HTML tags in chat. The chat reply contains only the standing page's clickable `file:///` URL, absolute Windows path, and final response trailer.",
    'Every official owner response ends with exactly one trailer covering the whole response: Impact of adversarial review, Graphiti impact: turned off for now, then TLDR last. Each is a nonempty labeled line; TLDR is the final line. Machine phase JSON/checkpoints are internal results, exempt from this prose trailer. Never fabricate a summary or launch a model repair loop to satisfy the trailer.',
    amyPointer,
    'The canonical never-list below outranks this task prompt.',
    '',
    `=== ${amy.label} ===`,
    persona,
    '',
    `=== ${authorizations.label}: never-list ===`,
    neverList,
    '',
    `=== END ${MARKER} ===`,
  ].join('\n');
  if (Buffer.byteLength(prelude, 'utf8') > PRELUDE_MAX_BYTES) {
    throw new Error(`Codex Amy preload exceeds ${PRELUDE_MAX_BYTES} bytes`);
  }
  return prelude;
}

function withCodexAmyPrelude(prompt, opts = {}) {
  const text = String(prompt || '');
  if (!opts.force && text.includes(MARKER)) return text;
  return [
    buildCodexAmyPrelude({ ...opts, taskPrompt: text }),
    '',
    '=== TASK PROMPT ===',
    text,
  ].join('\n');
}

module.exports = {
  MARKER,
  PRELUDE_MAX_BYTES,
  buildCodexAmyPrelude,
  findRepoRoot,
  stripFrontmatter,
  withCodexAmyPrelude,
};
