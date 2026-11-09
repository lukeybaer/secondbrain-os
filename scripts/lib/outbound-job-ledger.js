'use strict';

// Send-once guard for the outbound job ledgers (LinkedIn DMs and invites, the
// briefing email Send). State machine audit finding #1 (owner decision): the
// job id is a hash of recipient and text and the LATEST event won, so a second
// Send click appended sender_armed after sent and the sender sent the message
// again. A crash between the click and sent left `sending`, which nothing
// treated as final either.
//
// One place now owns the rules:
//   - sent is final. A job with any sent event in its history is never armed or
//     sent again, whatever its latest event says.
//   - sending is in flight for SENDING_TTL_MS. A second click inside that window
//     is refused. Past it nobody can know whether the message went out, so the
//     job moves to outcome_unknown and waits for the owner; it never goes back to
//     armed on its own.
//   - the history check and the append happen under one file lock, so two
//     clicks at once cannot both arm. HTTP handlers use the *Async calls (they
//     wait without blocking the event loop); the sync calls are for CLI callers.
// On-disk events keep their old shape (event, status, jobId, ts, channel); the
// aliases below map every spelling already in the ledgers.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { defineStateMachine, withFileLock, withFileLockAsync } = require('./ledger-state-machine');

// A verified send takes a couple of minutes and the sender's own lock treats
// ten minutes as dead, so fifteen is past any live attempt.
const SENDING_TTL_MS = 15 * 60 * 1000;

// An HTTP request waits this long for the ledger lock (without blocking the
// event loop), then gets a retryable busy refusal instead of a long stall.
const SERVER_LOCK_WAIT_MS = 5000;

const outboundJobMachine = defineStateMachine({
  name: 'outbound-job',
  transitions: {
    // The email Send claims `sending` directly; LinkedIn arms first.
    '': ['sender_armed', 'sending'],
    sender_armed: ['sending', 'blocked'],
    sending: ['sent', 'blocked', 'outcome_unknown'],
    // A re-click re-arms a blocked job; the sender's --force sends it straight.
    blocked: ['sender_armed', 'sending'],
    // Only the owner's review (a verified sent or blocked event) leaves this state.
    outcome_unknown: ['sent', 'blocked'],
  },
  terminal: ['sent'],
  aliases: {
    local_sender_armed: 'sender_armed',
    send_attempt_started: 'sending',
    sent_verified_in_thread: 'sent',
    sent_verified_pending_invite: 'sent',
    sent_verified_gmail: 'sent',
    posted: 'sent',
    dry_run_ready: 'blocked',
    send_outcome_unknown: 'outcome_unknown',
  },
  inFlight: { sending: { ttlMs: SENDING_TTL_MS } },
});

const ts = (ev) => {
  const n = Date.parse((ev && ev.ts) || '');
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every event for one job id, in file order, from the WHOLE ledger (the tracker
 * and the dashboard only look at the last 2000 lines, which a sent event can
 * fall out of). strict: a line that names the job but does not parse throws,
 * because it might be the sent event.
 */
function readJobEvents(file, jobId, { strict = true } = {}) {
  return readLedgerEvents(file, jobId, (ev) => ev.jobId === jobId, { strict });
}

// Every event on lines naming `needle` that `keep` accepts, in file order.
function readLedgerEvents(file, needle, keep, { strict = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(needle)) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      if (strict) throw new Error(`ledger line for ${needle} is unreadable, refusing to guess its state`);
      continue;
    }
    if (ev && keep(ev)) out.push(ev);
  }
  return out;
}

/** Merge histories from two ledgers (the EC2 copy and this PC's copy) by time. */
function mergeHistories(...lists) {
  return lists
    .flat()
    .filter(Boolean)
    .map((ev, i) => [ev, i])
    .sort((a, b) => ts(a[0]) - ts(b[0]) || a[1] - b[1])
    .map(([ev]) => ev);
}

/** Current state of a job from its history. Any sent event makes it `sent`. */
function jobState(events, now = Date.now()) {
  let state = '';
  let since = '';
  let sawSent = false;
  let sentAt = '';
  for (const ev of events || []) {
    const s = outboundJobMachine.normalize((ev && (ev.status || ev.event)) || '');
    // Free-text update events carry no state; they never move the job.
    if (!s || !outboundJobMachine.isKnown(s)) continue;
    if (s === 'sent' && !sawSent) {
      sawSent = true;
      sentAt = ev.ts || '';
    }
    state = s;
    since = ev.ts || since;
  }
  if (sawSent) return { state: 'sent', sentEver: true, since: sentAt, expired: false };
  return {
    state,
    sentEver: false,
    since,
    expired: state === 'sending' && outboundJobMachine.isExpired('sending', since, now),
  };
}

const hasSent = (events) => jobState(events).sentEver;

function at(since) {
  return since ? ` at ${since}` : '';
}

/**
 * Can this job move to `target` (sender_armed for a Send click, sending for a
 * sender or email claim)? Refusals carry a code the UI and sender act on.
 */
function decideMove(events, target, { now = Date.now() } = {}) {
  const s = jobState(events, now);
  const refuse = (code, state, error, extra = {}) => ({ ok: false, code, state, error, since: s.since, ...extra });
  if (s.state === 'sent') {
    return refuse(
      'already_sent',
      'sent',
      `Already sent${at(s.since)}. This exact message to this recipient went out before, so it will not be sent again. Edit the text to send a new message.`,
    );
  }
  if (s.state === 'sending' && !s.expired) {
    return refuse(
      'send_in_progress',
      'sending',
      `Send in progress: it started${at(s.since)} and is not confirmed yet. Wait for the result before sending again.`,
    );
  }
  if (s.state === 'sending' || s.state === 'outcome_unknown') {
    return refuse(
      'outcome_unknown',
      'outcome_unknown',
      `Outcome unknown: a send started${at(s.since)} and was never confirmed, so the message may or may not have gone out. It is held for the owner's review and will not be re-sent automatically. Check the thread; edit the text to send a new message.`,
      // A stale `sending` still needs its hold event written; an existing hold does not.
      { hold: s.state === 'sending' },
    );
  }
  if (s.state === target) return { ok: true, noop: true, state: s.state };
  if (!outboundJobMachine.canTransition(s.state, target)) {
    return refuse('illegal_transition', s.state, `Job is ${s.state || 'new'}; it cannot move to ${target}.`);
  }
  return { ok: true, state: s.state };
}

/** Sender gate: only an armed job (or a blocked one under --force) may be sent. */
function decideSend(events, { now = Date.now(), force = false } = {}) {
  const d = decideMove(events, 'sending', { now });
  if (!d.ok) return d;
  if (d.state === 'sender_armed' || (force && d.state === 'blocked')) return d;
  return { ok: false, code: 'not_armed', state: d.state, error: `Job is ${d.state || 'new'}, not armed for a send.` };
}

/** Event fields that park a job for the owner's review. */
function outcomeUnknownFields(message) {
  return {
    event: 'send_outcome_unknown',
    status: 'outcome_unknown',
    error: message,
    note: 'Held for review: a send started and was never confirmed. It is not re-sent automatically.',
  };
}

function appendLines(file, channel, events, now) {
  const stamp = new Date(now).toISOString();
  fs.appendFileSync(file, events.map((ev) => JSON.stringify({ ts: stamp, channel, ...ev }) + '\n').join(''));
}

// The locked step shared by the sync and async entry points. `now` is read
// once the lock is held, so a long wait cannot leave a stale clock behind.
function applyMove({ file, jobId, channel, target, events, now }) {
  const clock = now == null ? Date.now() : now;
  const d = decideMove(readJobEvents(file, jobId), target, { now: clock });
  if (d.hold) appendLines(file, channel, [{ jobId, ...outcomeUnknownFields(d.error) }], clock);
  else if (d.ok && !d.noop) appendLines(file, channel, events, clock);
  return { ...d, jobId };
}

/**
 * Check the job's whole history and append `events` in one locked step. Returns
 * the decision; nothing is written for a refusal, except the outcome_unknown
 * hold when a stale `sending` is found. Synchronous: a contended lock blocks the
 * whole process for up to 15 s, so this is for CLI callers only. HTTP handlers
 * use moveOutboundJobAsync.
 */
function moveOutboundJob(args) {
  return withFileLock(args.file, () => applyMove(args));
}

// Runs one locked step for an HTTP handler; a lock that stays busy becomes a
// retryable ledger_busy refusal with nothing written.
async function withServerLock(file, waitMs, fn, jobId) {
  try {
    return await withFileLockAsync(file, fn, { waitMs });
  } catch (error) {
    if (!error || error.code !== 'LEDGER_BUSY') throw error;
    return {
      ok: false,
      code: 'ledger_busy',
      state: '',
      retryable: true,
      error: 'The outbound ledger is busy with another request. Nothing was sent; try again in a moment.',
      jobId,
    };
  }
}

/**
 * Async twin for HTTP handlers: waits for the lock without blocking the event
 * loop. A lock that stays busy returns a ledger_busy refusal (retryable, nothing
 * written) that the route answers as 503.
 */
async function moveOutboundJobAsync({ waitMs = SERVER_LOCK_WAIT_MS, ...args }) {
  return withServerLock(args.file, waitMs, () => applyMove(args), args.jobId);
}

/** Plain append for an outcome the caller already owns (sent, blocked). CLI only. */
function appendOutboundEvents(file, channel, events, now = Date.now()) {
  withFileLock(file, () => appendLines(file, channel, events, now));
}

/** Async twin of appendOutboundEvents for HTTP handlers; a busy lock throws LEDGER_BUSY. */
async function appendOutboundEventsAsync(file, channel, events, { waitMs = SERVER_LOCK_WAIT_MS } = {}) {
  await withFileLockAsync(file, () => appendLines(file, channel, events, Date.now()), { waitMs });
}

// One id per reply action: (recipient, cc, thread, subject, text) plus the id of
// the inbound message being answered (`replyToId`). The same click retried, or a
// double click, is the same job and stays protected. The same words sent later
// as the answer to a newer message carry a different `replyToId`, so they are a
// new job. The id has no date in it. With no `replyToId` (a send that is not an
// answer to a known message) the key is the old one and stays permanent.
function emailOutboundJobId({ to, cc, threadId, subject, text, replyToId }) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const parts = [to, cc, threadId, subject].map(norm).concat(String(text || '').trim().replace(/\s+/g, ' '));
  if (norm(replyToId)) parts.push(`reply-to:${norm(replyToId)}`);
  return `em-${crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12)}`;
}

// The reply fields a briefing email Send is pinned to at its first attempt.
const EMAIL_REPLY_FIELDS = ['threadId', 'to', 'cc', 'subject', 'replyToId', 'inReplyTo', 'references'];
const pickReply = (src) => Object.fromEntries(EMAIL_REPLY_FIELDS.map((k) => [k, String((src && src[k]) || '')]));

// To and Cc compared as address sets, so a display name is not a recipient.
function addressSet(value) {
  const found = String(value || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return [...new Set(found)].sort().join(',');
}

function sameRecipients(a, b) {
  return addressSet(a && a.to) === addressSet(b && b.to) && addressSet(a && a.cc) === addressSet(b && b.cc);
}

// One id per Send action: the dashboard card key, scoped to the card's thread.
// A page that sends no key falls back to the card's section, person and subject.
function emailActionId({ actionKey, section, itemRef, subjectHint, threadId }) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const card = norm(actionKey) ? `key:${norm(actionKey)}` : `card:${[section, itemRef, subjectHint].map(norm).join('|')}`;
  return `ea-${crypto.createHash('sha1').update(`${card}\nthread:${norm(threadId)}`).digest('hex').slice(0, 12)}`;
}

/** The first claim ever written for a Send action (its pinned reply), or null. */
function readEmailActionBinding(file, actionId) {
  const claims = readLedgerEvents(
    file,
    actionId,
    (ev) => ev.actionId === actionId && outboundJobMachine.normalize(ev.status || ev.event) === 'sending',
  );
  return claims[0] || null;
}

// The locked step behind claimEmailReplyAsync.
function applyEmailClaim({ file, actionId, reply, text, note, now }) {
  const clock = now == null ? Date.now() : now;
  const binding = readEmailActionBinding(file, actionId);
  const job = pickReply(binding || reply);
  const jobId = emailOutboundJobId({ ...job, text });
  const events = readJobEvents(file, jobId);
  const d = decideMove(events, 'sending', { now: clock });
  if (d.hold) appendLines(file, 'email', [{ jobId, actionId, ...outcomeUnknownFields(d.error) }], clock);
  if (!d.ok) return { ...d, jobId, actionId, job };
  if (binding && !sameRecipients(binding, reply)) {
    const fresh = pickReply(reply);
    const error =
      `Recipients changed: this Send was first prepared for To ${job.to || '(none)'}${job.cc ? `, Cc ${job.cc}` : ''}, ` +
      `but the thread now gives To ${fresh.to || '(none)'}${fresh.cc ? `, Cc ${fresh.cc}` : ''}. Nothing was sent. ` +
      'Reply from Gmail to choose the recipients.';
    // The refusal is written down once per distinct change. The event carries no
    // status, so it never moves the job.
    const last = events[events.length - 1];
    if (!(last && last.event === 'recipients_changed' && last.freshTo === fresh.to && last.freshCc === fresh.cc)) {
      appendLines(
        file,
        'email',
        [{ event: 'recipients_changed', jobId, actionId, to: job.to, cc: job.cc, freshTo: fresh.to, freshCc: fresh.cc, error }],
        clock,
      );
    }
    return { ok: false, code: 'recipients_changed', state: d.state, error, jobId, actionId, job };
  }
  appendLines(file, 'email', [{ event: 'send_attempt_started', status: 'sending', jobId, actionId, ...job, note }], clock);
  return { ...d, jobId, actionId, job };
}

/**
 * The briefing email Send claim, bound to the action the owner clicked (review F5,
 * 2026-11-03). The first attempt for `actionId` fixes the message answered, the
 * recipients and the thread; every retry of that action reuses them, so a
 * message that lands in the thread meanwhile (our own sent reply included)
 * cannot change the job key or who gets the email. The job's history decides
 * first: sent, in flight and held stay refused. A retry whose freshly computed
 * recipients (`reply`) differ from the pinned ones is refused and recorded.
 * `job` in the result holds the reply fields the send must use.
 */
async function claimEmailReplyAsync({ waitMs = SERVER_LOCK_WAIT_MS, ...args }) {
  return withServerLock(args.file, waitMs, () => applyEmailClaim(args), '');
}

// A refusal before the network, or a 4xx, means nothing was sent and a retry is
// safe. Any other failure may have followed a delivered message.
function emailFailureStatus(err) {
  const msg = String((err && err.message) || '');
  const code = Number(err && (err.code || err.status));
  return /^sendGmailReply refused/.test(msg) || (code >= 400 && code < 500) ? 'blocked' : 'outcome_unknown';
}

module.exports = {
  SENDING_TTL_MS,
  SERVER_LOCK_WAIT_MS,
  appendOutboundEvents,
  appendOutboundEventsAsync,
  claimEmailReplyAsync,
  decideMove,
  decideSend,
  emailActionId,
  emailFailureStatus,
  emailOutboundJobId,
  hasSent,
  jobState,
  mergeHistories,
  moveOutboundJob,
  moveOutboundJobAsync,
  outboundJobMachine,
  outcomeUnknownFields,
  readEmailActionBinding,
  readJobEvents,
  sameRecipients,
};
