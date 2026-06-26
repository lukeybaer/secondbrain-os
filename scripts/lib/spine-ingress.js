const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'removed_non_actionable']);
const DEFAULT_STALE_HOURS = 6;

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data';
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data');
}

function resolveTasksDir(opts = {}) {
  return opts.tasksDir || process.env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(defaultDataDir(), 'tasks');
}

function nowIso(opts = {}) {
  return opts.nowIso ? opts.nowIso() : new Date().toISOString();
}

function ensureTasksDir(opts = {}) {
  const dir = resolveTasksDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hashId(parts) {
  return crypto
    .createHash('sha1')
    .update(parts.filter((p) => p !== undefined && p !== null && p !== '').join('|'))
    .digest('hex')
    .slice(0, 32);
}

function taskIdFor(input) {
  const source = input.source || {};
  return `spine-${hashId([input.origin, source.type, source.ref, input.title, input.prompt])}`;
}

function taskPath(id, opts = {}) {
  return path.join(resolveTasksDir(opts), `${id}.json`);
}

function readTask(id, opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(taskPath(id, opts), 'utf8'));
  } catch {
    return null;
  }
}

function writeTask(task, opts = {}) {
  const dir = ensureTasksDir(opts);
  const file = path.join(dir, `${task.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function listSpineTasks(opts = {}) {
  const dir = resolveTasksDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function createSpineTask(input, opts = {}) {
  if (!input || !input.kind || !input.origin || !input.prompt) {
    throw new Error('createSpineTask requires kind, origin, and prompt');
  }
  const id = input.id || taskIdFor(input);
  const existing = readTask(id, opts);
  if (existing) return existing;
  const ts = nowIso(opts);
  const status = input.status || 'queued';
  const task = {
    id,
    kind: input.kind,
    origin: input.origin,
    prompt: input.prompt,
    title: input.title || deriveTitle(input.prompt),
    status,
    createdAt: ts,
    updatedAt: ts,
    history: [{ status, ts, ...(input.historyNote ? { note: input.historyNote } : {}) }],
    ...(input.source ? { source: input.source } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.callback ? { callback: input.callback } : {}),
    ...(input.approved !== undefined ? { approved: input.approved } : {}),
    ...(input.requiresDesktop !== undefined ? { requiresDesktop: input.requiresDesktop } : {}),
    ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  if (TERMINAL_STATUSES.has(status)) task.completedAt = ts;
  writeTask(task, opts);
  return task;
}

function deriveTitle(prompt) {
  const first = String(prompt || '').trim().split('\n')[0].trim();
  if (!first) return 'Untitled task';
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function textOf(value, max = 1600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sourceRefFrom(parts, prefix) {
  const joined = parts.map((p) => textOf(p, 300)).filter(Boolean).join('|');
  return joined || `${prefix}:${hashId([Date.now(), Math.random()])}`;
}

function hasAmySignal(text) {
  return /(?:^|[^\w])#amy\b|hashtag\s+amy\b/i.test(String(text || ''));
}

function hasExplicitIngestSignal(text) {
  return hasAmySignal(text);
}

function hasPplSignal(text) {
  return /(?:^|[^\w])#ppl\b/i.test(String(text || ''));
}

function recordGmailMessage(msg, opts = {}) {
  const ref = opts.sourceRef || msg.message_id || msg.id || msg.gmail_message_id || sourceRefFrom(
    [msg.thread_id, msg.date, msg.subject],
    'gmail',
  );
  const body = msg.body || msg.text || msg.snippet || '';
  const subject = msg.subject || '(no subject)';
  const amySignal = hasAmySignal(`${subject}\n${body}`);
  const explicitSignal = hasExplicitIngestSignal(`${subject}\n${body}`);
  const pplSignal = hasPplSignal(`${subject}\n${body}`);
  return createSpineTask(
    {
      kind: 'ingest',
      origin: 'gmail',
      source: { type: 'gmail-message', ref },
      title: `Gmail: ${subject}`.slice(0, 100),
      prompt: [
        'Process this Gmail message as an open SecondBrain spine requirement.',
        'Run the #ppl/contact-enrichment hook only when #ppl is present, and create child dispatch tasks only when an exact #Amy or spoken "hashtag Amy" request is present.',
        'If inspection finds no follow-up, contact fact, dispatch, or other required action, mark this task removed_non_actionable with the reason.',
        '',
        `From: ${msg.from || ''}`,
        `To: ${msg.to || ''}`,
        `Subject: ${subject}`,
        `Date: ${msg.date || msg.timestamp || msg.fetched_at || ''}`,
        '',
        textOf(body, 5000),
      ].join('\n'),
      approved: explicitSignal,
      meta: {
        from: msg.from || null,
        to: msg.to || null,
        subject,
        threadId: msg.thread_id || msg.threadId || null,
        date: msg.date || msg.timestamp || msg.fetched_at || null,
        hasAmy: amySignal,
        hasPpl: pplSignal,
        explicitRequest: explicitSignal,
      },
    },
    opts,
  );
}

function recordOtterTranscript(speech, opts = {}) {
  const ref = opts.sourceRef || speech.id || speech.otid || speech.speech_id || sourceRefFrom(
    [speech.title, speech.created_at, speech.start_time],
    'otter',
  );
  const transcript = speech.transcript || speech.body || '';
  const title = speech.title || 'Otter transcript';
  const explicitSignal = hasExplicitIngestSignal(transcript);
  const pplSignal = hasPplSignal(transcript);
  return createSpineTask(
    {
      kind: 'ingest',
      origin: 'otter',
      source: { type: 'otter-transcript', ref },
      title: `Otter: ${title}`.slice(0, 100),
      prompt: [
        'Process this Otter transcript as an open SecondBrain spine requirement.',
        'Run #ppl/contact-enrichment only when #ppl is present, and create child dispatch tasks only when exact #Amy or spoken "hashtag Amy" dispatch intent is present.',
        'If inspection finds no follow-up, contact fact, dispatch, or other required action, mark this task removed_non_actionable with the reason.',
        '',
        `Title: ${title}`,
        `Date: ${speech.created_at || speech.start_time || ''}`,
        `Duration seconds: ${speech.duration_sec || speech.duration || ''}`,
        '',
        textOf(transcript || speech.summary, 7000),
      ].join('\n'),
      approved: explicitSignal,
      meta: {
        title,
        date: speech.created_at || speech.start_time || null,
        transcriptChars: String(transcript || '').length,
        hasAmy: hasAmySignal(transcript),
        hasPpl: pplSignal,
        explicitRequest: explicitSignal,
      },
    },
    opts,
  );
}

function recordLinkedInMessage(message, opts = {}) {
  const ref = opts.sourceRef || message.id || message.message_id || sourceRefFrom(
    [message.contact_url, message.name, message.contact_name, message.time, message.scanned_at, message.snippet, message.body],
    'linkedin',
  );
  const contact = message.contact_name || message.name || message.sender || 'LinkedIn contact';
  const body = message.body || message.snippet || message.text || '';
  const explicitSignal = hasExplicitIngestSignal(body);
  const pplSignal = hasPplSignal(body);
  return createSpineTask(
    {
      kind: 'ingest',
      origin: 'linkedin',
      source: { type: 'linkedin-message', ref },
      title: `LinkedIn: ${contact}`.slice(0, 100),
      prompt: [
        'Process this LinkedIn message/thread as an open SecondBrain spine requirement.',
        'Run the #ppl/contact-enrichment hook only when #ppl is present and create dispatch work only when exact #Amy or spoken "hashtag Amy" intent is present.',
        'If #Amy dispatch intent is present, create the child dispatch task. If inspection finds no follow-up, contact fact, dispatch, or other required action, mark this task removed_non_actionable with the reason.',
        '',
        `Contact: ${contact}`,
        `Time: ${message.time || message.scanned_at || message.timestamp || ''}`,
        '',
        textOf(body, 5000),
      ].join('\n'),
      approved: explicitSignal,
      meta: {
        contact,
        time: message.time || message.scanned_at || message.timestamp || null,
        unread: !!message.unread,
        hasAmy: hasAmySignal(body),
        hasPpl: pplSignal,
        explicitRequest: explicitSignal,
      },
    },
    opts,
  );
}

function recordDispatchInput(input, opts = {}) {
  const origin = input.origin || 'app';
  const sourceType = input.sourceType || origin;
  const ref = input.sourceRef || sourceRefFrom([sourceType, input.ts, input.title, input.text], sourceType);
  return createSpineTask(
    {
      kind: input.kind || 'action',
      origin,
      source: { type: sourceType, ref },
      title: input.title || `${origin} dispatch`,
      prompt: [
        `Process this ${origin} dispatch as an open SecondBrain spine requirement.`,
        'Inspect it for follow-up, #ppl/contact-enrichment, and #Amy dispatch intent where applicable.',
        'If inspection finds no actionable item, mark this task removed_non_actionable with the reason.',
        '',
        textOf(input.text || input.prompt || input.comment || '', 6000),
      ].join('\n'),
      approved: input.approved !== undefined ? input.approved : false,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      meta: {
        medium: sourceType,
        hasAmy: hasAmySignal(input.text || input.prompt || input.comment),
        ...(input.meta || {}),
      },
    },
    opts,
  );
}

function markNonActionable(id, reason, opts = {}) {
  const task = readTask(id, opts);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status === 'removed_non_actionable') return task;
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`Task ${id} is already terminal: ${task.status}`);
  }
  const ts = nowIso(opts);
  task.status = 'removed_non_actionable';
  task.updatedAt = ts;
  task.completedAt = ts;
  task.resultSummary = reason || 'Removed as non-actionable after inspection.';
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ status: 'removed_non_actionable', ts, note: task.resultSummary });
  writeTask(task, opts);
  return task;
}

function findStaleSpineTasks(opts = {}) {
  const thresholdHours = opts.thresholdHours || DEFAULT_STALE_HOURS;
  const nowMs = opts.nowMs || Date.now();
  return listSpineTasks(opts)
    .filter((task) => !TERMINAL_STATUSES.has(task.status))
    .map((task) => {
      const ageHours = (nowMs - Date.parse(task.updatedAt || task.createdAt || 0)) / 3600000;
      return { ...task, ageHours };
    })
    .filter((task) => Number.isFinite(task.ageHours) && task.ageHours > thresholdHours)
    .sort((a, b) => b.ageHours - a.ageHours);
}

function probeStaleSpineTasks(opts = {}) {
  const stale = findStaleSpineTasks(opts);
  if (stale.length === 0) {
    return {
      status: 'green',
      detail: `no open spine entries stale >${opts.thresholdHours || DEFAULT_STALE_HOURS}h`,
      staleTasks: [],
    };
  }
  return {
    status: 'red',
    detail: `${stale.length} open spine entr${stale.length === 1 ? 'y is' : 'ies are'} stale >${opts.thresholdHours || DEFAULT_STALE_HOURS}h: ${stale
      .slice(0, 5)
      .map((task) => `${task.title || task.id} (${Math.round(task.ageHours * 10) / 10}h)`)
      .join(', ')}`,
    staleTasks: stale.map((task) => ({
      id: task.id,
      title: task.title,
      origin: task.origin,
      status: task.status,
      updatedAt: task.updatedAt,
      ageHours: Math.round(task.ageHours * 10) / 10,
    })),
  };
}

function dispatchConsumedKey(entry) {
  if (entry && entry.match_hash) return entry.match_hash;
  return `${entry && entry.ts ? entry.ts : ''}|${entry && entry.itemRef ? entry.itemRef : ''}|${String(
    (entry && (entry.comment || entry.text || entry.prompt)) || '',
  ).slice(0, 64)}`;
}

function readConsumedSet(consumedPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(consumedPath, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function probeDispatchBacklog(opts = {}) {
  const queuePath =
    opts.queuePath || path.join(defaultDataDir(), 'agent', 'dispatch-queue.jsonl');
  const consumedPath =
    opts.consumedPath || path.join(path.dirname(queuePath), 'dispatch-intake-consumed.json');
  const consumed = readConsumedSet(consumedPath);
  let lines = [];
  let readError = null;
  try {
    if (!fs.existsSync(queuePath)) lines = [];
    else lines = fs.readFileSync(queuePath, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  } catch (err) {
    readError = err && err.message ? err.message : String(err);
  }

  const pending = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const text = String(entry.comment || entry.text || entry.prompt || '').trim();
      if (!text) continue;
      if (!consumed.has(dispatchConsumedKey(entry))) pending.push(entry);
    } catch {
      pending.push({ malformed: true });
    }
  }

  const drainError = opts.drainError || readError;
  const status = drainError ? 'red' : pending.length ? 'yellow' : 'green';
  return {
    status,
    pending: pending.length,
    detail: drainError
      ? `drainIntake failed; ${pending.length} raw dispatch row${pending.length === 1 ? '' : 's'} still pending`
      : pending.length
        ? `${pending.length} raw dispatch row${pending.length === 1 ? '' : 's'} pending intake`
        : 'no dispatch backlog',
    card:
      drainError || pending.length
        ? {
            title: 'Dispatch intake backlog',
            status: drainError ? 'blocked' : 'waiting',
            count: pending.length,
            tldr: drainError
              ? `Intake failed before task cards rendered; ${pending.length} raw row${pending.length === 1 ? '' : 's'} preserved.`
              : `${pending.length} raw dispatch row${pending.length === 1 ? '' : 's'} waiting for intake.`,
          }
        : null,
  };
}

module.exports = {
  createSpineTask,
  listSpineTasks,
  resolveTasksDir,
  recordGmailMessage,
  recordOtterTranscript,
  recordLinkedInMessage,
  recordDispatchInput,
  markNonActionable,
  findStaleSpineTasks,
  probeStaleSpineTasks,
  probeDispatchBacklog,
};
