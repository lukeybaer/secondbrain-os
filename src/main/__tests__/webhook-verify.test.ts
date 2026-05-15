/**
 * Tests for webhook signature verification. Covers Twilio (HMAC-SHA1 over
 * URL + sorted params), Vapi (Stripe-style HMAC-SHA256 over timestamp.body
 * with a 5-min replay window), and Telegram (static secret token).
 *
 * Each provider has happy-path + tampering + missing-header cases. Verifiers
 * must fail closed when secrets are unconfigured — that's the whole point of
 * the security fix.
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  verifyTwilioSignature,
  verifyVapiSignature,
  verifyTelegramSecret,
} from '../webhook-verify';

// ── Twilio ───────────────────────────────────────────────────────────────────

function twilioSign(authToken: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

describe('verifyTwilioSignature', () => {
  const authToken = 'twilio-auth-token-xyz';
  const url = 'https://example.com/twilio/webhook';
  const params = { From: '+15551112222', Body: 'hello', MessageSid: 'SM123' };

  it('accepts a valid signature', () => {
    const sig = twilioSign(authToken, url, params);
    const result = verifyTwilioSignature({
      authToken,
      fullUrl: url,
      params,
      signatureHeader: sig,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = twilioSign(authToken, url, params);
    const result = verifyTwilioSignature({
      authToken,
      fullUrl: url,
      params: { ...params, Body: 'tampered' },
      signatureHeader: sig,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a tampered URL', () => {
    const sig = twilioSign(authToken, url, params);
    const result = verifyTwilioSignature({
      authToken,
      fullUrl: 'https://attacker.example/twilio/webhook',
      params,
      signatureHeader: sig,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when signature header is missing', () => {
    const result = verifyTwilioSignature({
      authToken,
      fullUrl: url,
      params,
      signatureHeader: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing/i);
  });

  it('fails closed when auth token is not configured', () => {
    const result = verifyTwilioSignature({
      authToken: '',
      fullUrl: url,
      params,
      signatureHeader: 'whatever',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/i);
  });
});

// ── Vapi ─────────────────────────────────────────────────────────────────────

function vapiSign(secret: string, timestamp: number, rawBody: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

describe('verifyVapiSignature', () => {
  const secret = 'vapi-shared-secret';
  const rawBody = JSON.stringify({ message: { type: 'function-call' } });
  const now = 1_750_000_000; // Fixed clock for reproducibility

  it('accepts a valid signature within the replay window', () => {
    const sig = vapiSign(secret, now, rawBody);
    const result = verifyVapiSignature({
      secret,
      rawBody,
      signatureHeader: sig,
      timestampHeader: String(now),
      nowSeconds: now + 10,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = vapiSign(secret, now, rawBody);
    const result = verifyVapiSignature({
      secret,
      rawBody: rawBody + 'tampered',
      signatureHeader: sig,
      timestampHeader: String(now),
      nowSeconds: now + 10,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a stale timestamp (replay outside window)', () => {
    const sig = vapiSign(secret, now, rawBody);
    const result = verifyVapiSignature({
      secret,
      rawBody,
      signatureHeader: sig,
      timestampHeader: String(now),
      nowSeconds: now + 10 * 60, // 10 minutes later
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/replay/i);
  });

  it('rejects when signature header is missing', () => {
    const result = verifyVapiSignature({
      secret,
      rawBody,
      signatureHeader: null,
      timestampHeader: String(now),
      nowSeconds: now,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when timestamp header is missing', () => {
    const sig = vapiSign(secret, now, rawBody);
    const result = verifyVapiSignature({
      secret,
      rawBody,
      signatureHeader: sig,
      timestampHeader: null,
      nowSeconds: now,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const sig = vapiSign(secret, now, rawBody);
    const result = verifyVapiSignature({
      secret,
      rawBody,
      signatureHeader: sig,
      timestampHeader: 'not-a-number',
      nowSeconds: now,
    });
    expect(result.ok).toBe(false);
  });

  it('fails closed when secret is not configured', () => {
    const result = verifyVapiSignature({
      secret: '',
      rawBody,
      signatureHeader: 'whatever',
      timestampHeader: String(now),
      nowSeconds: now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/i);
  });
});

// ── Telegram ─────────────────────────────────────────────────────────────────

describe('verifyTelegramSecret', () => {
  const expected = 'telegram-shared-token-7d4f';

  it('accepts a matching token', () => {
    const result = verifyTelegramSecret({
      expectedSecret: expected,
      secretHeader: expected,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a mismatched token', () => {
    const result = verifyTelegramSecret({
      expectedSecret: expected,
      secretHeader: 'wrong-token',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when secret header is missing', () => {
    const result = verifyTelegramSecret({
      expectedSecret: expected,
      secretHeader: null,
    });
    expect(result.ok).toBe(false);
  });

  it('fails closed when secret is not configured', () => {
    const result = verifyTelegramSecret({
      expectedSecret: '',
      secretHeader: 'anything',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/i);
  });

  it('uses constant-time comparison (length mismatch does not throw)', () => {
    // Different lengths must return false cleanly, not throw — crypto.timingSafeEqual
    // would throw on length mismatch if called naively.
    expect(() =>
      verifyTelegramSecret({
        expectedSecret: 'short',
        secretHeader: 'much-longer-string',
      }),
    ).not.toThrow();
  });
});
