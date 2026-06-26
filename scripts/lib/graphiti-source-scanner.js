const fs = require('fs');
const path = require('path');

const { voiceArcEvents } = require('./graphiti-voice-arc-scanner');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function isoFrom(value, fallbackFile) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = value > 100000000000 ? value : value * 1000;
    const d = new Date(n);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d{10}(?:\.\d+)?$/.test(trimmed)) {
      const d = new Date(Number(trimmed) * 1000);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    if (/^\d{13}$/.test(trimmed)) {
      const d = new Date(Number(trimmed));
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    const d = new Date(trimmed);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  const d = value ? new Date(value) : null;
  if (d && Number.isFinite(d.getTime())) return d.toISOString();
  const st = fallbackFile ? safeStat(fallbackFile) : null;
  return (st ? st.mtime : new Date()).toISOString();
}

function* walkFiles(dir, opts = {}) {
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (!opts.ext || p.toLowerCase().endsWith(opts.ext)) {
        yield p;
      }
    }
  }
}

function dateKeys(sinceDate, untilDate) {
  const start = new Date(sinceDate);
  const end = new Date(untilDate);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  const keys = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

function inRange(iso, since, until) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return false;
  return ms >= Date.parse(since) && ms <= Date.parse(until);
}

function directionFromEmail(msg) {
  const from = String(msg.from || '').toLowerCase();
  return /ExampleCo\.d\.ExampleCo|ExampleCo\.ExampleCo|@ExampleCogroup\.com|@amazon\.com/.test(from) ? 'outbound' : 'inbound';
}

function gmailEvents(root, since, until) {
  const out = [];
  const rawRoot = path.join(root, 'data', 'gmail', 'raw');
  for (const day of dateKeys(since, until)) {
    const [year, month, dd] = day.split('-');
    const dayDir = path.join(rawRoot, year, month, dd);
    if (!fs.existsSync(dayDir)) continue;
    for (const file of walkFiles(dayDir, { ext: 'message.json' })) {
      const msg = readJson(file);
      if (!msg) continue;
      const reference = isoFrom(msg.date || msg.archived_at, file);
      if (!inRange(reference, since, until)) continue;
      const direction = directionFromEmail(msg);
      const id = String(msg.gmail_message_hex || msg.message_id || msg.id || path.basename(path.dirname(file)));
      const header = [
        `From: ${msg.from || ''}`,
        msg.to ? `To: ${msg.to}` : '',
        msg.cc ? `Cc: ${msg.cc}` : '',
        `Subject: ${msg.subject || '(no subject)'}`,
        msg.gmail_url ? `Gmail URL: ${msg.gmail_url}` : '',
      ].filter(Boolean).join(' | ');
      out.push({
        source: direction === 'outbound' ? 'gmail-outbound' : 'gmail-inbound',
        source_id: id,
        direction,
        name: `Gmail ${direction}: ${String(msg.subject || '(no subject)').slice(0, 100)}`,
        body: `${header}\n\n${String(msg.body || '').trim()}`,
        reference_time: reference,
        observed_at: isoFrom(msg.archived_at, file),
        raw_path: file,
        metadata: {
          thread_hex: msg.thread_hex || null,
          gmail_url: msg.gmail_url || null,
          attachments: Array.isArray(msg.attachments) ? msg.attachments.length : 0,
        },
      });
    }
  }
  return out;
}

function linkedinEvents(root, since, until) {
  const out = [];
  const dir = path.join(root, 'data', 'linkedin', 'raw');
  for (const file of walkFiles(dir, { ext: '.json' })) {
    const j = readJson(file);
    if (!j) continue;
    const reference = isoFrom(j.scanned_at || j.timestamp, file);
    if (!inRange(reference, since, until)) continue;
    const type = j.type === 'message' ? 'message' : 'profile';
    out.push({
      source: type === 'message' ? 'linkedin-message' : 'linkedin-profile',
      source_id: j.id || path.basename(file, '.json'),
      name: `LinkedIn ${type}: ${j.contact_name || path.basename(file, '.json')}`,
      body: [`Contact: ${j.contact_name || ''}`, j.contact_url || '', j.body || JSON.stringify(j.recent_posts || [])].filter(Boolean).join('\n\n'),
      reference_time: reference,
      observed_at: reference,
      raw_path: file,
      contact_name: j.contact_name || null,
      metadata: { contact_url: j.contact_url || null, category: j.category || null },
    });
  }
  return out;
}

function otterEvents(root, since, until) {
  const out = [];
  const dir = path.join(root, 'data', 'otter', 'raw');
  for (const file of walkFiles(dir, { ext: '.json' })) {
    const j = readJson(file);
    if (!j) continue;
    const reference = isoFrom(j.date || j.created_at || j.start_time || j.pulledAt || (j.raw && j.raw.created_at), file);
    if (!inRange(reference, since, until)) continue;
    const body = [`Summary: ${j.summary || ''}`, String(j.transcript || '').trim()].filter(Boolean).join('\n\n');
    out.push({
      source: 'otter-transcript',
      source_id: j.otterId || j.id || path.basename(file, '.json'),
      name: `Otter: ${j.title || path.basename(file, '.json')}`,
      body,
      reference_time: reference,
      observed_at: isoFrom(j.pulledAt, file),
      raw_path: file,
      metadata: { duration_minutes: j.durationMinutes || null },
    });
  }
  return out;
}

function vapiEvents(root, since, until) {
  const out = [];
  const dir = path.join(root, 'data', 'vapi', 'raw');
  for (const file of walkFiles(dir, { ext: '.json' })) {
    const j = readJson(file);
    if (!j) continue;
    const call = j.callObj || j.call || {};
    const msg = j.msg || {};
    const reference = isoFrom(call.createdAt || msg.timestamp || j.savedAt, file);
    if (!inRange(reference, since, until)) continue;
    const messages = (((msg.artifact || {}).messages) || [])
      .filter((m) => m && m.role !== 'system' && m.message)
      .map((m) => `${m.role}: ${String(m.message).slice(0, 2000)}`)
      .join('\n');
    const body = [
      msg.analysis && msg.analysis.summary ? `Summary: ${msg.analysis.summary}` : '',
      messages,
    ].filter(Boolean).join('\n\n');
    out.push({
      source: 'vapi-call',
      source_id: call.id || j.id || path.basename(file, '.json'),
      name: `Vapi call: ${call.customer && call.customer.number ? call.customer.number : call.id || path.basename(file, '.json')}`,
      body: body || JSON.stringify({ type: call.type, status: call.status, analysis: msg.analysis || null }),
      reference_time: reference,
      observed_at: isoFrom(j.savedAt, file),
      raw_path: file,
      metadata: { call_type: call.type || null, status: call.status || null },
    });
  }
  return out;
}

function jsonlEvents(file, since, until, mapRecord) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = mapRecord(j, file);
    if (ev && inRange(ev.reference_time, since, until)) out.push(ev);
  }
  return out;
}

function telegramEvents(root, since, until) {
  return jsonlEvents(path.join(root, 'data', 'agent', 'telegram-inbound.jsonl'), since, until, (j, file) => ({
    source: j.source === 'vapi_inline_command' ? 'vapi-inline-command' : 'telegram-message',
    source_id: j.command_id || `${j.ts}:${String(j.prompt || j.text || '').slice(0, 20)}`,
    name: j.source === 'vapi_inline_command' ? 'Vapi inline command' : 'Telegram inbound',
    body: String(j.prompt || j.text || j.message || '').trim(),
    reference_time: isoFrom(j.ts, file),
    observed_at: isoFrom(j.ts, file),
    raw_path: file,
    metadata: { routing_type: j.routing_type || null, status: j.status || null },
  })).filter((ev) => ev.body);
}

function dispatchEvents(root, since, until) {
  const files = ['amy-dispatch-log.jsonl', 'dispatch-queue.jsonl', 'briefing-actions.jsonl'];
  return files.flatMap((name) =>
    jsonlEvents(path.join(root, 'data', 'agent', name), since, until, (j, file) => {
      const source = name === 'briefing-actions.jsonl' ? 'prompt' : 'dispatch';
      const reference = isoFrom(j.ts || j.processed_at || j.call_started_at, file);
      const sourceId =
        j.command_id ||
        (source === 'prompt' && j.itemRef
          ? `${j.itemRef}:${j.kind || 'action'}:${reference}`
          : j.itemRef) ||
        j.vapi_call_id ||
        j.id ||
        `${j.ts}:${name}`;
      return {
        source,
        source_id: sourceId,
        name: `Amy ${name.replace(/\.jsonl$/, '')}`,
        body: String(j.prompt || j.comment || j.call_summary || j.text || j.summary || JSON.stringify(j)).slice(0, 4000),
        reference_time: reference,
        observed_at: isoFrom(j.processed_at || j.ts, file),
        raw_path: file,
        metadata: { status: j.status || null, source_file: name },
      };
    }).filter((ev) => ev.body && ev.body.length >= 10),
  );
}

function sessionEvents(root, since, until, maxFiles = 250) {
  const out = [];
  const dir = path.join(root, 'data', 'sessions', 'raw');
  for (const file of walkFiles(dir)) {
    const st = safeStat(file);
    if (!st || st.size > 500000) continue;
    const reference = st.mtime.toISOString();
    if (!inRange(reference, since, until)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 4000);
    } catch {
      continue;
    }
    if (text.trim().length < 10) continue;
    out.push({
      source: file.toLowerCase().includes('codex') ? 'codex-session' : 'claude-session',
      source_id: path.relative(dir, file).replace(/[\\/]/g, ':'),
      name: `Session archive: ${path.basename(file)}`,
      body: text,
      reference_time: reference,
      observed_at: reference,
      raw_path: file,
    });
    if (out.length >= maxFiles) break;
  }
  return out;
}

function smsEvents(root, since, until, maxFiles = 500) {
  const out = [];
  const dir = path.join(root, 'data', 'sms', 'raw');
  for (const file of walkFiles(dir)) {
    const st = safeStat(file);
    if (!st || st.size > 100000) continue;
    const reference = st.mtime.toISOString();
    if (!inRange(reference, since, until)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 4000);
    } catch {
      continue;
    }
    if (text.trim().length < 10) continue;
    out.push({
      source: 'sms-inbound',
      source_id: path.relative(dir, file).replace(/[\\/]/g, ':'),
      name: `SMS archive: ${path.basename(path.dirname(file))}`,
      body: text,
      reference_time: reference,
      observed_at: reference,
      raw_path: file,
    });
    if (out.length >= maxFiles) break;
  }
  return out;
}

function collectSourceEvents(root, since, until, opts = {}) {
  const selected = new Set(opts.sources || ['gmail', 'linkedin', 'otter', 'vapi', 'telegram', 'dispatches', 'sessions', 'sms', 'voice-arc']);
  const events = [];
  if (selected.has('gmail')) events.push(...gmailEvents(root, since, until));
  if (selected.has('linkedin')) events.push(...linkedinEvents(root, since, until));
  if (selected.has('otter')) events.push(...otterEvents(root, since, until));
  if (selected.has('vapi')) events.push(...vapiEvents(root, since, until));
  if (selected.has('telegram')) events.push(...telegramEvents(root, since, until));
  if (selected.has('dispatches')) events.push(...dispatchEvents(root, since, until));
  if (selected.has('sessions')) events.push(...sessionEvents(root, since, until, opts.maxSessionFiles || 250));
  if (selected.has('sms')) events.push(...smsEvents(root, since, until, opts.maxSmsFiles || 500));
  if (selected.has('voice-arc')) events.push(...voiceArcEvents(root, since, until, opts));
  return events;
}

function rawCounts(root, since, until, opts = {}) {
  const events = collectSourceEvents(root, since, until, opts);
  const counts = {};
  for (const ev of events) counts[ev.source] = (counts[ev.source] || 0) + 1;
  return counts;
}

module.exports = {
  collectSourceEvents,
  dateKeys,
  dispatchEvents,
  gmailEvents,
  inRange,
  isoFrom,
  linkedinEvents,
  otterEvents,
  rawCounts,
  sessionEvents,
  smsEvents,
  telegramEvents,
  vapiEvents,
};
