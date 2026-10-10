'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_SCHEMA = 'amy.signal.receiver-journal.v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function receiveEnvelope(notification) {
  const params = notification && notification.params ? notification.params : {};
  return (
    params.envelope ||
    (params.result && params.result.envelope) ||
    (notification && notification.envelope) ||
    (notification && notification.result && notification.result.envelope) ||
    (notification && (notification.dataMessage || notification.syncMessage) ? notification : null) ||
    null
  );
}

function receiveAccount(notification) {
  const params = notification && notification.params ? notification.params : {};
  return (
    params.account ||
    (params.result && params.result.account) ||
    (notification && notification.account) ||
    (notification && notification.result && notification.result.account) ||
    ''
  );
}

function stableSignalEventId(notification) {
  const envelope = receiveEnvelope(notification);
  const inbound = envelope?.dataMessage || null;
  const sent = envelope?.syncMessage?.sentMessage || null;
  const message = inbound || sent;
  if (!envelope || !message) return null;
  const direction = sent ? 'outbound' : 'inbound';
  const timestamp = Number(message.timestamp || envelope.timestamp || Date.now());
  const counterparty = sent
    ? message.destinationNumber || message.destination || message.destinationUuid || message.destinationServiceId || ''
    : envelope.sourceNumber || envelope.source || envelope.sourceUuid || envelope.sourceServiceId || '';
  const group = message.groupInfo || message.groupContext || null;
  const stable = JSON.stringify({
    account: receiveAccount(notification),
    direction,
    timestamp,
    counterparty,
    groupId: group && (group.groupId || group.id || null),
    text: typeof message.message === 'string' ? message.message : '',
  });
  return sha256(stable).slice(0, 32);
}

function messageTimestamp(notification) {
  const envelope = receiveEnvelope(notification);
  const message = envelope && (envelope.dataMessage || envelope.syncMessage?.sentMessage);
  if (!message) return null;
  const timestamp = Number(message.timestamp || envelope.timestamp || Date.now());
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function journalFile(stateRoot, referenceTime, journalId) {
  const date = String(referenceTime).slice(0, 10).replace(/-/g, path.sep);
  return path.join(stateRoot, 'receiver-journal', date, `${journalId}.json`);
}

function recordReceiverJournal(notification, options = {}) {
  const timestamp = messageTimestamp(notification);
  if (!timestamp) return { recorded: false, reason: 'not-a-message' };
  const receivedAt = options.receivedAt || new Date().toISOString();
  const referenceTime = new Date(timestamp).toISOString();
  const raw = JSON.stringify(notification);
  const rawSha256 = sha256(raw);
  const eventId = stableSignalEventId(notification);
  const journalId = eventId || `unparsed-${rawSha256.slice(0, 32)}`;
  const file = journalFile(options.stateRoot, referenceTime, journalId);
  if (fs.existsSync(file)) {
    return { recorded: true, duplicate: true, file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  const record = {
    schema: JOURNAL_SCHEMA,
    journalId,
    eventId,
    referenceTime,
    receivedAt,
    rawSha256,
    notification,
  };
  atomicWriteJson(file, record);
  return { recorded: true, duplicate: false, file, record };
}

function receiverJournalRows(stateRoot) {
  const root = path.join(stateRoot, 'receiver-journal');
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        try {
          const record = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (record?.schema === JOURNAL_SCHEMA && record?.journalId && record?.referenceTime) {
            out.push({ file: full, ...record });
          }
        } catch {
          out.push({ file: full, schema: JOURNAL_SCHEMA, journalId: path.basename(full, '.json'), invalid: true });
        }
      }
    }
  };
  walk(root);
  return out;
}

module.exports = {
  JOURNAL_SCHEMA,
  journalFile,
  messageTimestamp,
  receiveEnvelope,
  stableSignalEventId,
  receiverJournalRows,
  recordReceiverJournal,
};
