#!/usr/bin/env node
'use strict';

// Creates UNSENT Gmail reply drafts for direct asks unanswered past 7 days.
// Never sends. Usage: node scripts/pre-draft-replies.js [--data-dir <dir>] [--cap 5]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPreDraft, DAILY_CAP } = require('./lib/pre-drafted-replies');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function b64url(text) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function realGmail() {
  const { google } = require('googleapis');
  const secretDir = process.env.GMAIL_SECRETS_DIR || path.join(os.homedir(), '.secrets');
  const creds = JSON.parse(
    fs.readFileSync(path.join(secretDir, 'gmail_oauth_credentials.json'), 'utf8'),
  );
  const c = creds.installed || creds.web || creds;
  const auth = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost:9854');
  auth.setCredentials(
    JSON.parse(fs.readFileSync(path.join(secretDir, 'gmail_oauth_token.json'), 'utf8')),
  );
  const gmail = google.gmail({ version: 'v1', auth });
  const header = (msg, name) => {
    const h = ((msg.payload && msg.payload.headers) || []).find((x) => x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  return {
    async findThread({ threadId, from, subject }) {
      let id = threadId;
      if (!id) {
        const q = `from:${from} subject:"${String(subject || '').replace(/"/g, '').slice(0, 100)}"`;
        const list = await gmail.users.threads.list({ userId: 'me', q, maxResults: 1 });
        id = list.data.threads && list.data.threads[0] && list.data.threads[0].id;
      }
      if (!id) return null;
      let thread;
      try {
        thread = await gmail.users.threads.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References', 'From', 'To', 'Cc'],
        });
      } catch {
        return null;
      }
      const msgs = thread.data.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const participants = msgs.flatMap((m) => ['from', 'to', 'cc'].map((n) => header(m, n)));
      const messageId = header(last, 'message-id');
      return {
        threadId: thread.data.id,
        messageIdHeader: messageId,
        references: [header(last, 'references'), messageId].filter(Boolean).join(' '),
        participants,
        lastFromMe: (last.labelIds || []).includes('SENT'),
      };
    },
    async createDraft({ to, subject, body, threadId, inReplyTo, references }) {
      const lines = [`To: ${to}`, `Subject: ${subject}`];
      if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${references}`);
      lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '');
      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: b64url(lines.join('\r\n') + '\r\n' + body), threadId } },
      });
      const tid = (res.data.message && res.data.message.threadId) || threadId;
      return { draftId: res.data.id, url: `https://mail.google.com/mail/u/0/#inbox/${tid}` };
    },
  };
}

async function main() {
  const dataDir = arg('--data-dir') || process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
  const cap = Number(arg('--cap')) || DAILY_CAP;
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'briefing-action-items.json'), 'utf8'));
  const result = await runPreDraft({
    dataDir,
    items: raw.unansweredEmails || [],
    gmail: realGmail(),
    cap,
  });
  console.log(`[pre-draft-replies] created ${result.created.length}, skipped ${result.skipped.length}`);
  for (const s of result.skipped) console.log(`  skipped ${s.key}: ${s.reason}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[pre-draft-replies] ${e.message}`);
    process.exit(0); // best-effort: never fail the briefing refresh
  });
}
