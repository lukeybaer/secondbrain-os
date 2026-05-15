// webhook-verify.ts — HMAC / shared-secret verification for inbound webhooks.
//
// Each provider has its own scheme:
//   Twilio   — HMAC-SHA1 over (URL + sortedConcatPostParams), base64, header X-Twilio-Signature
//   Vapi     — HMAC-SHA256 over "<timestamp>.<rawBody>", hex, header X-Vapi-Signature + X-Vapi-Timestamp
//   Telegram — static secret token, header X-Telegram-Bot-Api-Secret-Token (no HMAC; Telegram does not sign payloads)
//
// All comparisons use crypto.timingSafeEqual to avoid timing oracles. Verifiers return
// a discriminated result; callers decide how to respond (401 + log is the convention).

import * as crypto from 'crypto';
import type * as http from 'http';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const REPLAY_WINDOW_SECONDS = 5 * 60;

function timingSafeEqualStr(a: string, b: string): boolean {
  // timingSafeEqual throws if lengths differ — pad to equal length but still fail.
  // We compare byte buffers; if lengths differ the result is unconditionally false.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ── Twilio ───────────────────────────────────────────────────────────────────
// Twilio signs `URL + concat(sortedKey + sortedValue)` with the account auth token.
// For form-urlencoded POSTs, the params are the decoded POST fields.
// Reference: https://www.twilio.com/docs/usage/webhook-security
export function verifyTwilioSignature(opts: {
  authToken: string;
  fullUrl: string; // The exact URL Twilio called, including query string
  params: Record<string, string>; // Decoded form-urlencoded POST params
  signatureHeader: string | null;
}): VerifyResult {
  if (!opts.authToken) return { ok: false, reason: 'twilio auth token not configured' };
  if (!opts.signatureHeader) return { ok: false, reason: 'missing X-Twilio-Signature header' };

  const sortedKeys = Object.keys(opts.params).sort();
  let data = opts.fullUrl;
  for (const k of sortedKeys) data += k + opts.params[k];

  const expected = crypto.createHmac('sha1', opts.authToken).update(data).digest('base64');
  const actual = opts.signatureHeader;
  return timingSafeEqualStr(expected, actual)
    ? { ok: true }
    : { ok: false, reason: 'twilio signature mismatch' };
}

// ── Vapi ─────────────────────────────────────────────────────────────────────
// Stripe-style: HMAC-SHA256 of "<timestamp>.<rawBody>" with shared secret, hex-encoded.
// Headers: X-Vapi-Timestamp (unix seconds) + X-Vapi-Signature (hex).
// If your Vapi tenant uses a different header scheme, adjust the header names here
// and the input format used to compute `data`.
export function verifyVapiSignature(opts: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  nowSeconds?: number; // Injectable for tests
}): VerifyResult {
  if (!opts.secret) return { ok: false, reason: 'vapi webhook secret not configured' };
  if (!opts.signatureHeader) return { ok: false, reason: 'missing X-Vapi-Signature header' };
  if (!opts.timestampHeader) return { ok: false, reason: 'missing X-Vapi-Timestamp header' };

  const ts = Number.parseInt(opts.timestampHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid X-Vapi-Timestamp' };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'vapi timestamp outside replay window' };
  }

  const data = `${ts}.${opts.rawBody}`;
  const expected = crypto.createHmac('sha256', opts.secret).update(data).digest('hex');
  return timingSafeEqualStr(expected, opts.signatureHeader)
    ? { ok: true }
    : { ok: false, reason: 'vapi signature mismatch' };
}

// ── Telegram ─────────────────────────────────────────────────────────────────
// Telegram does NOT sign payloads. Instead, when you register the webhook via
// setWebhook(secret_token=...), Telegram echoes the token back on every request
// in X-Telegram-Bot-Api-Secret-Token. We compare it constant-time.
export function verifyTelegramSecret(opts: {
  expectedSecret: string;
  secretHeader: string | null;
}): VerifyResult {
  if (!opts.expectedSecret) return { ok: false, reason: 'telegram webhook secret not configured' };
  if (!opts.secretHeader) return { ok: false, reason: 'missing X-Telegram-Bot-Api-Secret-Token' };
  return timingSafeEqualStr(opts.expectedSecret, opts.secretHeader)
    ? { ok: true }
    : { ok: false, reason: 'telegram secret mismatch' };
}

// ── Convenience: build the full URL Twilio would have computed ───────────────
// Twilio's HMAC input includes the exact URL it called, so if you're behind a
// tunnel/proxy you need to pass the public URL (not 0.0.0.0:3002). Callers can
// pass an override base; otherwise we reconstruct from Host header.
export function reconstructRequestUrl(req: http.IncomingMessage, publicBase: string): string {
  if (publicBase) {
    const base = publicBase.replace(/\/+$/, '');
    return base + (req.url ?? '/');
  }
  const host = headerValue(req, 'host') ?? 'localhost';
  // Behind TLS-terminating proxies Twilio still hits https://; honour X-Forwarded-Proto.
  const proto = headerValue(req, 'x-forwarded-proto') ?? 'http';
  return `${proto}://${host}${req.url ?? '/'}`;
}

export { headerValue };
