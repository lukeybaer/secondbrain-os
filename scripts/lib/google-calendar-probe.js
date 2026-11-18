'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchedLimitMs } = require('./watched-work-limit');

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
      grant_type: 'authorization_code',
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
      grant_type: 'refresh_token',
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

function shiftIsoDate(dateString, days) {
  const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Calendar target date must be YYYY-MM-DD.');
  const [, year, month, day] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12))
    .toISOString()
    .slice(0, 10);
}

function zonedMidnightEpochMs(dateString, timezone = 'America/Chicago') {
  const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Calendar target date must be YYYY-MM-DD.');
  const [, year, month, day] = match.map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let pass = 0; pass < 4; pass += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const renderedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0,
    );
    const adjustment = desired - renderedAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return guess;
}

function buildCalendarWindowForDate(
  dateString,
  days = 8,
  timezone = 'America/Chicago',
) {
  const startDate = String(dateString || '').slice(0, 10);
  const endDate = shiftIsoDate(startDate, Number(days || 8));
  return {
    timeMin: new Date(zonedMidnightEpochMs(startDate, timezone)).toISOString(),
    timeMax: new Date(zonedMidnightEpochMs(endDate, timezone)).toISOString(),
  };
}

// What a snapshot's read missed (review R2, 2026-11-15). `complete` is false
// when any calendar failed, was left out, or the list itself could not be read;
// `primaryUnread` is true when the owner's own calendar failed, even part way.
function calendarSnapshotGaps(snapshot) {
  const failures = Array.isArray(snapshot && snapshot.calendarFailures) ? snapshot.calendarFailures : [];
  const leftOut = Array.isArray(snapshot && snapshot.calendarsLeftOut) ? snapshot.calendarsLeftOut : [];
  const fallback = snapshot && snapshot.calendarListFallback;
  return {
    complete: Boolean(snapshot) && snapshot.coveragePartial !== true,
    primaryUnread: failures.some((failure) => failure && failure.primary === true),
    listUnread: Boolean(fallback && fallback.reason !== 'Calendar list was empty.'),
    failed: failures.length,
    leftOut: leftOut.length,
  };
}

// One line naming what a partial read missed, or '' when the read was complete.
function calendarGapLine(snapshot) {
  const gaps = calendarSnapshotGaps(snapshot);
  if (gaps.complete) return '';
  const parts = [
    gaps.listUnread ? 'the calendar list could not be read, so only the main calendar was read' : '',
    gaps.failed ? `${gaps.failed} calendar${gaps.failed === 1 ? '' : 's'} could not be read` : '',
    gaps.leftOut ? `${gaps.leftOut} left out over the ${MAX_CALENDARS}-calendar limit` : '',
  ].filter(Boolean);
  return `Not every calendar was read${parts.length ? ` (${parts.join('; ')})` : ''}; items on those calendars are not shown.`;
}

// True when the snapshot is a usable read of the whole horizon: the window
// covers it and the owner's own calendar was read in full. Other calendars that
// failed leave it usable, and calendarGapLine says what is missing.
function calendarSnapshotCoversDate(
  snapshot,
  dateString,
  days = 8,
  timezone = 'America/Chicago',
) {
  if (!snapshot || snapshot.ok !== true || !snapshot.window) return false;
  if (calendarSnapshotGaps(snapshot).primaryUnread) return false;
  let expected;
  try {
    expected = buildCalendarWindowForDate(dateString, days, timezone);
  } catch {
    return false;
  }
  const actualMin = Date.parse(String(snapshot.window.timeMin || ''));
  const actualMax = Date.parse(String(snapshot.window.timeMax || ''));
  const expectedMin = Date.parse(expected.timeMin);
  const expectedMax = Date.parse(expected.timeMax);
  return (
    Number.isFinite(actualMin) &&
    Number.isFinite(actualMax) &&
    actualMin <= expectedMin &&
    actualMax >= expectedMax
  );
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

async function calendarGet(accessToken, route, query = {}, fetchImpl = global.fetch, { timeoutMs = 0 } = {}) {
  if (!accessToken) throw new Error('Missing Google Calendar access token.');
  const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const request = async () => {
    const resp = await fetchImpl(calendarApiUrl(route, query), {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = await resp.json().catch(() => ({}));
    return { resp, body };
  };
  let outcome;
  if (timeoutMs > 0) {
    // A calendar that never answers must not hold up the rest.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error(`Google Calendar request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    try {
      outcome = await Promise.race([request(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    outcome = await request();
  }
  const { resp, body: json } = outcome;
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

const MAX_CALENDARS = 40;
const MAX_PARALLEL_CALENDARS = 4;
const MAX_PAGES = 20;
const CALENDAR_REQUEST_TIMEOUT_MS = watchedLimitMs(15000);
// One clock for the whole read (list plus every calendar), so a slow account
// cannot hold a voice call or a chat for minutes. What is not read by then is
// reported as not read, never as empty.
const CALENDAR_OVERALL_TIMEOUT_MS = watchedLimitMs(20000);

// `timeoutMs` is a number, or a function that returns the time left for the
// next request and throws once the overall clock has run out.
function nextRequestTimeout(timeoutMs) {
  return typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
}

// Read every page of the account's calendar list. Throws if any page cannot be read.
async function listAllCalendars(accessToken, fetchImpl, timeoutMs) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await calendarGet(
      accessToken,
      '/users/me/calendarList',
      {
        minAccessRole: 'reader',
        maxResults: 100,
        pageToken,
        fields: 'nextPageToken,items(id,summary,primary,accessRole,selected,deleted,hidden)',
      },
      fetchImpl,
      { timeoutMs: nextRequestTimeout(timeoutMs) },
    );
    if (!Array.isArray(body.items)) throw new Error('Calendar list response was not readable.');
    items.push(...body.items);
    pageToken = body.nextPageToken || '';
    if (!pageToken) return items;
  }
  throw new Error(`Calendar list had more than ${MAX_PAGES} pages.`);
}

// Read every page of one calendar's events in the window. On failure the error carries
// whatever pages were already read, so the caller can keep them and still flag the gap.
async function readCalendarEvents(accessToken, calendarId, window, fetchImpl, timeoutMs) {
  const events = [];
  let summary = '';
  let pageToken = '';
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await calendarGet(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          ...window,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50,
          pageToken,
          fields:
            'nextPageToken,items(id,iCalUID,summary,start,end,location,organizer(email,displayName),hangoutLink,status,attendees(self,responseStatus)),summary',
        },
        fetchImpl,
        { timeoutMs: nextRequestTimeout(timeoutMs) },
      );
      if (!Array.isArray(body.items)) throw new Error('Calendar events response was not readable.');
      if (body.summary) summary = body.summary;
      events.push(...body.items);
      pageToken = body.nextPageToken || '';
      if (!pageToken) return { events, summary };
    }
    throw new Error(`Calendar had more than ${MAX_PAGES} pages of events.`);
  } catch (err) {
    err.partialEvents = events;
    throw err;
  }
}

// Run async jobs with at most `limit` in flight. Results keep the input order.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function eventStartKey(event) {
  const start = event && event.start;
  return String((start && (start.dateTime || start.date)) || '');
}

function eventStartMs(event) {
  const ms = Date.parse(eventStartKey(event));
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

// The start two copies of an event are matched on (review R8): a timed start
// as an instant, so one meeting written in two time zones is one event; a
// date-only start kept apart from any timed one.
function eventMatchStart(event) {
  const start = (event && event.start) || {};
  if (start.dateTime) {
    const ms = Date.parse(start.dateTime);
    return `at|${Number.isFinite(ms) ? ms : start.dateTime}`;
  }
  return start.date ? `day|${start.date}` : '';
}

// Collapse the same event seen on several calendars into one. The same iCalUID at the same
// start counts as the same event; the event id at the same start is only a fallback, and
// never joins two events whose iCalUIDs differ (review R9). Calendars are passed in
// priority order (primary first), so the first copy seen is the one kept.
function mergeCalendarEvents(perCalendar) {
  const kept = [];
  const byKey = new Map();
  for (const { calendar, events } of perCalendar) {
    for (const event of events) {
      const start = eventMatchStart(event);
      const uidKey = event.iCalUID ? `uid|${event.iCalUID}|${start}` : '';
      const idKey = event.id ? `id|${event.id}|${start}` : '';
      let existing = uidKey ? byKey.get(uidKey) : undefined;
      if (!existing && idKey) {
        const byId = byKey.get(idKey);
        if (byId && !(byId.iCalUID && event.iCalUID && byId.iCalUID !== event.iCalUID)) existing = byId;
      }
      const keys = [uidKey, idKey].filter(Boolean);
      if (existing) {
        if (
          existing.calendarId !== calendar.id &&
          !existing.seenOnCalendars.some((seen) => seen.calendarId === calendar.id)
        ) {
          existing.seenOnCalendars.push({ calendarId: calendar.id, calendarName: calendar.summary });
        }
        for (const key of keys) if (!byKey.has(key)) byKey.set(key, existing);
        continue;
      }
      // Only this calendar's own answer to the invitation is kept (accepted,
      // declined, tentative, needsAction); the guest list itself is dropped.
      const { attendees, ...fields } = event;
      const own = Array.isArray(attendees) ? attendees.find((guest) => guest && guest.self) : null;
      const tagged = {
        ...fields,
        ...(own && own.responseStatus ? { selfResponse: own.responseStatus } : {}),
        calendarId: calendar.id,
        calendarName: calendar.summary,
        calendarPrimary: calendar.primary === true,
        seenOnCalendars: [],
      };
      for (const key of keys) if (!byKey.has(key)) byKey.set(key, tagged);
      kept.push(tagged);
    }
  }
  // Stable sort by start time, so calendar order breaks ties.
  return kept
    .map((event, index) => ({ event, index }))
    .sort((a, b) => eventStartMs(a.event) - eventStartMs(b.event) || a.index - b.index)
    .map((entry) => entry.event);
}

async function probeGoogleCalendarAccess({
  accessToken,
  days = 7,
  now = new Date(),
  targetDate = '',
  timezone = 'America/Chicago',
  includeEvents = false,
  fetchImpl = global.fetch,
  requestTimeoutMs = CALENDAR_REQUEST_TIMEOUT_MS,
  overallTimeoutMs = CALENDAR_OVERALL_TIMEOUT_MS,
} = {}) {
  const window = targetDate
    ? buildCalendarWindowForDate(targetDate, days, timezone)
    : buildCalendarWindow(days, now);

  // Every request draws from one clock. The list may use at most half of it, so
  // a slow list still leaves time to read the primary calendar.
  const startedMs = Date.now();
  const timeLeft = (budgetMs) => () => {
    if (!(overallTimeoutMs > 0)) return requestTimeoutMs;
    const left = startedMs + budgetMs - Date.now();
    if (left <= 0) throw new Error('Not read in time: the calendar time limit ran out.');
    return requestTimeoutMs > 0 ? Math.min(requestTimeoutMs, left) : left;
  };
  const listTimeout = timeLeft(overallTimeoutMs / 2);
  const eventsTimeout = timeLeft(overallTimeoutMs);

  // Step 1: the calendar list. If it cannot be read, fall back to the primary calendar alone.
  let listItems = [];
  let calendarListFallback = null;
  try {
    listItems = await listAllCalendars(accessToken, fetchImpl, listTimeout);
  } catch (err) {
    calendarListFallback = {
      reason: String((err && err.message) || err),
      usedCalendar: 'primary',
    };
  }

  // Step 2: pick the calendars to read, primary first: each calendar that is
  // ticked, shown and not deleted, and the primary calendar always. Unticking
  // or hiding the primary calendar only changes what the Google page shows;
  // skipping it made an empty read look complete (batch review, high).
  const readable = listItems.filter(
    (calendar) =>
      calendar &&
      calendar.id &&
      !calendar.deleted &&
      (calendar.primary === true || (calendar.selected !== false && !calendar.hidden)),
  );
  readable.sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
  const targets = readable.slice(0, MAX_CALENDARS).map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary,
    primary: calendar.primary === true,
  }));
  const calendarsLeftOut = readable.slice(MAX_CALENDARS).map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary,
  }));
  if (!targets.some((calendar) => calendar.primary)) {
    // No usable list, or a list without the primary calendar: read it by its
    // 'primary' name too, so a read never ends with no calendar read at all.
    if (!calendarListFallback && !listItems.length) {
      calendarListFallback = { reason: 'Calendar list was empty.', usedCalendar: 'primary' };
    }
    targets.unshift({ id: 'primary', summary: undefined, primary: true });
    if (targets.length > MAX_CALENDARS) {
      const dropped = targets.pop();
      calendarsLeftOut.unshift({ id: dropped.id, summary: dropped.summary });
    }
  }

  // Step 3: read each calendar, at most four at once. One failure never sinks the others.
  const outcomes = await mapWithLimit(targets, MAX_PARALLEL_CALENDARS, async (calendar) => {
    try {
      const result = await readCalendarEvents(accessToken, calendar.id, window, fetchImpl, eventsTimeout);
      return { calendar, ...result, error: null };
    } catch (err) {
      return {
        calendar,
        events: (err && err.partialEvents) || [],
        summary: '',
        error: err,
      };
    }
  });

  const failed = outcomes.filter((outcome) => outcome.error);
  // A calendar that failed on a later page still gave its earlier pages
  // (review R10): keep them and report the failure, never discard them.
  const readSomething = outcomes.some((outcome) => !outcome.error || outcome.events.length > 0);
  if (outcomes.length > 0 && !readSomething) {
    // Nothing could be read at all. That is an error, never an empty calendar.
    throw failed[0].error;
  }
  for (const outcome of outcomes) {
    if (outcome.summary && !outcome.calendar.summary) outcome.calendar.summary = outcome.summary;
  }

  const primaryOutcome = outcomes.find((outcome) => outcome.calendar.primary);
  const mergedEvents = mergeCalendarEvents(outcomes);
  const calendarFailures = failed.map((outcome) => ({
    calendarId: outcome.calendar.id,
    calendarName: outcome.calendar.summary,
    primary: outcome.calendar.primary,
    error: String((outcome.error && outcome.error.message) || outcome.error),
  }));

  return {
    ok: true,
    generatedAt: now.toISOString(),
    account: (primaryOutcome && primaryOutcome.summary) || 'primary',
    calendarCount: listItems.length,
    eventCount: mergedEvents.length,
    window,
    calendars: listItems.map((calendar) => ({
      id: calendar.id,
      summary: calendar.summary,
      primary: calendar.primary === true,
      accessRole: calendar.accessRole,
      selected: calendar.selected === true,
    })),
    events: includeEvents ? mergedEvents : [],
    calendarsRead: outcomes
      .filter((outcome) => !outcome.error)
      .map((outcome) => ({
        id: outcome.calendar.id,
        summary: outcome.calendar.summary,
        primary: outcome.calendar.primary,
        eventCount: outcome.events.length,
      })),
    calendarFailures,
    calendarsLeftOut,
    calendarListFallback,
    // True when any calendar failed, the list could not be read, or calendars were left out.
    coveragePartial:
      calendarFailures.length > 0 ||
      calendarsLeftOut.length > 0 ||
      Boolean(calendarListFallback && calendarListFallback.reason !== 'Calendar list was empty.'),
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

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best effort cleanup only. The destination was never partially written.
    }
  }
}

function parseArgs(argv) {
  const args = {
    accountLabel: 'personal',
    date: '',
    days: 7,
    snapshotFile: '',
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
    else if (arg === '--date') args.date = next();
    else if (arg === '--days') args.days = Number(next()) || 7;
    else if (arg === '--snapshot-file') args.snapshotFile = next();
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
  buildCalendarWindowForDate,
  calendarApiUrl,
  calendarGet,
  calendarPost,
  calendarScopes,
  calendarGapLine,
  calendarSnapshotCoversDate,
  calendarSnapshotGaps,
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
  writeJsonAtomic,
};
