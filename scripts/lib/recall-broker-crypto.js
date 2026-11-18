'use strict';
// Shared AES-256-GCM envelope for the Recall Broker read path.
// Both sides (PC hook and EC2 /amy/memory/query route) hold the same secret;
// possession of the key IS the authentication, GCM gives integrity, and the
// embedded timestamp plus caller-supplied replay check stop replays. App-layer
// encryption because the public listener is plain HTTP and memory content must
// not cross the wire readable.

const crypto = require('crypto');

const VERSION = 1;
const TS_WINDOW_MS = 5 * 60 * 1000;

function deriveKey(secret) {
  const s = String(secret || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  // A short or empty secret (misconfigured env var) must fail closed, never
  // silently become a guessable sha256('') key (Codex review 2026-07-06 #6).
  if (s.length < 32) throw new Error('recall-broker secret too short (need 64-char hex or >=32 chars)');
  return crypto.createHash('sha256').update(s).digest();
}

function seal(key, payload) {
  const nonce = crypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ ts: Date.now(), payload }), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: VERSION, n: nonce.toString('base64'), c: enc.toString('base64') };
}

// opts.replayCheck(nonceB64) returns true if the nonce was already seen.
// opts.now for tests. Returns { ok, payload?, ts?, reason? }; never throws.
function open(key, envelope, opts = {}) {
  try {
    if (!envelope || envelope.v !== VERSION || typeof envelope.n !== 'string' || typeof envelope.c !== 'string') {
      return { ok: false, reason: 'shape' };
    }
    const nonce = Buffer.from(envelope.n, 'base64');
    const data = Buffer.from(envelope.c, 'base64');
    if (nonce.length !== 12 || data.length < 17) return { ok: false, reason: 'shape' };
    const tag = data.subarray(data.length - 16);
    const enc = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    const { ts, payload } = JSON.parse(plaintext);
    const now = opts.now || Date.now();
    if (typeof ts !== 'number' || Math.abs(now - ts) > TS_WINDOW_MS) return { ok: false, reason: 'stale' };
    if (opts.replayCheck && opts.replayCheck(envelope.n)) return { ok: false, reason: 'replay' };
    return { ok: true, payload, ts };
  } catch {
    return { ok: false, reason: 'decrypt' };
  }
}

// Bounded body reader: rejects with err.code='BODY_TOO_LARGE' past maxBytes so
// routes can 413 instead of buffering unbounded input.
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) {
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// In-memory nonce replay cache with TTL pruning; returns a replayCheck fn.
function makeReplayCache(ttlMs = TS_WINDOW_MS * 2, maxEntries = 5000) {
  const seen = new Map();
  return function replayCheck(nonceB64) {
    const now = Date.now();
    if (seen.size > maxEntries || seen.size % 500 === 0) {
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    }
    if (seen.has(nonceB64)) return true;
    seen.set(nonceB64, now + ttlMs);
    return false;
  };
}

module.exports = { VERSION, TS_WINDOW_MS, deriveKey, seal, open, readBodyCapped, makeReplayCache };
