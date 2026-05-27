#!/usr/bin/env node
// Rebuild data/briefing-action-items.json from a current Gmail inbox pull.
//
// This is the missing mechanical counterpart to the daily-gmail-scan skill:
// the briefing must not clear the Action Items card just because an old JSON
// file was reply-verified. A clean card requires a current source rebuild.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadStandingReminders, mergeStandingIntoCommitments } = require('./lib/standing-reminders');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_PATH = path.join(REPO, 'data', 'briefing-action-items.json');
const LOG_PATH = path.join(REPO, 'data', 'agent', 'action-items-regenerator.jsonl');
const LUKE_EMAIL = 'luke.d.baer@gmail.com';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function log(row) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function parseJsonArray(stdout) {
  const raw = String(stdout || '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  return JSON.parse(raw.slice(start, end + 1));
}

function fetchRecentMessages(limit) {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(REPO, 'scripts', 'fetch-recent-gmail.py');
  const result = spawnSync(python, [script, String(limit)], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 4 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `exit ${result.status}`).slice(-1000);
    throw new Error(`fetch-recent-gmail.py failed: ${msg}`);
  }
  return parseJsonArray(result.stdout);
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€/g, '"')
    .replace(/â€”|â€“/g, ' - ')
    .replace(/â€‹/g, '')
    .replace(/=C2=A0/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&mdash;|&ndash;/gi, ' - ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanText(text, max = 700) {
  const noHtml = decodeEntities(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]{1,80}\]\(https?:\/\/[^)]+\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return noHtml.slice(0, max).trim();
}

function senderName(from) {
  const s = decodeEntities(from || '').trim();
  const m = s.match(/^"?([^"<]+)"?\s*</);
  return (m ? m[1] : s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || 'Unknown sender';
}

function emailAddress(raw) {
  const s = String(raw || '').toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : '';
}

function domainOf(raw) {
  const addr = emailAddress(raw);
  return addr.includes('@') ? addr.split('@')[1] : '';
}

function slug(text, max = 72) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'gmail-item';
}

function isoDate(raw) {
  const ms = Date.parse(raw || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function daysOld(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function firstSentence(text, max = 240) {
  const clean = cleanText(text, max + 120);
  const m = clean.match(/^(.{40,}?[.!?])\s+/);
  const s = (m ? m[1] : clean).slice(0, max).trim();
  return s || 'Recent Gmail message needs a current human review.';
}

const PROMO_RE = /\b(unsubscribe|view in browser|privacy notice|terms & conditions|limited time|shop now|shop|sale|free gift|gift alert|gifts for|personalized gift|deal|deals|cash bonus|cashback|pay less|bonus points|earn up to|offer disappears|rental car|car's value|credit score|webinar|newsletter|digest|promotion|sponsor|trial ended|market your business|coupon|off\b|address book|did you know|commercial auto|small business insurance|transaction history|receipt for payment|receipt|is hiring|job alert|product director|delivery update|shipped:|your order|order update)\b/i;
const HARD_PROMO_SUBJECT_RE = /\b(receipt for payment|weekend rundown|retired yet|bonus points|coupon|personalized gift|gifts? for|cashback|pay less|deals?|credit score|car's value|is hiring|job alert|product director|delivery update|shipped:|your order|order update|off\b)\b/i;
const BULK_SENDER_RE = /\b(no-?reply|donotreply|marketing|newsletter|notifications?|updates?|support@primallifeorganics|constantcontact|meetup|substack|medium|quora|noreply)\b/i;
const HUMAN_ASK_RE = /\b(please|can you|could you|would you|let me know|please reply|please respond|confirm|approve|approval|review|sign|send me|send over|follow up|following up|checking in|schedule|scheduling|calendar|introduction|intro)\b/i;
const SYSTEM_ACTION_RE = /\b(action required|needs your attention|payment failed|past due|federal notice|policy needs|complete your policy|renewal|invoice|bill is available|e-statement|statement is now available|document available|uploaded|shared|data room)\b/i;

function isFromLuke(msg) {
  return emailAddress(msg.from) === LUKE_EMAIL;
}

function isCalendarOrMeetingArtifact(msg) {
  const subject = cleanText(msg.subject || '', 240);
  const body = cleanText(msg.body || '', 1500);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const hasCalendarAttachment = attachments.some((att) =>
    /text\/calendar|application\/ics/i.test(att.content_type || '') || /\.ics$/i.test(att.filename || ''));
  const meetingChrome = /\b(Microsoft Teams|Meeting ID|Join the meeting|Add to calendar|Google Calendar|Outlook Calendar|RSVP)\b/i.test(body);
  const meetingSubject = /\b(meeting recap|steering committee|calendar|invitation|invite|event)\b/i.test(subject);
  const explicitAsk = /\b(Luke,?\s+please|please\s+(?:confirm|reply|respond|send|review)|can you|could you|would you|let me know|need you to|are you able to)\b/i.test(body);
  return (hasCalendarAttachment || (meetingSubject && meetingChrome)) && !explicitAsk;
}

function isLikelyActionable(msg) {
  const subject = cleanText(msg.subject || '', 240);
  const body = cleanText(msg.body || '', 1200);
  const combined = `${subject}\n${body}`;
  if (!subject || isFromLuke(msg)) return false;
  if (isCalendarOrMeetingArtifact(msg)) return false;
  if (/^(accepted|declined|tentative|updated|canceled):/i.test(subject)) return false;
  if (HARD_PROMO_SUBJECT_RE.test(subject)) return false;
  const hasHumanAsk = HUMAN_ASK_RE.test(combined);
  const hasSystemAction = SYSTEM_ACTION_RE.test(combined);
  if (!hasHumanAsk && !hasSystemAction) return false;

  const from = `${msg.from || ''} ${domainOf(msg.from)}`;
  if (PROMO_RE.test(combined) && !hasSystemAction) return false;
  if (BULK_SENDER_RE.test(from) && !hasSystemAction) return false;
  if (/klaviyo|constantcontact|mailchimp|sendgrid|geopod-ismtpd/i.test(String(msg.message_id || '')) && !hasSystemAction) return false;
  if (/^(re|fwd?):/i.test(subject) && /thanks|thank you|received|got it/i.test(body)) return false;
  return true;
}

function priorityFor(msg) {
  const s = `${msg.subject || ''}\n${msg.body || ''}`;
  if (/action required|past due|payment failed|federal notice|deadline|due today|needs your attention/i.test(s)) return 1;
  if (/please|can you|could you|review|approve|sign|confirm|quote|data room/i.test(s)) return 2;
  return 3;
}

// Verb-led exec summary per feedback_gmail_summary_labels.md: every Gmail item
// must read "Reply to <person> re: <topic>" or "Review <topic> from <person>",
// never the raw email body and never internal schema terms like "open commitment".
function execSummary(from, subject, body, age) {
  const combined = `${subject}\n${body}`;
  const isHumanAsk = /(please reply|please respond|let me know|when works|got time|are you available|can you|could you|would you|reply when|introduce|introduction|intro\b|follow up|following up|checking in)/i.test(combined);
  const isFinancialNotice = /(payment failed|past due|federal notice|action required|needs your attention|deadline|due today|invoice|bill is available|e-statement|statement is now available|renewal)/i.test(combined);
  const subjectShort = subject.replace(/^(re|fwd?):\s*/i, '').slice(0, 80);
  const ageNote = age === 0 ? 'today' : `${age}d old`;
  if (isFinancialNotice) {
    return `Review "${subjectShort}" from ${from} (${ageNote})`;
  }
  if (isHumanAsk) {
    return `Reply to ${from} re: "${subjectShort}" (${ageNote})`;
  }
  return `Reply to ${from} re: "${subjectShort}" (${ageNote})`;
}

function buildItem(msg, rank) {
  const sentAt = isoDate(msg.date);
  const subject = cleanText(msg.subject || '(no subject)', 180);
  const from = senderName(msg.from);
  const body = cleanText(msg.body || '', 1200);
  const threadId = slug(`${from}-${subject}`);
  const gmailUrl = 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(`subject:"${subject.slice(0, 100)}"`);
  const preview = firstSentence(body, 260);
  const age = daysOld(sentAt);
  return {
    rank,
    person: from,
    subject,
    threadId,
    sentAt,
    daysOld: age,
    summary: execSummary(from, subject, body, age),
    preview,
    gmailUrl,
    source: 'gmail-imap-current-inbox',
    sourceMessageId: msg.message_id || msg.id || '',
  };
}

function existingDismissedSignatures(existing) {
  const replied = new Set();
  for (const item of existing.unansweredEmails || []) {
    if (!item.repliedAt || !item.sentAt) continue;
    const r = Date.parse(item.repliedAt);
    const s = Date.parse(item.sentAt);
    if (Number.isFinite(r) && Number.isFinite(s) && r > s) {
      replied.add(`${slug(item.person)}|${slug(item.subject)}`);
    }
  }
  return replied;
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeActionArtifact(messages, options) {
  const existing = loadExisting();
  const repliedSigs = existingDismissedSignatures(existing);
  const seen = new Set();
  const candidates = [];
  for (const msg of messages) {
    if (!isLikelyActionable(msg)) continue;
    const sig = `${slug(senderName(msg.from))}|${slug(msg.subject)}`;
    if (seen.has(sig) || repliedSigs.has(sig)) continue;
    seen.add(sig);
    candidates.push(msg);
  }
  candidates.sort((a, b) => {
    const p = priorityFor(a) - priorityFor(b);
    if (p) return p;
    return Date.parse(b.date || '') - Date.parse(a.date || '');
  });
  const unansweredEmails = candidates.slice(0, options.maxItems).map((msg, ix) => buildItem(msg, ix + 1));
  const now = new Date().toISOString();
  const output = {
    generatedAt: now,
    lastFullReviewAt: now,
    generatedBy: `regenerate-action-items.js current Gmail inbox rebuild on ${now}; fetched ${messages.length} recent inbox messages, filtered ${candidates.length} actionable candidates, wrote ${unansweredEmails.length} current items. Reply verifier runs immediately after this write.`,
    reviewWindow: {
      date: options.date,
      fetchedMessages: messages.length,
      actionableCandidates: candidates.length,
      maxItems: options.maxItems,
      method: 'IMAP INBOX current pull plus sent-mail reply verifier',
    },
    unansweredEmails,
    openCommitments: mergeStandingIntoCommitments([], loadStandingReminders(), new Date()),
    supersededCommitments: Array.isArray(existing.supersededCommitments) ? existing.supersededCommitments : [],
    recentActivity: [],
    falseFlags: [],
  };
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  return output;
}

function runReplyVerifier() {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(REPO, 'scripts', 'verify-action-item-replies.py');
  const result = spawnSync(python, [script, '--repo', REPO], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 4 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function dropVerifiedReplies() {
  const data = loadExisting();
  const kept = [];
  const replied = [];
  for (const item of data.unansweredEmails || []) {
    const r = Date.parse(item.repliedAt || '');
    const s = Date.parse(item.sentAt || '');
    if (Number.isFinite(r) && Number.isFinite(s) && r > s) replied.push(item);
    else kept.push(item);
  }
  data.unansweredEmails = kept.map((item, ix) => ({ ...item, rank: ix + 1 }));
  data.recentActivity = [
    ...(Array.isArray(data.recentActivity) ? data.recentActivity : []),
    ...replied.map((item) => ({
      type: 'replied-action-item',
      person: item.person,
      subject: item.subject,
      repliedAt: item.repliedAt,
      note: 'Dropped from unansweredEmails by regenerate-action-items.js after sent-mail verification.',
    })),
  ].slice(-50);
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return replied.length;
}

function main() {
  const date = argValue('--date', todayCt());
  const limit = Number(argValue('--limit', process.env.ACTION_ITEMS_GMAIL_LIMIT || '300'));
  const maxItems = Number(argValue('--max-items', process.env.ACTION_ITEMS_MAX_ITEMS || '10'));
  const dryRun = process.argv.includes('--dry-run');
  const skipReplyVerify = process.argv.includes('--skip-reply-verify');

  const messages = fetchRecentMessages(limit);
  const artifact = writeActionArtifact(messages, { date, maxItems });
  let verifier = { ok: true, skipped: true };
  let droppedReplies = 0;
  if (!dryRun && !skipReplyVerify) {
    verifier = runReplyVerifier();
    if (verifier.ok) droppedReplies = dropVerifiedReplies();
  }
  const summary = {
    ok: verifier.ok !== false,
    date,
    fetchedMessages: messages.length,
    writtenItems: artifact.unansweredEmails.length,
    droppedReplies,
    verifier,
    output: DATA_PATH,
  };
  log({ event: 'regenerate-finish', ...summary });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    log({ event: 'regenerate-error', error: e.message || String(e) });
    console.error('[regenerate-action-items] ' + (e.message || e));
    process.exit(1);
  }
}

module.exports = {
  isLikelyActionable,
  buildItem,
  writeActionArtifact,
};
