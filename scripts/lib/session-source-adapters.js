'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FORBIDDEN_PEOPLE } = require('./forbidden-people.js');
const { isOwnerPromptText } = require('./voice-session-cloud-records.js');

const EVENT_SCHEMA = 'amy.session_event.v1';
const DEFAULT_SELECT_WINDOW_MS = 30 * 60 * 1000;

function concise(value, max = 1000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function defaultClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function defaultCodexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function defaultTasksDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'secondbrain',
    'data',
    'tasks',
  );
}

function defaultDesktopSessionRegistryDir() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data');
  return path.join(dataDir, 'agent', 'desktop-session-registry');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readTaskMap(tasksDir, sessionRegistryDir = defaultDesktopSessionRegistryDir()) {
  const bySession = new Map();
  const readDirectory = (dir, registry = false) => {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of files) {
      const task = readJson(path.join(dir, name));
      if (!task) continue;
      const ids = [task.sessionId, task.activeSessionId, ...(Array.isArray(task.sessionIds) ? task.sessionIds : [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      for (const id of ids) {
        if (registry || !bySession.has(id)) bySession.set(id, { task, file: path.join(dir, name) });
      }
    }
  };
  readDirectory(tasksDir);
  readDirectory(sessionRegistryDir, true);
  return bySession;
}

function walkJsonl(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file);
    }
  }
  return out;
}

function firstJsonlRows(file, maxBytes = 96 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, maxBytes);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      return buffer
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// Who started a session, from structure the client writes, never from prose.
// Claude stamps every row with its entrypoint: the desktop app or interactive
// CLI is the owner; an SDK run (claude -p from a script) is automation. Codex stamps
// session_meta with its originator: `codex exec` is the automated fleet
// (reviews, PII checks, recorder units), an interactive client is the owner. The file
// is streamed record by record because a first row carrying a pasted image can
// run to megabytes, and only a top-level field counts, never quoted text.
// With `row`, only the first row that test accepts is read: its field, or ''
// when that row has none.
function firstTopLevelField(file, field, { chunkBytes = 1024 * 1024, maxBytes = 64 * 1024 * 1024, row: accept = null } = {}) {
  const { StringDecoder } = require('node:string_decoder');
  const needle = `"${field}"`;
  const STOP = { value: '' };
  const pick = (line) => {
    if (!accept && !line.includes(needle)) return '';
    try {
      const row = JSON.parse(line);
      if (accept) {
        if (!row || !accept(row)) return '';
        return typeof row[field] === 'string' && row[field] ? row[field] : STOP;
      }
      return row && typeof row[field] === 'string' ? row[field] : '';
    } catch {
      return '';
    }
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(chunkBytes);
    let carry = '';
    let read = 0;
    while (read < maxBytes) {
      const n = fs.readSync(fd, buffer, 0, chunkBytes, read);
      if (n <= 0) break;
      read += n;
      const lines = (carry + decoder.write(buffer.subarray(0, n))).split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const value = pick(line);
        if (value === STOP) return '';
        if (value) return value;
      }
    }
    const last = pick(carry + decoder.end());
    return last === STOP ? '' : last;
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

// Known values only; anything else stays 'unknown' rather than guessing a side.
const CLAUDE_OWNER_ENTRYPOINTS = new Set(['claude-desktop', 'cli', 'claude-vscode', 'claude-jetbrains']);
const CODEX_OWNER_SOURCES = new Set(['vscode', 'cli', 'desktop']);

function claudeInitiator(file) {
  const entrypoint = firstTopLevelField(file, 'entrypoint').toLowerCase();
  if (!entrypoint) return '';
  if (/^sdk/.test(entrypoint)) return 'automated';
  // The desktop app also hosts headless jobs (session summarizers, briefing
  // gates) under its own entrypoint. Their opening turn comes from the SDK, not
  // a person: 2026-10-28, 132 of the 150 "owner" sessions on a voice lookup were
  // such runs. Only the opening user row decides; one with no origin stamp
  // keeps the entrypoint answer. It sits near the top, so the scan stays short.
  const openingOrigin = firstTopLevelField(file, 'turnOrigin', {
    maxBytes: 2 * 1024 * 1024,
    row: (row) => row.type === 'user',
  });
  if (openingOrigin.toLowerCase() === 'sdk') return 'automated';
  return CLAUDE_OWNER_ENTRYPOINTS.has(entrypoint) ? 'owner' : 'unknown';
}

function codexInitiator({ originator = '', source = '' } = {}) {
  const orig = String(originator).toLowerCase();
  const src = String(source).toLowerCase();
  if (!orig && !src) return '';
  if (src === 'exec' || orig === 'codex_exec') return 'automated';
  if (CODEX_OWNER_SOURCES.has(src) || (orig === 'codex desktop' && !src)) return 'owner';
  return 'unknown';
}

function basenameRepo(cwd, fallback = 'unknown') {
  return path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || fallback;
}

function sourceUpdatedAt(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return '';
  }
}

function discoverClaudeSources({ claudeProjectsDir, taskMap, nowMs, selectWindowMs }) {
  const out = [];
  // Pass 1 sees EVERY transcript, even ones outside the selection window, so a
  // source id never changes shape depending on which sibling happens to be recent.
  const candidates = [];
  const subagentIdCounts = new Map();
  for (const file of walkJsonl(claudeProjectsDir)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const relative = path.relative(claudeProjectsDir, file);
    const parts = relative.split(path.sep);
    const subagentsIndex = parts.indexOf('subagents');
    const sourceKind = subagentsIndex > 0 ? 'subagent' : 'main';
    const sessionId = sourceKind === 'subagent' ? parts[subagentsIndex - 1] : path.basename(file, '.jsonl');
    const sourceName = sourceKind === 'subagent' ? path.basename(file, '.jsonl') : 'main';
    const legacyId = `claude:${sessionId}:${sourceKind}:${sourceName}`;
    if (sourceKind === 'subagent') subagentIdCounts.set(legacyId, (subagentIdCounts.get(legacyId) || 0) + 1);
    candidates.push({ file, stat, parts, sourceKind, sessionId, legacyId });
  }
  for (const candidate of candidates) {
    const { file, stat, parts, sourceKind, sessionId, legacyId } = candidate;
    if (nowMs - stat.mtimeMs > selectWindowMs) continue;
    const parentSessionId = sessionId;
    const taskEntry = taskMap.get(sessionId) || null;
    const repo = basenameRepo(taskEntry?.task?.execution?.cwd, parts[0] || 'unknown');
    out.push({
      provider: 'claude',
      session_id: sessionId,
      parent_session_id: sourceKind === 'subagent' ? parentSessionId : null,
      source_id: subagentIdCounts.get(legacyId) > 1 ? collidingSubagentSourceId(sessionId, parts) : legacyId,
      source_kind: sourceKind,
      transcript_path: file,
      repo,
      title: concise(taskEntry?.task?.title || taskEntry?.task?.prompt || `${repo} Claude session`, 240),
      initiator: claudeInitiator(file),
      updated_at: stat.mtime.toISOString(),
      transcript_bytes: stat.size,
      task: taskEntry?.task || null,
      task_file: taskEntry?.file || null,
    });
  }
  return out;
}

/**
 * Several subagent transcripts of one session can share a basename (every
 * workflow keeps a `journal.jsonl`). The legacy id `...:subagent:<basename>`
 * then names more than one file, so they share one S3 prefix and one sweep state
 * and the archive audit can never seal the larger ones (permanent red, found
 * 2026-10-23: five journals of one session, one id). Only colliding files move to
 * a path-derived id; a unique basename keeps its legacy id and its S3 evidence.
 */
function collidingSubagentSourceId(sessionId, parts) {
  return `claude:${sessionId}:subagent:${parts.join('/').replace(/\.jsonl$/i, '')}`;
}

function codexMeta(file) {
  for (const row of firstJsonlRows(file)) {
    if (row?.type !== 'session_meta' || !row.payload) continue;
    return {
      sessionId: String(row.payload.id || row.payload.session_id || '').trim(),
      cwd: String(row.payload.cwd || '').trim(),
      initiator: codexInitiator({
        originator: String(row.payload.originator || ''),
        source: typeof row.payload.source === 'string' ? row.payload.source : '',
      }),
    };
  }
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,36})\.jsonl$/i);
  return { sessionId: match?.[1] || path.basename(file, '.jsonl').replace(/^rollout-[^-]+-/, ''), cwd: '', initiator: '' };
}

function discoverCodexSources({ codexSessionsDir, taskMap, nowMs, selectWindowMs }) {
  const out = [];
  for (const file of walkJsonl(codexSessionsDir)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (nowMs - stat.mtimeMs > selectWindowMs) continue;
    const meta = codexMeta(file);
    if (!meta.sessionId) continue;
    const taskEntry = taskMap.get(meta.sessionId) || null;
    const cwd = taskEntry?.task?.execution?.cwd || meta.cwd;
    const repo = basenameRepo(cwd, 'unknown');
    out.push({
      provider: 'codex',
      session_id: meta.sessionId,
      parent_session_id: null,
      source_id: `codex:${meta.sessionId}:main`,
      source_kind: 'main',
      transcript_path: file,
      repo,
      title: concise(taskEntry?.task?.title || taskEntry?.task?.prompt || `${repo} Codex session`, 240),
      initiator: meta.initiator,
      updated_at: stat.mtime.toISOString(),
      transcript_bytes: stat.size,
      task: taskEntry?.task || null,
      task_file: taskEntry?.file || null,
    });
  }
  return out;
}

function discoverSessionSources({
  claudeProjectsDir = defaultClaudeProjectsDir(),
  codexSessionsDir = defaultCodexSessionsDir(),
  tasksDir = defaultTasksDir(),
  sessionRegistryDir = defaultDesktopSessionRegistryDir(),
  nowMs = Date.now(),
  selectWindowMs = DEFAULT_SELECT_WINDOW_MS,
} = {}) {
  const taskMap = readTaskMap(tasksDir, sessionRegistryDir);
  return [
    ...discoverClaudeSources({ claudeProjectsDir, taskMap, nowMs, selectWindowMs }),
    ...discoverCodexSources({ codexSessionsDir, taskMap, nowMs, selectWindowMs }),
  ].sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => typeof block === 'string' || block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text')
    .map((block) => (typeof block === 'string' ? block : block.text || block.content || ''))
    .filter(Boolean)
    .join('\n');
}

function scrubDerivedText(value) {
  let text = String(value || '');
  for (const name of FORBIDDEN_PEOPLE) {
    const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    text = text.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'giu'),
      '$1privacy_redacted_person',
    );
  }
  const patterns = [
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    /\b(password|passwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]{8,})/gi,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, (match, label) => (label ? `${label}=[REDACTED]` : '[REDACTED]'));
  }
  return concise(text, 12000);
}

// What the owner asked a session, read from the whole transcript: his prompts (the
// opening one and the newest) and the latest compaction recap of what he wants.
// A long session only ever sees the owner's words as "#b" or a continuation summary,
// so its live turns alone cannot say what it is about. 2026-10-28 owner call:
// "the session for the nightly briefing fixes" missed a session that was open
// at that moment, because its record held nothing but its newest prompt.
const DIGEST_PROMPTS = 12;
const DIGEST_PROMPT_MAX = 300;
const DIGEST_INTENT_MAX = 700;
const CONTINUATION_RE = /being continued from a previous conversation/i;

function recapIntent(text) {
  const s = String(text || '');
  const start = s.search(/primary request and intent:?/i);
  if (start < 0) return '';
  const body = s.slice(start).replace(/^primary request and intent:?/i, '');
  const end = body.search(/\n\s*\d+\.\s+\*{0,2}[A-Z][^\n]{0,60}:/);
  return concise(
    (end >= 0 ? body.slice(0, end) : body)
      .replace(/\*\*|__|`/g, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim(),
    DIGEST_INTENT_MAX,
  );
}

function sessionDigestFromText(text, provider = 'claude') {
  const prompts = [];
  let intent = '';
  for (const line of String(text || '').split('\n')) {
    if (provider === 'codex') {
      if (!line.includes('"user_message"')) continue;
    } else if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const raw =
      provider === 'codex'
        ? row.type === 'event_msg' && row.payload?.type === 'user_message'
          ? textBlocks(row.payload.message || row.payload.content)
          : ''
        : row.type === 'user' && !row.isMeta
          ? textBlocks(row.message?.content ?? row.content)
          : '';
    const words = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim();
    if (!words) continue;
    if (CONTINUATION_RE.test(words.slice(0, 200))) {
      intent = recapIntent(words) || intent;
      continue;
    }
    if (!isOwnerPromptText(words)) continue;
    prompts.push({ at: String(row.timestamp || ''), text: concise(scrubDerivedText(words), DIGEST_PROMPT_MAX) });
  }
  const kept = prompts.length > DIGEST_PROMPTS ? [prompts[0], ...prompts.slice(-(DIGEST_PROMPTS - 1))] : prompts;
  return { owner_prompts: kept, intent: intent ? scrubDerivedText(intent) : '' };
}

function sessionDigestFromFile(file, provider = 'claude') {
  try {
    return sessionDigestFromText(fs.readFileSync(file, 'utf8'), provider);
  } catch {
    return { owner_prompts: [], intent: '' };
  }
}

function rowsFromDelta(deltaText) {
  const rows = [];
  for (const line of String(deltaText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // Complete malformed rows are ignored as derived text, while raw S3 keeps them.
    }
  }
  return rows;
}

function accumulator(map, order, id, stamp) {
  const key = String(id || '').trim() || `activity-${order.length + 1}`;
  if (!map.has(key)) {
    map.set(key, { id: key, prompt: [], agent: [], startedAt: stamp || '', completedAt: '', terminal: false });
    order.push(key);
  }
  return map.get(key);
}

function buildCodexActivities(rows, previousState) {
  const map = new Map();
  const order = [];
  let current = String(previousState?.active_activity_id || '');
  for (const row of rows) {
    if (row.type !== 'event_msg' || !row.payload) continue;
    const type = row.payload.type;
    const stamp = row.timestamp || row.payload.started_at || row.payload.completed_at || '';
    if (type === 'task_started') {
      current = String(row.payload.turn_id || current || `turn-${order.length + 1}`);
      accumulator(map, order, current, stamp).startedAt ||= row.payload.started_at || stamp;
    } else if (type === 'user_message') {
      const item = accumulator(map, order, current || `turn-${order.length + 1}`, stamp);
      current = item.id;
      const text = textBlocks(row.payload.message || row.payload.content);
      if (text) item.prompt.push(text);
    } else if (type === 'agent_message') {
      const item = accumulator(map, order, current || `turn-${order.length + 1}`, stamp);
      current = item.id;
      const text = textBlocks(row.payload.message || row.payload.content);
      if (text) item.agent.push(text);
    } else if (type === 'task_complete') {
      const item = accumulator(map, order, row.payload.turn_id || current || `turn-${order.length + 1}`, stamp);
      current = item.id;
      const last = textBlocks(row.payload.last_agent_message);
      if (last && !item.agent.includes(last)) item.agent.push(last);
      item.terminal = true;
      item.completedAt = row.payload.completed_at || stamp;
    }
  }
  return { activities: order.map((id) => map.get(id)), activeActivityId: current };
}

function buildClaudeActivities(rows, previousState, sourceId) {
  const map = new Map();
  const order = [];
  let current = String(previousState?.active_activity_id || '');
  for (const row of rows) {
    const stamp = row.timestamp || row.created_at || '';
    const role = row.message?.role || row.role || row.type;
    if (row.type === 'user' || role === 'user') {
      if (current) {
        const previous = accumulator(map, order, current, stamp);
        previous.terminal = true;
        previous.completedAt ||= stamp;
      }
      current = String(row.uuid || row.message?.id || `${sourceId}:${order.length + 1}`);
      const item = accumulator(map, order, current, stamp);
      // A system reminder can sit in front of the owner's words in the same message;
      // it is dropped so what he typed survives the boilerplate test below.
      const text = textBlocks(row.message?.content ?? row.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .trim();
      // Harness boilerplate (compaction continuations, command wrappers, task
      // notifications) starts a turn but is not what the owner asked, and neither is
      // a meta row (a loaded skill's instructions, an image path note).
      if (text && !row.isMeta && isOwnerPromptText(text)) item.prompt.push(text);
    } else if (row.type === 'assistant' || role === 'assistant') {
      const item = accumulator(map, order, current || `${sourceId}:${order.length + 1}`, stamp);
      current = item.id;
      const text = textBlocks(row.message?.content ?? row.content);
      if (text) item.agent.push(text);
      if (row.message?.stop_reason || row.stop_reason) {
        item.terminal = true;
        item.completedAt = stamp;
      }
    }
  }
  return { activities: order.map((id) => map.get(id)), activeActivityId: current };
}

function buildEventsFromDelta({
  source,
  deltaText,
  startOffset = 0,
  endOffset = 0,
  observedAt = new Date().toISOString(),
  previousState = {},
  terminalReceipt = null,
  raw = {},
} = {}) {
  if (!source?.provider || !source?.session_id || !source?.source_id) {
    throw new Error('session source provider, session_id, and source_id are required');
  }
  const rows = rowsFromDelta(deltaText);
  // The Claude app writes the sidebar name ("Quarterly planning") as custom-title
  // rows through the session; that name is how the owner refers to it.
  const titleRow = [...rows].reverse().find((row) => row?.type === 'custom-title' && row.customTitle);
  const sessionTitle = scrubDerivedText(
    String((titleRow && titleRow.customTitle) || previousState.session_title || ''),
  ).slice(0, 160);
  const parsed = source.provider === 'codex'
    ? buildCodexActivities(rows, previousState)
    : buildClaudeActivities(rows, previousState, source.source_id);
  const events = [];
  for (let index = 0; index < parsed.activities.length; index += 1) {
    const activity = parsed.activities[index];
    const prompt = scrubDerivedText(activity.prompt.join('\n'));
    const agent = scrubDerivedText(activity.agent.join('\n'));
    const type = activity.terminal ? 'activity_completed' : agent ? 'checkpoint' : 'activity_started';
    const occurredAt = activity.completedAt || activity.startedAt || source.updated_at || observedAt;
    const visibleText = scrubDerivedText(
      [prompt ? `user: ${prompt}` : '', agent ? `assistant: ${agent}` : ''].filter(Boolean).join('\n'),
    );
    const event = {
      schema: EVENT_SCHEMA,
      event_id: sha256(
        [source.provider, source.session_id, source.source_id, activity.id, type, startOffset, endOffset, index].join('|'),
      ),
      provider: source.provider,
      session_id: source.session_id,
      activity_id: activity.id,
      parent_session_id: source.parent_session_id || null,
      source_id: source.source_id,
      source_kind: source.source_kind || 'main',
      type,
      occurred_at: occurredAt,
      observed_at: observedAt,
      source_sequence: Number(endOffset),
      source_revision: 1,
      title: scrubDerivedText(source.title || `${source.provider} session`).slice(0, 240),
      ...(sessionTitle ? { session_title: sessionTitle } : {}),
      ...(source.initiator ? { initiator: source.initiator } : {}),
      prompt_summary: concise(prompt, 1000),
      progress_summary: concise(agent, 2000),
      result_summary: activity.terminal ? concise(agent, 4000) : '',
      execution: {
        cwd: scrubDerivedText(source.task?.execution?.cwd || '').slice(0, 500),
        branch: scrubDerivedText(source.task?.execution?.branch || '').slice(0, 240),
        commit: scrubDerivedText(source.task?.execution?.commit || '').slice(0, 80),
      },
      visible_text: visibleText,
      raw: {
        s3_key: String(raw.s3_key || ''),
        s3_bucket: String(raw.s3_bucket || ''),
        byte_start: Number(startOffset),
        byte_end: Number(endOffset),
        sha256: String(raw.sha256 || ''),
        verified: raw.verified !== false,
      },
      ...(activity.terminal && terminalReceipt ? { terminal_receipt: terminalReceipt } : {}),
    };
    events.push(event);
  }
  const lastTerminal = [...parsed.activities].reverse().find((item) => item.terminal);
  const lastOpen = [...parsed.activities].reverse().find((item) => !item.terminal);
  return {
    events,
    state: {
      ...previousState,
      ...(sessionTitle ? { session_title: sessionTitle } : {}),
      active_activity_id: lastOpen?.id || (lastTerminal ? '' : parsed.activeActivityId || ''),
      last_terminal_activity_id: lastTerminal?.id || previousState.last_terminal_activity_id || '',
    },
  };
}

function buildReceiptConfirmedEvent({ source, state = {}, receipt, observedAt = new Date().toISOString() } = {}) {
  const activityId = state.last_terminal_activity_id;
  if (!activityId || !receipt || receipt.status !== 'replicated') return null;
  const raw = receipt.transcript || {};
  return {
    schema: EVENT_SCHEMA,
    event_id: sha256(
      [source.provider, source.session_id, activityId, 'receipt_confirmed', raw.sha256 || '', raw.bytes || 0].join('|'),
    ),
    provider: source.provider,
    session_id: source.session_id,
    activity_id: activityId,
    parent_session_id: source.parent_session_id || null,
    source_id: source.source_id,
    source_kind: source.source_kind || 'main',
    type: 'receipt_confirmed',
    occurred_at: receipt.replicated_at || receipt.updated_at || observedAt,
    observed_at: observedAt,
    source_sequence: Number(state.last_offset || raw.bytes || 0),
    source_revision: 2,
    title: scrubDerivedText(source.title || `${source.provider} session`).slice(0, 240),
    ...(state.session_title ? { session_title: state.session_title } : {}),
    ...(source.initiator ? { initiator: source.initiator } : {}),
    prompt_summary: '',
    progress_summary: '',
    result_summary: '',
    visible_text: '',
    raw: {
      s3_key: receipt.s3?.transcript_key || '',
      s3_bucket: receipt.s3?.bucket || '',
      byte_start: 0,
      byte_end: Number(raw.bytes || 0),
      sha256: raw.sha256 || '',
      verified: true,
    },
    terminal_receipt: {
      verified: true,
      receipt_id: receipt.operation_id || receipt.session_id || source.session_id,
      replicated_at: receipt.replicated_at || receipt.updated_at || observedAt,
      transcript_sha256: raw.sha256 || '',
      transcript_bytes: Number(raw.bytes || 0),
    },
  };
}

module.exports = {
  DEFAULT_SELECT_WINDOW_MS,
  EVENT_SCHEMA,
  buildEventsFromDelta,
  buildReceiptConfirmedEvent,
  claudeInitiator,
  codexInitiator,
  defaultClaudeProjectsDir,
  defaultCodexSessionsDir,
  defaultDesktopSessionRegistryDir,
  defaultTasksDir,
  discoverSessionSources,
  scrubDerivedText,
  sessionDigestFromFile,
  sessionDigestFromText,
  sha256,
};
