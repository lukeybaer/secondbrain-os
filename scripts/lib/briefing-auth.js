// briefing-auth.js
//
// Auth gate for the public briefing dashboard surface (E0 workstream A,
// 2026-06-11). Before this, every /briefing* route on the EC2 :3001 listener
// (HTML dashboard, briefing.json, POST action routes like /briefing/dispatch
// and /briefing/send-message) was open to the whole internet.
//
// Model (capability-URL pattern, zero friction for ExampleCo):
//  - The Telegram daily-briefing link ExampleCos ?k=<SB_BRIEFING_TOKEN>. First
//    click sets an HttpOnly sb_briefing cookie so every later visit (tab
//    links, refreshes, bookmarks without ?k=) keeps working.
//  - The Electron app already holds SB_COMMAND_TOKEN, so a standard
//    Authorization: Bearer <SB_COMMAND_TOKEN> header is also accepted.
//  - No capability token configured = fail closed for non-localhost callers.
//    Localhost exemption is the CALLER's job (ec2-server.js checks
//    isLocalRequest before invoking this), keeping this lib pure.
//
// CSRF story for the POST action routes: authorization comes only from the
// HttpOnly SameSite=Lax cookie, the Authorization header, or the ?k= query
// token. A cross-site form post ExampleCos none of these (Lax cookies are not
// sent on cross-site POSTs, and forms cannot set Authorization headers), so
// no separate CSRF token is needed. Never accept credentials from form-data.

const fs = require('fs');
const crypto = require('crypto');

const COOKIE_NAME = 'sb_briefing';
const TRUSTED_DEVICE_COOKIE_NAME = 'sb_briefing_device';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function parseCookieValue(cookieHeader, name) {
  const raw = String(cookieHeader || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

function buildSetCookie(capToken) {
  return COOKIE_NAME + '=' + capToken + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax';
}

function buildTrustedDeviceSetCookie(cookieValue, { maxAgeSeconds = 31536000 } = {}) {
  return (
    TRUSTED_DEVICE_COOKIE_NAME +
    '=' +
    cookieValue +
    '; Path=/; Max-Age=' +
    Math.floor(maxAgeSeconds) +
    '; HttpOnly; SameSite=Lax'
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function constantTimeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getBriefingPasswordConfig({
  briefingPassword = '',
  capToken = '',
  env = process.env,
  allowTokenFallback = true,
} = {}) {
  const password = String(briefingPassword || env.SB_BRIEFING_PASSWORD || '').trim();
  if (password) return { password, source: 'SB_BRIEFING_PASSWORD' };

  // Compatibility only: older deploys may have only SB_BRIEFING_TOKEN.
  // Prefer SB_BRIEFING_PASSWORD for trusted-device login so the password can
  // rotate independently from capability links.
  const fallback = String(capToken || env.SB_BRIEFING_TOKEN || '').trim();
  if (allowTokenFallback && fallback) {
    return { password: fallback, source: 'SB_BRIEFING_TOKEN_COMPAT' };
  }

  return { password: '', source: null };
}

function verifyBriefingPassword(presentedPassword, config = {}) {
  const presented = String(presentedPassword || '');
  const { password, source } = getBriefingPasswordConfig(config);
  if (!password) return { ok: false, reason: 'no-password-configured', source: null };
  if (!presented) return { ok: false, reason: 'missing-password', source };
  const ok = constantTimeEqualString(presented, password);
  return {
    ok,
    reason: ok ? 'password-ok' : 'bad-password',
    source,
  };
}

function normalizeTrustedDeviceStore(store) {
  if (!store || typeof store !== 'object') return { version: 1, sessions: {} };
  const sessions = store.sessions && typeof store.sessions === 'object' ? store.sessions : {};
  return { version: store.version || 1, sessions };
}

function readTrustedDeviceSessionStore(storePath) {
  if (!storePath) return { version: 1, sessions: {} };
  try {
    return normalizeTrustedDeviceStore(JSON.parse(fs.readFileSync(storePath, 'utf8')));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: 1, sessions: {} };
    throw err;
  }
}

function writeTrustedDeviceSessionStore(storePath, store) {
  if (!storePath) throw new Error('storePath is required');
  const normalized = normalizeTrustedDeviceStore(store);
  fs.mkdirSync(require('path').dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

function createTrustedDeviceSession({
  store = { version: 1, sessions: {} },
  now = Date.now(),
  ttlMs = ONE_YEAR_MS,
  label = '',
  userAgent = '',
  ip = '',
} = {}) {
  const normalized = normalizeTrustedDeviceStore(store);
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const cookieValue = id + '.' + secret;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();

  normalized.sessions[id] = {
    tokenHash: sha256(secret),
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
    label: String(label || ''),
    userAgent: String(userAgent || ''),
    ip: String(ip || ''),
  };

  return {
    store: normalized,
    sessionId: id,
    cookieValue,
    setCookie: buildTrustedDeviceSetCookie(cookieValue, { maxAgeSeconds: Math.floor(ttlMs / 1000) }),
    expiresAt,
  };
}

function createTrustedDeviceSessionFromPassword({
  password = '',
  store = { version: 1, sessions: {} },
  now = Date.now(),
  ttlMs = ONE_YEAR_MS,
  label = '',
  userAgent = '',
  ip = '',
  passwordConfig = {},
} = {}) {
  const passwordCheck = verifyBriefingPassword(password, passwordConfig);
  if (!passwordCheck.ok) {
    return { ok: false, reason: passwordCheck.reason, source: passwordCheck.source };
  }
  const session = createTrustedDeviceSession({ store, now, ttlMs, label, userAgent, ip });
  return { ok: true, reason: 'trusted-device-created', source: passwordCheck.source, ...session };
}

function createTrustedDeviceSessionFileFromPassword({
  password = '',
  storePath = '',
  now = Date.now(),
  ttlMs = ONE_YEAR_MS,
  label = '',
  userAgent = '',
  ip = '',
  passwordConfig = {},
} = {}) {
  const store = readTrustedDeviceSessionStore(storePath);
  const created = createTrustedDeviceSessionFromPassword({
    password,
    store,
    now,
    ttlMs,
    label,
    userAgent,
    ip,
    passwordConfig,
  });
  if (!created.ok) return created;
  writeTrustedDeviceSessionStore(storePath, created.store);
  return created;
}

function validateTrustedDeviceCookie(cookieHeader, store, now = Date.now()) {
  const cookieValue = parseCookieValue(cookieHeader, TRUSTED_DEVICE_COOKIE_NAME);
  if (!cookieValue) return { ok: false, via: null, reason: 'missing-trusted-device-cookie' };

  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return { ok: false, via: null, reason: 'bad-trusted-device-cookie' };

  const id = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  const sessions = normalizeTrustedDeviceStore(store).sessions;
  const session = sessions[id];
  if (!session) return { ok: false, via: null, reason: 'ExampleCo-trusted-device' };

  const expires = Date.parse(session.expiresAt || '');
  if (!Number.isFinite(expires) || expires <= now) {
    return { ok: false, via: null, reason: 'expired-trusted-device' };
  }

  if (!constantTimeEqualString(sha256(secret), session.tokenHash)) {
    return { ok: false, via: null, reason: 'bad-trusted-device' };
  }

  return { ok: true, via: 'trusted-device', sessionId: id, reason: 'trusted-device-cookie' };
}

function buildBriefingSignInNeeded(reason = 'missing-token') {
  return {
    ok: false,
    via: null,
    setCookie: null,
    reason,
    needsSignIn: true,
    status: 401,
    title: 'Sign in needed',
    message: 'Sign in to view the briefing on this device.',
  };
}

// Decide whether a briefing-surface request is authorized.
// request: { headers, query, cookieHeader }, config: { capToken, commandToken }
// Returns { ok, via, setCookie, reason }.
function validateBriefingRequest(
  { headers = {}, query = {}, cookieHeader = '' } = {},
  { capToken = '', commandToken = '', trustedDeviceStore = null, now = Date.now() } = {},
) {
  // Bearer SB_COMMAND_TOKEN always works (the Electron app already holds it),
  // independent of whether the capability token has been configured yet.
  const authHeader = String((headers && headers.authorization) || '');
  if (commandToken && authHeader === 'Bearer ' + commandToken) {
    return { ok: true, via: 'bearer', setCookie: null, reason: 'command-token' };
  }

  if (trustedDeviceStore) {
    const trusted = validateTrustedDeviceCookie(cookieHeader, trustedDeviceStore, now);
    if (trusted.ok) return { ...trusted, setCookie: null };
  }

  const cap = String(capToken || '').trim();
  if (!cap) {
    // Fail closed: with no capability token configured, no anonymous external
    // access. (Localhost never reaches this lib; the caller exempts it.)
    return { ok: false, via: null, setCookie: null, reason: 'no-token-configured' };
  }

  if (query && typeof query.k === 'string' && query.k === cap) {
    return {
      ok: true,
      via: 'query-token',
      setCookie: buildSetCookie(cap),
      reason: 'cap-token-query',
    };
  }

  if (parseCookieValue(cookieHeader, COOKIE_NAME) === cap) {
    return { ok: true, via: 'cookie', setCookie: null, reason: 'cap-token-cookie' };
  }

  const presented = query && query.k;
  return buildBriefingSignInNeeded(presented ? 'bad-token' : 'missing-token');
}

// Pure sliding-window rate limiter. stateMap: Map<key, number[]> of hit
// timestamps (mutated in place). Returns true when THIS hit exceeds max
// within windowMs (i.e. the 31st hit in a minute at the defaults).
function isRateLimited(stateMap, key, now, { max = 30, windowMs = 60000 } = {}) {
  const hits = (stateMap.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  stateMap.set(key, hits);
  return hits.length > max;
}

// Append the capability token to a briefing dashboard URL so the Telegram
// link (and the publish-receipt probe) authenticate on first click. No-op
// when no token is configured so unhardened deploys keep their plain URL.
function buildBriefingDashboardUrl(baseUrl, capToken) {
  const base = String(baseUrl || '').trim();
  const token = String(capToken || '').trim();
  if (!base || !token) return base;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'k=' + encodeURIComponent(token);
}

module.exports = {
  validateBriefingRequest,
  verifyBriefingPassword,
  getBriefingPasswordConfig,
  createTrustedDeviceSession,
  createTrustedDeviceSessionFromPassword,
  createTrustedDeviceSessionFileFromPassword,
  validateTrustedDeviceCookie,
  readTrustedDeviceSessionStore,
  writeTrustedDeviceSessionStore,
  buildBriefingSignInNeeded,
  isRateLimited,
  buildBriefingDashboardUrl,
  BRIEFING_COOKIE_NAME: COOKIE_NAME,
  BRIEFING_TRUSTED_DEVICE_COOKIE_NAME: TRUSTED_DEVICE_COOKIE_NAME,
};
