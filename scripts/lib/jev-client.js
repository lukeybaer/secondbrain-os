'use strict';

// scripts/lib/jev-client.js
//
// Minimal client for TypeSafe's Jev decision model (POST /v1/systemone).
// Owner grants: auth-jev-speaker-naming (ExampleCo, 2026-09-18) and
// auth-jev-decision-control-plane (ExampleCo, 2026-09-19/20). Jev returns typed decisions only
// (choice / score / noul) with probabilities; it never writes text. Pure Node
// builtins, so it runs on EC2 and the PC with no install.

const https = require('node:https');
const credentialBroker = require('./credential-broker.js');

const JEV_HOST = 'api.typesafe.ai';
const JEV_PATH = '/v1/systemone';
// Pinned on purpose: acceptance thresholds are tuned against this version. An
// upgrade is a deliberate change with a re-test, never a silent alias move.
const JEV_MODEL = 'jev-1.13.0';
const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

class JevError extends Error {
  constructor(message, { status = 0, code = 'jev_error', body = '' } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.code = code;
    this.body = String(body || '').slice(0, 500);
  }
}

// All TypeSafe secret discovery is owned by the credential broker. Callers do
// not know or probe host-specific files, SSM parameters, or legacy locations.
function resolveJevKey({ resolver = credentialBroker.resolveCredential } = {}) {
  const resolved = resolver('typesafe', 'apiKey');
  return resolved && resolved.value ? String(resolved.value).trim() : '';
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

function costUsd(inputTokens) {
  return (Number(inputTokens || 0) / 1e6) * JEV_USD_PER_MILLION_INPUT_TOKENS;
}

function postOnce({ key, body, timeoutMs, request, signal }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: JEV_HOST,
        path: JEV_PATH,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          signal?.removeEventListener?.('abort', abort);
          resolve({ status: res.statusCode || 0, text: data });
        });
      },
    );
    const abort = () => req.destroy(new JevError('jev request aborted', { code: 'aborted' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    req.on('timeout', () =>
      req.destroy(new JevError(`jev timeout after ${timeoutMs}ms`, { code: 'timeout' })),
    );
    req.on('error', (error) => {
      signal?.removeEventListener?.('abort', abort);
      reject(error instanceof JevError ? error : new JevError(error.message, { code: 'network' }));
    });
    req.end(body);
  });
}

// Bounded, secret-free failure detail for the spend ledger. A bare
// `failed:http` row hid the real 400 (max_tokens_exceeded) on 2026-09-23, so
// the provider's reason is kept, capped, with anything key-like redacted.
const ERROR_DETAIL_MAX_CHARS = 300;
function jevErrorDetail(error) {
  if (!error) return '';
  const raw = String(error.body || error.message || '')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|ts|tsk|key|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.slice(0, ERROR_DETAIL_MAX_CHARS);
}

function jevMaxTokensExceeded(error) {
  return Number(error?.status) === 400 && /max_tokens_exceeded/i.test(String(error?.body || ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One System One evaluation. Retries only throttling and server faults; a 401
// or 422 is a configuration or request defect and fails at once.
async function jevSystemOne({
  state,
  questions,
  model = JEV_MODEL,
  key,
  timeoutMs = 30000,
  retries = 2,
  request = https.request,
  sleepFn = sleep,
  signal,
} = {}) {
  const apiKey = key === undefined ? resolveJevKey() : key;
  if (!apiKey) throw new JevError('TYPESAFE_API_KEY is not configured', { code: 'no_key' });
  const body = JSON.stringify({ model, state, questions });
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new JevError('jev request aborted', { code: 'aborted' });
    const started = Date.now();
    try {
      const res = await postOnce({ key: apiKey, body, timeoutMs, request, signal });
      if (res.status === 200) {
        let parsed;
        try {
          parsed = JSON.parse(res.text);
        } catch (error) {
          throw new JevError(`jev returned invalid JSON: ${error.message}`, { code: 'parse' });
        }
        return { ...parsed, latencyMs: Date.now() - started, attempts: attempt + 1 };
      }
      lastError = new JevError(`jev http ${res.status}`, {
        status: res.status,
        code: res.status === 401 ? 'auth' : 'http',
        body: res.text,
      });
      if (!RETRYABLE_STATUS.has(res.status)) break;
    } catch (error) {
      lastError = error instanceof JevError ? error : new JevError(error.message);
      if (lastError.code === 'parse') break;
    }
    if (lastError?.code === 'aborted') break;
    if (attempt < retries) await sleepFn(2000 * (attempt + 1));
  }
  throw lastError || new JevError('jev failed');
}

module.exports = {
  JEV_MODEL,
  JEV_USD_PER_MILLION_INPUT_TOKENS,
  JevError,
  jevErrorDetail,
  jevMaxTokensExceeded,
  jevSystemOne,
  resolveJevKey,
  estimateTokens,
  costUsd,
};
