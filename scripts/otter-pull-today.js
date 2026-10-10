#!/usr/bin/env node
// One-shot: pull Otter speeches in a date range (default: today CT)
// and write transcripts + meta.json under
// %APPDATA%\secondbrain\data\conversations\otter_<id>\ for the date(s) you ask for.
//
// Usage:
//   node otter-pull-today.js              # today (CT)
//   node otter-pull-today.js 2026-05-28   # specific date (CT)
//   node otter-pull-today.js 2026-05-27 2026-05-28
//
// Matches the conventions in src/main/otter.ts and src/main/otter-ingest.ts so the
// rest of the SecondBrain pipeline picks the new files up on next refresh.
'use strict';
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://otter.ai/forward/api/v1';
const APPDATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const CONFIG_FILE = path.join(APPDATA, 'secondbrain', 'config.json');
const CONV_DIR = path.join(APPDATA, 'secondbrain', 'data', 'conversations');
const RAW_DIR = path.resolve(__dirname, '..', 'data', 'otter', 'raw');

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
let sessionCookies = cfg.otterSessionCookie || null;
let userId = cfg.otterUserId || null;

function parseCookies(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  if (raw.length === 0) {
    const single = headers.get('set-cookie');
    if (single) raw.push(...single.split(/,(?=[^ ])/));
  }
  return raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}
function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const pair of [...existing.split('; '), ...incoming.split('; ')]) {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function otterFetch(p, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${p}${qs ? '?' + qs : ''}`;
  const headers = {
    // Otter's API silently hangs without a browser User-Agent; an unbounded fetch
    // then wedges the pull forever. ExampleCo 2026-06-28 otter-hang #gap.
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'x-origin': 'https://otter.ai',
    Referer: 'https://otter.ai/',
  };
  if (sessionCookies) headers.Cookie = sessionCookies;
  const ac = new AbortController();
  const fetchTimeout = setTimeout(
    () => ac.abort(),
    Number(process.env.OTTER_FETCH_TIMEOUT_MS || 20000),
  );
  let res;
  try {
    res = await fetch(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(fetchTimeout);
  }
  const newC = parseCookies(res.headers);
  if (newC) sessionCookies = sessionCookies ? mergeCookies(sessionCookies, newC) : newC;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Otter ${res.status} ${p}: ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
async function login() {
  if (sessionCookies && userId) {
    // verify
    try { await otterFetch('/groups'); return; } catch {}
  }
  if (!cfg.otterEmail || !cfg.otterPassword) throw new Error('No otter creds');
  const credentials = Buffer.from(`${cfg.otterEmail}:${cfg.otterPassword}`).toString('base64');
  const res = await fetch(`${BASE_URL}/login?username=${encodeURIComponent(cfg.otterEmail)}`, {
    headers: { Authorization: `Basic ${credentials}`, 'x-origin': 'https://otter.ai', Referer: 'https://otter.ai/' },
  });
  const c = parseCookies(res.headers);
  if (c) sessionCookies = c;
  if (!res.ok) throw new Error(`Login ${res.status}`);
  const data = await res.json();
  userId = String(data.userid || data.user_id);
}

function ymd(d, tz = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function speechCreatedDateCT(s) {
  const t = s.created_at || s.start_time || s.modified_time;
  if (!t) return '';
  // Otter uses epoch seconds; if it's <10^12 treat as seconds
  const ms = Number(t) > 1e12 ? Number(t) : Number(t) * 1000;
  return ymd(new Date(ms));
}
function speechId(s) { return s.otid || s.id || s.speech_id; }
function speechTitle(s) { return s.title || 'Untitled'; }
function slug(s) { return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }

function transcriptFromSpeech(speech) {
  // Replicate normalizeSpeech transcript build from otter.ts
  if (typeof speech.transcript === 'string' && speech.transcript.length > 20) return speech.transcript;
  const trans = speech.transcripts || speech.transcript_segments || [];
  if (Array.isArray(trans) && trans.length) {
    return trans.map((t) => {
      const speaker = (t.speaker && (t.speaker.speaker_name || t.speaker.name)) || (t.speaker_name || '');
      const text = t.transcript || t.text || '';
      return speaker ? `${speaker}: ${text}` : text;
    }).filter(Boolean).join('\n');
  }
  return speech.summary || '';
}
function speakersFromSpeech(speech) {
  const seen = new Set();
  const trans = speech.transcripts || speech.transcript_segments || [];
  for (const t of trans) {
    const n = (t.speaker && (t.speaker.speaker_name || t.speaker.name)) || t.speaker_name;
    if (n) seen.add(n);
  }
  return [...seen];
}

async function getSpeechFull(otid) {
  const data = await otterFetch('/speech', { userid: userId, otid });
  return data.speech || data;
}

async function listForDates(dates) {
  const want = new Set(dates);
  const PAGE = 20;
  let lastLoadTs = null;
  let firstDone = false;
  let matched = [];
  let pages = 0;
  while (true) {
    const params = { userid: userId, page_size: String(firstDone ? PAGE : 1) };
    if (lastLoadTs !== null) { params.last_load_ts = lastLoadTs; params.modified_after = '1'; }
    const data = await otterFetch('/speeches', params);
    const raw = data.speeches || data.data || [];
    if (raw.length === 0) break;
    for (const s of raw) {
      const d = speechCreatedDateCT(s);
      if (want.has(d)) matched.push(s);
    }
    pages++;
    process.stderr.write(`page ${pages}: got ${raw.length}, matches so far ${matched.length}, latest=${speechCreatedDateCT(raw[0])} oldest=${speechCreatedDateCT(raw[raw.length-1])}\n`);
    if (data.end_of_list) break;
    if (raw.length < (firstDone ? PAGE : 1)) break;
    const oldest = speechCreatedDateCT(raw[raw.length - 1]);
    if (oldest && oldest < [...want].sort()[0]) {
      process.stderr.write(`Past oldest wanted date (${oldest} < ${[...want].sort()[0]}), stopping.\n`);
      break;
    }
    lastLoadTs = data.last_load_ts || raw[raw.length - 1]?.last_modified_at || raw[raw.length - 1]?.created_at;
    firstDone = true;
    if (pages > 60) break; // safety
  }
  return matched;
}

function writeConversation(speech) {
  const id = speechId(speech);
  if (!id) return null;
  const outDir = path.join(CONV_DIR, `otter_${id}`);
  fs.mkdirSync(outDir, { recursive: true });
  const transcript = transcriptFromSpeech(speech);
  fs.writeFileSync(path.join(outDir, 'transcript.txt'), transcript, 'utf8');
  const meta = {
    id: `otter_${id}`,
    otterId: id,
    title: speechTitle(speech),
    date: speechCreatedDateCT(speech),
    durationMinutes: Math.round((Number(speech.duration) || 0) / 60),
    speakers: speakersFromSpeech(speech),
    transcriptFile: 'transcript.txt',
    pulledAt: new Date().toISOString(),
    // raw passthroughs for the tagger
    summary: speech.summary || '',
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  // mirror into data/otter/raw so otter-query.js can find it.
  // The raw file stores the BARE otid (consistent with otter-ingest-watch),
  // so downstream otid derivation and the Otter /speech API call do not get a
  // stray "otter_" prefix. The conversations meta.json keeps its prefixed id.
  // F5: include a short otid suffix so two same-day speeches with the same or
  // blank ("Untitled") title cannot overwrite each other (raw-archival data
  // loss). The otid is globally unique; the date+slug stays for readability.
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const otidSuffix = String(id).replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  const rawName = `${meta.date}-${slug(meta.title)}-${otidSuffix}.json`;
  fs.writeFileSync(path.join(RAW_DIR, rawName), JSON.stringify({ ...meta, id, otterId: id, transcript, raw: speech }, null, 2), 'utf8');
  return { outDir, rawName, meta };
}

(async () => {
  const args = process.argv.slice(2);
  const dates = args.length ? args : [ymd(new Date())];
  process.stderr.write(`Pulling Otter speeches for: ${dates.join(', ')}\n`);
  await login();
  process.stderr.write(`Logged in as userId=${userId}\n`);
  const speeches = await listForDates(dates);
  process.stderr.write(`Matched ${speeches.length} speeches\n`);
  const out = [];
  for (const s of speeches) {
    const id = speechId(s);
    const full = await getSpeechFull(id);
    const res = writeConversation(full);
    if (res) {
      out.push({ id, title: res.meta.title, date: res.meta.date, durationMinutes: res.meta.durationMinutes, speakers: res.meta.speakers, dir: res.outDir, raw: res.rawName });
    }
  }
  process.stdout.write(JSON.stringify({ count: out.length, items: out }, null, 2) + '\n');
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(2); });
