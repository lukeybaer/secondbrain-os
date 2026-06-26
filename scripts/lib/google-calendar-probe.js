'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DEFAULT_SCOPES = [CALENDAR_READONLY_SCOPE];
const WRITE_SCOPES = [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE];
const REDIRECT_PORT = 9855;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function calendarScopes(opts = {}) {
  return opts.write ? [...WRITE_SCOPES] : [...DEFAULT_SCOPES];
}

function safeFileLabel(label) {
  return String(label || 'personal')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'personal';
}

function isGoogleCalendarLabel(label) {
  const value = safeFileLabel(label);
  return ['personal', 'gmail', 'google', 'google-calendar', 'default'].includes(value);
}

function defaultAuthDir(env = process.env) {
  if (env.SECONDBRAIN_AUTH_DIR) return env.SECONDBRAIN_AUTH_DIR;
  if (env.SECONDBRAIN_DATA_DIR) return path.join(env.SECONDBRAIN_DATA_DIR, 'auth');
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data/auth';
  }
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'auth');
}

function defaultCredentialsPath(env = process.env) {
  if (env.GOOGLE_CALENDAR_CREDENTIALS_FILE) return env.GOOGLE_CALENDAR_CREDENTIALS_FILE;
  if (env.GMAIL_OAUTH_CREDENTIALS_FILE) return env.GMAIL_OAUTH_CREDENTIALS_FILE;
  return path.join(os.homedir(), '.secrets', 'gmail_oauth_credentials.json');
}

function tokenPath(env = process.env, accountLabel = 'personal') {
  return path.join(defaultAuthDir(env), `google-calendar-${safeFileLabel(accountLabel)}.json`);
}

function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeCredentials(raw) {
  const cfg = raw && (raw.installed || raw.web || raw);
  return {
    clientId: String(cfg && cfg.client_id ? cfg.client_id : '').trim(),
    clientSecret: String(cfg && cfg.client_secret ? cfg.client_secret : '').trim(),
  };
}

function resolveGoogleCredentials({ env = process.env, credentialsPath = defaultCredentialsPath(env) } = {}) {
  const fromEnv = {
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID || env.GOOGLE_CLIENT_ID || env.GMAIL_CLIENT_ID || '',
    clientSecret:
      env.GOOGLE_CALENDAR_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || env.GMAIL_CLIENT_SECRET || '',
  };
  if (fromEnv.clientId && fromEnv.clientSecret) return fromEnv;
  const fromFile = normalizeCredentials(readJsonIfExists(credentialsPath));
  return fromFile;
}

function buildAuthUrl({ clientId, scopes = DEFAULT_SCOPES, redirectUri = REDIRECT_URI } = {}) {
  if (!clientId) throw new Error('Missing Google OAuth client id.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function postForm(url, body, fetchImpl = global.fetch) {
  if (!fetchImpl) throw new Error('fetch is not available in this Node runtime');
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json.error_description || json.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function exchangeCodeForToken({
  code,
  clientId,
  clientSecret,
  redirectUri = REDIRECT_URI,
  fetchImpl,
} = {}) {
  if (!code) throw new Error('Missing Google OAuth authorization code.');
  if (!clientId || !clientSecret) throw new Error('Missing Google OAuth client credentials.');
  return postForm(
    'https://oauth2.googleapis.com/token',
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      ExampleCo_type: 'authorization_code',
    },
    fetchImpl,
  );
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl } = {}) {
  if (!clientId || !clientSecret) throw new Error('Missing Google OAuth client credentials.');
  if (!refreshToken) throw new Error('Missing Google Calendar refresh token.');
  return postForm(
    'https://oauth2.googleapis.com/token',
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      ExampleCo_type: 'refresh_token',
    },
    fetchImpl,
  );
}

function decorateTokenRecord({
  accountLabel = 'personal',
  clientId,
  clientSecret,
  scopes = DEFAULT_SCOPES,
  token,
  obtainedAt = new Date(),
}) {
  const obtainedDate = obtainedAt instanceof Date ? obtainedAt : new Date(obtainedAt);
  const expiresIn = Number(token && token.expires_in ? token.expires_in : 0);
  return {
    accountLabel,
    provider: 'google-calendar',
    clientId,
    clientSecret,
    scopes,
    obtainedAt: obtainedDate.toISOString(),
    expiresAt: expiresIn ? new Date(obtainedDate.getTime() + expiresIn * 1000).toISOString() : '',
    token,
  };
}

function isAccessTokenFresh(record, now = new Date(), skewMs = 120000) {
  if (!record || !record.token || !record.token.access_token) return false;
  if (!record.expiresAt) return true;
  return new Date(record.expiresAt).getTime() - now.getTime() > skewMs;
}

function buildCalendarWindow(days = 7, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + Number(days || 7));
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function calendarApiUrl(route, query = {}) {
  const url = new URL(route.replace(/^\//, ''), 'https://www.googleapis.com/calendar/v3/');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function calendarGet(accessToken, route, query = {}, fetchImpl = global.fetch) {
  if (!accessToken) throw new Error('Missing Google Calendar access token.');
  const resp = await fetchImpl(calendarApiUrl(route, query), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json.error?.message || json.error_description || json.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function calendarPost(accessToken, route, body = {}, query = {}, fetchImpl = global.fetch) {
  if (!accessToken) throw new Error('Missing Google Calendar access token.');
  const resp = await fetchImpl(calendarApiUrl(route, query), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json.error?.message || json.error_description || json.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function todayInTimeZone(now = new Date(), timezone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDaysToDate(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return d.toISOString().slice(0, 10);
}

function normalizeEventDate(dateValue, now = new Date(), timezone = 'America/Chicago') {
  const value = String(dateValue || 'today').trim().toLowerCase();
  if (!value || value === 'today') return todayInTimeZone(now, timezone);
  if (value === 'tomorrow') return addDaysToDate(todayInTimeZone(now, timezone), 1);
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  throw new Error('Calendar event date is ambiguous. I did not create anything.');
}

function parseClock(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\./g, '');
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) throw new Error('Calendar event start time is ambiguous. I did not create anything.');
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const suffix = match[3];
  if (hour > 24 || minute > 59) throw new Error('Calendar event start time is invalid. I did not create anything.');
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (!suffix && hour === 24) hour = 0;
  return { hour, minute };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMinutesLocal(dateTime, minutes) {
  const match = String(dateTime).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Calendar event time is invalid. I did not create anything.');
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi + Number(minutes || 0), s));
  return (
    t.getUTCFullYear() +
    '-' +
    pad2(t.getUTCMonth() + 1) +
    '-' +
    pad2(t.getUTCDate()) +
    'T' +
    pad2(t.getUTCHours()) +
    ':' +
    pad2(t.getUTCMinutes()) +
    ':' +
    pad2(t.getUTCSeconds())
  );
}

function resolveEventTimes({
  title,
  date,
  start_time,
  startTime,
  end_time,
  endTime,
  duration_minutes,
  durationMinutes,
  timezone = 'America/Chicago',
  now = new Date(),
} = {}) {
  const summary = String(title || '').trim();
  if (!summary) throw new Error('Calendar event title is required. I did not create anything.');
  const startRaw = String(start_time || startTime || '').trim();
  if (!startRaw) throw new Error('Calendar event start time is required. I did not create anything.');

  let startDateTime;
  const isoStart = startRaw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (isoStart) {
    startDateTime = `${isoStart[1]}T${isoStart[2]}:${isoStart[3] || '00'}`;
  } else {
    const eventDate = normalizeEventDate(date, now, timezone);
    const clock = parseClock(startRaw);
    startDateTime = `${eventDate}T${pad2(clock.hour)}:${pad2(clock.minute)}:00`;
  }

  let endDateTime;
  const endRaw = String(end_time || endTime || '').trim();
  if (endRaw) {
    const isoEnd = endRaw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    if (isoEnd) {
      endDateTime = `${isoEnd[1]}T${isoEnd[2]}:${isoEnd[3] || '00'}`;
    } else {
      const eventDate = normalizeEventDate(date, now, timezone);
      const clock = parseClock(endRaw);
      endDateTime = `${eventDate}T${pad2(clock.hour)}:${pad2(clock.minute)}:00`;
    }
  } else {
    endDateTime = addMinutesLocal(startDateTime, Math.max(1, Number(duration_minutes || durationMinutes || 30)));
  }

  return {
    summary,
    start: { dateTime: startDateTime, timeZone: timezone },
    end: { dateTime: endDateTime, timeZone: timezone },
  };
}

async function createGoogleCalendarEvent({
  accessToken,
  calendarId = 'primary',
  title,
  date,
  start_time,
  startTime,
  end_time,
  endTime,
  duration_minutes,
  durationMinutes,
  timezone = 'America/Chicago',
  description,
  now = new Date(),
  fetchImpl = global.fetch,
} = {}) {
  const body = resolveEventTimes({
    title,
    date,
    start_time,
    startTime,
    end_time,
    endTime,
    duration_minutes,
    durationMinutes,
    timezone,
    now,
  });
  if (description) body.description = String(description);
  return calendarPost(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    body,
    {},
    fetchImpl,
  );
}

function tokenHasScope(record, scope) {
  const wanted = String(scope || '').trim();
  if (!wanted) return false;
  const fromRecord = Array.isArray(record && record.scopes) ? record.scopes : [];
  const fromToken = String(record && record.token && record.token.scope ? record.token.scope : '')
    .split(/\s+/)
    .filter(Boolean);
  return [...fromRecord, ...fromToken].includes(wanted);
}

async function probeGoogleCalendarAccess({
  accessToken,
  days = 7,
  now = new Date(),
  includeEvents = false,
  fetchImpl = global.fetch,
} = {}) {
  const calendars = await calendarGet(
    accessToken,
    '/users/me/calendarList',
    {
      minAccessRole: 'reader',
      maxResults: 100,
      fields: 'items(id,summary,primary,accessRole,selected)',
    },
    fetchImpl,
  );
  const window = buildCalendarWindow(days, now);
  const events = await calendarGet(
    accessToken,
    '/calendars/primary/events',
    {
      ...window,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
      fields: 'items(id,summary,start,end,location,organizer(email,displayName),hangoutLink,status),summary',
    },
    fetchImpl,
  );

  return {
    ok: true,
    account: events.summary || 'primary',
    calendarCount: Array.isArray(calendars.items) ? calendars.items.length : 0,
    eventCount: Array.isArray(events.items) ? events.items.length : 0,
    window,
    calendars: (calendars.items || []).map((calendar) => ({
      id: calendar.id,
      summary: calendar.summary,
      primary: calendar.primary === true,
      accessRole: calendar.accessRole,
      selected: calendar.selected === true,
    })),
    events: includeEvents ? events.items || [] : [],
  };
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|assertion|code/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactSecrets(item);
    }
  }
  return out;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function parseArgs(argv) {
  const args = {
    accountLabel: 'personal',
    days: 7,
    setup: false,
    probe: false,
    showEvents: false,
    printUrl: false,
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--account-label') args.accountLabel = next();
    else if (arg === '--days') args.days = Number(next()) || 7;
    else if (arg === '--setup' || arg === '--auth') args.setup = true;
    else if (arg === '--probe') args.probe = true;
    else if (arg === '--show-events') args.showEvents = true;
    else if (arg === '--print-url') args.printUrl = true;
    else if (arg === '--write' || arg === '--calendar-write') args.write = true;
  }
  return args;
}

module.exports = {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DEFAULT_SCOPES,
  REDIRECT_PORT,
  REDIRECT_URI,
  WRITE_SCOPES,
  buildAuthUrl,
  buildCalendarWindow,
  calendarApiUrl,
  calendarGet,
  calendarPost,
  calendarScopes,
  createGoogleCalendarEvent,
  decorateTokenRecord,
  defaultAuthDir,
  defaultCredentialsPath,
  exchangeCodeForToken,
  isAccessTokenFresh,
  isGoogleCalendarLabel,
  parseArgs,
  probeGoogleCalendarAccess,
  redactSecrets,
  refreshAccessToken,
  resolveGoogleCredentials,
  resolveEventTimes,
  safeFileLabel,
  tokenHasScope,
  tokenPath,
  writeJson,
};
