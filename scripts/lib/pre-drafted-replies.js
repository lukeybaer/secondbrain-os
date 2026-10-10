'use strict';

// Pre-drafted replies: a direct human ask that has sat unanswered past 7 days
// gets an UNSENT Gmail draft (never a send), signed as Amy. The draft link is
// stored in a ledger and attached to the Action Items card item. Pure logic is
// separated from Gmail I/O: the runner takes an injected `gmail` adapter
// ({ findThread, createDraft }) so tests never touch a real mailbox.

const fs = require('fs');
const path = require('path');
const { assertOutboundIdentity } = require('./outbound-identity');

const MIN_AGE_DAYS = 7;
const DAILY_CAP = 5;
const SIGNATURE = 'Amy\nExecutive Assistant to PRIVATE_NAME';
const ExampleCo_RE = /@(?:[\w-]+\.)*ExampleCo\.com\b/i;

function ledgerPath(dataDir) {
  return path.join(dataDir, 'agent', 'pre-drafted-replies.json');
}

function readLedger(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(dataDir), 'utf8'));
    return parsed && typeof parsed.drafts === 'object' && parsed.drafts ? parsed : { drafts: {} };
  } catch {
    return { drafts: {} };
  }
}

function writeLedger(dataDir, ledger) {
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// Stable identity: the source message id when present, else sender + subject.
function preDraftKey(item = {}) {
  const id = String(item.sourceMessageId || item.message_id || item.id || '').trim();
  if (id) return `id:${id}`;
  const who = String(item.senderAddress || item.person || item.from || '');
  return `sig:${slug(who)}|${slug(item.subject)}`;
}

function senderAddress(item) {
  if (item.senderAddress) return String(item.senderAddress).trim();
  const from = String(item.from || '');
  const m = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  return m ? m[1].trim() : '';
}

function isExampleCoItem(item) {
  return [item.senderAddress, item.from, item.gmailUrl, item.subject].some((v) =>
    ExampleCo_RE.test(String(v || '')),
  );
}

// An item qualifies only when a real human asked ExampleCo something directly, the
// ask is older than the threshold, and nobody has replied or resolved it.
function isDraftEligible(item, { minAgeDays = MIN_AGE_DAYS } = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.repliedAt || item.resolvedAt || item.dismissedAt) return false;
  const o = item.ownership || {};
  if (!(o.senderRole === 'human' && o.explicitAsk === true && o.nextMoveOwner === 'ExampleCo')) {
    return false;
  }
  if (!(Number(item.daysOld) > minAgeDays)) return false;
  if (!senderAddress(item) || isExampleCoItem(item)) return false;
  return true;
}

function localDay(now) {
  return now.toISOString().slice(0, 10);
}

function selectCandidates(items, { ledger = { drafts: {} }, now = new Date(), cap = DAILY_CAP } = {}) {
  const today = localDay(now);
  const usedToday = Object.values(ledger.drafts || {}).filter(
    (d) => String(d.createdAt || '').slice(0, 10) === today,
  ).length;
  const room = Math.max(0, cap - usedToday);
  const picked = [];
  const seen = new Set();
  const ordered = [...(items || [])].sort((a, b) => Number(b.daysOld || 0) - Number(a.daysOld || 0));
  for (const item of ordered) {
    if (picked.length >= room) break;
    if (!isDraftEligible(item)) continue;
    const key = preDraftKey(item);
    if (seen.has(key) || (ledger.drafts || {})[key]) continue;
    seen.add(key);
    picked.push({ key, item });
  }
  return picked;
}

function firstName(item) {
  const name = String(item.person || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'.-]*$/.test(name) ? name : '';
}

// Uses the stored suggested reply when one exists; otherwise a neutral
// holding note that makes no commitment for ExampleCo. ExampleCo edits before sending.
function buildDraftBody(item) {
  const greeting = firstName(item) ? `Hi ${firstName(item)},` : 'Hello,';
  const subject = String(item.subject || '').trim();
  const core =
    String(item.suggestedReply || '').trim() ||
    `Thank you for your message${subject ? ` about "${subject}"` : ''}, and apologies for the delay in responding. ExampleCo has your note and I am following up so it is not lost. We will come back to you with a full answer.`;
  return `${greeting}\n\n${core}\n\n${SIGNATURE}\n`;
}

function replySubject(subject) {
  const s = String(subject || '(no subject)').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// Gmail URLs of the form .../#all/<hex id> carry a usable thread id.
function threadIdFromUrl(url) {
  const m = String(url || '').match(/#(?:all|inbox|sent|label\/[^/]+)\/([0-9a-f]{12,20})\b/i);
  return m ? m[1] : '';
}

async function runPreDraft({ dataDir, items, gmail, now = new Date(), cap = DAILY_CAP }) {
  const ledger = readLedger(dataDir);
  const picks = selectCandidates(items, { ledger, now, cap });
  const result = { created: [], skipped: [] };
  for (const { key, item } of picks) {
    try {
      const thread = await gmail.findThread({
        threadId: threadIdFromUrl(item.gmailUrl),
        from: senderAddress(item),
        subject: item.subject,
      });
      if (!thread || !thread.threadId) {
        result.skipped.push({ key, reason: 'thread-not-found' });
        continue;
      }
      const participants = Array.isArray(thread.participants) ? thread.participants : [];
      if (participants.some((p) => ExampleCo_RE.test(String(p)))) {
        result.skipped.push({ key, reason: 'ExampleCo-thread' });
        continue;
      }
      if (thread.lastFromMe) {
        result.skipped.push({ key, reason: 'already-replied' });
        continue;
      }
      const body = buildDraftBody(item);
      assertOutboundIdentity({ body });
      const draft = await gmail.createDraft({
        to: senderAddress(item),
        subject: replySubject(item.subject),
        body,
        threadId: thread.threadId,
        inReplyTo: thread.messageIdHeader || '',
        references: thread.references || '',
      });
      ledger.drafts[key] = {
        draftId: draft.draftId,
        url: draft.url,
        threadId: thread.threadId,
        subject: String(item.subject || '').slice(0, 160),
        createdAt: now.toISOString(),
      };
      writeLedger(dataDir, ledger);
      result.created.push({ key, url: draft.url });
    } catch (error) {
      result.skipped.push({
        key,
        reason: `error: ${String((error && error.message) || error).slice(0, 120)}`,
      });
    }
  }
  return result;
}

// Used by the briefing build: attach the stored draft link to a card item.
function draftUrlFor(ledger, key) {
  const entry = ledger && ledger.drafts && ledger.drafts[key];
  return entry && typeof entry.url === 'string' ? entry.url : '';
}

module.exports = {
  MIN_AGE_DAYS,
  DAILY_CAP,
  SIGNATURE,
  readLedger,
  preDraftKey,
  isDraftEligible,
  selectCandidates,
  buildDraftBody,
  replySubject,
  threadIdFromUrl,
  runPreDraft,
  draftUrlFor,
};
