#!/usr/bin/env node
'use strict';

// Owner-only Gmail transport for the daily briefing. The recipient is always
// resolved from Gmail's authenticated `me` profile, so this scheduled path
// cannot be redirected to another human through a payload or environment
// value. It sends the same plain-text, two-link message proven by the briefing
// notifier and returns only secret-safe hashes plus Gmail message identifiers.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { google } = require('googleapis');

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function base64Url(value) {
  return Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeHeader(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`briefing email ${label} is invalid`);
  }
  return normalized;
}

function briefingEmailSubject(date) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('briefing email date is invalid');
  return `Daily briefing | ${day}`;
}

function buildBriefingEmailMessage({ to, date, text } = {}) {
  const recipient = safeHeader(to, 'recipient');
  const body = String(text || '').trim();
  if (!body) throw new Error('briefing email body is blank');
  const subject = briefingEmailSubject(date);
  return [
    `To: ${recipient}`,
    `From: ${recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

function gmailSecretPaths(env = process.env) {
  const secretsDir = String(env.GMAIL_SECRETS_DIR || path.join(os.homedir(), '.secrets'));
  return {
    credentialsFile: String(
      env.GMAIL_OAUTH_CREDENTIALS_FILE || path.join(secretsDir, 'gmail_oauth_credentials.json'),
    ),
    tokenFile: String(
      env.GMAIL_OAUTH_TOKEN_FILE || path.join(secretsDir, 'gmail_oauth_token.json'),
    ),
  };
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

async function createBriefingGmailClient({ env = process.env } = {}) {
  const { credentialsFile, tokenFile } = gmailSecretPaths(env);
  const rawCredentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  const credentials = rawCredentials.installed || rawCredentials.web || rawCredentials;
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const oauth2 = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    'http://localhost:9854',
  );
  oauth2.setCredentials(token);
  if (token.expiry_date && Number(token.expiry_date) < Date.now()) {
    const refreshed = await oauth2.refreshAccessToken();
    const next = {
      ...token,
      ...(refreshed.credentials || {}),
      refresh_token: refreshed.credentials?.refresh_token || token.refresh_token,
    };
    oauth2.setCredentials(next);
    writeJsonAtomic(tokenFile, next);
  }
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function briefingEmailLinkProof(text) {
  const body = String(text || '');
  const links = body
    .split(/\r?\n/)
    .map((line) => /^([^:\n]+):\s+(https?:\/\/\S+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ label: match[1].trim(), url: match[2] }));
  const urls = Array.from(body.matchAll(/(?:https?:\/\/|www\.)\S+/gi), (match) => match[0]);
  return {
    linkCount: urls.length,
    linkLabels: links.map((link) => link.label),
  };
}

async function sendBriefingEmail({ gmail = null, date, text, env = process.env } = {}) {
  const body = String(text || '').trim();
  const linkProof = briefingEmailLinkProof(body);
  if (
    linkProof.linkCount !== 2 ||
    linkProof.linkLabels.length !== 2 ||
    linkProof.linkLabels[0] !== 'Briefing' ||
    linkProof.linkLabels[1] !== 'Overnight report'
  ) {
    throw new Error('briefing email refused: expected exactly Briefing and Overnight report links');
  }

  const client = gmail || (await createBriefingGmailClient({ env }));
  const profile = await client.users.getProfile({ userId: 'me' });
  const recipient = safeHeader(profile?.data?.emailAddress, 'authenticated profile');
  const subject = briefingEmailSubject(date);
  const mime = buildBriefingEmailMessage({ to: recipient, date, text: body });
  const response = await client.users.messages.send({
    userId: 'me',
    requestBody: { raw: base64Url(mime) },
  });
  const messageId = String(response?.data?.id || '').trim();
  if (!messageId) throw new Error('briefing email send returned no Gmail message id');
  // The briefing mail goes only to the authenticated owner address.
  require('./outbound-send-record.js').recordOutboundSend({
    surface: 'briefing-email-out', authorization: 'owner-only', details: { message_id: messageId },
  });

  return {
    ok: true,
    channel: 'gmail',
    messageId,
    threadId: String(response?.data?.threadId || '').trim() || null,
    recipientIsAuthenticatedUser: true,
    recipientHash: sha256(recipient.toLowerCase()),
    requestTextHash: sha256(body),
    requestSubjectHash: sha256(subject),
    linkCount: linkProof.linkCount,
    linkLabels: linkProof.linkLabels,
  };
}

module.exports = {
  base64Url,
  briefingEmailLinkProof,
  briefingEmailSubject,
  buildBriefingEmailMessage,
  createBriefingGmailClient,
  gmailSecretPaths,
  sendBriefingEmail,
};
