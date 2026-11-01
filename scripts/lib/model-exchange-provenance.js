'use strict';

// Records every model prompt and its response as operation-provenance events
// (owner decision: "even the prompt response should be saved, so we always
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
const os = require('node:os');
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
// headless: an explicit marker for a recorder that knows (recordModelExchange
// is always automated); otherwise derived from the entrypoint when one is
// known, and absent when neither is. Gravity grades an unmarked prompt with
// the short headless window (Codex deploy review 2559b2ea3410).
function recordPrompt({ surface, sessionId = '', prompt, dataDir, root, now = new Date(), record = recordOperationEvent, digest = null, entrypoint = '', headless = null, pid = process.ppid, pidStart = processStartKey(pid) } = {}) {
  const isHeadless = typeof headless === 'boolean' ? headless : (entrypoint ? entrypoint === 'sdk-cli' : null);
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
      ...(entrypoint ? { entrypoint: String(entrypoint) } : {}),
      ...(isHeadless === null ? {} : { headless: isHeadless }),
    },
  }, { dataDir, now });
  record({ ...common, eventType: 'prompt.context.delivered', status: 'green', details: { authority_digest: authority.sha256 } }, { dataDir, now });
  if (sessionId) {
    // Keep every prompt still waiting for an answer: a message sent mid-turn
    // must not replace the one before it.
    const file = sessionIndexPath(dataDir, sessionId);
    let open = [];
    try { open = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first prompt */ }
    open.push({ operation_id: operationId, prompt_sha256: captured.sha256, at: now.toISOString(), ...(isHeadless === true ? { headless: true } : {}), ...(Number.isInteger(pid) && pid > 0 ? { pid, host: os.hostname(), ...(pidStart ? { pid_start: String(pidStart) } : {}) } : {}) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ open: open.slice(-50) }));
  }
  return { operationId, promptSha256: captured.sha256 };
}

// Response side: pairs with the session's open prompt. With no open prompt it
// still records the response, marked orphan, so nothing is silently dropped.
// Owner note: the 2026-10-18 orphan response was
// recorded under a different session id than its prompt (the desktop forwarded
// the session under a new id mid-turn), so the same-session lookup missed an
// open prompt that the same Claude process had admitted. With no open prompt
// in its own session, a response claims ONE open prompt that carries
// its process id on this host from any recent session index: the newest entry
// admitted inside the claim window (Codex deploy review 2559b2ea3410: first
// file match claimed every entry of that pid, so a long-lived or reused pid
// could pair with the wrong session and erase unrelated open prompts). An
// entry older than the window is never claimed, and on Linux the recorded
// process start time must match when both sides have one. The scan is
// bounded (recent files only) because it runs inside the Stop hook.
const PID_CLAIM_WINDOW_MS = 12 * 60 * 60 * 1000;
const PID_CLAIM_MAX_FILES = 3000;
// Linux /proc start time (clock ticks since boot) as a process identity beyond
// the pid; empty where unavailable (Windows hooks).
function processStartKey(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '';
  } catch { return ''; }
}
function claimOpenPromptsByPid({ dataDir, pid, pidStart = '', excludeFile, now }) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const dir = path.join(runtimeDataDir(dataDir), 'agent', 'prompt-provenance', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const host = os.hostname();
  const cutoff = now.getTime() - PID_CLAIM_WINDOW_MS;
  const mine = (entry) => entry && entry.pid === pid && entry.host === host
    && Date.parse(entry.at || '') >= cutoff
    && (!pidStart || !entry.pid_start || String(entry.pid_start) === String(pidStart));
  let best = null;
  for (const name of names.slice(0, PID_CLAIM_MAX_FILES)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    if (excludeFile && path.resolve(file) === path.resolve(excludeFile)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let open;
    try { open = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { continue; }
    for (const entry of open) {
      if (!mine(entry)) continue;
      if (!best || Date.parse(entry.at) > Date.parse(best.entry.at)) best = { file, name, entry, open };
    }
  }
  if (!best) return null;
  try { fs.writeFileSync(best.file, JSON.stringify({ open: best.open.filter((entry) => entry !== best.entry) })); } catch { return null; }
  return { file: best.name, entries: [best.entry] };
}

function recordResponse({ surface, sessionId = '', response, dataDir, now = new Date(), record = recordOperationEvent, operationId = null, promptSha256 = null, pid = process.ppid, pidStart = processStartKey(pid) } = {}) {
  let opId = operationId;
  let promptHash = promptSha256;
  let orphan = false;
  let answered = opId ? [opId] : [];
  let pairedBy = opId ? 'caller' : null;
  const ownFile = sessionId ? sessionIndexPath(dataDir, sessionId) : null;
  if (!opId && sessionId) {
    try {
      const open = openPrompts(JSON.parse(fs.readFileSync(ownFile, 'utf8')));
      if (open.length) {
        const latest = open[open.length - 1];
        opId = latest.operation_id;
        promptHash = latest.prompt_sha256;
        answered = open.map((entry) => entry.operation_id);
        pairedBy = 'session';
        fs.writeFileSync(ownFile, JSON.stringify({ open: [] }));
      }
    } catch { /* no open prompt for this session */ }
  }
  if (!opId) {
    const claimed = claimOpenPromptsByPid({ dataDir, pid, pidStart, excludeFile: ownFile, now });
    if (claimed) {
      const latest = claimed.entries[claimed.entries.length - 1];
      opId = latest.operation_id;
      promptHash = latest.prompt_sha256;
      answered = claimed.entries.map((entry) => entry.operation_id);
      pairedBy = `pid:${claimed.file}`;
    }
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
      ...(pairedBy ? { paired_by: pairedBy } : {}),
    },
  }, { dataDir, now });
  return { operationId: opId, orphan };
}

// Caller-ended receipt (#b 2026-10-14): a headless `claude -p` run its caller
// ended (deadline, lease loss, crash) never reaches the Stop hook, so Gravity
// g1/g6/g25 graded its prompt missing. The caller passes the run's
// --session-id; this records a distinct prompt.caller_ended.recorded event
// that CLOSES the open prompts without answering them (Codex deploy review
// d53b55345f3d: an interrupted run is never a response). It records nothing
// once the Stop hook already answered them.
function recordCallerEnded({ surface = 'claude-code', sessionId, reason = '', exitCode = null, signal = null, dataDir, now = new Date(), record = recordOperationEvent, onlyOperationIds = null } = {}) {
  if (!sessionId) return null;
  const file = sessionIndexPath(dataDir, sessionId);
  let open;
  try {
    open = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  // Targeted close: only the exact ids named, never a prompt appended since.
  if (onlyOperationIds) {
    const wanted = new Set(onlyOperationIds);
    open = open.filter((entry) => wanted.has(entry.operation_id));
  }
  if (!open.length) return null;
  const why = reason || `exited code=${exitCode} signal=${signal || ''}`;
  const operationId = open[open.length - 1].operation_id;
  record({
    operationId,
    surface,
    sessionId,
    eventType: 'prompt.caller_ended.recorded',
    status: 'yellow',
    details: {
      closes_operation_ids: open.map((entry) => entry.operation_id),
      answered: false,
      exit_reason: why,
      exit_code: exitCode,
      exit_signal: signal || null,
    },
  }, { dataDir, now });
  // Receipt first, then drop only the prompts it closed: a failed write leaves
  // them open so a retry can still close them (Codex closure c815a2edb39b).
  const closed = new Set(open.map((entry) => entry.operation_id));
  let current = [];
  try { current = openPrompts(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* index gone */ }
  fs.writeFileSync(file, JSON.stringify({ open: current.filter((entry) => !closed.has(entry.operation_id)) }));
  return { operationId, closed: open.length };
}

// Sweep (2026-10-16): a headless run whose process died without its caller
// recording the end (e.g. a spine-worker dispatch claude run, 2026-10-15 23:38Z)
// left its prompt open forever, so Gravity g1/g6/g25 read it as missing. Age
// alone proves nothing (a long run may still be alive), so a prompt is closed
// only with terminal evidence: it is headless, older than the in-flight window,
// and its recorded pid on THIS host no longer exists. Prompts without a recorded
// pid/host, from another host, or with a live pid stay open. Each closure names
// the exact stale operation ids; prompts appended later are never touched.
// #b 2026-10-25 RED-1: an interactive PC turn the desktop app ended mid-turn
// (2026-10-24 17:09Z, op_1792861798718) never reached Stop or StopFailure, and
// this sweep ran only on EC2 for headless runs, so the prompt stayed open and
// Gravity g1/g6/g25 graded it missing. Interactive prompts now close on the
// same terminal evidence after the grader's 8 hour interactive window, and the
// PC prompt hook runs the sweep for its own host.
const HEADLESS_SWEEP_AGE_MS = 2 * 60 * 60 * 1000;
const INTERACTIVE_SWEEP_AGE_MS = 8 * 60 * 60 * 1000;
function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}
function sweepStaleHeadlessPrompts({ dataDir, now = new Date(), maxAgeMs = HEADLESS_SWEEP_AGE_MS, interactiveMaxAgeMs = INTERACTIVE_SWEEP_AGE_MS, record = recordOperationEvent, isGone = processGone, host = os.hostname() } = {}) {
  const dir = path.dirname(sessionIndexPath(dataDir, 'x'));
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return { swept: 0, prompts: 0, errors: 0 }; }
  const out = { swept: 0, prompts: 0, errors: 0 };
  for (const name of names) {
    const sessionId = name.slice(0, -'.json'.length);
    try {
      const open = openPrompts(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      const dead = open.filter((entry) => now.getTime() - Date.parse(entry.at || '') >= (entry.headless === true ? maxAgeMs : interactiveMaxAgeMs)
        && Number.isInteger(entry.pid) && entry.pid > 0 && entry.host === host && isGone(entry.pid));
      if (!dead.length) continue;
      const kind = dead.every((entry) => entry.headless === true) ? 'headless run' : 'turn';
      const ended = recordCallerEnded({ sessionId, reason: `swept: ${kind} process is gone and left no Stop-hook response or caller receipt`, dataDir, now, record, onlyOperationIds: dead.map((entry) => entry.operation_id) });
      if (ended) { out.swept += 1; out.prompts += ended.closed; }
    } catch { out.errors += 1; }
  }
  return out;
}

// One call for automated (non-interactive) model runs, e.g. EC2 ask-ai. Always
// headless: no one waits on the turn, so Gravity grades its prompt with the
// two hour window (Codex deploy review 2559b2ea3410).
function recordModelExchange({ surface, prompt, response, sessionId = '', dataDir, root, now = new Date(), record = recordOperationEvent, digest = null } = {}) {
  const { operationId, promptSha256 } = recordPrompt({ surface, sessionId: '', prompt, dataDir, root, now, record, digest, headless: true });
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

module.exports = { TEXT_CAP_BYTES, capText, sha256, recordPrompt, recordResponse, recordCallerEnded, sweepStaleHeadlessPrompts, recordModelExchange, lastAssistantText, modelSurface, sessionIndexPath, processStartKey, PID_CLAIM_WINDOW_MS };
