#!/usr/bin/env node
'use strict';
const { resolveVoicePrimary } = require('./lib/voice-primary');
const { LISTEN_OPENING_METADATA } = require('./lib/outbound-call-broker');

/**
 * Real phone-level Vapi regression test.
 *
 * The webhook probe proves the backend tool route. This script places an actual
 * Vapi outbound call from Amy's test caller number to Amy's inbound number, with
 * a synthetic ExampleCo prompt loaded into the caller assistant. It verifies the full
 * phone path: PSTN/SIP, assistant-request, live prompt, model tool choices,
 * tool execution, transcript, and final spoken behavior.
 *
 * Run after voice deploys:
 *   node scripts/vapi-self-call-status-test.js --live --seed-topic "update blocker card diagnostics"
 *
 * EC2 must trust the outbound test caller number via VAPI_SELF_TEST_CALLER_PHONES.
 *
 * Run `npm run verify:voice-conversation` FIRST. It drives the same multi-turn
 * loop over the model path without placing a real call, so it catches dead air,
 * hang-ups, and garbled speech in seconds instead of burning a phone call. On
 * 2026-08-16 a voice deploy shipped after single-turn checks only, and ExampleCo
 * found the failures on live calls: 13.4s of silence, a hang-up from a 502 on
 * turn 2, and TTS slurring "1 sexession dialogue updated just now".
 */

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const {
  assertCanonicalOutboundCallsAllowed,
  admitInternalVoiceSelfTestEverywhere,
  consumeMachineSelfTestCorrectionLeaseEverywhere,
  defaultDataDir,
  publishVoiceReleaseProof,
} = require('./lib/outbound-call-control');
const { resolveVapiRuntimeConfig } = require('./lib/vapi-runtime-config');
const {
  buildVapiModelHeaders,
  resolveVapiLlmSecret,
  withVapiCallIdMarker,
} = require('./lib/vapi-call-correlation');
const {
  VAPI_SUBSCRIPTION_LLM_URL,
  VAPI_SUBSCRIPTION_VOICE_MODEL,
} = require('./lib/vapi-static-model');
const { inferenceLedgerPath } = require('./lib/inference-work-ledger');
const { currentVoiceSurface, writeVoiceReleaseProof } = require('./lib/voice-release-proof');

const DEFAULT_MAX_DURATION_SECONDS = 90;
// Amy's live inbound assistant. Its stored model headers carry the LLM secret
// EC2 actually accepts, which is the only authority on whether a self-call will
// authenticate.
const AMY_LIVE_ASSISTANT_ID = 'ExampleCo-2da6-45b2-9379-1b575634a337';
const MAX_SELF_CALL_DURATION_SECONDS = 180;
// A simple phone answer must first become useful within three seconds. A
// harder answer may stream to the bounded completion deadline.
const DEFAULT_MAX_VOICE_INFERENCE_MS = 3000;
// 2026-10-03: at 1.5s the caller still answered a four-sentence status reply
// three times (call 01a102d6), failing the duplicate-turn check on its own leg
// while Amy's leg was clean. Amy pauses up to about two seconds between
// sentences of a tool result, so the caller waits longer than that.
// 2026-10-05: at 2.8s it happened again right after a deploy restart (call
// 01a10bc1-ef1a): the caller's turn 2 started three times, 2.7 and 3.8 seconds
// apart, with identical output, while Amy's three-sentence answer was correct
// and her own leg was clean. The wait now clears the longest pause observed.
const SYNTHETIC_CALLER_WAIT_SECONDS = 4.5;
// A backend that restarted moments ago pauses longest between sentences, which
// is when the synthetic caller repeats its turn. The proof never dials until
// the backend has been up this long. It waits for that, bounded, and refuses
// to dial when the health endpoint cannot be read.
const MIN_BACKEND_UPTIME_SECONDS = 180;
const BACKEND_WARM_TIMEOUT_MS = 6 * 60 * 1000;
const BACKEND_WARM_POLL_MS = 15 * 1000;
// One health request may not outlive this, or the remaining overall deadline.
const BACKEND_HEALTH_REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_VOICE_COMPLETION_DURATION_MS = 45000;
const ACCEPTABLE_SELF_CALL_END_REASONS = new Set([
  'assistant-ended-call',
  'assistant-said-end-call-phrase',
  'customer-ended-call',
]);
const DEFAULT_FORBID = [
  'could not find agent session',
  'no active or recent',
  'do not have active or recent',
  "don't have a confirmed live session",
  'do not have a confirmed live session',
  'found no active',
  'found no recent',
  "can't retrieve detailed progress",
  'cannot retrieve detailed progress',
  'checking live status',
  'this will just take a sec',
  'this will just take a second',
  'give me a moment',
  'give me a second',
  'sorry. a few more seconds',
  'a few more seconds',
  'start a new session',
  'restart the task',
  'investigate further',
  'Amy Call',
  '0 1 9 f',
  '7 0 0 0',
  '7000 launched',
  '7000 completed',
  '7000 of 7000',
];

function usage() {
  console.log(`Usage:
  node scripts/vapi-self-call-status-test.js --live [options]

Options:
  --live                 Required. Places a real Vapi phone call.
  --seed-topic <text>    Seed the real status topic used by the call and default assertion.
  --first <text>         First synthetic ExampleCo utterance. Defaults from --seed-topic.
  --expect <text>        Additional exact transcript text. Repeatable.
  --forbid <text>        Forbidden transcript text. Repeatable.
  --score-speaker <who>  all, user, or ai. Default: user, because outbound self-calls label inbound Amy as User.
  --expected-tool <name> Receiving-Amy tool required by this scenario. Default: check_spine.
  --no-default-expect    Skip the default normalized topic-evidence check.
  --max-duration-sec <n> Damage ceiling for the real call. Default: 90; maximum: 180.
  --max-inference-ms <n> Maximum measured first meaningful voice response. Default and hard maximum: 3000.
  --timeout-sec <n>      Poll timeout. Default: 180.
  --machine-correction-invocation-key <key>
                       Consume one server-verified machine-only correction lease before dialing.
  --dry-run              Print the call target and prompt without dialing.
  --help                 Show this message.
`);
}

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function readConfig() {
  let diskConfig = {};
  try {
    diskConfig = JSON.parse(
      fs.readFileSync(path.join(appDataDir(), 'secondbrain', 'config.json'), 'utf8'),
    );
  } catch {
    // EC2 acceptance tests have no desktop config. The same canonical runtime
    // credential and stable Vapi resource IDs are resolved below.
  }
  return resolveVapiRuntimeConfig({ diskConfig });
}

function parseArgs(argv) {
  const opts = {
    first: '',
    expect: [],
    forbid: [...DEFAULT_FORBID],
    scoreSpeaker: 'user',
    timeoutSec: 180,
    defaultExpect: true,
    maxDurationSec: DEFAULT_MAX_DURATION_SECONDS,
    maxInferenceMs: DEFAULT_MAX_VOICE_INFERENCE_MS,
    expectedTool: 'check_spine',
    callerOpening: 'listen',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--seed-topic') opts.seedTopic = argv[++i] || '';
    else if (arg === '--first') opts.first = argv[++i] || '';
    else if (arg === '--caller-opening') opts.callerOpening = argv[++i] || '';
    else if (arg === '--no-default-expect') opts.defaultExpect = false;
    else if (arg === '--expect') opts.expect.push(argv[++i] || '');
    else if (arg === '--forbid') opts.forbid.push(argv[++i] || '');
    else if (arg === '--score-speaker') opts.scoreSpeaker = argv[++i] || 'user';
    else if (arg === '--expected-tool') opts.expectedTool = argv[++i] || 'check_spine';
    else if (arg === '--max-duration-sec') opts.maxDurationSec = Number(argv[++i] || 0);
    else if (arg === '--max-inference-ms') opts.maxInferenceMs = Number(argv[++i] || 0);
    else if (arg === '--timeout-sec') opts.timeoutSec = Number(argv[++i] || 180);
    else if (arg === '--machine-correction-invocation-key') {
      opts.machineCorrectionInvocationKey = argv[++i] || '';
    }
    else throw new Error('Unknown argument: ' + arg);
  }
  if (opts.help) return opts;
  if (!opts.first && opts.seedTopic) {
    opts.first = `What is the current status of ${opts.seedTopic}?`;
  }
  const requestedDuration = Number(opts.maxDurationSec);
  opts.maxDurationSec =
    Number.isFinite(requestedDuration) && requestedDuration > 0
      ? Math.max(30, Math.min(MAX_SELF_CALL_DURATION_SECONDS, requestedDuration))
      : DEFAULT_MAX_DURATION_SECONDS;
  const requestedInferenceMs = Number(opts.maxInferenceMs);
  opts.maxInferenceMs =
    Number.isFinite(requestedInferenceMs) && requestedInferenceMs > 0
      ? Math.max(1000, Math.min(DEFAULT_MAX_VOICE_INFERENCE_MS, requestedInferenceMs))
      : DEFAULT_MAX_VOICE_INFERENCE_MS;
  if (!opts.first) {
    throw new Error('Pass --seed-topic or an explicit --first utterance.');
  }
  if (!['listen', 'speak'].includes(opts.callerOpening)) {
    throw new Error('--caller-opening must be listen or speak.');
  }
  if (!opts.expect.length && opts.defaultExpect && !opts.seedTopic) {
    throw new Error('Pass --seed-topic, --expect, or --no-default-expect.');
  }
  if (
    opts.machineCorrectionInvocationKey &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(opts.machineCorrectionInvocationKey)
  ) {
    throw new Error('Machine self-test correction invocation key contains unsafe characters.');
  }
  return opts;
}

async function admitSelfCallBeforeDial(opts, deps = {}) {
  if (opts.internalTestInvocationKey) {
    const admit = deps.admitInternalVoiceSelfTestEverywhere || admitInternalVoiceSelfTestEverywhere;
    return admit({
      dataDir: deps.dataDir || defaultDataDir(),
      rootDir: deps.rootDir || path.resolve(__dirname, '..'),
      invocationKey: opts.internalTestInvocationKey,
      phoneNumber: opts.machineCorrectionTargetPhone,
      phoneNumberId: opts.machineCorrectionPhoneNumberId,
      inboundPhoneNumberId: opts.inboundPhoneNumberId,
    });
  }
  const assertAllowed = deps.assertCanonicalOutboundCallsAllowed || assertCanonicalOutboundCallsAllowed;
  const consumeCorrection =
    deps.consumeMachineSelfTestCorrectionLeaseEverywhere ||
    consumeMachineSelfTestCorrectionLeaseEverywhere;
  const dataDir = deps.dataDir || defaultDataDir();
  const key = String(opts.machineCorrectionInvocationKey || '').trim();
  if (key) {
    const phoneNumber = String(opts.machineCorrectionTargetPhone || '').trim();
    const phoneNumberId = String(opts.machineCorrectionPhoneNumberId || '').trim();
    if (!phoneNumber || !phoneNumberId) {
      throw new Error('Machine self-test correction requires the current harness destination and Vapi phone-number ID.');
    }
    await assertAllowed({
      dataDir,
      purpose: 'machine-self-test-correction',
      invocationKey: key,
      phoneNumber,
      phoneNumberId,
    });
    // This consumes the cross-host lease before the Vapi POST. A replay,
    // changed pause, or local/EC2 disagreement stops here with no phone call.
    await consumeCorrection({ dataDir, invocationKey: key, phoneNumber, phoneNumberId });
    return { mode: 'machine-self-test-correction', invocationKey: key, phoneNumber, phoneNumberId };
  }
  await assertAllowed({
    dataDir,
    purpose: 'voice-self-test',
    allowReleaseProofRun: true,
  });
  return { mode: 'release-proof' };
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json;
}

function postJson(urlString, body, secret) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (secret) headers['x-vapi-secret'] = secret;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, raw });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getPhoneNumber(config, id) {
  const phone = await apiFetch('https://api.vapi.ai/phone-number/' + id, {
    headers: { Authorization: `Bearer ${config.vapiApiKey}` },
  });
  if (!phone.number) throw new Error('Vapi phone number has no number: ' + id);
  return phone;
}

// The backend the call will actually reach is the server URL on the inbound
// phone resource Vapi routes the call to. Probe that one; a stale environment
// or config value could name a different backend. Without a provider URL the
// gate refuses rather than guessing.
function backendHealthUrl(inboundPhone = {}) {
  const webhookUrl = String((inboundPhone && inboundPhone.server && inboundPhone.server.url) || '').trim();
  if (!/^https:\/\/\S+$/i.test(webhookUrl)) {
    throw new Error('Inbound phone resource has no https server URL; the proof was not dialed.');
  }
  // The health endpoint sits beside the webhook on the same gateway stage.
  const suffix = '/vapi/webhook';
  const base = String(webhookUrl).replace(new RegExp('[/]+$'), '');
  return (base.endsWith(suffix) ? base.slice(0, -suffix.length) : base) + '/health';
}

// Resolves once the backend reports at least the minimum uptime. Throws, so
// nothing is reserved or dialed, when the deadline passes first or the health
// endpoint never answers with a numeric uptime.
async function waitForBackendWarm(
  inboundPhone,
  {
    fetchJson = (url, opts) => apiFetch(url, opts),
    requestTimeoutMs = BACKEND_HEALTH_REQUEST_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    minUptimeSeconds = MIN_BACKEND_UPTIME_SECONDS,
    timeoutMs = BACKEND_WARM_TIMEOUT_MS,
    pollMs = BACKEND_WARM_POLL_MS,
    log = (line) => console.log(line),
  } = {},
) {
  const url = backendHealthUrl(inboundPhone);
  const deadline = now() + timeoutMs;
  let uptime = NaN;
  let failure = '';
  const refuse = () => {
    throw new Error(
      Number.isFinite(uptime)
        ? `Backend restarted ${Math.round(uptime)}s ago and is not warm; the proof was not dialed.`
        : `Backend health could not be read (${failure || 'no numeric uptime'}); the proof was not dialed.`,
    );
  };
  for (;;) {
    // The deadline is checked before every request, so a warm answer that
    // would only arrive after it can never start a dial.
    const remainingMs = deadline - now();
    if (remainingMs <= 0) refuse();
    uptime = NaN;
    failure = '';
    // A stalled connection must not hold the proof past its own deadline:
    // each request is aborted after its timeout, capped by the time left.
    const requestMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
    const controller = new AbortController();
    let timer;
    try {
      const health = await Promise.race([
        fetchJson(url, { signal: controller.signal }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`health request timed out after ${requestMs}ms`));
          }, requestMs);
        }),
      ]);
      uptime = Number(health && health.uptime);
    } catch (error) {
      failure = String((error && error.message) || error);
    } finally {
      clearTimeout(timer);
    }
    if (Number.isFinite(uptime) && uptime >= minUptimeSeconds) {
      return { uptimeSeconds: uptime };
    }
    const leftMs = deadline - now();
    if (leftMs <= 0) refuse();
    log(
      Number.isFinite(uptime)
        ? `[self-call] backend up ${Math.round(uptime)}s; waiting for ${minUptimeSeconds}s before dialing`
        : '[self-call] backend health not readable yet; waiting before dialing',
    );
    // Never sleep past the deadline.
    await sleep(Math.min(pollMs, leftMs));
  }
}

async function seedRecentTopic(config, topic, ownerPhone) {
  if (!topic) return null;
  const webhookUrl =
    process.env.VAPI_WEBHOOK_URL ||
    config.vapiServerUrl ||
    'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';
  const secret = process.env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '';
  const callId = 'self_test_seed_' + Date.now();
  const payload = {
    message: {
      type: 'voice-self-test-status-seed',
      seedId: callId,
      topic,
      call: {
        id: callId,
        customer: { number: ownerPhone },
        startedAt: new Date().toISOString(),
      },
      transcript: [
        'AI: Hey, ExampleCo.',
        'User: How is the ' + topic + ' session going?',
        "AI: I'm checking the live spine.",
      ].join('\n'),
      analysis: { summary: 'ExampleCo asked for the ' + topic + ' session status.' },
    },
  };
  const res = await postJson(webhookUrl, payload, secret);
  if (res.status < 200 || res.status >= 300) {
    throw new Error('recent-context seed failed: HTTP ' + res.status + ' ' + res.raw.slice(0, 300));
  }
  let response = {};
  try {
    response = JSON.parse(res.raw || '{}');
  } catch {
    /* status code remains authoritative */
  }
  return { seedId: callId, taskId: response.taskId || '' };
}

async function clearRecentTopic(config, seed, ownerPhone) {
  if (!seed || !seed.seedId) return;
  const webhookUrl =
    process.env.VAPI_WEBHOOK_URL ||
    config.vapiServerUrl ||
    'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';
  const secret = process.env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '';
  const payload = {
    message: {
      type: 'voice-self-test-status-clear',
      seedId: seed.seedId,
      call: {
        id: seed.seedId,
        customer: { number: ownerPhone },
      },
    },
  };
  const res = await postJson(webhookUrl, payload, secret);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      'recent-context clear failed: HTTP ' + res.status + ' ' + res.raw.slice(0, 300),
    );
  }
}

// Caller-leg transcript: `AI:` is the synthetic caller, `User:` the receiving
// Amy. A passing listen opening is the caller's "Hello?" into dead air, then
// Amy's reply, then the caller's question, in that order.
function scoreListenOpening(transcript, first) {
  const turns = String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^(AI|User):\s*(.*)$/))
    .filter(Boolean)
    .map((m) => ({ who: m[1], text: m[2].trim() }));
  if (!turns.length) return { ok: false, issue: 'empty transcript' };
  // The transcriber punctuates the spoken "Hello?" freely ("Hello." on
  // 2026-10-06); the words are the evidence, not the mark.
  const isHello = (text) => /^hello[.?!]?$/i.test(text);
  if (turns[0].who !== 'AI' || !isHello(turns[0].text)) {
    return { ok: false, issue: 'first turn was not the caller saying Hello?: ' + JSON.stringify(turns[0]) };
  }
  if (turns[1]?.who !== 'User') return { ok: false, issue: 'the receiving Amy never answered the Hello?' };
  // Hello? belongs to the opening only; a second one means the check fired
  // again later in the call (a hold or a pause), which a callee hears as broken.
  const hellos = turns.filter((t) => t.who === 'AI' && isHello(t.text)).length;
  if (hellos !== 1) return { ok: false, issue: 'the caller said Hello? ' + hellos + ' times; it must cover only the opening' };
  // The caller's first turn after Amy answers must be the opening itself:
  // most of its meaningful words, not one shared filler word like "what".
  // The transcriber writes "three" as "3" (2026-10-06), so number words count
  // as their digits. At least one subject word must match exactly, so a
  // generic "current status" plus a number never stands in for the opening.
  const meaningful = (text) =>
    new Set(
      (String(text || '').toLowerCase().match(/[a-z]+|\d+/g) || [])
        .map((w) => LISTEN_SCORE_NUMBERS[w] || w)
        .filter((w) => (/^\d+$/.test(w) || w.length >= 4) && !LISTEN_SCORE_STOPWORDS.has(w)),
    );
  const expected = [...meaningful(first)];
  const next = turns.slice(2).find((t) => t.who === 'AI');
  if (!next) return { ok: false, issue: 'the caller never took its turn after Amy answered' };
  const said = meaningful(next.text);
  const matched = expected.filter((w) => said.has(w));
  const subjectMatched = matched.some((w) => !/^\d+$/.test(w) && !LISTEN_SCORE_GENERIC.has(w));
  if (!expected.length || matched.length / expected.length < 0.6 || !subjectMatched) {
    return { ok: false, issue: 'the caller turn after Amy answered was not its opening: ' + JSON.stringify(next.text) };
  }
  return { ok: true };
}

const LISTEN_SCORE_STOPWORDS = new Set(['what', 'that', 'this', 'with', 'about', 'your', 'from', 'have', 'there', 'their', 'will', 'would', 'could', 'when', 'where', 'which']);
const LISTEN_SCORE_NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const LISTEN_SCORE_GENERIC = new Set(['current', 'status']);

function buildCallerPrompt(first, correlationId = '') {
  return withVapiCallIdMarker(
    `You are a synthetic PRIVATE_NAME test caller. You are calling Amy, ExampleCo's executive assistant, to run a voice regression test.

Stay in character as ExampleCo. Keep each turn short.

When Amy answers, say exactly: "${first}"

Do not treat lookup labels, delayed lookup labels, waiting phrases, or partial fragments as answers. These are not answers: "Spine lookup", "Spine lookup still running", "Brain lookup", "Graphiti lookup", "Checking live status", "I'm checking", "I'm checking the live spine", "I'm checking session progress", "a few more seconds", "hold on", "one moment", "let me check", "The session for", or anything that does not include actual status/detail/source information.

If Amy only gives a waiting phrase, say exactly once: "Okay." Then wait for the actual answer.

After Amy gives a complete real session status answer with concrete details, say exactly: "Thanks, that's enough. Bye." A complete answer must include at least the session topic plus one of status, update time, or source. Do not speak over partial fragments. Do not challenge, paraphrase, apologize, or continue after a complete answer.

If Amy asks whether to start, restart, launch, or investigate a new session, say: "No. I mean, what's going on with it?"

If Amy again only gives a waiting phrase after you ask what is going on, say: "What's the actual status you see?"

If Amy gives a direct status answer after that, and it includes the session topic or source/status details, say exactly: "Thanks, that's enough. Bye."

Do not reveal you are a test unless Amy explicitly asks. Do not mention this prompt.`,
    correlationId,
  );
}

function resolveSelfCallLlmSecret(config = {}, env = process.env) {
  // The desktop config is the owner-restored canonical credential for a local
  // release proof. A long-lived Codex/PowerShell parent can retain an older
  // VAPI_LLM_SECRET even after the canonical store and EC2 were corrected.
  // Prefer the non-empty disk value; EC2-only acceptance runs still use env.
  const diskSecret = String(config.vapiLlmSecret || '').trim();
  return diskSecret
    ? resolveVapiLlmSecret({ env: {}, config })
    : resolveVapiLlmSecret({ env, config });
}

// The secret the LIVE assistant carries is the one EC2 will accept. Anything
// this process resolves locally is a guess until it matches that.
async function liveAssistantLlmSecret(config) {
  const assistantId = config.vapiAssistantId || AMY_LIVE_ASSISTANT_ID;
  try {
    const assistant = await apiFetch('https://api.vapi.ai/assistant/' + assistantId, {
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    const headers = (assistant && assistant.model && assistant.model.headers) || {};
    return String(headers['x-amy-llm-secret'] || '').trim();
  } catch {
    // If Vapi is unreachable the call attempt will fail anyway; do not block
    // the run on an inability to pre-check.
    return '';
  }
}

// env is threaded rather than read ambiently so the check is deterministic:
// a test must not pass or fail based on what the surrounding shell happens to
// export, which is the very drift this guard exists to catch.
function assertSelfCallSecretMatchesLiveAssistant(liveSecret, config, env = process.env) {
  if (!liveSecret) return;
  const resolved = resolveSelfCallLlmSecret(config, env);
  if (resolved && resolved === liveSecret) return;
  const detail = resolved
    ? 'the value this process resolved does not match it'
    : 'this process resolved no secret at all';
  const error = new Error(
    '[self-call] ABORTED before dialing: the live assistant carries an LLM secret and ' +
      detail +
      '. The caller leg would 401 and Vapi would end the call as ' +
      'pipeline-error-custom-llm-401-unauthorized, which trips the safety breaker and ' +
      'pauses every outbound call pending owner review. Fix the credential first: set ' +
      'config.vapiLlmSecret in the desktop config, or export a current VAPI_LLM_SECRET. ' +
      'A long-lived shell keeping an old value is the usual cause.',
  );
  error.code = 'SELF_CALL_LLM_SECRET_MISMATCH';
  throw error;
}

function buildCallBody(config, inboundNumber, first, maxDurationSec, callerBase = {}, callerOpening = 'speak') {
  const correlationId = crypto.randomUUID();
  if (!callerBase.voice || typeof callerBase.voice !== 'object') {
    throw new Error('Self-call requires the saved Amy voice configuration.');
  }
  const assistant = {
    name: 'Amy self-call synthetic owner',
    voice: callerBase.voice,
    ...(callerBase.transcriber && typeof callerBase.transcriber === 'object'
      ? { transcriber: callerBase.transcriber }
      : {}),
    // The receiving Amy waits for this dedicated self-test number. Put the
    // question on the wire deterministically; later turns still use the
    // isolated model to evaluate Amy's real answer and close naturally.
    // `listen` proves the third-party outbound opening: the receiving Amy stays
    // silent for this number, which is a dead-air pickup, so the caller must
    // say the broker's "Hello?" and then ask its question once Amy answers.
    ...(callerOpening === 'listen'
      ? { firstMessage: '', firstMessageMode: 'assistant-waits-for-user' }
      : { firstMessage: first, firstMessageMode: 'assistant-speaks-first' }),
    firstMessageInterruptionsEnabled: true,
    backgroundSound: 'off',
    // The synthetic caller is patient: it lets Amy finish a multi-clause answer
    // before replying. With Amy's own snappy 0.2s plan it replied to every pause
    // in her speech and ran one logical turn three times (2026-09-29 18:12 UTC),
    // failing the duplicate-turn check on the test caller's leg, not Amy's.
    startSpeakingPlan: {
      waitSeconds: SYNTHETIC_CALLER_WAIT_SECONDS,
      smartEndpointingPlan: { provider: 'vapi' },
    },
    stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.4, backoffSeconds: 1 },
    model: {
      provider: 'custom-llm',
      model: resolveVoicePrimary().model,
      url: VAPI_SUBSCRIPTION_LLM_URL,
      headers: buildVapiModelHeaders(resolveSelfCallLlmSecret(config), correlationId),
      messages: [{ role: 'system', content: buildCallerPrompt(first, correlationId) }],
      tools: [],
      maxTokens: 500,
    },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: maxDurationSec,
    endCallPhrases: ["Thanks, that's enough. Bye.", 'Bye.', 'Goodbye.'],
  };
  return {
    phoneNumberId: config.vapiPhoneNumberId,
    customer: { number: inboundNumber },
    metadata: {
      amyCallCorrelationId: correlationId,
      ...(callerOpening === 'listen' ? LISTEN_OPENING_METADATA : {}),
    },
    // Inline the caller so Vapi cannot merge the saved Amy assistant's tools
    // back into a supposedly tool-free synthetic caller.
    assistant,
  };
}

function redactCallBodyForDiagnostics(body) {
  const copy = JSON.parse(JSON.stringify(body || {}));
  const headers = copy?.assistant?.model?.headers;
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (/secret|authorization|api[-_]?key|token/i.test(key)) headers[key] = '[redacted]';
    }
  }
  return copy;
}

async function initiateCall(config, body) {
  return apiFetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.vapiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function pollCall(config, callId, timeoutSec) {
  const deadline = Date.now() + Math.max(30, timeoutSec || 180) * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await apiFetch('https://api.vapi.ai/call/' + callId, {
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    process.stderr.write(
      `[self-call] ${new Date().toISOString().slice(11, 19)} ${last.status || 'unknown'}${
        last.endedReason ? ' (' + last.endedReason + ')' : ''
      }\n`,
    );
    if (last.status === 'ended') return last;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  last = await apiFetch('https://api.vapi.ai/call/' + callId, {
    headers: { Authorization: `Bearer ${config.vapiApiKey}` },
  });
  if (last.status === 'ended') return last;
  throw new Error('poll timeout for call ' + callId);
}

function saveCallRecord(call) {
  // A self-test call dials only ExampleCo's own number.
  if (call && call.id) {
    require('./lib/outbound-send-record.js').recordOutboundSend({
      surface: 'vapi-call-out', authorization: 'principal-test', details: { call_id: call.id, script: 'vapi-self-call-status-test' },
    });
  }
  const dir = path.join(defaultDataDir(), 'calls');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${call.id || 'vapi-self-test-' + Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(call, null, 2), 'utf8');
  return file;
}

function transcriptForSpeaker(transcript, speaker = 'all') {
  const mode = String(speaker || 'all').toLowerCase();
  if (mode === 'all') return String(transcript || '');
  if (!['user', 'ai'].includes(mode)) throw new Error('Invalid --score-speaker: ' + speaker);

  const wanted = mode === 'user' ? 'User' : 'AI';
  return String(transcript || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(AI|User):\s*(.*)$/i);
      if (!match) return '';
      return match[1].toLowerCase() === wanted.toLowerCase() ? match[2] : '';
    })
    .filter(Boolean)
    .join('\n');
}

function scoreTranscript(transcript, expectList, forbidList) {
  const normalize = (value) =>
    String(value || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  const lower = normalize(transcript);
  const missing = expectList.filter((x) => x && !lower.includes(normalize(x)));
  const forbidden = forbidList.filter((x) => x && lower.includes(normalize(x)));
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
  };
}

function evaluateCallCloseReasons(callDetails = []) {
  return (callDetails || []).flatMap((call) => {
    const reason = String(call?.endedReason || '').toLowerCase();
    if (ACCEPTABLE_SELF_CALL_END_REASONS.has(reason)) return [];
    return [
      `${String(call?.id || 'unknown')} closed with ${reason || 'no provider reason'} instead of ending naturally after a useful answer`,
    ];
  });
}

// A real receptionist once heard "One sec." in front of almost every
// sentence and hung up. Every Amy-to-Amy proof at the time PASSED while its own
// transcript was littered with the same thing, because this harness only ever
// scored machine facts: receipts, attribution, durations, tool names, topic
// terms. It never listened to how Amy sounded. A proof that cannot fail on
// speech that would embarrass ExampleCo is not a release gate for a phone call.
//
// The hold phrase is legitimate on a genuinely slow turn, so this does not ban
// it. It fails when it is pervasive, or when it opens the conversation, which
// are the two shapes a callee actually notices.
const HOLD_PHRASE_PATTERN = /\b(?:one|1)\s*sec\b/i;

function scoreHoldPhraseLeakage(transcript) {
  const lines = String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const spoken = lines.filter((line) => /^(?:ai|assistant)\s*:/i.test(line));
  const strip = (line) => line.replace(/^(?:ai|assistant)\s*:\s*/i, '');
  const withHold = spoken.filter((line) => HOLD_PHRASE_PATTERN.test(line));
  const opensWithHold = spoken.length
    ? HOLD_PHRASE_PATTERN.test(strip(spoken[0]).slice(0, 24))
    : false;
  // A bare "One." before a greeting is the worst shape: the hold fired before
  // Amy had said anything, so the callee heard a number as her opening word.
  const bareNumberOpener = spoken.some((line) =>
    /^(?:one|1)\b[.,]?\s+(?:hi|hello|good|this is|thanks|thank)/i.test(strip(line)),
  );
  const ratio = spoken.length ? withHold.length / spoken.length : 0;
  return {
    spokenTurns: spoken.length,
    holdTurns: withHold.length,
    ratio: Math.round(ratio * 100) / 100,
    opensWithHold,
    bareNumberOpener,
    ok: !opensWithHold && !bareNumberOpener && !(spoken.length >= 3 && ratio > 0.5),
  };
}

function scoreTopicEvidence(transcript, topic) {
  // Provider speech-to-text commonly expands product compounds and ordinal
  // names ("SecondBrain backend" -> "2nd brain back end") and rendered the
  // exact observed product phrase as "2nd ring back end" in live self-call
  // 01a0c035-f0e1-7dd6-b410-90af605c3f32. Keep that ambiguous homophone
  // transcript-only and require the adjacent backend phrase so an unrelated
  // mention of a second ring cannot satisfy SecondBrain topic evidence.
  const normalizeEvidenceText = (value, { transcriptSide = false } = {}) => {
    let normalized = String(value || '').toLowerCase();
    if (transcriptSide) {
      normalized = normalized.replace(
        /\b(?:2nd|second)\s+ring\s+back\s+end\b/g,
        'secondbrain backend',
      );
    }
    return normalized
      .replace(/\b(?:2nd|second)\s+brain\b/g, 'secondbrain')
      .replace(/\bback\s+end\b/g, 'backend');
  };
  const stop = new Set([
    'about',
    'after',
    'before',
    'going',
    'session',
    'status',
    'that',
    'this',
    'with',
  ]);
  const tokens = [
    ...new Set(
      normalizeEvidenceText(topic)
        .match(/[a-z0-9]+/g) || [],
    ),
  ].filter((token) => token.length >= 4 && !stop.has(token));
  const spoken = new Set(
    normalizeEvidenceText(transcript, { transcriptSide: true })
      .match(/[a-z0-9]+/g) || [],
  );
  const matched = tokens.filter((token) => spoken.has(token));
  const required = Math.min(2, tokens.length);
  return { ok: required > 0 && matched.length >= required, tokens, matched, required };
}

function parseInferenceRowsSince(text, sinceMs) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return Date.parse(String(row.ts || '')) >= sinceMs ? [row] : [];
      } catch {
        return [];
      }
    });
}

// Paid primary voice inference runs on EC2, so its receipts land in EC2's
// ledger, not the desktop's. A desktop-run proof must read both (2026-09-29:
// a clean talkback failed with "no vapi-voice events were written").
function readCanonicalInferenceText(sinceMs) {
  // Windows resolves /opt to C:\opt, which can exist on the desktop; only a
  // Linux host with the canonical data dir is EC2 itself.
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data/agent')) return null;
  const { runRemote } = require('./lib/ec2-remote');
  // Filter on EC2 so only this call's window crosses SSH; the whole ledger can
  // exceed the default spawnSync output buffer.
  const since = Number(sinceMs) || 0;
  const filter =
    "const fs=require('fs');const f='/opt/secondbrain/data/agent/inference-work-events.jsonl';" +
    `if(fs.existsSync(f))for(const l of fs.readFileSync(f,'utf8').split('\\n')){try{if(Date.parse(JSON.parse(l).ts)>=${since})console.log(l)}catch{}}`;
  const r = runRemote(`node -e ${JSON.stringify(filter)}`, { timeoutMs: 60000 });
  if (r.status !== 0) throw new Error('could not read the EC2 inference ledger: ' + String(r.stderr).slice(0, 200));
  return r.stdout;
}

function readInferenceEventsSince(sinceMs, { readRemote = readCanonicalInferenceText } = {}) {
  const file = inferenceLedgerPath();
  const local = fs.existsSync(file) ? parseInferenceRowsSince(fs.readFileSync(file, 'utf8'), sinceMs) : [];
  const remoteText = readRemote(sinceMs);
  if (remoteText == null) return { file, rows: local };
  const remote = parseInferenceRowsSince(remoteText, sinceMs);
  // Suppress only a local row mirrored in the EC2 ledger. Duplicates within one
  // ledger stay, because the verifier must see and reject them.
  const key = (row) => `${row.inferenceId}|${row.event}|${row.ts}`;
  const mirrors = new Map();
  for (const row of remote) mirrors.set(key(row), (mirrors.get(key(row)) || 0) + 1);
  const unmirrored = local.filter((row) => {
    const left = mirrors.get(key(row)) || 0;
    if (!left) return true;
    mirrors.set(key(row), left - 1);
    return false;
  });
  const rows = [...unmirrored, ...remote];
  return { file: `${file} + EC2 ledger`, rows };
}

function normalizePhone(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(-10);
}

async function discoverSelfCallIds(config, createdId, sinceMs, outboundNumber) {
  const deadline = Date.now() + 30_000;
  let related = [];
  while (Date.now() < deadline) {
    const calls = await apiFetch('https://api.vapi.ai/call?limit=100', {
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    const rows = Array.isArray(calls) ? calls : calls.results || [];
    related = selectRelatedSelfCalls({
      rows,
      createdId,
      sinceMs,
      inboundPhoneNumberId: config.vapiInboundPhoneNumberId,
      outboundNumber,
    });
    if (new Set(related.map((call) => call.id).filter(Boolean)).size >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return {
    ids: [...new Set(related.map((call) => String(call.id || '')).filter(Boolean))],
    calls: related.map((call) => ({
      id: call.id,
      type: call.type,
      status: call.status,
      endedReason: call.endedReason,
      phoneNumberId: call.phoneNumberId,
    })),
  };
}

function selectRelatedSelfCalls({
  rows = [],
  createdId,
  sinceMs,
  inboundPhoneNumberId,
  outboundNumber,
} = {}) {
  const created = rows.find((call) => String(call?.id || '') === String(createdId || ''));
  if (!created) return [];
  const anchorMs = Date.parse(String(created.createdAt || created.startedAt || '')) || sinceMs;
  const inbound = rows
    .filter((call) => {
      if (String(call?.id || '') === String(createdId || '')) return false;
      const createdAt = Date.parse(String(call?.createdAt || call?.startedAt || ''));
      return (
        call?.phoneNumberId === inboundPhoneNumberId &&
        Number.isFinite(createdAt) &&
        createdAt >= sinceMs - 2 * 60 * 1000 &&
        Math.abs(createdAt - anchorMs) <= 30_000 &&
        normalizePhone(call?.customer?.number) === normalizePhone(outboundNumber)
      );
    })
    .sort(
      (a, b) =>
        Math.abs(Date.parse(String(a.createdAt || a.startedAt || '')) - anchorMs) -
        Math.abs(Date.parse(String(b.createdAt || b.startedAt || '')) - anchorMs),
    )[0];
  return inbound ? [created, inbound] : [created];
}

function toolNamesFromCall(call) {
  const names = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if ((key === 'toolCalls' || key === 'tool_calls') && Array.isArray(nested)) {
        for (const toolCall of nested) {
          const name = toolCall?.function?.name || toolCall?.name;
          if (name) names.add(String(name));
        }
      }
      if (
        (value.role === 'tool' || value.type === 'tool-call' || value.type === 'tool_call') &&
        key === 'name' &&
        typeof nested === 'string'
      ) {
        names.add(nested);
      }
      visit(nested);
    }
  };
  visit(call?.artifact?.messages || call?.messages || []);
  return [...names];
}

// Tool calls Vapi executed on one leg, from its own log. Any ambiguity (a
// reused or missing call ID) returns null so a proof relying on it fails.
// True when the caller leg's Vapi messages hold exactly one bot line between
// the last callee line before the turn settled and the next callee line, and
// that line is exactly the settled reply's byte length.
function callerSpokeOnce(messages, settledTimes, outputBytes) {
  if (!Array.isArray(messages) || !settledTimes.length || !settledTimes.every(Number.isFinite)) return false;
  if (!(outputBytes > 0)) return false;
  const lines = messages
    .filter((m) => m?.role === 'bot' || m?.role === 'user')
    .map((m) => ({ role: m.role, time: Number(m.time), text: String(m.message || '').trim() }));
  if (lines.some((m) => !Number.isFinite(m.time))) return false;
  const firstSettled = Math.min(...settledTimes);
  const userTimes = lines.filter((m) => m.role === 'user').map((m) => m.time);
  const before = Math.max(-Infinity, ...userTimes.filter((t) => t < firstSettled));
  const after = Math.min(Infinity, ...userTimes.filter((t) => t > before));
  const run = lines.filter((m) => m.role === 'bot' && m.time > before && m.time < after);
  return run.length === 1 && Buffer.byteLength(run[0].text) === outputBytes;
}

function executedToolCallCount(call) {
  const ids = new Set();
  for (const message of call?.artifact?.messages || call?.messages || []) {
    if (message?.role !== 'tool_calls') continue;
    for (const toolCall of message?.toolCalls || message?.tool_calls || []) {
      const id = String(toolCall?.id || '');
      if (!id || ids.has(id)) return null;
      ids.add(id);
    }
  }
  return ids.size;
}

async function loadRelatedCallDetails(config, callIds) {
  return Promise.all(
    callIds.map((callId) =>
      apiFetch('https://api.vapi.ai/call/' + callId, {
        headers: { Authorization: `Bearer ${config.vapiApiKey}` },
      }),
    ),
  );
}

async function waitForRelatedCallDetails(
  config,
  callIds,
  { timeoutMs = 20000, pollMs = 500, loadImpl = loadRelatedCallDetails } = {},
) {
  const ids = (callIds || []).map(String).filter(Boolean);
  const terminalStatuses = new Set(['ended', 'failed']);
  const deadline = Date.now() + timeoutMs;
  let details = [];
  do {
    details = await loadImpl(config, ids);
    if (
      details.length === ids.length &&
      details.every((call) => terminalStatuses.has(String(call?.status || '').toLowerCase()))
    ) {
      return details;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  return details;
}

function verifySelfCallInferenceLedger(
  sinceMs,
  callIds,
  correlationIds = [],
  requiredRootIds = [],
  opts = {},
) {
  const { file, rows } = Array.isArray(opts.rows)
    ? { file: opts.ledgerFile || '[provided rows]', rows: opts.rows }
    : readInferenceEventsSince(sinceMs);
  const maxInferenceMs = Math.max(
    1000,
    Math.min(
      DEFAULT_MAX_VOICE_INFERENCE_MS,
      Number(opts.maxInferenceMs || DEFAULT_MAX_VOICE_INFERENCE_MS),
    ),
  );
  const expectedVoiceSurfaceHash = String(
    opts.expectedVoiceSurfaceHash ||
      currentVoiceSurface({ rootDir: path.resolve(__dirname, '..') }).hash,
  );
  const callIdSet = new Set((callIds || []).map(String).filter(Boolean));
  const idSet = new Set([...callIdSet, ...(correlationIds || []).map(String).filter(Boolean)]);
  const scopedRows = rows.filter((row) =>
    [...idSet].some((callId) => String(row.rootWorkId || '').includes(callId)),
  );
  const voiceRows = scopedRows.filter((row) => row.process === 'vapi-voice');
  const legacyRows = scopedRows.filter((row) => row.process === 'openai-compatible-claude-proxy');
  const byInference = new Map();
  for (const row of voiceRows) {
    const key = String(row.inferenceId || '');
    if (!byInference.has(key)) byInference.set(key, []);
    byInference.get(key).push(row);
  }
  const issues = [];
  if (callIdSet.size < 2) issues.push('the Amy-to-Amy call did not expose both Vapi call legs');
  if (!voiceRows.length) issues.push('no vapi-voice events were written');
  if (legacyRows.length) issues.push(`${legacyRows.length} legacy Claude-proxy event(s) fired`);
  const voiceSurfaceHashes = [
    ...new Set(voiceRows.map((row) => String(row.voiceSurfaceHash || '')).filter(Boolean)),
  ];
  const missingSurfaceHashes = voiceRows.filter((row) => !row.voiceSurfaceHash).length;
  if (missingSurfaceHashes) {
    issues.push(
      `${missingSurfaceHashes} vapi-voice event(s) did not identify the running proxy surface`,
    );
  }
  const foreignSurfaceHashes = voiceSurfaceHashes.filter(
    (hash) => hash !== expectedVoiceSurfaceHash,
  );
  if (foreignSurfaceHashes.length) {
    issues.push('vapi-voice events came from a different proxy/call surface');
  }
  const settledWorkIds = [];
  const settledLogicalTurnIds = [];
  const completedSettlementsByLogicalTurn = new Map();
  const isCompletedVoiceSettlement = (row) => {
    const outcome = String(row?.outcome || '')
      .trim()
      .toLowerCase();
    return !outcome || outcome === 'completed' || outcome === 'completed-app-server';
  };
  let maxInferenceDurationMs = 0;
  let maxFirstMeaningfulMs = 0;
  for (const [inferenceId, events] of byInference.entries()) {
    const starts = events.filter((row) => row.event === 'started');
    const settlements = events.filter((row) => row.event === 'settled');
    if (starts.length !== 1 || settlements.length !== 1) {
      issues.push(
        `${inferenceId || 'missing-id'} has ${starts.length} start(s) and ${settlements.length} settlement(s)`,
      );
    }
    for (const row of events) {
      if (String(row.rootWorkId || '').includes('unattributed-')) {
        issues.push(`${inferenceId || 'missing-id'} is unattributed`);
      }
    }
    for (const row of settlements) {
      const workId = String(row.workId || '');
      const durationMs = Number(row.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        issues.push(`${inferenceId || 'missing-id'} has no measured settled duration`);
      } else {
        maxInferenceDurationMs = Math.max(maxInferenceDurationMs, durationMs);
        if (durationMs > MAX_VOICE_COMPLETION_DURATION_MS) {
          issues.push(
            `${inferenceId || 'missing-id'} took ${durationMs}ms, exceeding the ${MAX_VOICE_COMPLETION_DURATION_MS}ms completion limit`,
          );
        }
      }
      const firstMeaningfulMs = Number(row.firstMeaningfulMs);
      if ((!Number.isFinite(firstMeaningfulMs) || firstMeaningfulMs <= 0) && isCompletedVoiceSettlement(row)) {
        issues.push(`${inferenceId || 'missing-id'} has no measured first meaningful response`);
      } else if (firstMeaningfulMs > 0) {
        maxFirstMeaningfulMs = Math.max(maxFirstMeaningfulMs, firstMeaningfulMs);
        if (firstMeaningfulMs > maxInferenceMs) {
          issues.push(
            `${inferenceId || 'missing-id'} first became useful at ${firstMeaningfulMs}ms, exceeding the ${maxInferenceMs}ms phone target`,
          );
        }
      }
      if (isCompletedVoiceSettlement(row)) {
        settledWorkIds.push(workId);
        const logicalMatch = workId.match(/^(voice-call:[^:]+:turn:\d+)/i);
        const logicalTurnId = logicalMatch ? logicalMatch[1] : workId;
        settledLogicalTurnIds.push(logicalTurnId);
        if (!completedSettlementsByLogicalTurn.has(logicalTurnId)) {
          completedSettlementsByLogicalTurn.set(logicalTurnId, []);
        }
        completedSettlementsByLogicalTurn.get(logicalTurnId).push(row);
      }
    }
  }
  const duplicateWorkIds = settledWorkIds.filter(
    (workId, index, all) => workId && all.indexOf(workId) !== index,
  );
  if (duplicateWorkIds.length) {
    issues.push(`duplicate completion state(s): ${[...new Set(duplicateWorkIds)].join(', ')}`);
  }
  const duplicateLogicalTurns = settledLogicalTurnIds.filter(
    (turnId, index, all) => turnId && all.indexOf(turnId) !== index,
  );
  const allowedProviderSupersededRoots = new Set(
    (opts.allowedProviderSupersededRootIds || [])
      .filter((rootId) => rootId != null && String(rootId).trim())
      .map((rootId) => `voice-call:${String(rootId).trim()}`),
  );
  const transcriptLines = String(opts.providerFinalTranscript || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((line) => /^(?:ai|user):\s*\S/.test(line));
  // Compare words only, so a repeat transcribed with different punctuation
  // still counts as a duplicate.
  const lineWords = (line) => line.replace(/[^a-z0-9]+/g, ' ').trim();
  const transcriptHasAdjacentDuplicate = transcriptLines.some(
    (line, index) => index > 0 && lineWords(line) === lineWords(transcriptLines[index - 1]),
  );
  const providerSupersededLogicalTurns = [];
  const unresolvedDuplicateLogicalTurns = [];
  for (const logicalTurnId of [...new Set(duplicateLogicalTurns)]) {
    const settlements = completedSettlementsByLogicalTurn.get(logicalTurnId) || [];
    const rootAllowed = settlements.every((row) =>
      allowedProviderSupersededRoots.has(String(row.rootWorkId || '')),
    );
    const outputSizes = new Set(settlements.map((row) => Number(row.outputBytes || 0)));
    const settledTimes = settlements.map((row) => Date.parse(String(row.ts || '')));
    const bounded =
      settledTimes.every(Number.isFinite) &&
      Math.max(...settledTimes) - Math.min(...settledTimes) <= 5000;
    // 2026-10-07 (01a116a2): the receiving leg's answer finalized in three
    // transcriber pieces, so Vapi re-asked the caller's closing turn twice and
    // spoke only the last. More than two settlements count only when each
    // re-ask carried strictly more context than the one before it.
    const byTime = [...settlements].sort(
      (a, b) => Date.parse(String(a.ts || '')) - Date.parse(String(b.ts || '')),
    );
    const contextGrows =
      settlements.length === 2 ||
      byTime.every(
        (row, index) =>
          Number.isFinite(row.contextBytes) &&
          (index === 0 || row.contextBytes > byTime[index - 1].contextBytes),
      );
    // Equal byte counts do not prove only one reply was heard. The caller
    // leg's own Vapi log must show exactly one spoken line between the callee
    // lines around this turn, and it must be exactly the settled reply's
    // length, so two replies spoken separately or merged both fail.
    const spokenOnce = callerSpokeOnce(opts.callerSpokenMessages, settledTimes, [...outputSizes][0]);
    const isProviderSuperseded =
      settlements.length >= 2 &&
      settlements.length <= 3 &&
      contextGrows &&
      spokenOnce &&
      rootAllowed &&
      Boolean(opts.providerFinalTranscript) &&
      transcriptLines.length >= 2 &&
      !transcriptHasAdjacentDuplicate &&
      new Set(settlements.map((row) => String(row.workId || ''))).size === settlements.length &&
      outputSizes.size === 1 &&
      [...outputSizes][0] > 0 &&
      bounded;
    // 2026-10-06 (01a111ca): the transcriber finished the caller's question
    // after the receiving leg had already started a tool handoff on the
    // partial text, so Vapi re-asked the same turn with a longer transcript
    // and dropped the first handoff. That is supersession only when both
    // answers were tool handoffs (no spoken bytes), the later request carried
    // strictly more context, and it is the leg's only tool-handoff turn with
    // exactly one tool call in the leg's own Vapi log, so nothing ran twice.
    const rootId = String(settlements[0]?.rootWorkId || '');
    const executedToolCalls = (opts.executedToolCallsByCallId || {})[rootId.replace(/^voice-call:/, '')];
    const ordered = [...settlements].sort(
      (a, b) => Date.parse(String(a.ts || '')) - Date.parse(String(b.ts || '')),
    );
    const handoffTurnsOnRoot = [...completedSettlementsByLogicalTurn.values()].filter(
      (rows) =>
        String(rows[0]?.rootWorkId || '') === rootId &&
        rows.every((row) => row.outputBytes === 0),
    ).length;
    const isToolHandoffSuperseded =
      settlements.length === 2 &&
      settlements.every((row) => String(row.rootWorkId || '') === rootId) &&
      settlements.every((row) => row.outputBytes === 0) &&
      new Set(settlements.map((row) => String(row.workId || ''))).size === 2 &&
      ordered.every((row) => Number.isFinite(row.contextBytes)) &&
      ordered[1].contextBytes > ordered[0].contextBytes &&
      handoffTurnsOnRoot === 1 &&
      executedToolCalls === 1 &&
      transcriptLines.length >= 2 &&
      !transcriptHasAdjacentDuplicate &&
      bounded;
    if (isProviderSuperseded || isToolHandoffSuperseded) {
      providerSupersededLogicalTurns.push(logicalTurnId);
    }
    else unresolvedDuplicateLogicalTurns.push(logicalTurnId);
  }
  if (unresolvedDuplicateLogicalTurns.length) {
    issues.push(
      `duplicate logical turn completion(s): ${unresolvedDuplicateLogicalTurns.join(', ')}`,
    );
  }
  for (const requiredRootId of requiredRootIds.map(String).filter(Boolean)) {
    const settlements = voiceRows.filter(
      (row) =>
        row.event === 'settled' &&
        isCompletedVoiceSettlement(row) &&
        String(row.rootWorkId || '').includes(requiredRootId),
    );
    if (!settlements.length) {
      issues.push(`required call leg ${requiredRootId} emitted no settled isolated inference`);
    }
  }
  return {
    schema: 'amy.vapi_self_call_inference_proof.v1',
    checkedAt: new Date().toISOString(),
    ledgerFile: file,
    ok: issues.length === 0,
    issues,
    voiceEvents: voiceRows.length,
    voiceInferences: byInference.size,
    legacyEvents: legacyRows.length,
    callIds: [...callIdSet],
    correlationIds: [...new Set((correlationIds || []).map(String).filter(Boolean))],
    rootWorkIds: [...new Set(voiceRows.map((row) => row.rootWorkId).filter(Boolean))],
    settledWorkIds,
    settledLogicalTurnIds,
    providerSupersededLogicalTurns,
    maxInferenceDurationMs,
    maxAllowedInferenceDurationMs: MAX_VOICE_COMPLETION_DURATION_MS,
    maxFirstMeaningfulMs,
    maxAllowedFirstMeaningfulMs: maxInferenceMs,
    expectedVoiceSurfaceHash,
    voiceSurfaceHashes,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.live && !opts.dryRun) {
    usage();
    throw new Error('Pass --live to place the real self-call, or --dry-run to inspect.');
  }

  const config = readConfig();
  if (!config.vapiApiKey || !config.vapiPhoneNumberId || !config.vapiInboundPhoneNumberId) {
    throw new Error('Missing canonical Vapi credential or phone-number IDs.');
  }
  const outbound = await getPhoneNumber(config, config.vapiPhoneNumberId);
  const inbound = await getPhoneNumber(config, config.vapiInboundPhoneNumberId);
  const callerBase = await apiFetch('https://api.vapi.ai/assistant/' + config.callbackAssistantId, {
    headers: { Authorization: `Bearer ${config.vapiApiKey}` },
  });
  const body = buildCallBody(config, inbound.number, opts.first, opts.maxDurationSec, callerBase, opts.callerOpening);

  console.log('[self-call] outbound test caller: ' + outbound.number);
  console.log('[self-call] inbound Amy line: ' + inbound.number);
  console.log('[self-call] first utterance: ' + opts.first);
  console.log('[self-call] EC2 must include outbound number in VAPI_SELF_TEST_CALLER_PHONES.');

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        { seedTopic: opts.seedTopic || null, body: redactCallBodyForDiagnostics(body) },
        null,
        2,
      ),
    );
    return;
  }

  // Before admission and before any dial: the backend the inbound line routes
  // to must be warm. warmGateRunsBeforeDial pins this order.
  const warm = await waitForBackendWarm(inbound);
  console.log('[self-call] backend warm: up ' + Math.round(warm.uptimeSeconds) + 's');

  // Never spend a phone call to discover a credential mismatch. On 2026-08-16
  // this shell held a stale VAPI_LLM_SECRET, the caller leg 401'd, the call
  // ended as pipeline-error-custom-llm-401-unauthorized, and because it had
  // already reached a human the safety breaker paused ALL outbound calls and
  // demanded owner review. A five-line check before dialing avoids all of that.
  assertSelfCallSecretMatchesLiveAssistant(await liveAssistantLlmSecret(config), config);

  // Standing permission covers verified Amy-to-Amy tests. It neither resumes
  // human calls nor remints the consumed historical correction lease.
  console.log('[self-call] invocation: ' + body.metadata.amyCallCorrelationId);
  const admission = await admitSelfCallBeforeDial({
    ...opts,
    ...(!opts.machineCorrectionInvocationKey ? {
      internalTestInvocationKey: body.metadata.amyCallCorrelationId,
      inboundPhoneNumberId: config.vapiInboundPhoneNumberId,
    } : {}),
    machineCorrectionTargetPhone: body.customer.number,
    machineCorrectionPhoneNumberId: body.phoneNumberId,
  });

  let recentTopicSeed = null;
  let internalCallIds = [];
  let primaryError = null;
  try {
  if (opts.seedTopic) {
    recentTopicSeed = await seedRecentTopic(config, opts.seedTopic, '+ExampleCo');
    console.log(
      '[self-call] seeded live owner status "' + opts.seedTopic + '" via ' + recentTopicSeed.seedId,
    );
  }

  const ledgerSinceMs = Date.now() - 5000;
  const created = await initiateCall(config, body);
  internalCallIds = [created.id];
  console.log('[self-call] call id: ' + created.id);
  const final = await pollCall(config, created.id, opts.timeoutSec);
  const file = saveCallRecord(final);
  const transcript = final.transcript || '';
  console.log('[self-call] saved: ' + file);
  console.log('[self-call] transcript:');
  console.log(transcript);

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const relatedCalls = await discoverSelfCallIds(
    config,
    created.id,
    ledgerSinceMs,
    outbound.number,
  );
  // Vapi can mark the outbound leg ended before the receiving leg and its last
  // model stream settle. Poll actual state instead of racing the causal ledger
  // with a fixed sleep.
  const relatedCallDetails = await waitForRelatedCallDetails(config, relatedCalls.ids);
  internalCallIds = relatedCalls.ids;
  const receivingCallIds = relatedCalls.ids.filter(
    (callId) => String(callId) !== String(created.id),
  );
  const toolNamesByCall = Object.fromEntries(
    relatedCallDetails.map((call) => [String(call.id || ''), toolNamesFromCall(call)]),
  );
  const callerToolNames = toolNamesByCall[String(created.id)] || [];
  const receivingToolNames = [
    ...new Set(
      relatedCallDetails
        .filter((call) => String(call.id || '') !== String(created.id))
        .flatMap((call) => toolNamesFromCall(call)),
    ),
  ];
  const observedToolNames = [...new Set(Object.values(toolNamesByCall).flat())];
  const scoredTranscript = transcriptForSpeaker(transcript, opts.scoreSpeaker);
  const topicEvidence =
    opts.seedTopic && opts.defaultExpect
      ? scoreTopicEvidence(scoredTranscript, opts.seedTopic)
      : { ok: true, tokens: [], matched: [], required: 0 };
  const inferenceProof = {
    ...verifySelfCallInferenceLedger(
      ledgerSinceMs,
      relatedCalls.ids,
      [body.metadata?.amyCallCorrelationId],
      [
        body.metadata?.amyCallCorrelationId,
        ...(receivingCallIds.length === 1 ? receivingCallIds : []),
      ],
      {
        maxInferenceMs: opts.maxInferenceMs,
        allowedProviderSupersededRootIds: body.metadata?.amyCallCorrelationId
          ? [body.metadata.amyCallCorrelationId]
          : [],
        providerFinalTranscript: transcript,
        callerSpokenMessages: (() => {
          const caller = relatedCallDetails.find((call) => String(call.id || '') === String(created.id));
          return caller?.artifact?.messages || caller?.messages || null;
        })(),
        executedToolCallsByCallId: Object.fromEntries(
          relatedCallDetails.map((call) => [String(call.id || ''), executedToolCallCount(call)]),
        ),
      },
    ),
    relatedCalls: relatedCalls.calls,
    observedToolNames,
    toolNamesByCall,
    callerToolNames,
    receivingToolNames,
    topicEvidence,
  };
  const unacceptableCloseIssues = evaluateCallCloseReasons(relatedCallDetails);
  if (unacceptableCloseIssues.length) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(...unacceptableCloseIssues);
  }
  if (receivingCallIds.length !== 1) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      `expected exactly one receiving Amy call leg, found ${receivingCallIds.length}`,
    );
  }
  if (!receivingToolNames.includes(opts.expectedTool)) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      'the isolated voice lane did not emit the expected ' + opts.expectedTool + ' tool call',
    );
  }
  if (callerToolNames.length) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      'the synthetic caller emitted tool(s): ' + callerToolNames.join(', '),
    );
  }
  const unexpectedReceivingTools = receivingToolNames.filter((name) => name !== opts.expectedTool);
  if (unexpectedReceivingTools.length) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      'the receiving Amy emitted unexpected tool(s) for a status-only question: ' +
        unexpectedReceivingTools.join(', '),
    );
  }
  if (opts.callerOpening === 'listen') {
    const opening = scoreListenOpening(transcript, opts.first);
    inferenceProof.listenOpening = opening;
    if (!opening.ok) {
      inferenceProof.ok = false;
      inferenceProof.issues.push('listen opening: ' + opening.issue);
    }
  }
  const holdPhrase = scoreHoldPhraseLeakage(transcript);
  inferenceProof.holdPhrase = holdPhrase;
  if (!holdPhrase.ok) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      holdPhrase.bareNumberOpener || holdPhrase.opensWithHold
        ? 'Amy opened the conversation with a hold phrase, which a callee hears as her first word'
        : `Amy spoke a hold phrase on ${holdPhrase.holdTurns} of ${holdPhrase.spokenTurns} turns, which sounds broken to a callee`,
    );
  }
  if (!topicEvidence.ok) {
    inferenceProof.ok = false;
    inferenceProof.issues.push(
      topicEvidence.required === 0
        ? 'the seed topic yielded no scorable evidence terms'
        : `the spoken status matched ${topicEvidence.matched.length}/${topicEvidence.required} required topic terms`,
    );
  }
  const proofFile = path.join(
    path.dirname(inferenceLedgerPath()),
    `vapi-self-call-inference-proof-${created.id}.json`,
  );
  fs.mkdirSync(path.dirname(proofFile), { recursive: true });
  fs.writeFileSync(proofFile, `${JSON.stringify(inferenceProof, null, 2)}\n`, 'utf8');
  console.log('[self-call] inference proof: ' + proofFile);
  console.log(
    `[self-call] inference ledger: ${inferenceProof.voiceInferences} isolated, ${inferenceProof.legacyEvents} legacy`,
  );
  if (!inferenceProof.ok) {
    console.error('[self-call] inference proof failed: ' + inferenceProof.issues.join('; '));
    if (recentTopicSeed) {
      await clearRecentTopic(config, recentTopicSeed, '+ExampleCo');
      recentTopicSeed = null;
    }
    throw new Error('Amy-to-Amy inference proof failed.');
  }

  console.log('[self-call] scoring speaker: ' + opts.scoreSpeaker);
  const score = scoreTranscript(scoredTranscript, opts.expect, opts.forbid);
  if (!score.ok) {
    if (score.missing.length)
      console.error('[self-call] missing expected: ' + score.missing.join(', '));
    if (score.forbidden.length)
      console.error('[self-call] forbidden text: ' + score.forbidden.join(', '));
    if (recentTopicSeed) {
      await clearRecentTopic(config, recentTopicSeed, '+ExampleCo');
      recentTopicSeed = null;
    }
    throw new Error('Amy-to-Amy transcript proof failed.');
  }
  const releaseDataDir = defaultDataDir();
  const releaseEvidence = {
    callIds: relatedCalls.ids,
    exactLegCorrelation: relatedCalls.ids.length === 2 && receivingCallIds.length === 1,
    substantiveReply: score.ok && topicEvidence.ok,
    substantiveReplyChars: scoredTranscript.trim().length,
    naturalClose: unacceptableCloseIssues.length === 0,
    listenOpening: opts.callerOpening === 'listen' && inferenceProof.listenOpening?.ok === true,
    transcriptSha256: crypto.createHash('sha256').update(transcript).digest('hex'),
    maxInferenceDurationMs: inferenceProof.maxInferenceDurationMs,
    maxAllowedInferenceDurationMs: inferenceProof.maxAllowedInferenceDurationMs,
    maxFirstMeaningfulMs: inferenceProof.maxFirstMeaningfulMs,
    maxAllowedFirstMeaningfulMs: inferenceProof.maxAllowedFirstMeaningfulMs,
    outboundCallId: created.id,
    inboundCallId: receivingCallIds[0],
    proxySurfaceHash: inferenceProof.expectedVoiceSurfaceHash,
  };
  const releaseProof = writeVoiceReleaseProof({
    dataDir: releaseDataDir,
    rootDir: path.resolve(__dirname, '..'),
    evidence: releaseEvidence,
  });
  console.log('[self-call] release proof: ' + releaseProof.surfaceHash);
  const canonicalRelease = await publishVoiceReleaseProof(releaseEvidence);
  if (
    canonicalRelease.recordedProof !== true ||
    canonicalRelease.surfaceHash !== releaseProof.surfaceHash
  ) {
    throw new Error('Canonical EC2 rejected the exact Amy-to-Amy call-surface proof.');
  }
  console.log('[self-call] canonical release proof: ' + canonicalRelease.surfaceHash);
  if (recentTopicSeed) {
    await clearRecentTopic(config, recentTopicSeed, '+ExampleCo');
    recentTopicSeed = null;
  }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
    if (admission?.source === 'auth-internal-voice-self-tests' && internalCallIds.length) {
      // An error or timeout must leave an unresolved intent if provider state
      // cannot be reconciled. Never invent an outcome or automatically redial.
      const { settleInternalVoiceSelfTestEverywhere } = require('./lib/outbound-call-control');
      const settled = await settleInternalVoiceSelfTestEverywhere({ invocationKey: admission.invocationKey, callIds: internalCallIds });
      console.log('[self-call] durable outcome: ' + settled.outcome?.status);
      if (settled.outcome?.status !== 'passed') throw new Error('Canonical internal test outcome did not pass.');
    }
    } catch (error) {
      if (!primaryError) throw error;
      console.error('[self-call] additional reconciliation failure: ' + error.message);
    } finally {
      if (recentTopicSeed) {
        try { await clearRecentTopic(config, recentTopicSeed, '+ExampleCo'); }
        catch (error) { console.error('[self-call] topic cleanup failed: ' + error.message); }
      }
    }
  }
  console.log('[self-call] PASS');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[self-call] ERROR: ' + err.message);
    process.exit(2);
  });
}

module.exports = {
  MIN_BACKEND_UPTIME_SECONDS,
  scoreListenOpening,
  SYNTHETIC_CALLER_WAIT_SECONDS,
  backendHealthUrl,
  waitForBackendWarm,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_MAX_VOICE_INFERENCE_MS,
  MAX_SELF_CALL_DURATION_SECONDS,
  buildCallBody,
  admitSelfCallBeforeDial,
  evaluateCallCloseReasons,
  parseArgs,
  redactCallBodyForDiagnostics,
  resolveSelfCallLlmSecret,
  assertSelfCallSecretMatchesLiveAssistant,
  scoreTopicEvidence,
  scoreTranscript,
  selectRelatedSelfCalls,
  transcriptForSpeaker,
  waitForRelatedCallDetails,
  verifySelfCallInferenceLedger,
  executedToolCallCount,
  callerSpokeOnce,
  readInferenceEventsSince,
};
