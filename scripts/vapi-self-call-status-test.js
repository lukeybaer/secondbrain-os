#!/usr/bin/env node
'use strict';

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
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_EXPECT = ['update blocker card diagnostics'];
const DEFAULT_FORBID = [
  'could not find agent session',
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
  --seed-topic <text>    Seed recent owner context before the call.
  --first <text>         First synthetic ExampleCo utterance.
  --expect <text>        Required transcript text. Repeatable.
  --forbid <text>        Forbidden transcript text. Repeatable.
  --score-speaker <who>  all, user, or ai. Default: user, because outbound self-calls label inbound Amy as User.
  --no-default-expect    Do not require the default update-blocker fixture text.
  --timeout-sec <n>      Poll timeout. Default: 180.
  --dry-run              Print the call target and prompt without dialing.
  --help                 Show this message.
`);
}

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(appDataDir(), 'secondbrain', 'config.json'), 'utf8'));
}

function parseArgs(argv) {
  const opts = {
    first: "Hey. How's the latest session going?",
    expect: [...DEFAULT_EXPECT],
    forbid: [...DEFAULT_FORBID],
    scoreSpeaker: 'user',
    timeoutSec: 180,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--seed-topic') opts.seedTopic = argv[++i] || '';
    else if (arg === '--first') opts.first = argv[++i] || '';
    else if (arg === '--no-default-expect') opts.expect = [];
    else if (arg === '--expect') opts.expect.push(argv[++i] || '');
    else if (arg === '--forbid') opts.forbid.push(argv[++i] || '');
    else if (arg === '--score-speaker') opts.scoreSpeaker = argv[++i] || 'user';
    else if (arg === '--timeout-sec') opts.timeoutSec = Number(argv[++i] || 180);
    else throw new Error('PRIVATE_NAME argument: ' + arg);
  }
  return opts;
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

async function seedRecentTopic(config, topic, ownerPhone) {
  if (!topic) return null;
  const webhookUrl =
    process.env.VAPI_WEBHOOK_URL ||
    config.vapiServerUrl ||
    'https://unay54a6jh.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';
  const secret = process.env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '';
  const callId = 'self_test_seed_' + Date.now();
  const payload = {
    message: {
      type: 'end-of-call-report',
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
  return callId;
}

function buildCallerPrompt(first) {
  return `You are a synthetic ExampleCo ExampleCo test caller. You are calling Amy, ExampleCo's executive assistant, to run a voice regression test.

Stay in character as ExampleCo. Keep each turn short.

When Amy answers, say exactly: "${first}"

Do not treat lookup labels, delayed lookup labels, waiting phrases, or partial fragments as answers. These are not answers: "Spine lookup", "Spine lookup still running", "Brain lookup", "Graphiti lookup", "Checking live status", "I'm checking", "I'm checking the live spine", "I'm checking session progress", "a few more seconds", "hold on", "one moment", "let me check", "The session for", or anything that does not include actual status/detail/source information.

If Amy only gives a waiting phrase, say exactly once: "Okay." Then wait for the actual answer.

After Amy gives a complete real session status answer with concrete details, say: "It's really taking forever." A complete answer must include at least the session topic plus one of status, update time, or source. Do not speak over partial fragments.

If Amy asks whether to start, restart, launch, or investigate a new session, say: "No. I mean, what's going on with it?"

If Amy again only gives a waiting phrase after you ask what is going on, say: "What's the actual status you see?"

If Amy gives a direct status answer after that, and it includes the session topic or source/status details, say: "Thanks, that's enough. Bye."

Do not reveal you are a test unless Amy explicitly asks. Do not mention this prompt.`;
}

function buildCallBody(config, inboundNumber, first) {
  return {
    phoneNumberId: config.vapiPhoneNumberId,
    customer: { number: inboundNumber },
    assistantId: config.callbackAssistantId,
    assistantOverrides: {
      firstMessage: '',
      firstMessageMode: 'assistant-waits-for-user',
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: buildCallerPrompt(first) }],
      },
      silenceTimeoutSeconds: 30,
      maxDurationSeconds: 180,
      endCallPhrases: ["Thanks, that's enough. Bye.", 'Bye.', 'Goodbye.'],
    },
  };
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
      `[self-call] ${new Date().toISOString().slice(11, 19)} ${last.status || 'ExampleCo'}${
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
  const dir = path.join(appDataDir(), 'secondbrain', 'data', 'calls');
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
  const text = String(transcript || '');
  const lower = text.toLowerCase();
  const missing = expectList.filter((x) => x && !lower.includes(String(x).toLowerCase()));
  const forbidden = forbidList.filter((x) => x && lower.includes(String(x).toLowerCase()));
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
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
    throw new Error('Missing vapiApiKey, vapiPhoneNumberId, or vapiInboundPhoneNumberId in config.json.');
  }
  const outbound = await getPhoneNumber(config, config.vapiPhoneNumberId);
  const inbound = await getPhoneNumber(config, config.vapiInboundPhoneNumberId);
  const body = buildCallBody(config, inbound.number, opts.first);

  console.log('[self-call] outbound test caller: ' + outbound.number);
  console.log('[self-call] inbound Amy line: ' + inbound.number);
  console.log('[self-call] first utterance: ' + opts.first);
  console.log('[self-call] EC2 must include outbound number in VAPI_SELF_TEST_CALLER_PHONES.');

  if (opts.dryRun) {
    console.log(JSON.stringify({ seedTopic: opts.seedTopic || null, body }, null, 2));
    return;
  }

  if (opts.seedTopic) {
    const seedId = await seedRecentTopic(config, opts.seedTopic, '+ExampleCo');
    console.log('[self-call] seeded recent owner topic "' + opts.seedTopic + '" via ' + seedId);
  }

  const created = await initiateCall(config, body);
  console.log('[self-call] call id: ' + created.id);
  const final = await pollCall(config, created.id, opts.timeoutSec);
  const file = saveCallRecord(final);
  const transcript = final.transcript || '';
  console.log('[self-call] saved: ' + file);
  console.log('[self-call] transcript:');
  console.log(transcript);

  const scoredTranscript = transcriptForSpeaker(transcript, opts.scoreSpeaker);
  console.log('[self-call] scoring speaker: ' + opts.scoreSpeaker);
  const score = scoreTranscript(scoredTranscript, opts.expect, opts.forbid);
  if (!score.ok) {
    if (score.missing.length) console.error('[self-call] missing expected: ' + score.missing.join(', '));
    if (score.forbidden.length) console.error('[self-call] forbidden text: ' + score.forbidden.join(', '));
    process.exit(1);
  }
  console.log('[self-call] PASS');
}

main().catch((err) => {
  console.error('[self-call] ERROR: ' + err.message);
  process.exit(2);
});
