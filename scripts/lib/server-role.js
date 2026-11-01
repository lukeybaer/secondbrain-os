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
function forwardToPhone(req, res, { port = phonePort(), request = http.request } = {}) {
  const headers = { ...req.headers, [FORWARDED_HEADER]: (req.socket && req.socket.remoteAddress) || '' };
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

function drainCommandHandoff(dir, { settleMs = 50 } = {}) {
  const file = handoffFile(dir);
  const claimed = `${file}.${process.pid}.claimed`;
  if (!fs.existsSync(claimed)) {
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
  appendCommandHandoff,
  createWebhookStamp,
  drainCommandHandoff,
  forwardToPhone,
  isPhonePath,
  phonePort,
  readWebhookStamp,
  resolveServerRole,
  restoreForwardedRemote,
  routeDecision,
};
