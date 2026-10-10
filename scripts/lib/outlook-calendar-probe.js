'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TENANT = 'organizations';
const DEFAULT_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadBasic'];
const FULL_CALENDAR_SCOPES = ['offline_access', 'User.Read', 'Calendars.Read'];

function sanitizeTenant(tenant) {
  const value = String(tenant || DEFAULT_TENANT).trim();
  if (!value) return DEFAULT_TENANT;
  return value.replace(/[^A-Za-z0-9_.-]/g, '');
}

function microsoftLoginUrl(tenant, kind) {
  const cleanTenant = sanitizeTenant(tenant);
  const suffix = kind === 'devicecode' ? 'devicecode' : 'token';
  return `https://login.microsoftonline.com/${cleanTenant}/oauth2/v2.0/${suffix}`;
}

function graphUrl(route, query = {}) {
  const url = new URL(route.replace(/^\//, ''), `${GRAPH_BASE_URL}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
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

function pendingAuthPath(env = process.env, accountLabel = 'work') {
  return path.join(defaultAuthDir(env), `microsoft-calendar-${safeFileLabel(accountLabel)}.pending.json`);
}

function tokenPath(env = process.env, accountLabel = 'work') {
  return path.join(defaultAuthDir(env), `microsoft-calendar-${safeFileLabel(accountLabel)}.json`);
}

function safeFileLabel(label) {
  return String(label || 'work')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'work';
}

function candidateConfigPaths(env = process.env) {
  const paths = [];
  if (env.APPDATA) paths.push(path.join(env.APPDATA, 'secondbrain', 'config.json'));
  if (env.USERPROFILE) paths.push(path.join(env.USERPROFILE, '.secondbrain', 'config.json'));
  return paths;
}

function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveGraphConfig({ env = process.env, configPaths = candidateConfigPaths(env), args = {} } = {}) {
  const configs = configPaths.map(readJsonIfExists).filter(Boolean);
  const pickConfig = (...keys) => {
    for (const cfg of configs) {
      for (const key of keys) {
        if (cfg && typeof cfg[key] === 'string' && cfg[key].trim()) return cfg[key].trim();
      }
    }
    return '';
  };

  const clientId =
    args.clientId ||
    env.MS_GRAPH_CLIENT_ID ||
    env.MICROSOFT_GRAPH_CLIENT_ID ||
    env.OUTLOOK_CLIENT_ID ||
    pickConfig('microsoftGraphClientId', 'outlookClientId', 'microsoftClientId');
  const tenant =
    args.tenant ||
    env.MS_GRAPH_TENANT ||
    env.MICROSOFT_GRAPH_TENANT ||
    env.OUTLOOK_TENANT ||
    pickConfig('microsoftGraphTenant', 'outlookTenant', 'microsoftTenant') ||
    DEFAULT_TENANT;

  return {
    clientId: clientId ? String(clientId).trim() : '',
    tenant: sanitizeTenant(tenant),
  };
}

function calendarScopes({ full = false } = {}) {
  return full ? [...FULL_CALENDAR_SCOPES] : [...DEFAULT_SCOPES];
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
    err.classification = classifyMicrosoftError(json);
    throw err;
  }
  return json;
}

async function requestDeviceCode({ clientId, tenant = DEFAULT_TENANT, scopes = DEFAULT_SCOPES, fetchImpl } = {}) {
  if (!clientId) {
    const err = new Error('Missing Microsoft Graph client id. Set MS_GRAPH_CLIENT_ID or add microsoftGraphClientId to config.json.');
    err.code = 'missing_client_id';
    throw err;
  }
  return postForm(
    microsoftLoginUrl(tenant, 'devicecode'),
    {
      client_id: clientId,
      scope: scopes.join(' '),
    },
    fetchImpl,
  );
}

async function pollDeviceToken({
  clientId,
  tenant = DEFAULT_TENANT,
  deviceCode,
  interval = 5,
  expiresIn = 900,
  fetchImpl,
} = {}) {
  if (!clientId) throw new Error('Missing Microsoft Graph client id.');
  if (!deviceCode) throw new Error('Missing Microsoft device_code.');

  const started = Date.now();
  let waitSeconds = Number(interval) || 5;
  while (Date.now() - started < Number(expiresIn) * 1000) {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    try {
      return await postForm(
        microsoftLoginUrl(tenant, 'token'),
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: clientId,
          device_code: deviceCode,
        },
        fetchImpl,
      );
    } catch (err) {
      const payload = err.payload || {};
      if (payload.error === 'authorization_pending') continue;
      if (payload.error === 'slow_down') {
        waitSeconds += 5;
        continue;
      }
      throw err;
    }
  }
  const err = new Error('Microsoft device code expired before authorization completed.');
  err.code = 'device_code_expired';
  throw err;
}

async function refreshAccessToken({
  clientId,
  tenant = DEFAULT_TENANT,
  refreshToken,
  scopes = DEFAULT_SCOPES,
  fetchImpl,
} = {}) {
  if (!clientId) throw new Error('Missing Microsoft Graph client id.');
  if (!refreshToken) throw new Error('Missing Microsoft Graph refresh token.');
  return postForm(
    microsoftLoginUrl(tenant, 'token'),
    {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    },
    fetchImpl,
  );
}

function buildCalendarViewWindow(days = 7, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + Number(days || 7));
  return {
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
  };
}

async function graphGet(accessToken, route, query = {}, fetchImpl = global.fetch) {
  if (!accessToken) throw new Error('Missing Microsoft Graph access token.');
  const resp = await fetchImpl(graphUrl(route, query), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json.error?.message || json.error_description || json.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.payload = json;
    err.classification = classifyMicrosoftError(json);
    throw err;
  }
  return json;
}

async function probeCalendarAccess({
  accessToken,
  days = 7,
  now = new Date(),
  fetchImpl = global.fetch,
  includeEvents = false,
} = {}) {
  const user = await graphGet(accessToken, '/me', { $select: 'displayName,userPrincipalName,mail' }, fetchImpl);
  const calendars = await graphGet(accessToken, '/me/calendars', { $select: 'id,name,owner,canEdit,canShare' }, fetchImpl);
  const window = buildCalendarViewWindow(days, now);
  const calendarView = await graphGet(
    accessToken,
    '/me/calendarView',
    {
      ...window,
      $top: 50,
      $select: 'subject,start,end,location,organizer,isAllDay,showAs',
      $orderby: 'start/dateTime',
    },
    fetchImpl,
  );

  return {
    ok: true,
    account: {
      displayName: user.displayName || '',
      userPrincipalName: user.userPrincipalName || user.mail || '',
    },
    calendarCount: Array.isArray(calendars.value) ? calendars.value.length : 0,
    eventCount: Array.isArray(calendarView.value) ? calendarView.value.length : 0,
    window,
    calendars: (calendars.value || []).map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      owner: calendar.owner?.name || calendar.owner?.address || '',
      canEdit: calendar.canEdit,
      canShare: calendar.canShare,
    })),
    events: includeEvents ? calendarView.value || [] : [],
  };
}

function classifyMicrosoftError(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input || {});
  if (/AADSTS700016|invalid_client/i.test(text)) return 'unknown_or_unusable_client_id';
  if (/AADSTS53003|Conditional Access|device.*compliance|managed device|required/i.test(text)) {
    return 'conditional_access_or_device_policy_blocked';
  }
  if (/AADSTS65001|AADSTS90094|admin consent|user consent|consent_required/i.test(text)) {
    return 'admin_or_user_consent_required';
  }
  if (/AADSTS50020|user account.*does not exist|not found in the tenant/i.test(text)) {
    return 'wrong_tenant_or_external_account_blocked';
  }
  if (/Authorization_RequestDenied|accessDenied|Forbidden|Insufficient privileges/i.test(text)) {
    return 'graph_permission_denied';
  }
  if (/interaction_required/i.test(text)) return 'interaction_required';
  return 'unknown';
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|assertion|device[_-]?code/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactSecrets(item);
    }
  }
  return out;
}

function decorateTokenRecord({ accountLabel, clientId, tenant, scopes, token, obtainedAt = new Date() }) {
  const obtainedDate = obtainedAt instanceof Date ? obtainedAt : new Date(obtainedAt);
  const expiresIn = Number(token && token.expires_in ? token.expires_in : 0);
  const expiresAt = expiresIn
    ? new Date(obtainedDate.getTime() + expiresIn * 1000).toISOString()
    : '';
  return {
    accountLabel,
    clientId,
    tenant: sanitizeTenant(tenant),
    scopes,
    obtainedAt: obtainedDate.toISOString(),
    expiresAt,
    token,
  };
}

function isAccessTokenFresh(record, now = new Date(), skewMs = 120000) {
  if (!record || !record.token || !record.token.access_token) return false;
  if (!record.expiresAt) return true;
  return new Date(record.expiresAt).getTime() - now.getTime() > skewMs;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readPendingAuth(file) {
  const pending = readJsonIfExists(file);
  if (!pending || !pending.clientId || !pending.deviceCode) {
    throw new Error(`No pending Microsoft calendar auth found at ${file}. Start one first.`);
  }
  return pending;
}

function parseArgs(argv) {
  const args = {
    tenant: '',
    clientId: '',
    accountLabel: 'work',
    days: 7,
    full: false,
    wait: false,
    poll: false,
    saveToken: false,
    showEvents: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--tenant') args.tenant = next();
    else if (arg === '--client-id') args.clientId = next();
    else if (arg === '--account-label') args.accountLabel = next();
    else if (arg === '--days') args.days = Number(next()) || 7;
    else if (arg === '--full') args.full = true;
    else if (arg === '--wait') args.wait = true;
    else if (arg === '--poll') args.poll = true;
    else if (arg === '--save-token') args.saveToken = true;
    else if (arg === '--show-events') args.showEvents = true;
  }
  return args;
}

module.exports = {
  DEFAULT_SCOPES,
  FULL_CALENDAR_SCOPES,
  DEFAULT_TENANT,
  buildCalendarViewWindow,
  calendarScopes,
  candidateConfigPaths,
  classifyMicrosoftError,
  defaultAuthDir,
  graphGet,
  graphUrl,
  microsoftLoginUrl,
  parseArgs,
  pendingAuthPath,
  pollDeviceToken,
  probeCalendarAccess,
  readPendingAuth,
  redactSecrets,
  requestDeviceCode,
  refreshAccessToken,
  resolveGraphConfig,
  safeFileLabel,
  sanitizeTenant,
  decorateTokenRecord,
  isAccessTokenFresh,
  tokenPath,
  writeJson,
};
