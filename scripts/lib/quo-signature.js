'use strict';

const crypto = require('node:crypto');

const MAX_REPLAY_AGE_SECONDS = 300;

function singleHeader(headers, name) {
  const value = headers && (headers[name] ?? headers[name.toLowerCase()]);
  if (Array.isArray(value) || value == null || String(value).trim() === '') {
    throw new Error(`missing or repeated ${name}`);
  }
  return String(value).trim();
}

function signingKey(secret) {
  if (!secret || !String(secret).startsWith('whsec_')) throw new Error('missing or invalid Quo webhook key');
  const encoded = String(secret).slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (!encoded || key.length < 16 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('missing or invalid Quo webhook key');
  }
  return key;
}

function verifyQuoSignature({ headers, rawBody, secret, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = MAX_REPLAY_AGE_SECONDS }) {
  const id = singleHeader(headers, 'webhook-id');
  const timestampText = singleHeader(headers, 'webhook-timestamp');
  const signatureText = singleHeader(headers, 'webhook-signature');
  const timestamp = Number(timestampText);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > maxAgeSeconds) throw new Error('stale Quo webhook timestamp');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const expected = crypto.createHmac('sha256', signingKey(secret)).update(Buffer.from(`${id}.${timestampText}.`)).update(body).digest();
  const valid = signatureText.split(/\s+/).some((entry) => {
    if (!entry.startsWith('v1,')) return false;
    let candidate;
    try { candidate = Buffer.from(entry.slice(3), 'base64'); } catch { return false; }
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
  if (!valid) throw new Error('invalid Quo webhook signature');
  return { id, timestamp };
}

module.exports = { MAX_REPLAY_AGE_SECONDS, signingKey, verifyQuoSignature };
