'use strict';

// Records every model prompt and its response as operation-provenance events
// (ExampleCo 2026-09-23: "even the prompt response should be saved, so we always
// know what we talked about"). Graphiti-free: the 2026-09-07 Graphiti-off
// overhaul removed the only previous writer (the Graphiti advisor hooks), and
// prompt evidence went dark from 2026-09-08. Events:
//   prompt.admitted            prompt text + hash + authority digest (g1, g6)
//   prompt.context.delivered   the authority context reached the model (g25)
//   prompt.response.recorded   response text + hash, same operation_id (g25)
// Text is capped at TEXT_CAP_BYTES per field; the sha256 always covers the full
// untruncated text so a cut record still proves exactly what was said.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { recordOperationEvent } = require('./operation-provenance.js');
const { authorityDigest, runtimeDataDir } = require('./prompt-admission-token.js');

const TEXT_CAP_BYTES = 200 * 1024;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function capText(text) {
  const full = String(text ?? '');
  const buffer = Buffer.from(full, 'utf8');
  if (buffer.length <= TEXT_CAP_BYTES) return { text: full, sha256: sha256(full), bytes: buffer.length, truncated: false };
  // Cut on a byte budget, then drop any partial trailing UTF-8 character.
  const cut = buffer.subarray(0, TEXT_CAP_BYTES).toString('utf8').replace(/�$/, '');
  return { text: cut, sha256: sha256(full), bytes: buffer.length, truncated: true };
}

function sessionIndexPath(dataDir, sessionId) {
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(runtimeDataDir(dataDir), 'agent', 'prompt-provenance', 'sessions', `${safe}.json`);
}

// Session index before 2026-09-24 held one prompt as { operation_id, ... };
// read it as a one-item open list so a turn spanning the upgrade still pairs.
function openPrompts(index) {
  if (Array.isArray(index?.open)) return index.open;
  return index?.operation_id ? [{ operation_id: index.operation_id, prompt_sha256: index.prompt_sha256 || null, at: index.at || null }] : [];
}

function newOperationId(now = new Date()) {
  return `op_${now.getTime()}_${crypto.randomBytes(8).toString('hex')}`;
}

// Prompt side: prompt.admitted + prompt.context.delivered under one new
// operation_id, remembered per session so the response pairs with it.
// entrypoint is Claude Code's CLAUDE_CODE_ENTRYPOINT for the run; 'sdk-cli' is
// a headless `claude -p` run. No one waits on that turn, and a caller that
// kills it on timeout ends it before the Stop hook can record a response.
function recordPrompt({ surface, sessionId = '', prompt, dataDir, root, now = new Date(), record = recordOperationEvent, digest = null, entrypoint = '' } = {}) {
  const operationId = newOperationId(now);
  const authority = digest || authorityDigest({ root });
  const captured = capText(prompt);
  const common = { operationId, surface, sessionId };
  record({
    ...common,
    eventType: 'prompt.admitted',
    status: authority.status === 'verified' ? 'green' : 'amber',
    details: {
      prompt_text: captured.text,
      prompt_sha256: captured.sha256,
      prompt_bytes: captured.bytes,
      truncated: captured.truncated,
      authority_digest: authority.sha256,
      authority_status: authority.status,
      ...(entrypoint ? { entrypoint: String(entrypoint), headless: entrypoint === 'sdk-cli' } : {}),
    },
  }, { dataDir, now });
  record({ ...common, eventType: 'prompt.context.delivered', status: 'green', details: { authority_digest: authority.sha256 } }, { dataDir, now });
  if (sessionId) {
    // Keep every prompt still waiting for an answer: a message sent mid-turn
    // must not replace the one before it.
    const file = sessionIndexPath(dataDir, sessionId);
    let open = [];
    try { open = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first prompt */ }
    open.push({ operation_id: operationId, prompt_sha256: captured.sha256, at: now.toISOString() });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ open: open.slice(-50) }));
  }
  return { operationId, promptSha256: captured.sha256 };
}

// Response side: pairs with the session's open prompt. With no open prompt it
// still records the response, marked orphan, so nothing is silently dropped.
function recordResponse({ surface, sessionId = '', response, dataDir, now = new Date(), record = recordOperationEvent, operationId = null, promptSha256 = null } = {}) {
  let opId = operationId;
  let promptHash = promptSha256;
  let orphan = false;
  let answered = opId ? [opId] : [];
  if (!opId && sessionId) {
    const file = sessionIndexPath(dataDir, sessionId);
    try {
      const open = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (open.length) {
        const latest = open[open.length - 1];
        opId = latest.operation_id;
        promptHash = latest.prompt_sha256;
        answered = open.map((entry) => entry.operation_id);
        fs.writeFileSync(file, JSON.stringify({ open: [] }));
      }
    } catch { /* no open prompt for this session */ }
  }
  if (!opId) { opId = newOperationId(now); orphan = true; }
  const captured = capText(response);
  record({
    operationId: opId,
    surface,
    sessionId,
    eventType: 'prompt.response.recorded',
    status: 'green',
    details: {
      response_text: captured.text,
      response_sha256: captured.sha256,
      response_bytes: captured.bytes,
      truncated: captured.truncated,
      prompt_sha256: promptHash || null,
      answers_operation_ids: answered,
      orphan,
    },
  }, { dataDir, now });
  return { operationId: opId, orphan };
}

// One call for automated (non-interactive) model runs, e.g. EC2 ask-ai.
function recordModelExchange({ surface, prompt, response, sessionId = '', dataDir, root, now = new Date(), record = recordOperationEvent, digest = null } = {}) {
  const { operationId, promptSha256 } = recordPrompt({ surface, sessionId: '', prompt, dataDir, root, now, record, digest });
  return recordResponse({ surface, sessionId, response, dataDir, now, record, operationId, promptSha256 });
}

// Final assistant text of the last turn in a Claude Code transcript (JSONL).
function lastAssistantText(transcriptPath) {
  let lines = [];
  try { lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return ''; }
  const parts = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    if (entry.type === 'user' && typeof entry.message?.content === 'string') break;
    if (entry.type === 'user' && Array.isArray(entry.message?.content) && !entry.message.content.some((c) => c.type === 'tool_result')) break;
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
    if (text) parts.unshift(text);
  }
  return parts.join('\n\n');
}

function modelSurface(platform = process.platform, cwd = process.cwd()) {
  return platform === 'linux' && cwd.startsWith('/opt/secondbrain') ? 'ec2-automated' : `${platform === 'win32' ? 'pc' : platform}-automated`;
}

module.exports = { TEXT_CAP_BYTES, capText, sha256, recordPrompt, recordResponse, recordModelExchange, lastAssistantText, modelSurface, sessionIndexPath };
