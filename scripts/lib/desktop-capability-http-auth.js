'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { relaySecret } = require('./desktop-capability-relay.js');

function bodyDigest(bodyText) {
  return crypto.createHash('sha256').update(String(bodyText || '')).digest('hex');
}

function canonicalHttpRequest({ timestamp, nonce, method, path, bodyText }) {
  return [timestamp, nonce, String(method || '').toUpperCase(), path, bodyDigest(bodyText)].join('\n');
}

function signDesktopHttpRequest(input, secret = relaySecret()) {
  return crypto.createHmac('sha256', secret).update(canonicalHttpRequest(input)).digest('hex');
}

function desktopHttpHeaders(
  { method, path, bodyText, now = Date.now(), nonce = crypto.randomUUID() } = {},
  secret = relaySecret(),
) {
  const timestamp = new Date(now).toISOString();
  return {
    'Content-Type': 'application/json',
    'X-Amy-Timestamp': timestamp,
    'X-Amy-Nonce': nonce,
    'X-Amy-Signature': signDesktopHttpRequest({ timestamp, nonce, method, path, bodyText }, secret),
  };
}

function writeNonceStore(file, seen) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(Object.fromEntries(seen))}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function createDesktopHttpVerifier({
  maxSkewMs = 5 * 60 * 1000,
  now = () => Date.now(),
  nonceStorePath = '',
} = {}) {
  const seen = new Map();
  let nonceStoreHealthy = true;
  if (nonceStorePath && fs.existsSync(nonceStorePath)) {
    try {
      for (const [nonce, expiresAt] of Object.entries(JSON.parse(fs.readFileSync(nonceStorePath, 'utf8')))) {
        if (Number(expiresAt) > now()) seen.set(nonce, Number(expiresAt));
      }
    } catch {
      nonceStoreHealthy = false;
    }
  }
  return function verify({ headers = {}, method, path, bodyText } = {}) {
    if (!nonceStoreHealthy) return { ok: false, reason: 'nonce-store-corrupt' };
    const timestamp = String(headers['x-amy-timestamp'] || '');
    const nonce = String(headers['x-amy-nonce'] || '');
    const actual = String(headers['x-amy-signature'] || '');
    const time = Date.parse(timestamp);
    if (!timestamp || !nonce || !actual || !Number.isFinite(time)) return { ok: false, reason: 'missing-auth' };
    const current = now();
    if (Math.abs(current - time) > maxSkewMs) return { ok: false, reason: 'stale-auth' };
    for (const [key, expiresAt] of seen) if (expiresAt <= current) seen.delete(key);
    if (seen.has(nonce)) return { ok: false, reason: 'replayed-auth' };
    let expected;
    try {
      expected = signDesktopHttpRequest({ timestamp, nonce, method, path, bodyText });
    } catch {
      return { ok: false, reason: 'not-configured' };
    }
    const valid =
      actual.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!valid) return { ok: false, reason: 'bad-signature' };
    seen.set(nonce, current + maxSkewMs);
    writeNonceStore(nonceStorePath, seen);
    return { ok: true };
  };
}

module.exports = {
  bodyDigest,
  canonicalHttpRequest,
  createDesktopHttpVerifier,
  desktopHttpHeaders,
  signDesktopHttpRequest,
  writeNonceStore,
};
