'use strict';

// One server file, run as separate processes by role (Owner decision: "you
// can re-test calling once you split it out"). Phone calls used to share one
// process with the briefing, videos and chat, so a slow render could stall
// a live call and every deploy restarted the call path.
//
//   all    the old monolith: every route and timer. Listens on the main port
//          and the phone port, so the gateway's phone routes keep working with
//          the split turned off.
//   main   everything except calls. Phone paths it receives are forwarded to
//          the phone process; it starts no voice warm-up or call reconciler.
//   phone  phone paths and /health only, plus the voice startup work and the
//          two caches calls read (Voice provider assistant config, contacts). No
//          Chat polling, scheduler, briefing warmer or other timers.
//
// State the two processes share goes through files: the desktop command
// queue (a handoff file main drains), the desktop sync snapshot (phone reloads
// it), and the last voice provider webhook time (phone writes it, main's channel-health
// monitor reads it). The owner approval store was already a locked file.
const fs = require('fs');
const http = require('http');
const path = require('path');

const PHONE_PATH_RE = /^\/(vapi\/|amy\/call\/|amy\/voice\/|llm\/chat\/|v1\/chat\/|chat\/completions$)|\/outbound-call-control$/;
const ROLES = new Set(['all', 'main', 'phone']);
const MAIN_PORT = 3001;
const PHONE_PORT = 3002;
const FORWARDED_HEADER = 'x-sb-phone-forwarded-for';
const RECEIVED_HEADER = 'x-sb-phone-received-at';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function resolveServerRole(env = process.env) {
  const role = String(env.SB_SERVER_ROLE || 'all').trim().toLowerCase();
  if (!ROLES.has(role)) throw new Error(`SB_SERVER_ROLE must be one of ${[...ROLES].join(', ')}; got ${role}`);
  return role;
}

function phonePort(env = process.env) {
  const port = Number(env.SB_PHONE_PORT || PHONE_PORT);
  return Number.isInteger(port) && port > 0 && port !== MAIN_PORT ? port : PHONE_PORT;
}

function isPhonePath(urlPath) {
  return PHONE_PATH_RE.test(String(urlPath || ''));
}

// What a role does with one request: serve it here, forward it to the phone
// process, or refuse it.
function routeDecision(role, urlPath) {
  const phone = isPhonePath(urlPath);
  if (role === 'main' && phone) return 'forward';
  if (role === 'phone' && !phone && urlPath !== '/health') return 'refuse';
  return 'serve';
}

// Main hands a phone request to the phone process unread. One socket per
// request (no keep-alive), so the caller address set below never leaks to a
// later request on a reused connection. Phone down means 503, never a local
// fallback: phone state lives in one process.
function forwardToPhone(req, res, { port = phonePort(), request = http.request, receivedAtMs = Date.now() } = {}) {
  const headers = { ...req.headers, [FORWARDED_HEADER]: (req.socket && req.socket.remoteAddress) || '', [RECEIVED_HEADER]: String(receivedAtMs) };
  const upstream = request(
    { hostname: '127.0.0.1', port, path: req.url, method: req.method, headers, agent: false },
    (phoneRes) => {
      res.writeHead(phoneRes.statusCode || 502, phoneRes.headers);
      phoneRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    console.error('[server-role] phone process unreachable:', error.message);
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'phone process unavailable' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

// When EC2 received this request, in epoch ms: main's arrival time for a
// request main forwarded here, otherwise now. A voice turn's receipt starts
// from it, so time lost before the handler counts against EC2, not against
// Voice provider (Codex review f28f4468dedb). Only a loopback peer may set it, and it
// can only move the time earlier, which counts more of a turn against EC2.
function requestReceivedAt(req, { trustForwarded = false, now = Date.now() } = {}) {
  const claimed = req.headers && req.headers[RECEIVED_HEADER];
  if (claimed === undefined) return now;
  delete req.headers[RECEIVED_HEADER];
  const at = Number(claimed);
  const peer = req.socket && req.socket.remoteAddress;
  return trustForwarded && LOOPBACK.has(peer) && Number.isInteger(at) && at <= now && now - at < 60000 ? at : now;
}

// In the phone process a forwarded request carries the original caller's
// address. Only a loopback peer (main on this box) may set it, so an internet
// caller hitting the phone port directly cannot claim to be local.
function restoreForwardedRemote(req) {
  const claimed = req.headers && req.headers[FORWARDED_HEADER];
  const peer = req.socket && req.socket.remoteAddress;
  if (claimed === undefined) return;
  delete req.headers[FORWARDED_HEADER];
  if (!LOOPBACK.has(peer)) return;
  Object.defineProperty(req.socket, 'remoteAddress', { value: String(claimed), configurable: true });
}

// ── Desktop command queue handoff ─────────────────────────────────────────────
// The queue is one JSON file rewritten whole, so only main may own it. The
// phone process appends each new command to a handoff file; main claims the
// file by rename and merges the rows.
function handoffFile(dir) {
  return path.join(dir, 'phone-command-handoff.jsonl');
}

function appendCommandHandoff(dir, command) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(handoffFile(dir), JSON.stringify(command) + '\n');
}

// A main process that died holding a claim leaves `<file>.<pid>.claimed`, whose
// rows may never have been saved (Codex review 2b6a75dd8ff4). A live owner
// touches its claim on every drain (each second), so a claim is taken over once
// its owner is gone or it has gone untouched this long (a recycled pid).
const ABANDONED_CLAIM_MS = 2 * 60 * 1000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function adoptAbandonedClaim(file, claimed, nowMs) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.claimed')) continue;
    const pid = Number(name.slice(prefix.length, -'.claimed'.length));
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const other = path.join(dir, name);
    try {
      if (pidAlive(pid) && nowMs - fs.statSync(other).mtimeMs < ABANDONED_CLAIM_MS) continue;
      fs.renameSync(other, claimed);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

function drainCommandHandoff(dir, { settleMs = 50, nowMs = Date.now() } = {}) {
  const file = handoffFile(dir);
  const claimed = `${file}.${process.pid}.claimed`;
  if (!fs.existsSync(claimed)) {
    if (!fs.existsSync(dir)) return { rows: [], commit: () => {} };
    if (!adoptAbandonedClaim(file, claimed, nowMs)) {
      try {
        fs.renameSync(file, claimed);
      } catch (error) {
        if (error.code === 'ENOENT') return { rows: [], commit: () => {} };
        throw error;
      }
      // An append that opened the file just before the rename lands in the
      // claimed file; give it a moment before reading.
      const until = Date.now() + settleMs;
      while (Date.now() < until) { /* settle */ }
    }
  }
  // Best effort: a missed touch can only let another main process take a live
  // claim over, which the queue lock makes safe; it must never stall the merge.
  try {
    const touched = new Date(nowMs);
    fs.utimesSync(claimed, touched, touched);
  } catch {
    /* untouched */
  }
  const rows = [];
  for (const line of fs.readFileSync(claimed, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.id) rows.push(row);
    } catch {
      console.warn('[server-role] skipped a torn command handoff row');
    }
  }
  return { rows, commit: () => fs.rmSync(claimed, { force: true }) };
}

// ── Last voice provider webhook time ────────────────────────────────────────────────────
function webhookStampFile(dir) {
  return path.join(dir, 'vapi-last-webhook.json');
}

function createWebhookStamp(dir, { minIntervalMs = 15000, now = Date.now } = {}) {
  let lastWrite = 0;
  return (ts) => {
    if (ts - lastWrite < minIntervalMs) return;
    lastWrite = ts;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${webhookStampFile(dir)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: ts, written_at: now() }));
      fs.renameSync(tmp, webhookStampFile(dir));
    } catch (error) {
      console.warn('[server-role] webhook stamp write failed:', error.message);
    }
  };
}

function readWebhookStamp(dir) {
  try {
    const at = Number(JSON.parse(fs.readFileSync(webhookStampFile(dir), 'utf8')).at);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

module.exports = {
  FORWARDED_HEADER,
  MAIN_PORT,
  PHONE_PATH_RE,
  PHONE_PORT,
  RECEIVED_HEADER,
  appendCommandHandoff,
  createWebhookStamp,
  drainCommandHandoff,
  forwardToPhone,
  isPhonePath,
  phonePort,
  readWebhookStamp,
  requestReceivedAt,
  resolveServerRole,
  restoreForwardedRemote,
  routeDecision,
};
