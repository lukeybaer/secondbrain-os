#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { askAI } = require('./lib/ask-ai');
const { graphitiEnrichmentAdmission } = require('./lib/graphiti-overnight-policy.js');
const { assertGraphitiIngestionEnabled } = require('./lib/graphiti-ingestion-policy.js');

const SOCKET_PATH =
  process.env.GRAPHITI_SUBSCRIPTION_SOCKET ||
  (process.platform === 'win32'
    ? '\\\\.\\pipe\\secondbrain-graphiti-subscription'
    : '/opt/secondbrain-durable/graphiti/subscription.sock');
// The gateway is deliberately single-concurrency and the subscription ladder
// runs the Codex/Claude CLI synchronously, so an in-flight extraction blocks
// this process's event loop and /health cannot answer. A health probe cannot
// tell that apart from a dead listener, which produced a full day of false red.
// This heartbeat lets the probe distinguish "busy on a bounded job" from
// "stuck or dead" without giving the gateway a second provider or a paid key.
const STATUS_PATH =
  process.env.GRAPHITI_SUBSCRIPTION_STATUS ||
  (process.platform === 'win32'
    ? path.join(os.tmpdir(), 'secondbrain-graphiti-gateway-status.json')
    : '/opt/secondbrain-durable/graphiti/gateway-status.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE = 32;
const REQUEST_TIMEOUT_MS = 120_000;
const DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux'
    ? '/opt/secondbrain/data'
    : path.resolve(__dirname, '..', 'data'));

let active = false;
const queue = [];

function writeStatus(patch, statusPath = STATUS_PATH) {
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true, mode: 0o750 });
    const tmp = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, updated_ms: Date.now(), ...patch }),
    );
    fs.renameSync(tmp, statusPath);
  } catch {
    // The heartbeat is diagnostic only and must never fail a real extraction.
  }
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  return messages.map((message) => ({
    role: String(message && message.role ? message.role : 'user').slice(0, 32),
    content: String(message && message.content ? message.content : '').slice(0, 500_000),
  }));
}

function buildPrompt(body) {
  const messages = normalizeMessages(body.messages);
  const schema = body.responseSchema && typeof body.responseSchema === 'object'
    ? JSON.stringify(body.responseSchema)
    : '{}';
  return [
    'Return exactly one JSON object and no markdown fences.',
    'The JSON must satisfy this schema:',
    schema,
    'Conversation:',
    ...messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
  ].join('\n\n');
}

async function runSubscriptionRequest(body) {
  // Includes queued work and direct --canary calls, not only HTTP admission.
  assertGraphitiIngestionEnabled();
  const prompt = buildPrompt(body);
  const result = await askAI(prompt, {
    surface: 'graphiti-subscription-gateway',
    phase: 'routine-observation',
    system: 'You are Graphiti structured extraction. Return strict JSON only.',
    rungOrder: ['codex', 'claude-cli'],
    briefingContext: false,
    briefingNightCircuit: true,
    briefingPriority: 'nonessential',
    briefingEstimatedTokens: 250_000,
    rungRetries: 0,
    rungTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!result || !result.text) throw new Error('subscription ladder returned no JSON');
  return {
    text: result.text,
    provider: result.rung,
    attempts: result.attempts,
  };
}

function drainQueue() {
  if (active || queue.length === 0) return;
  active = true;
  const job = queue.shift();
  writeStatus({ active: true, active_since_ms: Date.now(), queued: queue.length });
  runSubscriptionRequest(job.body)
    .then((result) => json(job.res, 200, result))
    .catch((error) => json(job.res, 503, { error: String(error.message || error).slice(0, 500) }))
    .finally(() => {
      active = false;
      writeStatus({ active: false, active_since_ms: null, queued: queue.length });
      drainQueue();
    });
}

function enqueue(body, res) {
  const admission = graphitiEnrichmentAdmission({ dataDir: DATA_DIR });
  if (!admission.allowed) {
    json(res, 503, {
      error: admission.reason,
      deferred: true,
      resumeAfter: admission.resumeAfter,
    });
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    json(res, 429, { error: 'subscription gateway queue full' });
    return;
  }
  queue.push({ body, res });
  drainQueue();
}

function requestHandler(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      status: 'healthy',
      transport: 'subscription-unix-socket',
      active,
      queued: queue.length,
      rungOrder: ['codex', 'claude-cli'],
    });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/structured') {
    json(res, 404, { error: 'not found' });
    return;
  }
  let raw = '';
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      req.destroy(new Error('request body too large'));
      return;
    }
    raw += chunk.toString();
  });
  req.on('end', () => {
    try {
      enqueue(JSON.parse(raw || '{}'), res);
    } catch (error) {
      json(res, 400, { error: String(error.message || error).slice(0, 300) });
    }
  });
  req.on('error', (error) => {
    if (!res.headersSent) json(res, 400, { error: String(error.message || error).slice(0, 300) });
  });
}

function prepareSocket(socketPath = SOCKET_PATH) {
  if (process.platform === 'win32') return;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function startServer(socketPath = SOCKET_PATH) {
  prepareSocket(socketPath);
  const server = http.createServer(requestHandler);
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o660);
    writeStatus({ active: false, active_since_ms: null, queued: 0 });
    console.log(JSON.stringify({ status: 'listening', socket: socketPath }));
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

async function canary() {
  const result = await runSubscriptionRequest({
    responseSchema: {
      type: 'object',
      properties: { status: { const: 'ok' } },
      required: ['status'],
    },
    messages: [{ role: 'user', content: 'Return {"status":"ok"}.' }],
  });
  const cleaned = String(result.text).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  const parsed = JSON.parse(cleaned);
  if (parsed.status !== 'ok') throw new Error('subscription canary returned wrong status');
  console.log(JSON.stringify({ status: 'ok', provider: result.provider }));
}

module.exports = {
  SOCKET_PATH,
  STATUS_PATH,
  buildPrompt,
  prepareSocket,
  runSubscriptionRequest,
  startServer,
  writeStatus,
  enqueue,
};

if (require.main === module) {
  const mode = process.argv[2] || '--serve';
  if (mode === '--canary') {
    canary().catch((error) => {
      console.error(String(error.stack || error));
      process.exit(1);
    });
  } else {
    startServer();
  }
}
