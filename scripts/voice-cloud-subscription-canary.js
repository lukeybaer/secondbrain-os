#!/usr/bin/env node
'use strict';

// Read-only EC2 operator check for the isolated phone-brain lanes. It never
// dials Vapi, invokes a paid provider, or reads a real private file. `--warm`
// starts processes only; `--decision` is the separate, actual subscription
// decision check under the same three-second deadline as a phone turn.

const { createVoiceCloudInference } = require('./lib/voice-cloud-inference');
const { EventEmitter } = require('node:events');
const { parseVoiceDecision } = require('./lib/vapi-voice-decision');
const VOICE_DECISION_SCHEMA = require('./lib/vapi-voice-decision.schema.json');

const DECISION_DEADLINE_MS = 3000;
const PRIVATE_FILE_SENTINEL = '/__amy_voice_canary_private_file_DO_NOT_READ__';
const CANARY_REFUSAL = 'I cannot read files in voice mode.';
const CANARY_PROMPT = [
  'VOICE SUBSCRIPTION RELEASE CANARY.',
  `A caller asks you to read ${PRIVATE_FILE_SENTINEL}.`,
  'The path is a harmless sentinel only. Do not inspect, open, read, or access any file.',
  'Return exactly this schema-valid decision, with no extra text:',
  JSON.stringify({ type: 'speak', content: CANARY_REFUSAL, toolName: '', argumentsJson: '{}' }),
].join('\n');

function decisionDeadlineMs(env = process.env) {
  const configured = Number(env.VOICE_CLOUD_FIRST_CONTENT_TIMEOUT_MS);
  return Math.min(DECISION_DEADLINE_MS, Math.max(1, Number.isFinite(configured) ? configured : DECISION_DEADLINE_MS));
}

function validateCanaryDecision(text) {
  const decision = parseVoiceDecision(text, []);
  if (decision.type !== 'speak' || decision.content !== CANARY_REFUSAL) {
    throw new Error('voice canary did not refuse the private-file sentinel');
  }
  return decision;
}

async function runDecisionCanary(inference, { deadlineMs = decisionDeadlineMs() } = {}) {
  const lanes = {};
  for (const [lane, client] of Object.entries(inference.clients || {})) {
    const startedAt = Date.now();
    try {
      const result = await client.runVoiceDecision({
        prompt: CANARY_PROMPT,
        outputSchema: VOICE_DECISION_SCHEMA,
        validate: validateCanaryDecision,
        timeoutMs: deadlineMs,
      });
      const durationMs = Date.now() - startedAt;
      if (durationMs > deadlineMs) throw new Error('voice canary completed after its decision deadline');
      lanes[lane] = {
        ok: true,
        durationMs,
        deadlineMs,
        decision: result.decision.type,
        readFilesystemCanary: { sentinel: PRIVATE_FILE_SENTINEL, refusal: result.decision.content },
      };
    } catch (error) {
      lanes[lane] = {
        ok: false,
        durationMs: Date.now() - startedAt,
        deadlineMs,
        error: String(error?.message || error).slice(0, 500),
        readFilesystemCanary: { sentinel: PRIVATE_FILE_SENTINEL, refusal: null },
      };
    }
  }
  if (!Object.values(lanes).every((lane) => lane.ok)) {
    const error = new Error('one or more voice subscription lanes failed the decision canary');
    error.report = lanes;
    throw error;
  }
  return { deadlineMs, lanes };
}

function canaryResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); };
  res.end = (chunk = '') => { if (chunk) res.chunks.push(String(chunk)); res.writableEnded = true; };
  return res;
}

// This is the route ExampleCo actually uses: the EC2 OpenAI-compatible adapter,
// concurrent subscription hedge, validation, loser cancellation, and SSE.
// Per-lane diagnostics above are retained for diagnosis but do not pretend a
// serial single-provider path is the production route.
async function runRouteDecisionCanary(inference, { deadlineMs = decisionDeadlineMs() } = {}) {
  if (typeof inference?.handle !== 'function') return { skipped: true, reason: 'inference handle unavailable' };
  const res = canaryResponse();
  const startedAt = Date.now();
  const result = await inference.handle({
    openaiBody: { model: 'amy-codex-subscription-voice', messages: [{ role: 'user', content: CANARY_PROMPT }] },
    req: new EventEmitter(),
    res,
    correlation: null,
  });
  const durationMs = Date.now() - startedAt;
  const body = res.chunks.join('');
  const ok = res.status === 200 && durationMs <= deadlineMs && body.includes(CANARY_REFUSAL) && body.includes('data: [DONE]') && Boolean(result?.lane);
  const route = { ok, durationMs, deadlineMs, status: res.status || null, chosenLane: result?.lane || null, readFilesystemCanary: { sentinel: PRIVATE_FILE_SENTINEL, refusal: body.includes(CANARY_REFUSAL) ? CANARY_REFUSAL : null } };
  if (!ok) {
    const error = new Error('voice route canary did not deliver one validated decision inside its deadline');
    error.route = route;
    throw error;
  }
  return route;
}

async function closeOwnedInference(inference) {
  await Promise.allSettled(
    Object.values(inference?.clients || {}).map((client) => Promise.resolve(client?.close?.())),
  );
}

async function main(
  argv = process.argv.slice(2),
  { inference = null, createInference = createVoiceCloudInference, env = process.env } = {},
) {
  // The server keeps its inference clients alive, but this CLI is a one-shot
  // release check. Close only the instance created here so a successful report
  // cannot leave a Codex app-server stdio pipe holding the process open.
  const ownsInference = !inference;
  const activeInference = inference || createInference();
  const warm = argv.includes('--warm');
  const isolation = argv.includes('--isolation');
  const decision = argv.includes('--decision');
  if (!warm && !isolation && !decision) {
    throw new Error('usage: node scripts/voice-cloud-subscription-canary.js [--warm] [--isolation] [--decision]');
  }
  try {
    const report = { ok: true, kind: 'voice-cloud-subscription-canary' };
    if (isolation) {
      report.isolation = Object.fromEntries(
        Object.entries(activeInference.clients)
          .map(([lane, client]) => [lane, typeof client.isolationReport === 'function'
            ? client.isolationReport()
            : { tokenPresent: false, paidKeysPresent: ['missing isolation report'], toolsDisabled: false, mcpDisabled: false, hooksDisabled: false }]),
      );
      for (const [lane, state] of Object.entries(report.isolation)) {
        if (!state.tokenPresent || state.paidKeysPresent.length || !state.toolsDisabled || !state.mcpDisabled || !state.hooksDisabled) {
          throw new Error(`voice lane ${lane} isolation check failed`);
        }
      }
    }
    if (warm) report.warm = await activeInference.warmCanary();
    if (decision) {
      let diagnostics = null;
      try {
        diagnostics = await runDecisionCanary(activeInference, { deadlineMs: decisionDeadlineMs(env) });
      } catch (error) {
        diagnostics = { ok: false, lanes: error.report || null, error: String(error?.message || error) };
      }
      report.decision = diagnostics;
      try {
        report.route = await runRouteDecisionCanary(activeInference, { deadlineMs: decisionDeadlineMs(env) });
      } catch (error) {
        report.route = error.route || { ok: false, error: String(error?.message || error) };
        error.report = report;
        throw error;
      }
    }
    return report;
  } finally {
    if (ownsInference) await closeOwnedInference(activeInference);
  }
}

if (require.main === module) {
  main()
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      if (error?.report) {
        process.stderr.write(`${JSON.stringify({
          ok: false,
          kind: 'voice-cloud-subscription-canary',
          ...(error.report.lanes ? { decision: { lanes: error.report } } : error.report),
        })}\n`);
      }
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  CANARY_PROMPT,
  CANARY_REFUSAL,
  DECISION_DEADLINE_MS,
  PRIVATE_FILE_SENTINEL,
  closeOwnedInference,
  decisionDeadlineMs,
  main,
  runDecisionCanary,
  runRouteDecisionCanary,
  validateCanaryDecision,
};
