#!/usr/bin/env node
/**
 * gmail-attach.js , Attach files to an existing Gmail draft.
 *
 * Usage:
 *   node scripts/gmail-attach.js --draft-id <id> --files <path1> [<path2> ...]
 *
 * First run: performs a one-time Google OAuth2 device flow. Stores the
 * refresh token in ~/.secrets/gmail_oauth_token.json. All future runs
 * use the stored token with no user interaction.
 *
 * The Gmail API credentials (client_id + client_secret) come from:
 *   ~/.secrets/gmail_oauth_credentials.json
 * or env vars GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET.
 *
 * Format of ~/.secrets/gmail_oauth_credentials.json:
 *   { "client_id": "...", "client_secret": "..." }
 *
 * Quick start (one-time):
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable the Gmail API
 *   3. Create OAuth 2.0 credentials (Desktop app) -> download JSON
 *   4. Extract client_id + client_secret from the downloaded JSON
 *   5. Save to ~/.secrets/gmail_oauth_credentials.json
 *   6. Run: node scripts/gmail-attach.js --setup
 *      -> prints a URL, the owner visits it, pastes the code back
 *   7. Refresh token saved to ~/.secrets/gmail_oauth_token.json
 *   8. Done , all future runs are fully autonomous.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const readline = require('readline');
const { google } = require('googleapis');

// ── Paths ────────────────────────────────────────────────────────────────────
const SECRETS_DIR = path.join(os.homedir(), '.secrets');
const CREDS_FILE = path.join(SECRETS_DIR, 'gmail_oauth_credentials.json');
const TOKEN_FILE = path.join(SECRETS_DIR, 'gmail_oauth_token.json');

// Scopes needed: read drafts + modify drafts
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

// ── Credential loading ────────────────────────────────────────────────────────
function loadCredentials() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (clientId && clientSecret) return { client_id: clientId, client_secret: clientSecret };

  if (!fs.existsSync(CREDS_FILE)) {
    console.error(`
ERROR: No Gmail OAuth2 credentials found.

Create ~/.secrets/gmail_oauth_credentials.json with:
  { "client_id": "...", "client_secret": "..." }

Steps:
  1. Go to https://console.cloud.google.com
  2. Create project -> Enable Gmail API
  3. APIs & Services -> Credentials -> Create OAuth 2.0 Client ID (Desktop)
  4. Download JSON, extract client_id + client_secret
  5. Save to: ${CREDS_FILE}
  6. Re-run: node scripts/gmail-attach.js --setup

Or set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables.
`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  // Support both raw format and Google's downloaded JSON format
  if (raw.installed)
    return { client_id: raw.installed.client_id, client_secret: raw.installed.client_secret };
  if (raw.web) return { client_id: raw.web.client_id, client_secret: raw.web.client_secret };
  return raw;
}

// ── OAuth2 client factory ─────────────────────────────────────────────────────
// Uses http://localhost redirect , starts a temp local server to capture the code
const http = require('http');
const { execSync } = require('child_process');

const AUTH_PORT = 9854; // Fixed port for localhost redirect
const REDIRECT_URI = `http://localhost:${AUTH_PORT}`;

function buildOAuth2Client() {
  const { client_id, client_secret } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

// Starts a one-shot local HTTP server, returns the 'code' query param from the redirect
// No timeout , waits until user completes the browser auth flow
function captureAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<h2>Authorization successful!</h2><p>You can close this tab.</p>');
        server.close();
        resolve(code);
      } else {
        res.end(`<h2>Authorization failed</h2><p>${error || 'Unknown error'}</p>`);
        server.close();
        reject(new Error(`Auth failed: ${error || 'unknown'}`));
      }
    });
    server.on('error', (err) => reject(err));
    server.listen(AUTH_PORT, '127.0.0.1', () => {
      console.log(`Listening on http://localhost:${AUTH_PORT} , waiting for Google redirect...`);
    });
  });
}

// ── First-time authorization flow (localhost redirect + auto browser open) ────
async function authorize(oauth2Client) {
  if (fs.existsSync(TOKEN_FILE)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    oauth2Client.setCredentials(token);
    // Refresh if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(credentials, null, 2));
    }
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nFirst-time Gmail authorization required.\n');
  console.log('Opening browser for Google OAuth2 consent...');
  console.log('\nIf browser does not open, visit this URL manually:\n');
  console.log('   ' + authUrl + '\n');

  // Try to open browser automatically
  try {
    if (process.platform === 'win32') execSync(`start "" "${authUrl}"`, { stdio: 'ignore' });
    else if (process.platform === 'darwin') execSync(`open "${authUrl}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${authUrl}"`, { stdio: 'ignore' });
  } catch (_) {
    /* ignore , URL printed above */
  }

  console.log('Waiting for Google OAuth2 redirect on http://localhost:' + AUTH_PORT + '...');
  const code = await captureAuthCode();

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('Token saved to', TOKEN_FILE);
  return oauth2Client;
}

// ── MIME construction ─────────────────────────────────────────────────────────
function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return map[ext] || 'application/octet-stream';
}

function buildMimeMessage(existingParts, attachments) {
  const boundary = 'boundary_' + Date.now() + '_' + Math.random().toString(36).slice(2);

  // Extract headers and body from the existing message
  const { headers, textBody, htmlBody } = existingParts;

  const lines = [];

  // Top-level headers
  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  // Use multipart/mixed if we have attachments
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('MIME-Version: 1.0');
  lines.push('');

  // Body part
  const innerBoundary = 'inner_' + boundary;
  if (htmlBody) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${innerBoundary}"`);
    lines.push('');
    if (textBody) {
      lines.push(`--${innerBoundary}`);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('');
      lines.push(textBody);
    }
    lines.push(`--${innerBoundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(htmlBody);
    lines.push(`--${innerBoundary}--`);
  } else if (textBody) {
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(textBody);
  }

  // Attachment parts
  for (const att of attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    // Split base64 into 76-char lines per RFC 2822
    const b64 = att.data;
    for (let i = 0; i < b64.length; i += 76) {
      lines.push(b64.slice(i, i + 76));
    }
  }

  lines.push(`--${boundary}--`);

  return lines.join('\r\n');
}

// ── Extract parts from existing draft message ─────────────────────────────────
function extractMessageParts(gmailMessage) {
  const payload = gmailMessage.payload;
  const headers = [];

  // Headers to preserve (skip Content-Type + MIME-Version , we rebuild these)
  const SKIP_HEADERS = new Set(['content-type', 'mime-version', 'content-transfer-encoding']);
  for (const h of payload.headers || []) {
    if (!SKIP_HEADERS.has(h.name.toLowerCase())) {
      headers.push([h.name, h.value]);
    }
  }

  let textBody = '';
  let htmlBody = '';

  function extractBodies(part) {
    const mimeType = (part.mimeType || '').toLowerCase();
    if (mimeType === 'text/plain' && part.body?.data) {
      textBody = Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (mimeType === 'text/html' && part.body?.data) {
      htmlBody = Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (mimeType.startsWith('multipart/') && part.parts) {
      for (const sub of part.parts) extractBodies(sub);
    }
    // Top-level body (simple non-multipart messages)
    if (
      !mimeType.startsWith('multipart/') &&
      mimeType !== 'text/plain' &&
      mimeType !== 'text/html' &&
      part.body?.data
    ) {
      textBody = Buffer.from(part.body.data, 'base64').toString('utf8');
    }
  }

  // Handle simple messages (no parts array at top level)
  if (!payload.parts && payload.body?.data) {
    const mt = (payload.mimeType || '').toLowerCase();
    if (mt === 'text/html') htmlBody = Buffer.from(payload.body.data, 'base64').toString('utf8');
    else textBody = Buffer.from(payload.body.data, 'base64').toString('utf8');
  } else if (payload.parts) {
    for (const p of payload.parts) extractBodies(p);
  }

  return { headers, textBody, htmlBody };
}

// ── Main logic ────────────────────────────────────────────────────────────────
async function attachFiles(draftId, filePaths) {
  const oauth2Client = buildOAuth2Client();
  await authorize(oauth2Client);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // 1. Fetch the existing draft
  console.log(`Fetching draft ${draftId}...`);
  const draftRes = await gmail.users.drafts.get({
    userId: 'me',
    id: draftId,
    format: 'full',
  });

  const draft = draftRes.data;
  const messageId = draft.message.id;
  const threadId = draft.message.threadId;
  console.log(`Draft fetched. Message ID: ${messageId}, Thread: ${threadId}`);

  // 2. Extract existing content
  const existingParts = extractMessageParts(draft.message);
  console.log(
    `Body extracted. Text: ${existingParts.textBody.length} chars, HTML: ${existingParts.htmlBody.length} chars`,
  );

  // 3. Load attachment files
  const attachments = [];
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    const data = fs.readFileSync(filePath).toString('base64');
    const filename = path.basename(filePath);
    const mimeType = guessMimeType(filename);
    attachments.push({ filename, mimeType, data });
    console.log(`Loaded: ${filename} (${mimeType}, ${Math.round((data.length * 0.75) / 1024)} KB)`);
  }

  // 4. Build the full MIME message
  const mimeMessage = buildMimeMessage(existingParts, attachments);

  // 5. base64url encode it
  const raw = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // 6. Update the draft
  console.log('Updating draft with attachments...');
  const updateRes = await gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: {
      id: draftId,
      message: {
        id: messageId,
        threadId: threadId,
        raw: raw,
      },
    },
  });

  console.log(`Draft updated successfully. Draft ID: ${updateRes.data.id}`);
  console.log(`Attachments added: ${attachments.map((a) => a.filename).join(', ')}`);
  return updateRes.data;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup') || args.includes('--auth')) {
    const oauth2Client = buildOAuth2Client();
    await authorize(oauth2Client);
    console.log('Setup complete. You can now use gmail-attach.js without any browser interaction.');
    return;
  }

  // Parse args
  let draftId = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--draft-id' && args[i + 1]) {
      draftId = args[++i];
    } else if (args[i] === '--files') {
      // Collect all remaining args as file paths
      for (let j = i + 1; j < args.length; j++) {
        if (args[j].startsWith('--')) break;
        files.push(args[j]);
      }
    }
  }

  if (!draftId) {
    console.error(
      'Usage: node scripts/gmail-attach.js --draft-id <id> --files <path1> [<path2> ...]',
    );
    console.error('       node scripts/gmail-attach.js --setup');
    process.exit(1);
  }

  if (files.length === 0) {
    console.error('No files specified. Use --files <path1> [<path2> ...]');
    process.exit(1);
  }

  await attachFiles(draftId, files);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
