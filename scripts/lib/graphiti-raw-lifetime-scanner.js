const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAW_LIFETIME_SOURCES = [
  'archive-lifetime-gmail',
  'archive-lifetime-sms',
  'archive-lifetime-otter',
  'archive-lifetime-vapi',
  'archive-lifetime-linkedin',
  'archive-lifetime-linkedin-dm',
  'archive-lifetime-whatsapp',
  'archive-lifetime-codex-session',
  'archive-lifetime-claude-session',
  'archive-lifetime-dispatch',
  'archive-lifetime-generic-file',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file, maxChars = 12000) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxChars * 4, fs.statSync(file).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function hash(value, len = 24) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

function normalizeIso(value, fallbackFile) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = value > 100000000000 ? value : value * 1000;
    const d = new Date(n);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (/^\d{10}(?:\.\d+)?$/.test(s)) {
      const d = new Date(Number(s) * 1000);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    if (/^\d{13}$/.test(s)) {
      const d = new Date(Number(s));
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    const d = new Date(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2'));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  const st = fallbackFile ? safeStat(fallbackFile) : null;
  return (st ? st.mtime : new Date()).toISOString();
}

function dateFromPath(file) {
  const p = file.replace(/\\/g, '/');
  let m = p.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T12:00:00Z`;
  m = p.match(/(\d{4})-(\d{2})-(\d{2})[ _](\d{2})[ _](\d{2})[ _](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return null;
}

function inRange(iso, since, until) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return false;
  return ms >= Date.parse(since) && ms <= Date.parse(until);
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
      } else {
        const lower = entry.name.toLowerCase();
        if (!opts.exts || opts.exts.some((ext) => lower.endsWith(ext))) yield p;
      }
    }
  }
}

function compact(text, max = 9000) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 38).trim()} ... [truncated for Graphiti]`;
}

function event(source, sourceId, name, body, referenceTime, rawPath, metadata = {}) {
  return {
    source,
    source_id: sourceId,
    source_description: `${source}:${sourceId}`,
    name: String(name || `${source}:${sourceId}`).slice(0, 180),
    body,
    reference_time: referenceTime,
    observed_at: normalizeIso(metadata.observed_at || metadata.captured_at || metadata.indexed_at, rawPath),
    raw_path: rawPath,
    contact_name: metadata.contact_name || metadata.author || null,
    direction: metadata.direction || null,
    priority: metadata.priority || 'normal',
    metadata,
  };
}

function gmailEvents(root, since, until) {
  const script = path.join(root, 'scripts', 'graphiti-gmail-raw-export.py');
  if (!fs.existsSync(script)) return gmailEventsJs(root, since, until);
  const py = process.env.PYTHON || 'python';
  const r = spawnSync(py, [script, '--root', root, '--since', since, '--until', until], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: 3600000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`gmail lifetime export failed: ${r.error ? r.error.message : (r.stderr || '').slice(0, 500)}`);
  }
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function gmailEventsJs(root, since, until) {
  const out = [];
  const base = path.join(root, 'data', 'gmail', 'raw');
  for (const file of walkFiles(base, { exts: ['message.json'] })) {
    const msg = readJson(file);
    if (!msg) continue;
    const reference = normalizeIso(msg.date || dateFromPath(file) || msg.archived_at, file);
    if (!inRange(reference, since, until)) continue;
    const dir = path.dirname(file);
    const id = String(msg.gmail_message_hex || msg.message_id || msg.id || path.basename(dir));
    const from = msg.from || '';
    const direction = /ExampleCo\.d\.ExampleCo|ExampleCo\.ExampleCo|@ExampleCogroup\.com/i.test(from) ? 'outbound' : 'inbound';
    const body = [
      'Gmail message',
      `From: ${from}`,
      `To: ${msg.to || ''}`,
      msg.cc ? `Cc: ${msg.cc}` : '',
      `Subject: ${msg.subject || '(no subject)'}`,
      msg.gmail_url ? `Gmail URL: ${msg.gmail_url}` : '',
      '',
      compact(msg.body || '(body empty in message.json; raw.eml remains the provenance source)', 9000),
    ].filter(Boolean).join('\n');
    out.push(event('archive-lifetime-gmail', id, `Gmail lifetime: ${msg.subject || '(no subject)'}`, body, reference, file, {
      archive_source: 'gmail',
      gmail_message_hex: msg.gmail_message_hex || null,
      thread_hex: msg.thread_hex || null,
      message_id: msg.message_id || null,
      gmail_url: msg.gmail_url || null,
      author: from,
      recipients: msg.to || '',
      attachment_count: Array.isArray(msg.attachments) ? msg.attachments.length : 0,
      direction,
      captured_at: msg.archived_at || null,
    }));
  }
  return out;
}

function gmailCount(root, since, until) {
  const script = path.join(root, 'scripts', 'graphiti-gmail-raw-export.py');
  if (!fs.existsSync(script)) return 0;
  const py = process.env.PYTHON || 'python';
  const r = spawnSync(py, [script, '--root', root, '--since', since, '--until', until, '--count-only'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 600000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return 0;
  try {
    return Number(JSON.parse((r.stdout || '').trim())['archive-lifetime-gmail'] || 0);
  } catch {
    return 0;
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function smsEvents(root, since, until) {
  const out = [];
  const base = path.join(root, 'data', 'sms', 'raw');
  for (const file of walkFiles(base, { exts: ['.csv'] })) {
    const text = readText(file, 50 * 1024 * 1024);
    if (!text.trim()) continue;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const headers = parseCsvLine(lines[0]).map((h) => h.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = cells[idx] || ''; });
      const reference = normalizeIso(row['Message Date'], file);
      if (!inRange(reference, since, until)) continue;
      const textBody = row.Text || row.Attachment || '';
      if (!textBody.trim()) continue;
      const sourceId = hash([
        path.relative(base, file),
        i,
        row['Message Date'],
        row['Sender ID'],
        row.Type,
        textBody,
      ].join('|'));
      const body = [
        `SMS/iMessage row`,
        `Chat: ${row['Chat Session'] || ''}`,
        `Message date: ${row['Message Date'] || ''}`,
        `Service/type: ${row.Service || ''} ${row.Type || ''}`,
        `Sender: ${row['Sender Name'] || row['Sender ID'] || ''}`,
        row.Status ? `Status: ${row.Status}` : '',
        '',
        compact(textBody, 4000),
      ].filter(Boolean).join('\n');
      out.push(event('archive-lifetime-sms', sourceId, `SMS lifetime: ${row['Chat Session'] || row['Sender ID'] || sourceId}`, body, reference, file, {
        archive_source: 'sms',
        row_number: i,
        chat_session: row['Chat Session'] || null,
        sender_id: row['Sender ID'] || null,
        sender_name: row['Sender Name'] || null,
        service: row.Service || null,
        message_type: row.Type || null,
        attachment: row.Attachment || null,
        direction: /incoming/i.test(row.Type || '') ? 'inbound' : /outgoing/i.test(row.Type || '') ? 'outbound' : null,
      }));
    }
  }
  return out;
}

function otterEvents(root, since, until) {
  const out = [];
  const seen = new Set();
  const dirs = [path.join(root, 'data', 'otter', 'raw')];
  for (const dir of dirs) {
    for (const file of walkFiles(dir, { exts: ['.json'] })) {
      const j = readJson(file);
      if (!j) continue;
      const id = String(j.otid || j.otterId || j.id || path.basename(file, '.json'));
      if (seen.has(id)) continue;
      seen.add(id);
      const reference = normalizeIso(j.start_time || j.created_at || j.date || j.ingested_at, file);
      if (!inRange(reference, since, until)) continue;
      const body = [
        `Otter transcript`,
        `Title: ${j.title || id}`,
        `Otter id: ${id}`,
        j.summary ? `Summary: ${j.summary}` : '',
        '',
        compact(j.transcript || JSON.stringify(j.raw || {}), 12000),
      ].filter(Boolean).join('\n');
      out.push(event('archive-lifetime-otter', id, `Otter lifetime: ${j.title || id}`, body, reference, file, {
        archive_source: 'otter',
        otid: id,
        duration_sec: j.duration_sec || j.durationSeconds || null,
        segment_count: Array.isArray(j.segments) ? j.segments.length : null,
        captured_at: j.ingested_at || j.pulledAt || null,
      }));
    }
  }
  return out;
}

function vapiBody(j) {
  const call = j.callObj || j.call || j;
  const msg = j.msg || {};
  const transcript = msg.transcript || j.transcript || call.transcript || '';
  const summary = (msg.analysis && msg.analysis.summary) || j.summary || call.summary || '';
  const messages = Array.isArray(msg.messages)
    ? msg.messages.filter((m) => m && m.role !== 'system' && m.message).map((m) => `${m.role}: ${m.message}`).join('\n')
    : '';
  return [`Vapi/Amy call`, summary ? `Summary: ${summary}` : '', '', compact(transcript || messages || JSON.stringify(j), 12000)]
    .filter(Boolean)
    .join('\n');
}

function vapiEvents(root, since, until) {
  const candidates = [];
  for (const dir of [path.join(root, 'data', 'vapi', 'raw'), path.join(root, 'data', 'sessions', 'raw', 'vapi')]) {
    for (const file of walkFiles(dir, { exts: ['.json'] })) {
      const j = readJson(file);
      if (!j) continue;
      const call = j.callObj || j.call || j;
      const msg = j.msg || {};
      const id = String(call.id || j.id || msg.callId || path.basename(file, '.json'));
      const reference = normalizeIso(call.startedAt || msg.startedAt || call.createdAt || j.createdAt || j.savedAt, file);
      candidates.push({ id, reference, file, j });
    }
  }
  const byId = new Map();
  for (const c of candidates) {
    const prev = byId.get(c.id);
    if (!prev || c.file.includes(`${path.sep}data${path.sep}vapi${path.sep}raw${path.sep}`)) byId.set(c.id, c);
  }
  const out = [];
  for (const c of byId.values()) {
    if (!inRange(c.reference, since, until)) continue;
    const call = c.j.callObj || c.j.call || c.j;
    out.push(event('archive-lifetime-vapi', c.id, `Vapi lifetime: ${call.customer && call.customer.number ? call.customer.number : c.id}`, vapiBody(c.j), c.reference, c.file, {
      archive_source: 'vapi',
      call_id: c.id,
      phone_number: call.customer && call.customer.number ? call.customer.number : c.j.phoneNumber || null,
      status: call.status || c.j.status || null,
      captured_at: c.j.savedAt || null,
    }));
  }
  return out;
}

function linkedinEvents(root, since, until) {
  const out = [];
  for (const file of walkFiles(path.join(root, 'data', 'linkedin', 'raw'), { exts: ['.json'] })) {
    const j = readJson(file);
    if (!j) continue;
    const reference = normalizeIso(j.scanned_at || j.timestamp, file);
    if (!inRange(reference, since, until)) continue;
    const id = String(j.id || path.basename(file, '.json'));
    const body = [
      `LinkedIn profile/posts scan`,
      `Contact: ${j.contact_name || ''}`,
      j.contact_url ? `URL: ${j.contact_url}` : '',
      `Category: ${j.category || ''}`,
      '',
      compact(j.body || JSON.stringify(j.recent_posts || []), 9000),
    ].filter(Boolean).join('\n');
    out.push(event('archive-lifetime-linkedin', id, `LinkedIn lifetime: ${j.contact_name || id}`, body, reference, file, {
      archive_source: 'linkedin',
      contact_name: j.contact_name || null,
      contact_url: j.contact_url || null,
      category: j.category || null,
      captured_at: j.scanned_at || null,
    }));
  }

  for (const file of walkFiles(path.join(root, 'data', 'sessions', 'raw', 'linkedin'), { exts: ['.json'] })) {
    const j = readJson(file);
    const reference = normalizeIso(j && (j.lastCrawl || j.scanned_at || j.timestamp), file);
    if (!j || !inRange(reference, since, until)) continue;
    const threads = Array.isArray(j.threads) ? j.threads : Array.isArray(j) ? j : [j];
    threads.forEach((thread, idx) => {
      const name = thread.name || thread.contact_name || thread.title || `thread-${idx}`;
      const sourceId = hash(`${file}:${idx}:${name}:${thread.snippet || thread.text || ''}`);
      out.push(event('archive-lifetime-linkedin-dm', sourceId, `LinkedIn DM lifetime: ${name}`, compact(JSON.stringify(thread), 9000), reference, file, {
        archive_source: 'linkedin-dm',
        contact_name: name,
        captured_at: j.lastCrawl || null,
      }));
    });
  }
  return out;
}

function whatsappEvents(root, since, until) {
  const out = [];
  const base = path.join(root, 'data', 'sessions', 'raw', 'whatsapp-conversation');
  for (const file of walkFiles(base, { exts: ['.txt'] })) {
    const reference = normalizeIso(dateFromPath(file), file);
    if (!inRange(reference, since, until)) continue;
    const body = compact(readText(file, 15000), 12000);
    if (!body) continue;
    const sourceId = hash(path.relative(base, file));
    out.push(event('archive-lifetime-whatsapp', sourceId, `WhatsApp/conversation lifetime: ${path.basename(file)}`, body, reference, file, {
      archive_source: 'whatsapp',
      source_kind: 'conversation-transcript-copy',
    }));
  }
  return out;
}

function sessionIdentity(file, text, fallbackPrefix) {
  const firstLines = text.split(/\r?\n/).slice(0, 20);
  let firstTs = null;
  let sessionId = null;
  const pieces = [];
  for (const line of firstLines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      firstTs = firstTs || j.timestamp || (j.payload && j.payload.timestamp) || j.created_at || null;
      sessionId = sessionId || j.sessionId || (j.payload && j.payload.id) || null;
      pieces.push(JSON.stringify(j).slice(0, 1200));
    } catch {
      pieces.push(line.slice(0, 1200));
    }
  }
  return {
    sessionId: sessionId || hash(`${fallbackPrefix}:${file}`),
    firstTs,
    body: pieces.join('\n'),
  };
}

function sessionEvents(root, since, until) {
  const out = [];
  const seen = new Set();
  const codexDirs = [
    path.join(root, 'data', 'sessions', 'raw', 'codex'),
    path.join(process.env.USERPROFILE || '', '.codex', 'sessions'),
  ];
  for (const dir of codexDirs) {
    for (const file of walkFiles(dir, { exts: ['.jsonl'] })) {
      const text = readText(file, 6000);
      const info = sessionIdentity(file, text, 'codex');
      if (seen.has(`codex:${info.sessionId}`)) continue;
      seen.add(`codex:${info.sessionId}`);
      const reference = normalizeIso(info.firstTs || dateFromPath(file), file);
      if (!inRange(reference, since, until)) continue;
      out.push(event('archive-lifetime-codex-session', info.sessionId, `Codex session lifetime: ${info.sessionId}`, compact(info.body || text, 6000), reference, file, {
        archive_source: 'codex',
        session_id: info.sessionId,
      }));
    }
  }

  const claudeDirs = [
    path.join(root, 'data', 'sessions', 'raw', 'claude-code'),
    path.join(root, 'data', 'sessions', 'raw', 'claude-code-mirror'),
    path.join(process.env.USERPROFILE || '', '.claude', 'projects'),
  ];
  for (const dir of claudeDirs) {
    for (const file of walkFiles(dir, { exts: ['.jsonl'] })) {
      const text = readText(file, 6000);
      const info = sessionIdentity(file, text, 'claude');
      if (seen.has(`claude:${info.sessionId}`)) continue;
      seen.add(`claude:${info.sessionId}`);
      const reference = normalizeIso(info.firstTs || dateFromPath(file), file);
      if (!inRange(reference, since, until)) continue;
      out.push(event('archive-lifetime-claude-session', info.sessionId, `Claude Code session lifetime: ${info.sessionId}`, compact(info.body || text, 6000), reference, file, {
        archive_source: 'claude-code',
        session_id: info.sessionId,
      }));
    }
  }
  return out;
}

function dispatchEvents(root, since, until) {
  const out = [];
  const base = path.join(root, 'data', 'agent');
  for (const name of ['dispatch-queue.jsonl', 'amy-dispatch-log.jsonl', 'dispatch-resolutions.jsonl', 'briefing-actions.jsonl']) {
    const file = path.join(base, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (!line.trim()) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const reference = normalizeIso(j.ts || j.processed_at || j.date || j.created_at, file);
      if (!inRange(reference, since, until)) return;
      const sourceId = j.id || j.command_id || j.itemRef || hash(`${name}:${idx}:${line}`);
      out.push(event('archive-lifetime-dispatch', String(sourceId), `Dispatch lifetime: ${name}`, compact(JSON.stringify(j), 9000), reference, file, {
        archive_source: 'dispatch',
        source_file: name,
        row_number: idx + 1,
        status: j.status || null,
      }));
    });
  }
  return out;
}

function genericFileEvents(root, since, until, maxFiles = 5000) {
  const out = [];
  let count = 0;
  for (const dir of [path.join(root, 'data', 'sessions', 'raw', 'generic'), path.join(root, 'data', 'sessions', 'raw', 'cursor')]) {
    for (const file of walkFiles(dir, { exts: ['.json', '.md', '.txt'] })) {
      if (count >= maxFiles) break;
      const reference = normalizeIso(dateFromPath(file), file);
      if (!inRange(reference, since, until)) continue;
      const body = compact(readText(file, 12000), 9000);
      if (!body || body.length < 10) continue;
      count++;
      out.push(event('archive-lifetime-generic-file', hash(path.relative(root, file)), `Generic archive lifetime: ${path.basename(file)}`, body, reference, file, {
        archive_source: 'generic',
      }));
    }
  }
  return out;
}

function rawLifetimeEvents(root, since, until, opts = {}) {
  const selected = new Set(opts.sources || [
    'gmail',
    'sms',
    'otter',
    'vapi',
    'linkedin',
    'whatsapp',
    'sessions',
    'dispatches',
    'generic',
  ]);
  const out = [];
  if (selected.has('gmail')) out.push(...gmailEvents(root, since, until));
  if (selected.has('sms')) out.push(...smsEvents(root, since, until));
  if (selected.has('otter')) out.push(...otterEvents(root, since, until));
  if (selected.has('vapi')) out.push(...vapiEvents(root, since, until));
  if (selected.has('linkedin')) out.push(...linkedinEvents(root, since, until));
  if (selected.has('whatsapp')) out.push(...whatsappEvents(root, since, until));
  if (selected.has('sessions')) out.push(...sessionEvents(root, since, until));
  if (selected.has('dispatches')) out.push(...dispatchEvents(root, since, until));
  if (selected.has('generic')) out.push(...genericFileEvents(root, since, until, opts.maxGenericFiles || 5000));
  return out;
}

function rawLifetimeCounts(root, since, until, opts = {}) {
  if (!opts.exact) return rawLifetimeFastCounts(root, since, until);
  const counts = {};
  for (const ev of rawLifetimeEvents(root, since, until, opts)) {
    counts[ev.source] = (counts[ev.source] || 0) + 1;
  }
  return counts;
}

function countJsonFilesInRange(dir, since, until, timeFn) {
  let count = 0;
  for (const file of walkFiles(dir, { exts: ['.json'] })) {
    const j = readJson(file);
    if (!j) continue;
    const reference = normalizeIso(timeFn(j, file), file);
    if (inRange(reference, since, until)) count++;
  }
  return count;
}

function countLinesInJsonl(file, since, until, timeFields = ['ts', 'processed_at', 'date', 'created_at']) {
  if (!fs.existsSync(file)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const reference = normalizeIso(timeFields.map((f) => j[f]).find(Boolean), file);
    if (inRange(reference, since, until)) count++;
  }
  return count;
}

function rawLifetimeFastCounts(root, since, until) {
  const counts = {};
  counts['archive-lifetime-gmail'] = gmailCount(root, since, until);
  counts['archive-lifetime-otter'] = countJsonFilesInRange(
    path.join(root, 'data', 'otter', 'raw'),
    since,
    until,
    (j) => j.start_time || j.created_at || j.date || j.ingested_at,
  );
  counts['archive-lifetime-vapi'] = new Set([
    ...vapiEvents(root, since, until).map((ev) => ev.source_id),
  ]).size;
  counts['archive-lifetime-linkedin'] = countJsonFilesInRange(
    path.join(root, 'data', 'linkedin', 'raw'),
    since,
    until,
    (j) => j.scanned_at || j.timestamp,
  );
  counts['archive-lifetime-linkedin-dm'] = linkedinEvents(root, since, until).filter((ev) => ev.source === 'archive-lifetime-linkedin-dm').length;
  counts['archive-lifetime-whatsapp'] = whatsappEvents(root, since, until).length;
  const sessions = sessionEvents(root, since, until);
  counts['archive-lifetime-codex-session'] = sessions.filter((ev) => ev.source === 'archive-lifetime-codex-session').length;
  counts['archive-lifetime-claude-session'] = sessions.filter((ev) => ev.source === 'archive-lifetime-claude-session').length;
  counts['archive-lifetime-dispatch'] = ['dispatch-queue.jsonl', 'amy-dispatch-log.jsonl', 'dispatch-resolutions.jsonl', 'briefing-actions.jsonl']
    .reduce((sum, name) => sum + countLinesInJsonl(path.join(root, 'data', 'agent', name), since, until), 0);
  counts['archive-lifetime-generic-file'] = genericFileEvents(root, since, until).length;
  counts['archive-lifetime-sms'] = smsEvents(root, since, until).length;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

module.exports = {
  RAW_LIFETIME_SOURCES,
  gmailEvents,
  normalizeIso,
  rawLifetimeCounts,
  rawLifetimeEvents,
  smsEvents,
};
