'use strict';

const API_VERSION = '2026-03-30';
const API_ROOT = 'https://api.quo.com';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function apiConfig(env = process.env) {
  if (!env.QUO_API_KEY) throw new Error('missing Quo API key');
  return { apiKey: env.QUO_API_KEY, version: API_VERSION };
}

function fixedApiUrl(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith('/') || value.startsWith('//')) throw new Error('Quo API path must be root-relative');
  const url = new URL(value, API_ROOT);
  if (url.origin !== API_ROOT || url.username || url.password) throw new Error('Quo API request must use the fixed API origin');
  return url;
}

async function readResponseBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || response.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Quo API response exceeded byte limit');
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new Error('Quo API response did not provide a bounded stream');
  }
  const chunks = [];
  let bytes = 0;
  for await (const value of response.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      try { await response.body.cancel?.(); } catch {}
      throw new Error('Quo API response exceeded byte limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function requestJson(pathname, options = {}) {
  const config = apiConfig(options.env);
  const url = fixedApiUrl(pathname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  const method = options.method || 'GET';
  const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body));
  try {
    const response = await (options.fetch || fetch)(url, {
      method,
      headers: {
        Authorization: config.apiKey,
        'Quo-Api-Version': config.version,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
      },
      ...(body ? { body } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error('Quo API cross-origin or redirected response refused');
    const raw = await readResponseBytes(response, options.maxBytes || MAX_RESPONSE_BYTES);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Quo API returned invalid JSON'); }
    if (!response.ok) {
      const detail = String(parsed?.message || parsed?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const error = new Error(`Quo API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.statusCode = response.status;
      // A documented 4xx is a definite refusal. A write-side 5xx is not: Quo
      // warns that retrying a POST can repeat an effect whose response was
      // lost, so callers must preserve it as uncertain and refuse replay.
      error.providerRejected = response.status >= 400 && response.status < 500;
      error.externalEffectUncertain = method !== 'GET' && method !== 'HEAD' && response.status >= 500;
      throw error;
    }
    return { url: url.toString(), raw, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function paginated(pathname, params = {}, options = {}) {
  const items = [];
  const pages = [];
  let after = null;
  do {
    const url = fixedApiUrl(pathname);
    Object.entries({ ...params, limit: Math.min(50, Number(params.limit) || 50), ...(after ? { after } : {}) })
      .forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
    const page = await requestJson(`${url.pathname}${url.search}`, options);
    pages.push(page);
    if (!Array.isArray(page.body.data)) throw new Error('Quo API list response omitted data array');
    if (options.onPage) await options.onPage(page, pages.length - 1);
    items.push(...page.body.data);
    after = page.body.nextCursor || null;
    if (pages.length >= (options.maxPages || 100) && after) throw new Error('Quo API pagination exceeded configured page limit');
  } while (after);
  return { items, pages };
}

function e164OrShortCode(value) {
  return /^\+[1-9]\d{1,14}$/.test(value) || /^\d{3,8}$/.test(value);
}

function validateSendInput({ content, from, to }) {
  if (typeof content !== 'string' || content.length < 1 || content.length > 1600) throw new Error('Quo message content must be 1-1600 characters');
  if (!/^PN.+/.test(String(from || ''))) throw new Error('invalid Quo sending phone-number ID');
  if (!Array.isArray(to) || to.length < 1 || to.length > 10 || to.some((value) => !e164OrShortCode(String(value)))) {
    throw new Error('invalid Quo message recipient list');
  }
}

function getOrganization(options) { return requestJson('/organization', options); }
function getA2pRegistration(options) { return requestJson('/a2p-registration', options); }
function getPhoneNumber(phoneNumberId, options) {
  if (!/^PN.+/.test(String(phoneNumberId || ''))) throw new Error('invalid Quo phone-number ID');
  return requestJson(`/phone-numbers/${encodeURIComponent(phoneNumberId)}?include=restrictions`, options);
}
function getPhoneNumberSettings(phoneNumberId, options) {
  if (!/^PN.+/.test(String(phoneNumberId || ''))) throw new Error('invalid Quo phone-number ID');
  return requestJson(`/phone-numbers/${encodeURIComponent(phoneNumberId)}/settings`, options);
}
function listCalls(params, options) { return paginated('/calls', params, options); }
function listMessages(params, options) { return paginated('/messages', params, options); }
function listRecordings(callId, params = {}, options = {}) {
  if (!/^AC.+/.test(String(callId || ''))) throw new Error('invalid Quo call ID');
  return paginated(`/calls/${encodeURIComponent(callId)}/recordings`, params, options);
}
function listTranscripts(callId, params = {}, options = {}) {
  if (!/^AC.+/.test(String(callId || ''))) throw new Error('invalid Quo call ID');
  return paginated(`/calls/${encodeURIComponent(callId)}/transcripts`, params, options);
}
function sendMessage(input, options = {}) {
  validateSendInput(input || {});
  return requestJson('/messages', { ...options, method: 'POST', body: input });
}

module.exports = {
  API_ROOT,
  API_VERSION,
  MAX_RESPONSE_BYTES,
  apiConfig,
  fixedApiUrl,
  getA2pRegistration,
  getOrganization,
  getPhoneNumber,
  getPhoneNumberSettings,
  listCalls,
  listMessages,
  listRecordings,
  listTranscripts,
  paginated,
  readResponseBytes,
  requestJson,
  sendMessage,
  validateSendInput,
};
