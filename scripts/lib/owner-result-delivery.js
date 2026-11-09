'use strict';

// Did the owner get the result? (S-1, the owner approved 2026-11-07.) Four emailed #Amy
// results sat undelivered from 10-15 to 11-07 and nothing alarmed, because the
// health rows counted only work still queued or running, never a finished
// result that never reached him. A result counts as delivered only when its
// delivery receipt is on file:
// - emailed ask: a Gmail reply ledger row with a Gmail message id;
// - Chat ask: a chat delivery ledger row with a message id.
// A result older than two hours with no receipt is undelivered ("fail loud").

const fs = require('node:fs');
const path = require('node:path');

const RESULT_STATUSES = new Set(['done', 'awaiting-review', 'blocked', 'failed']);
const UNDELIVERED_AFTER_MS = 2 * 60 * 60 * 1000;
// Older results age out of the alarm after a week of red, so history from
// before the check existed cannot pin the row red forever.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function ownerGmailTask(task) {
  return (
    String(task?.origin || '') === 'gmail' &&
    task?.meta?.principal === 'owner' &&
    task?.meta?.principalAuthenticated === true &&
    Boolean(String(task?.meta?.gmailThreadId || '').trim())
  );
}

function ownerTelegramTask(task) {
  return (
    String(task?.origin || '') === 'telegram' &&
    task?.meta?.ownerVerified === true &&
    task?.meta?.sessionTurn === true &&
    String(task?.meta?.sessionId || '').startsWith('telegram:')
  );
}

function spineReplyKey(task) {
  return `spine-reply:${task.id}${task.reopenCount ? `:${task.reopenCount}` : ''}`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function rows(raw, needle) {
  return raw
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function gmailReceiptIn(raw, task) {
  return rows(raw, task.id).some((row) => row.taskId === task.id && Boolean(String(row.messageId || '').trim()));
}

function telegramReceiptIn(raw, task) {
  const key = spineReplyKey(task);
  return rows(raw, key).some((row) => row.dedupKey === key && Number(row.messageId) > 0);
}

function producedAtMs(task) {
  return Date.parse(task?.completedAt || task?.updatedAt || '');
}

function undeliveredOwnerResults({ tasks = [], gmailLedgerRaw = '', telegramLedgerRaw = '', nowMs = Date.now() } = {}) {
  const out = [];
  for (const task of tasks) {
    if (!task || !RESULT_STATUSES.has(String(task.status || ''))) continue;
    const channel = ownerGmailTask(task) ? 'email' : ownerTelegramTask(task) ? 'Chat' : '';
    if (!channel) continue;
    const age = nowMs - producedAtMs(task);
    if (!Number.isFinite(age) || age < UNDELIVERED_AFTER_MS || age > LOOKBACK_MS) continue;
    const delivered = channel === 'email' ? gmailReceiptIn(gmailLedgerRaw, task) : telegramReceiptIn(telegramLedgerRaw, task);
    if (!delivered) out.push({ id: task.id, channel, ageHours: Math.floor(age / 3600000) });
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

function readTasks(taskDir) {
  return fs
    .readdirSync(taskDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8'));
      } catch {
        return null;
      }
    });
}

function undeliveredOwnerResultsIn({ dataDir, now = new Date(), tasks = null } = {}) {
  const agent = path.join(dataDir, 'agent');
  return undeliveredOwnerResults({
    tasks: tasks || readTasks(path.join(dataDir, 'tasks')),
    gmailLedgerRaw: readText(path.join(agent, 'gmail-owner-replies.jsonl')),
    telegramLedgerRaw: readText(path.join(agent, 'telegram-deliveries.jsonl')),
    nowMs: new Date(now).getTime(),
  });
}

function undeliveredSentence(list) {
  if (!list.length) return 'every finished result from the last 7 days reached the owner';
  const email = list.filter((r) => r.channel === 'email').length;
  const telegram = list.length - email;
  const oldest = list[0];
  return `${list.length} finished result${list.length === 1 ? '' : 's'} never reached the owner after 2 hours (email ${email}, chat ${telegram}; oldest ${oldest.id}, ${oldest.ageHours} hours)`;
}

module.exports = {
  LOOKBACK_MS,
  RESULT_STATUSES,
  UNDELIVERED_AFTER_MS,
  gmailReceiptIn,
  ownerGmailTask,
  ownerTelegramTask,
  spineReplyKey,
  telegramReceiptIn,
  undeliveredOwnerResults,
  undeliveredOwnerResultsIn,
  undeliveredSentence,
};
