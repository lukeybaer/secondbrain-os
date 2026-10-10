'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { uploadFile } = require('./cloud-archive.js');
const { findForbiddenPeople } = require('./forbidden-people.js');
const { addEpisode } = require('./graphiti-mcp.js');
const { graphitiIngestionAdmission } = require('./graphiti-ingestion-policy.js');
const {
  appendCycleReceipt,
  attemptHistoryFile,
  stageAdmissionDecision,
  withEventLease,
} = require('./signal-flow-cycles.js');
const {
  citationBody,
  extractUrls,
  resolveAndArchiveLinks,
} = require('./signal-link-context.js');

const DEFAULT_STATE_ROOT = '/opt/secondbrain-durable/signal-ingest';
const DEFAULT_SIGNAL_ROOT = '/opt/secondbrain-durable/signal-cli';
const DEFAULT_RPC_URL = 'http://127.0.0.1:7584/api/v1/rpc';
const DEFAULT_RECEIVE_HOST = '127.0.0.1';
const DEFAULT_RECEIVE_PORT = 7583;
const DEFAULT_ARCHIVE_PREFIX = 'data-lake/secondbrain/life-archive/data/signal/raw';
const inFlightEvents = new Map();
const {
  receiverJournalRows,
  recordReceiverJournal,
  stableSignalEventId,
} = require('./signal-message-completeness.js');

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

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isoFromTimestamp(value) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date();
  return date.toISOString();
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function messageAttachments(message) {
  const attachments = Array.isArray(message && message.attachments) ? [...message.attachments] : [];
  for (const preview of Array.isArray(message && message.previews) ? message.previews : []) {
    if (preview && preview.image) attachments.push(preview.image);
  }
  if (message && message.sticker && message.sticker.data) attachments.push(message.sticker.data);
  for (const contact of Array.isArray(message && message.contacts) ? message.contacts : []) {
    if (contact && contact.avatar && contact.avatar.avatar) attachments.push(contact.avatar.avatar);
  }
  return attachments;
}

function normalizeNotification(notification) {
  const params = notification && notification.params ? notification.params : {};
  const topLevelEnvelope = notification && notification.envelope;
  const bareEnvelope =
    notification && (notification.dataMessage || notification.syncMessage) ? notification : null;
  const envelope =
    params.envelope ||
    (params.result && params.result.envelope) ||
    topLevelEnvelope ||
    (notification && notification.result && notification.result.envelope) ||
    bareEnvelope ||
    null;
  if (!envelope) return null;

  const inbound = envelope.dataMessage || null;
  const sent = envelope.syncMessage && envelope.syncMessage.sentMessage;
  const message = inbound || sent || null;
  if (!message) return null;

  const direction = sent ? 'outbound' : 'inbound';
  const timestamp = Number(message.timestamp || envelope.timestamp || Date.now());
  const counterparty = sent
    ? message.destinationNumber || message.destination || message.destinationUuid || message.destinationServiceId || ''
    : envelope.sourceNumber || envelope.source || envelope.sourceUuid || envelope.sourceServiceId || '';
  const group = message.groupInfo || message.groupContext || null;
  const attachments = messageAttachments(message);
  const text = typeof message.message === 'string' ? message.message : '';
  const account =
    params.account ||
    (params.result && params.result.account) ||
    (notification && notification.account) ||
    (notification && notification.result && notification.result.account) ||
    '';
  const sourceDevice = envelope.sourceDevice || null;
  const id = stableSignalEventId(notification);
  if (!id) return null;
  return {
    schema: 'amy.signal.message.v2',
    id,
    account,
    direction,
    timestamp,
    referenceTime: isoFromTimestamp(timestamp),
    counterparty,
    counterpartyDigits: phoneDigits(counterparty),
    sourceDevice,
    text,
    links: extractUrls(text),
    group,
    attachments,
    envelope,
  };
}

function normalizedStoredMessage(value) {
  if (!value) return null;
  return {
    ...value,
    schema: 'amy.signal.message.v2',
    links: Array.isArray(value.links) ? value.links : extractUrls(value.text),
  };
}

function isWithin(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function attachmentPathCandidates(value, out = new Set()) {
  if (typeof value === 'string' && path.isAbsolute(value)) out.add(path.resolve(value));
  if (Array.isArray(value)) {
    for (const item of value) attachmentPathCandidates(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) attachmentPathCandidates(item, out);
  }
  return [...out];
}

function copyAttachments(normalized, eventDir, signalRoot = DEFAULT_SIGNAL_ROOT) {
  const destination = path.join(eventDir, 'attachments');
  const files = [];
  const candidates = attachmentPathCandidates(normalized.attachments);
  for (const source of candidates) {
    if (!isWithin(source, signalRoot) || !fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const digest = sha256(fs.readFileSync(source));
    const safeName = path.basename(source).replace(/[^A-Za-z0-9._-]+/g, '-');
    const target = path.join(destination, `${digest.slice(0, 12)}-${safeName || 'attachment'}`);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    files.push({ source, localPath: target, sha256: digest, bytes: fs.statSync(target).size });
  }
  return files;
}

function eventDirectory(root, normalized) {
  const date = normalized.referenceTime.slice(0, 10).replace(/-/g, path.sep);
  return path.join(root, 'events', date, normalized.id);
}

function s3KeyFor(normalized, name) {
  const date = normalized.referenceTime.slice(0, 10).replace(/-/g, '/');
  return `${DEFAULT_ARCHIVE_PREFIX}/${date}/${normalized.id}/${name}`;
}

function graphitiBody(normalized, archivedAttachments) {
  const forbidden = findForbiddenPeople(
    `${normalized.counterparty || ''}\n${normalized.envelope && normalized.envelope.sourceName || ''}\n${normalized.text || ''}`,
  );
  if (forbidden.length) {
    return [
      `Signal ${normalized.direction} message at ${normalized.referenceTime}.`,
      'Message content and participant were suppressed as privacy_redacted_person.',
      `Permanent raw archive event id: ${normalized.id}.`,
    ].join('\n');
  }
  const target = normalized.counterparty || 'unknown Signal contact';
  const attachmentSummary = archivedAttachments.length
    ? ` Attachments: ${archivedAttachments.map((a) => `${path.basename(a.localPath)} sha256=${a.sha256}`).join(', ')}.`
    : '';
  return [
    `Signal ${normalized.direction} message with ${target} at ${normalized.referenceTime}.`,
    normalized.text ? `Message: ${normalized.text}` : 'Message contained no text.',
    attachmentSummary,
    `Permanent raw archive event id: ${normalized.id}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function migratedStatus(value, normalized) {
  const prior = value && typeof value === 'object' ? value : {};
  const priorS3 = prior.s3 && prior.s3.status === 'verified' ? prior.s3 : null;
  const priorGraphiti = prior.graphiti && prior.graphiti.status === 'accepted' ? prior.graphiti : null;
  const stages = prior.stages && typeof prior.stages === 'object' ? prior.stages : {};
  const linksComplete = stages.linked_context && stages.linked_context.status === 'complete';
  const graphitiComplete =
    stages.graphiti &&
    stages.graphiti.status === 'complete' &&
    Number(stages.graphiti.citations || 0) >= Number(normalized.links?.length || 0);
  const graphitiTerminallyDisabled =
    stages.graphiti &&
    stages.graphiti.status === 'complete' &&
    stages.graphiti.disposition === 'disabled_by_owner';
  return {
    ...prior,
    schema: 'amy.signal.ingest-status.v2',
    eventId: normalized.id,
    referenceTime: normalized.referenceTime,
    admittedAt: prior.admittedAt || prior.createdAt || new Date().toISOString(),
    stages: {
      ...stages,
      capture:
        stages.capture && stages.capture.status === 'complete'
          ? stages.capture
          : { status: 'complete', at: prior.createdAt || new Date().toISOString() },
      archive:
        stages.archive && stages.archive.status === 'complete'
          ? {
              ...stages.archive,
              objects:
                Number(stages.archive.objects) ||
                (priorS3 ? 2 + Number(priorS3.attachments?.length || 0) : 0),
            }
          : priorS3
            ? {
                status: 'complete',
                at: priorS3.uploadedAt || prior.createdAt || null,
                objects: 2 + Number(priorS3.attachments?.length || 0),
              }
            : { status: 'pending' },
      linked_context: linksComplete ? stages.linked_context : { status: 'pending' },
      graphiti: graphitiComplete || graphitiTerminallyDisabled ? stages.graphiti : { status: 'pending' },
      people: stages.people || { status: 'pending' },
    },
    s3: priorS3 || prior.s3 || null,
    graphiti: priorGraphiti
      ? { message: priorGraphiti, citations: prior.graphiti.citations || [] }
      : prior.graphiti || { message: null, citations: [] },
    captureComplete: Boolean(prior.captureComplete && linksComplete && (graphitiComplete || graphitiTerminallyDisabled)),
    complete: Boolean(prior.complete && prior.stages?.people?.status === 'complete'),
  };
}

function stageFingerprint(normalized, status, stage) {
  return sha256(
    JSON.stringify({
      eventId: normalized.id,
      stage,
      links: normalized.links,
      archive: status.stages?.archive?.status || 'pending',
      linkedContext: status.stages?.linked_context?.status || 'pending',
      graphiti: status.stages?.graphiti?.status || 'pending',
    }),
  );
}

async function runReceiptedStage({
  stateRoot,
  eventDir,
  normalized,
  status,
  statusFile,
  stage,
  tactic,
  action,
  applyResult,
  logStage,
}) {
  const historyFile = attemptHistoryFile(stateRoot, normalized.id);
  const fingerprint = stageFingerprint(normalized, status, stage);
  const admission = stageAdmissionDecision(historyFile, {
    eventId: normalized.id,
    stage,
    tactic,
    fingerprint,
  });
  if (!admission.allowed) {
    status.stages[stage] = {
      status: 'blocked',
      at: new Date().toISOString(),
      reason: admission.reason,
      consumedCycles: admission.consumedCycles,
    };
    atomicWriteJson(statusFile, status);
    throw new Error(`Signal ${stage} blocked: ${admission.reason}`);
  }
  const startedAt = new Date().toISOString();
  status.stages[stage] = { status: 'running', at: startedAt, tactic, fingerprint };
  atomicWriteJson(statusFile, status);
  appendCycleReceipt(historyFile, {
    eventId: normalized.id,
    stage,
    tactic,
    fingerprint,
    outcome: 'started',
    consumed: false,
  });
  try {
    const value = await action();
    const at = new Date().toISOString();
    const evidence = applyResult ? (await applyResult(value)) || {} : {};
    status.stages[stage] = { status: 'complete', at, tactic, fingerprint, ...evidence };
    appendCycleReceipt(historyFile, {
      eventId: normalized.id,
      stage,
      tactic,
      fingerprint,
      outcome: 'complete',
      consumed: true,
    });
    atomicWriteJson(statusFile, status);
    logStage(`${stage}_complete`);
    return value;
  } catch (error) {
    const at = new Date().toISOString();
    const consumed = error && error.code === 'SIGNAL_PERMANENT_STAGE_FAILURE';
    status.stages[stage] = {
      status: 'pending',
      at,
      tactic,
      fingerprint,
      lastError: String(error.message || error).slice(0, 1000),
      retryable: !consumed,
    };
    appendCycleReceipt(historyFile, {
      eventId: normalized.id,
      stage,
      tactic,
      fingerprint,
      outcome: consumed ? 'no_progress' : 'deferred_retryable',
      consumed,
      error: String(error.message || error).slice(0, 1000),
    });
    atomicWriteJson(statusFile, status);
    throw error;
  }
}

function removeFileIfPresent(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
  } catch {
    // A later cleanup pass retries verified local artifacts. Capture success is
    // never reversed because a local retention cleanup was temporarily blocked.
  }
}

function cleanupArchivedLocal(eventDir, normalized, options = {}) {
  const roots = [
    options.signalRoot || process.env.SIGNAL_CLI_CONFIG || DEFAULT_SIGNAL_ROOT,
    options.stateRoot || process.env.SIGNAL_INGEST_ROOT || DEFAULT_STATE_ROOT,
  ];
  removeFileIfPresent(path.join(eventDir, 'raw.json'));
  const localAttachments = path.join(eventDir, 'attachments');
  if (fs.existsSync(localAttachments)) {
    for (const name of fs.readdirSync(localAttachments)) removeFileIfPresent(path.join(localAttachments, name));
    try { fs.rmdirSync(localAttachments); } catch { /* not empty or already absent */ }
  }
  for (const candidate of attachmentPathCandidates(normalized.attachments)) {
    if (roots.some((root) => isWithin(candidate, root))) removeFileIfPresent(candidate);
  }
}

async function processNotificationOnce(notification, options = {}) {
  const normalized = normalizeNotification(notification);
  if (!normalized) return { accepted: false, reason: 'not-a-message' };
  return processNormalizedEvent(normalized, { ...options, notification });
}

async function processNormalizedEvent(normalizedInput, options = {}) {
  const normalized = normalizedStoredMessage(normalizedInput);
  const log = options.log || console.log;
  const logStage = (stage, detail = '') =>
    log(
      `[signal-ingest] event=${normalized.id} direction=${normalized.direction} stage=${stage}${
        detail ? ` ${detail}` : ''
      }`,
    );
  const stateRoot = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || DEFAULT_STATE_ROOT;
  const eventDir = eventDirectory(stateRoot, normalized);
  const statusFile = path.join(eventDir, 'status.json');
  fs.mkdirSync(eventDir, { recursive: true, mode: 0o700 });
  const rawFile = path.join(eventDir, 'raw.json');
  const normalizedFile = path.join(eventDir, 'normalized.json');
  const newlyCaptured = !fs.existsSync(normalizedFile);
  if (newlyCaptured && options.notification) atomicWriteJson(rawFile, options.notification);
  atomicWriteJson(normalizedFile, normalized);
  let status = migratedStatus(readJson(statusFile, null), normalized);
  atomicWriteJson(statusFile, status);

  const lease = await withEventLease(eventDir, async () => {
    status = migratedStatus(readJson(statusFile, status), normalized);
    if (status.captureComplete === true) {
      return { accepted: true, duplicate: true, normalized, status, eventDir };
    }
    const attachmentFiles = copyAttachments(
      normalized,
      eventDir,
      options.signalRoot || process.env.SIGNAL_CLI_CONFIG || DEFAULT_SIGNAL_ROOT,
    );
    if (newlyCaptured) logStage('captured', `attachments=${attachmentFiles.length}`);
    try {
      if (status.stages.archive.status !== 'complete') {
        const archive = await runReceiptedStage({
          stateRoot,
          eventDir,
          normalized,
          status,
          statusFile,
          stage: 'archive',
          tactic: 'verified_single_put',
          logStage,
          action: async () => {
            if (!fs.existsSync(rawFile)) {
              const error = new Error('Signal raw event is missing before archive proof');
              error.code = 'SIGNAL_PERMANENT_STAGE_FAILURE';
              throw error;
            }
            const upload = options.uploadFile || uploadFile;
            const rawReceipt = upload(rawFile, {
              env: options.env || process.env,
              key: s3KeyFor(normalized, 'raw.json'),
              requireChecksumSha256: true,
              allowSensitive: true,
            });
            const normalizedReceipt = upload(normalizedFile, {
              env: options.env || process.env,
              key: s3KeyFor(normalized, 'normalized.json'),
              requireChecksumSha256: true,
              allowSensitive: true,
            });
            const attachmentReceipts = attachmentFiles.map((file) =>
              upload(file.localPath, {
                env: options.env || process.env,
                key: s3KeyFor(normalized, `attachments/${path.basename(file.localPath)}`),
                requireChecksumSha256: true,
                allowSensitive: true,
              }),
            );
            return {
              status: 'verified',
              raw: rawReceipt,
              normalized: normalizedReceipt,
              attachments: attachmentReceipts,
            };
          },
          applyResult: (value) => {
            status.s3 = value;
            return { objects: 2 + value.attachments.length };
          },
        });
        logStage('s3_verified', `objects=${2 + archive.attachments.length}`);
      }

      if (status.stages.linked_context.status !== 'complete') {
        const resolver = options.resolveAndArchiveLinks || resolveAndArchiveLinks;
        const context = await runReceiptedStage({
          stateRoot,
          eventDir,
          normalized,
          status,
          statusFile,
          stage: 'linked_context',
          tactic: 'fetch_archive_and_transcribe',
          logStage,
          action: () =>
            resolver({
              normalized,
              eventDir,
              uploadFile: options.uploadFile || uploadFile,
              env: options.env || process.env,
              fetchSharedUrl: options.fetchSharedUrl,
              mediaResolver: options.mediaResolver,
              transcribe: options.transcribe,
              repoRoot: options.repoRoot,
            }),
          applyResult: (value) => {
            status.linkContext = value;
            return {
              links: value.links.length,
              manifest: value.archive?.manifest || null,
            };
          },
        });
      }

      if (status.stages.graphiti.status !== 'complete') {
        const graphitiAdmission = options.graphitiIngestionAdmission || graphitiIngestionAdmission;
        const admission = graphitiAdmission({ policyPath: options.graphitiPolicyPath });
        if (!admission.allowed) {
          const at = new Date().toISOString();
          status.stages.graphiti = {
            status: 'complete',
            at,
            disposition: 'disabled_by_owner',
            reason: admission.reason,
            citations: 0,
          };
          status.graphiti = {
            message: { status: 'disabled_by_owner', at, reason: admission.reason },
            citations: [],
          };
          atomicWriteJson(statusFile, status);
          logStage('graphiti_terminal_disabled', admission.reason);
        } else {
        const graphitiResult = await runReceiptedStage({
          stateRoot,
          eventDir,
          normalized,
          status,
          statusFile,
          stage: 'graphiti',
          tactic: 'submit_message_and_citations',
          logStage,
          action: async () => {
            const graphitiAdd = options.addEpisode || addEpisode;
            const current = status.graphiti && status.graphiti.message
              ? status.graphiti
              : { message: null, citations: [] };
            if (!current.message || current.message.status !== 'accepted') {
              const result = await graphitiAdd({
                name: `Signal ${normalized.direction} ${normalized.id}`,
                body: graphitiBody(normalized, attachmentFiles),
                source: `signal-${normalized.direction}`,
                source_id: normalized.id,
                source_description: `Signal ${normalized.direction}; raw event ${status.s3.raw.s3Uri}`,
                reference_time: normalized.referenceTime,
                group_id: options.graphitiGroup || process.env.GRAPHITI_GROUP_ID || 'owner-ea',
              });
              current.message = { status: 'accepted', at: new Date().toISOString(), result };
              status.graphiti = current;
              atomicWriteJson(statusFile, status);
            }
            const byId = new Map((current.citations || []).map((row) => [row.linkId, row]));
            for (const link of status.linkContext?.links || []) {
              if (byId.get(link.id)?.status === 'accepted') continue;
              const result = await graphitiAdd({
                name: `Signal shared link ${normalized.id} ${link.id}`,
                body: citationBody(normalized, link),
                source: 'signal-linked-context',
                source_id: `${normalized.id}:${link.id}`,
                source_description: `Context cited by Signal event ${normalized.id}; archive ${status.linkContext.archive?.manifest?.s3Uri || 'verified'}`,
                reference_time: normalized.referenceTime,
                group_id: options.graphitiGroup || process.env.GRAPHITI_GROUP_ID || 'owner-ea',
              });
              byId.set(link.id, { linkId: link.id, status: 'accepted', at: new Date().toISOString(), result });
              current.citations = [...byId.values()];
              status.graphiti = current;
              atomicWriteJson(statusFile, status);
            }
            return { message: current.message, citations: [...byId.values()] };
          },
          applyResult: (value) => {
            status.graphiti = value;
            return { citations: value.citations.length };
          },
        });
        logStage('graphiti_accepted', `citations=${graphitiResult.citations.length}`);
        }
      }

      status.captureComplete = true;
      status.complete = status.stages.people?.status === 'complete';
      delete status.lastError;
      status.captureCompletedAt = new Date().toISOString();
      atomicWriteJson(statusFile, status);
      cleanupArchivedLocal(eventDir, normalized, { ...options, stateRoot });
      logStage('capture_complete', 'people=pending');
      return { accepted: true, normalized, status, eventDir };
    } catch (error) {
      status.captureComplete = false;
      status.complete = false;
      status.lastError = { at: new Date().toISOString(), message: error.message };
      atomicWriteJson(statusFile, status);
      throw error;
    }
  });
  if (!lease.acquired) {
    return { accepted: true, deferred: true, reason: lease.reason, normalized, status, eventDir };
  }
  return lease.value;
}

async function processNotification(notification, options = {}) {
  const normalized = normalizeNotification(notification);
  if (!normalized) return { accepted: false, reason: 'not-a-message' };
  if (inFlightEvents.has(normalized.id)) return inFlightEvents.get(normalized.id);
  const promise = processNotificationOnce(notification, options).finally(() => inFlightEvents.delete(normalized.id));
  inFlightEvents.set(normalized.id, promise);
  return promise;
}

function pendingRawFiles(stateRoot = DEFAULT_STATE_ROOT) {
  const events = path.join(stateRoot, 'events');
  if (!fs.existsSync(events)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'raw.json') {
        const status = readJson(path.join(dir, 'status.json'), {});
        if (status.captureComplete !== true) out.push(full);
      }
    }
  };
  walk(events);
  return out;
}

function pendingEventDirectories(stateRoot = DEFAULT_STATE_ROOT) {
  const events = path.join(stateRoot, 'events');
  if (!fs.existsSync(events)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'normalized.json') {
        const status = readJson(path.join(dir, 'status.json'), {});
        if (status.captureComplete !== true) out.push(dir);
      }
    }
  };
  walk(events);
  return out;
}

function cleanupCompletedEvents(stateRoot = DEFAULT_STATE_ROOT, options = {}) {
  const events = path.join(stateRoot, 'events');
  if (!fs.existsSync(events)) return 0;
  let cleaned = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'status.json') {
        const status = readJson(full, {});
        const normalized = readJson(path.join(dir, 'normalized.json'));
        if (status.captureComplete === true && normalized) {
          cleanupArchivedLocal(dir, normalized, { ...options, stateRoot });
          cleaned += 1;
        }
      }
    }
  };
  walk(events);
  return cleaned;
}

async function retryPending(options = {}) {
  const root = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || DEFAULT_STATE_ROOT;
  const results = [];
  const pending = pendingEventDirectories(root).slice(0, Number(options.limit || 25));
  for (const dir of pending) {
    const normalized = normalizedStoredMessage(readJson(path.join(dir, 'normalized.json')));
    const raw = readJson(path.join(dir, 'raw.json'));
    try {
      if (normalized) results.push(await processNormalizedEvent(normalized, { ...options, notification: raw }));
      else if (raw) results.push(await processNotification(raw, options));
    } catch (error) {
      const eventId = normalized?.id || path.basename(dir);
      (options.logError || console.error)(
        `[signal-flow] event=${eventId} stage=redrive outcome=failed error=${String(error.message || error).slice(0, 300)}`,
      );
      results.push({
        accepted: false,
        eventId,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }
  return results;
}

async function retryUnadmittedJournal(options = {}) {
  const root = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || DEFAULT_STATE_ROOT;
  const admittedIds = new Set(
    pendingAndCompleteEventIds(root),
  );
  const missing = receiverJournalRows(root)
    .filter(
      (row) => !row.invalid && row.notification && (!row.eventId || !admittedIds.has(row.eventId)),
    )
    .slice(0, Number(options.limit || 25));
  const results = [];
  const processor = options.processNotification || processNotification;
  for (const row of missing) {
    try {
      const result = await processor(row.notification, options);
      results.push({ journalId: row.journalId, ...result });
    } catch (error) {
      (options.logError || console.error)(
        `[signal-flow] journal=${row.journalId} stage=admission-redrive outcome=failed error=${String(error.message || error).slice(0, 300)}`,
      );
      results.push({
        accepted: false,
        journalId: row.journalId,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }
  return results;
}

function pendingAndCompleteEventIds(stateRoot = DEFAULT_STATE_ROOT) {
  const events = path.join(stateRoot, 'events');
  if (!fs.existsSync(events)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'normalized.json') {
        const normalized = readJson(full);
        if (normalized?.id) out.push(normalized.id);
      }
    }
  };
  walk(events);
  return out;
}

function recordListenerHeartbeat(stateRoot = DEFAULT_STATE_ROOT, values = {}) {
  const file = path.join(stateRoot, 'listener-heartbeat.json');
  atomicWriteJson(file, {
    schema: 'amy.signal.listener-heartbeat.v1',
    at: new Date().toISOString(),
    pid: process.pid,
    connected: true,
    ...values,
  });
  return file;
}

function jsonRpc(method, params = {}, options = {}) {
  const url = new URL(options.rpcUrl || process.env.SIGNAL_RPC_URL || DEFAULT_RPC_URL);
  const id = `amy-${method}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: Number(options.rpcTimeoutMs || 10_000),
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`signal-cli JSON-RPC HTTP ${response.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
            resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`signal-cli JSON-RPC ${method} timed out`)));
    request.on('error', reject);
    request.end(payload);
  });
}

function connectJsonRpcReceiver(options = {}) {
  const host = options.host || process.env.SIGNAL_RECEIVE_HOST || DEFAULT_RECEIVE_HOST;
  const port = Number(options.port || process.env.SIGNAL_RECEIVE_PORT || DEFAULT_RECEIVE_PORT);
  const log = options.log || console.log;
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let chain = Promise.resolve();
  let connected = false;
  let subscriptionId = null;
  let requestSequence = 0;
  const stateRoot = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || DEFAULT_STATE_ROOT;
  const priorHeartbeat = readJson(path.join(stateRoot, 'listener-heartbeat.json'), {});
  let coverageStartedAt = priorHeartbeat?.receiveMode === 'manual' ? priorHeartbeat.coverageStartedAt || null : null;
  const processor = options.processNotification || processNotification;
  const journalReceiver = options.recordReceiverJournal || recordReceiverJournal;
  const setConnected = (value, detail = '') => {
    connected = Boolean(value);
    const state = {
      connected,
      detail,
      receiveMode: 'manual',
      subscriptionActive: connected && Number.isInteger(subscriptionId),
      subscriptionId,
      coverageStartedAt,
    };
    recordListenerHeartbeat(stateRoot, state);
    if (typeof options.onState === 'function') options.onState(state);
  };
  const scheduleReconnect = (detail) => {
    setConnected(false, detail);
    subscriptionId = null;
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, options.reconnectMs || 5000);
  };
  const acceptNotification = (notification) => {
    const notificationSubscription = notification?.params?.subscription;
    if (
      Number.isInteger(subscriptionId) &&
      Number.isInteger(notificationSubscription) &&
      notificationSubscription !== subscriptionId
    ) {
      log(
        `[signal-ingest] ignored receive notification for subscription ${notificationSubscription}; active=${subscriptionId}`,
      );
      return;
    }
    const journal = journalReceiver(notification, { stateRoot });
    chain = chain
      .then(() => processor(notification, options))
      .catch((error) => log(`[signal-ingest] event failed: ${error.message}`));
    if (journal.recorded) {
      log(
        `[signal-ingest] journal=${journal.record.journalId} stage=receiver-journal outcome=${journal.duplicate ? 'duplicate' : 'durable'}`,
      );
    }
  };
  const open = () => {
    if (stopped) return;
    const currentSocket = net.createConnection({ host, port });
    socket = currentSocket;
    const subscribeRequestId = `signal-receive-${process.pid}-${Date.now()}-${++requestSequence}`;
    let buffer = '';
    let subscribeTimer = null;
    setConnected(false, 'tcp-connecting');
    currentSocket.setEncoding('utf8');
    currentSocket.setKeepAlive(true, 30_000);
    currentSocket.on('connect', () => {
      log('[signal-ingest] connected to signal-cli TCP JSON-RPC; opening manual receive subscription');
      setConnected(false, 'tcp-open-awaiting-manual-subscription');
      currentSocket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: subscribeRequestId, method: 'subscribeReceive' })}\n`,
      );
      subscribeTimer = setTimeout(() => {
        log('[signal-ingest] subscribe failed: response timed out');
        currentSocket.destroy();
      }, options.subscribeTimeoutMs || 10_000);
    });
    currentSocket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          log(`[signal-ingest] invalid TCP JSON-RPC: ${error.message}`);
          continue;
        }
        if (message.id === subscribeRequestId) {
          if (subscribeTimer) clearTimeout(subscribeTimer);
          subscribeTimer = null;
          if (message.error) {
            log(`[signal-ingest] subscribe failed: ${message.error.message || JSON.stringify(message.error)}`);
            currentSocket.destroy();
            continue;
          }
          if (!Number.isInteger(message.result)) {
            log(`[signal-ingest] subscribe failed: invalid subscription id ${JSON.stringify(message.result)}`);
            currentSocket.destroy();
            continue;
          }
          subscriptionId = message.result;
          coverageStartedAt = coverageStartedAt || new Date().toISOString();
          log(`[signal-ingest] manual receive subscription active id=${subscriptionId}`);
          setConnected(true, 'manual-subscription-active');
          continue;
        }
        if (message.method === 'receive') acceptNotification(message);
      }
    });
    currentSocket.on('error', (error) => {
      log(`[signal-ingest] connection error: ${error.message}`);
    });
    currentSocket.on('close', () => {
      if (subscribeTimer) clearTimeout(subscribeTimer);
      subscribeTimer = null;
      if (socket === currentSocket) socket = null;
      scheduleReconnect('tcp-disconnected');
    });
  };
  open();
  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    // The receive subscription belongs to this TCP connection. Closing the
    // socket is the authoritative retirement boundary before any reconnect.
    if (socket) socket.destroy();
    socket = null;
    subscriptionId = null;
    setConnected(false, 'stopped');
  };
  stop.isConnected = () => connected;
  stop.getState = () => ({
    connected,
    receiveMode: 'manual',
    subscriptionActive: connected && Number.isInteger(subscriptionId),
    subscriptionId,
    coverageStartedAt,
  });
  return stop;
}

module.exports = {
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_RECEIVE_HOST,
  DEFAULT_RECEIVE_PORT,
  DEFAULT_RPC_URL,
  DEFAULT_SIGNAL_ROOT,
  DEFAULT_STATE_ROOT,
  atomicWriteJson,
  attachmentPathCandidates,
  cleanupArchivedLocal,
  cleanupCompletedEvents,
  connectJsonRpcReceiver,
  copyAttachments,
  eventDirectory,
  graphitiBody,
  normalizeNotification,
  pendingAndCompleteEventIds,
  pendingRawFiles,
  pendingEventDirectories,
  phoneDigits,
  processNotification,
  processNotificationOnce,
  processNormalizedEvent,
  recordListenerHeartbeat,
  retryUnadmittedJournal,
  readJson,
  retryPending,
  jsonRpc,
  s3KeyFor,
  sha256,
  normalizedStoredMessage,
  migratedStatus,
};
