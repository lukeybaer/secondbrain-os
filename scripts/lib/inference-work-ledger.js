'use strict';

const crypto = require('node:crypto');
const {VAPI_PAID_VOICE_PREFLIGHT_MODEL} = require('./voice-primary.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
  callIdFromHeaders,
} = require('./vapi-call-correlation');

const INFERENCE_LEDGER_SCHEMA = 'inference-work-event.v1';
const INFERENCE_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INFERENCE_LEDGER_PRUNE_SIZE_BYTES = 5 * 1024 * 1024;
const lastPruneAt = new Map();

function defaultInferenceDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'secondbrain',
      'data',
    );
  }
  return '/opt/secondbrain/data';
}

function inferenceLedgerPath(dataDir = defaultInferenceDataDir()) {
  return path.join(dataDir, 'agent', 'inference-work-events.jsonl');
}

function compact(value, max = 240) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function appendInferenceEvent(
  event,
  { dataDir = defaultInferenceDataDir(), nowMs = Date.now() } = {},
) {
  const row = {
    schema: INFERENCE_LEDGER_SCHEMA,
    ts: new Date(nowMs).toISOString(),
    event: compact(event && event.event, 40) || 'started',
    inferenceId: compact(event && event.inferenceId, 120),
    rootWorkId: compact(event && event.rootWorkId, 180),
    workId: compact(event && event.workId, 180),
    parentWorkId: compact(event && event.parentWorkId, 180),
    process: compact(event && event.process, 100),
    trigger: compact(event && event.trigger, 100),
    stateFingerprint: compact(event && event.stateFingerprint, 80),
    voiceSurfaceHash: compact(event && event.voiceSurfaceHash, 128),
    model: compact(event && event.model, 100),
    effort: compact(event && event.effort, 40),
    returnCondition: compact(event && event.returnCondition, 300),
    contextBytes: Math.max(0, Number(event && event.contextBytes) || 0),
    inputTokens: Math.max(0, Number(event && event.inputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(event && event.cachedInputTokens) || 0),
    outputTokens: Math.max(0, Number(event && event.outputTokens) || 0),
    processedTokens: Math.max(0, Number(event && event.processedTokens) || 0),
    outcome: compact(event && event.outcome, 100),
    outputBytes: Math.max(0, Number(event && event.outputBytes) || 0),
    durationMs: Math.max(0, Number(event && event.durationMs) || 0),
    ...(Number.isFinite(event?.firstMeaningfulMs)
      ? { firstMeaningfulMs: Math.max(0, event.firstMeaningfulMs) } : {}),
  };
  if (!row.inferenceId || !row.workId || !row.process || !row.trigger) {
    throw new Error('inference event requires inferenceId, workId, process, and trigger');
  }
  const file = inferenceLedgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  const lastPrune = lastPruneAt.get(file) || 0;
  if (nowMs - lastPrune >= 6 * 60 * 60 * 1000) {
    lastPruneAt.set(file, nowMs);
    try {
      if (fs.statSync(file).size >= INFERENCE_LEDGER_PRUNE_SIZE_BYTES) {
        pruneInferenceLedger({ file, nowMs });
      }
    } catch {
      /* retention maintenance cannot break a live completion */
    }
  }
  return { file, row };
}

function pruneInferenceLedger({
  file = inferenceLedgerPath(),
  nowMs = Date.now(),
  retentionMs = INFERENCE_LEDGER_RETENTION_MS,
} = {}) {
  if (!fs.existsSync(file)) return { file, retained: 0, removed: 0 };
  const cutoff = nowMs - retentionMs;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const retained = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const ts = Date.parse(String(row.ts || ''));
      if (row.schema === INFERENCE_LEDGER_SCHEMA && Number.isFinite(ts) && ts >= cutoff) {
        retained.push(JSON.stringify(row));
      }
    } catch {
      /* corrupt telemetry is not durable evidence */
    }
  }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, retained.length ? `${retained.join('\n')}\n` : '', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  return { file, retained: retained.length, removed: lines.length - retained.length };
}

function correlationFromOpenAiRequest(openaiBody = {}, headers = {}, { trustedProviderTurns = false } = {}) {
  // Only signaling metadata forwarded by EC2 can establish parentage. Prompt
  // text and request-body metadata are model-facing or caller-supplied and may
  // describe a call, but they cannot prove which real call caused inference.
  const callId = callIdFromHeaders(headers);
  const messages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const lastDecisionInput = [...messages]
    .reverse()
    .find((message) => message && ['user', 'tool'].includes(String(message.role || '')));
  // Fingerprint only the conversation shape. Hashing even unpersisted prompt
  // text makes short utterances recoverable by dictionary attack. Message
  // count, role sequence, tool identity, and content byte count are enough to
  // identify a repeated runtime state without putting caller words in the
  // ledger, even as an unsalted digest.
  const messageShape = messages.map((message) => ({
    role: compact(message && message.role, 24),
    name: compact(message && message.name, 80),
    toolCallId: compact(message && message.tool_call_id, 120),
    contentBytes: Buffer.byteLength(String(message && message.content ? message.content : '')),
  }));
  const stateFingerprint = sha256(
    JSON.stringify({
      model: compact(openaiBody.model, 100),
      messageCount: messages.length,
      lastDecisionRole: compact(lastDecisionInput && lastDecisionInput.role, 24),
      messageShape,
    }),
  );
  const stableCallId = callId || `unattributed-${crypto.randomUUID()}`;
  // Vapi can replace an interrupted transcript without growing messages.
  // Only the authenticated endpoint may admit its monotonic turn counters;
  // these never establish identity or authorize tools.
  const counters = [openaiBody.metadata?.numAssistantTurns, openaiBody.metadata?.numUserTurns];
  const providerTurn = trustedProviderTurns && counters.every(value => Number.isInteger(value) && value >= 0 && value < 10000)
    ? counters[0] + counters[1] + messages.filter(message => message?.role === 'tool').length
    : null;
  const turnNumber = providerTurn == null ? messages.length : providerTurn;
  const rootKind =
    [VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,VAPI_PAID_VOICE_PREFLIGHT_MODEL].includes(openaiBody.model)
      ? 'voice-preflight'
      : 'voice-call';
  return {
    callId: stableCallId,
    rootWorkId: `${rootKind}:${stableCallId}`,
    parentWorkId: `${rootKind}:${stableCallId}`,
    workId: `${rootKind}:${stableCallId}:turn:${turnNumber}:${stateFingerprint.slice(0, 12)}`,
    stateFingerprint,
    attributed: Boolean(callId),
  };
}

module.exports = {
  INFERENCE_LEDGER_SCHEMA,
  INFERENCE_LEDGER_RETENTION_MS,
  appendInferenceEvent,
  correlationFromOpenAiRequest,
  defaultInferenceDataDir,
  inferenceLedgerPath,
  pruneInferenceLedger,
  sha256,
};
