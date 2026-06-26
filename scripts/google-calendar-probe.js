#!/usr/bin/env node
'use strict';

const http = require('http');
const { execSync } = require('child_process');

const {
  DEFAULT_SCOPES,
  REDIRECT_PORT,
  REDIRECT_URI,
  buildAuthUrl,
  calendarScopes,
  decorateTokenRecord,
  exchangeCodeForToken,
  isAccessTokenFresh,
  parseArgs,
  probeGoogleCalendarAccess,
  redactSecrets,
  refreshAccessToken,
  resolveGoogleCredentials,
  tokenPath,
  writeJson,
} = require('./lib/google-calendar-probe');

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    // The URL is printed either way.
  }
}

function captureAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<h2>Google Calendar linked.</h2><p>You can close this tab.</p>');
        server.close();
        resolve(code);
      } else {
        res.end('<h2>Google Calendar authorization failed.</h2><p>' + (error || 'PRIVATE_NAME error') + '</p>');
        server.close();
        reject(new Error('Google OAuth failed: ' + (error || 'ExampleCo')));
      }
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log('[google-calendar] waiting for Google redirect on ' + REDIRECT_URI);
    });
  });
}

async function loadFreshToken(record, credentials) {
  if (isAccessTokenFresh(record)) return record;
  if (!record.token || !record.token.refresh_token) {
    throw new Error('Saved Google Calendar token has no refresh_token. Run --setup again.');
  }
  const refreshed = await refreshAccessToken({
    clientId: record.clientId || credentials.clientId,
    clientSecret: record.clientSecret || credentials.clientSecret,
    refreshToken: record.token.refresh_token,
  });
  if (!refreshed.refresh_token) refreshed.refresh_token = record.token.refresh_token;
  return decorateTokenRecord({
    accountLabel: record.accountLabel,
    clientId: record.clientId || credentials.clientId,
    clientSecret: record.clientSecret || credentials.clientSecret,
    scopes: record.scopes || DEFAULT_SCOPES,
    token: refreshed,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = resolveGoogleCredentials();
  const file = tokenPath(process.env, args.accountLabel);

  if (!credentials.clientId || !credentials.clientSecret) {
    console.error('[google-calendar] missing Google OAuth credentials');
    console.error('Expected ~/.secrets/gmail_oauth_credentials.json or env GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET.');
    process.exitCode = 2;
    return;
  }

  if (args.printUrl) {
    console.log(buildAuthUrl({ clientId: credentials.clientId, scopes: calendarScopes({ write: args.write }) }));
    return;
  }

  let record = null;
  try {
    record = require('fs').existsSync(file) ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : null;
  } catch {
    record = null;
  }

  if (args.setup || !record) {
    const scopes = calendarScopes({ write: args.write });
    const authUrl = buildAuthUrl({ clientId: credentials.clientId, scopes });
    console.log(
      args.write
        ? '[google-calendar] Authorize personal Google Calendar read/write event access.'
        : '[google-calendar] Authorize personal Google Calendar read access.',
    );
    console.log(authUrl);
    openBrowser(authUrl);
    const code = await captureAuthCode();
    const token = await exchangeCodeForToken({
      code,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    record = decorateTokenRecord({
      accountLabel: args.accountLabel,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      scopes,
      token,
    });
    writeJson(file, record);
    console.log('[google-calendar] token saved:', file);
  } else {
    record = await loadFreshToken(record, credentials);
    writeJson(file, record);
  }

  const probe = await probeGoogleCalendarAccess({
    accessToken: record.token.access_token,
    days: args.days,
    includeEvents: args.showEvents,
  });
  console.log(JSON.stringify(redactSecrets(probe), null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[google-calendar] failed:', err.message || err);
    if (err.payload) console.error(JSON.stringify(redactSecrets(err.payload), null, 2));
    process.exit(1);
  });
}
