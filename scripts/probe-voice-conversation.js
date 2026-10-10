#!/usr/bin/env node
'use strict';

/**
 * Multi-turn voice conversation probe.
 *
 * The single-turn probes lie. They prove the model can emit a tool call, then
 * stop. Every voice failure ExampleCo actually hit lived in the SECOND turn or in
 * what the caller heard out loud:
 *
 *   - 2026-08-16 call 01a00bcf: turn 1 fired check_spine at 13.4s, the tool
 *     returned, and the turn that had to SPEAK the result failed. Vapi read the
 *     error as custom-llm-llm-failed and hung up on him.
 *   - call 01a00bef: turn 2 overran its budget and he heard "that one is taking
 *     too long, ask me again".
 *   - call 01a00bd8: the hold phrase and the answer were concatenated into one
 *     utterance and TTS spoke "1 sexession dialogue updated just now".
 *
 * None of that is visible unless you drive the whole conversation: caller turn
 * -> model decision -> REAL tool execution on EC2 -> model narration -> spoken
 * text. That is what this does, against the live proxy and the live webhook.
 *
 *   node scripts/probe-voice-conversation.js
 *   node scripts/probe-voice-conversation.js --say "How is the watcher session going?"
 *
 * Exit code is non-zero when a contract is violated, so it can gate a deploy.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT) || 3456;
const ASSISTANT_ID = 'ExampleCo-2da6-45b2-9379-1b575634a337';
const WEBHOOK = 'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';
const OWNER_PHONE = '+ExampleCo';

// Contracts, from ExampleCo: no more than ~3s of dead air, and a real answer in a
// time he would call decent. Turn budget is generous because the understudy
// lane is slow, but silence is not allowed to grow with it.
const MAX_DEAD_AIR_MS = 3000;
const MAX_TURN_MS = 20000; // Vapi abandons a custom-LLM request around here.

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(appDataDir(), 'secondbrain', 'config.json'), 'utf8'));
}

function httpsJson(pathname, headers) {
  return new Promise((resolve, reject) => {
    https
      .get({ host: 'api.vapi.ai', path: pathname, headers }, (r) => {
        let d = '';
        r.on('data', (x) => (d += x));
        r.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function postJson(url, body, headers) {
  const u = new URL(url);
  const text = JSON.stringify(body);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
          ...headers,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on('error', reject);
    req.write(text);
    req.end();
  });
}

// One model turn against the live proxy. Records when the FIRST audible token
// arrived (the dead-air clock the caller experiences) separately from when the
// turn completed.
function modelTurn(messages, tools, model) {
  const body = JSON.stringify({ model, stream: true, tools, messages });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let firstAudibleMs = null;
    let buf = '';
    let spoken = '';
    let toolName = null;
    let toolArgs = '';
    let finish = null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            let ev;
            try {
              ev = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            const delta = ev?.choices?.[0]?.delta || {};
            if (delta.content) {
              if (firstAudibleMs === null) firstAudibleMs = Date.now() - t0;
              spoken += delta.content;
            }
            for (const tc of delta.tool_calls || []) {
              if (tc.function?.name) {
                if (firstAudibleMs === null) firstAudibleMs = Date.now() - t0;
                toolName = tc.function.name;
              }
              if (tc.function?.arguments) toolArgs += tc.function.arguments;
            }
            if (ev?.choices?.[0]?.finish_reason) finish = ev.choices[0].finish_reason;
          }
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            firstAudibleMs,
            totalMs: Date.now() - t0,
            spoken,
            toolName,
            toolArgs,
            finish,
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Execute the tool for real, through the same EC2 webhook Vapi uses.
function toolCallPayload(callId, name, argsJson) {
  return {
      message: {
        type: 'tool-calls',
        call: { id: callId, type: 'inboundPhoneCall', customer: { number: OWNER_PHONE } },
        // Shape matters: the webhook reads `toolCalls[].function.name` with
        // arguments as a JSON STRING. A `toolCallList` payload is accepted with
        // {"received":true} and silently executes nothing, which would make
        // this probe pass while testing air.
        toolCalls: [{ id: 'call_probe', function: { name, arguments: argsJson || '{}' } }],
      },
  };
}

async function runTool(config, callId, name, argsJson) {
  const res = await postJson(WEBHOOK, toolCallPayload(callId, name, argsJson), {
    'x-vapi-secret': config.vapiWebhookSecret || '',
  });
  let result = '';
  try {
    const parsed = JSON.parse(res.body);
    result = parsed?.results?.[0]?.result ?? res.body;
  } catch {
    result = res.body;
  }
  const text = String(result);
  if (/^\s*\{\s*"received"\s*:\s*true\s*\}\s*$/.test(text)) {
    throw new Error(
      'tool webhook echoed {"received":true}: the payload shape is wrong and nothing executed',
    );
  }
  return { status: res.status, result: text };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

// TTS speaks what it is given. These are the exact classes of damage seen on
// real calls, so they are checked as hard contracts, not style notes.
function speechDefects(text) {
  const defects = [];
  const t = String(text || '');
  if (!t.trim()) return defects;
  if (/\b\d+\s*sec\b/i.test(t)) defects.push('numeral-filler ("1 sec"), TTS read a numeral aloud');
  // Vapi concatenates content deltas into ONE utterance. If a delta ends a
  // sentence and the next starts without a space, TTS slurs them: the real call
  // produced "1 sexession dialogue updated just now" from "One sec." plus
  // "session dialogue...". Missing space after terminal punctuation is the
  // signature, and it is what an earlier version of this check failed to catch
  // while the defect was sitting in its own output.
  // Missing space after terminal punctuation is the real signature. An earlier
  // version also flagged [a-z]{3,}[A-Z], which fired on legitimate proper nouns
  // like SecondBrain and ExampleCo and failed a perfectly clean answer.
  if (/[.!?][A-Za-z]/.test(t))
    defects.push('deltas concatenated without a space, TTS will slur them together');
  if (/session cloud projection|source packet|probe_level|spine task|_source/i.test(t))
    defects.push('raw machine text spoken aloud');
  if (/taking too long/i.test(t)) defects.push('timed out instead of answering');
  else if (/ask me again/i.test(t)) defects.push('gave up and asked ExampleCo to retry instead of answering');
  if (/cloud code agent|tool isn'?t available|do not have .*access here/i.test(t))
    defects.push('broke character about its own plumbing');
  return defects;
}

if (require.main !== module) {
  module.exports = { speechDefects, toolCallPayload, MAX_DEAD_AIR_MS, MAX_TURN_MS };
  return;
}

(async () => {
  const config = loadConfig();
  const say = process.argv.includes('--say')
    ? process.argv[process.argv.indexOf('--say') + 1]
    : 'How is the watcher session going?';

  const assistant = await httpsJson('/assistant/' + ASSISTANT_ID, {
    Authorization: 'Bearer ' + config.vapiApiKey,
  });
  const m = assistant.model || {};
  const tools = m.tools || [];
  const system = (m.messages && m.messages[0] && m.messages[0].content) || '';
  const callId = '01a00000-0000-7000-8000-' + String(Date.now()).slice(-12);

  console.log('[conversation] "' + say + '"');
  console.log(
    '[conversation] contracts: first audio <= ' +
      MAX_DEAD_AIR_MS +
      'ms, turn <= ' +
      MAX_TURN_MS +
      'ms',
  );
  console.log();

  const failures = [];
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: say },
  ];

  // ---- Turn 1: caller asks. Model should reach for a tool. ----
  const t1 = await modelTurn(messages, tools, m.model);
  report('turn 1 (caller question)', t1, failures);
  if (t1.status !== 200)
    failures.push('turn 1 returned HTTP ' + t1.status + ', which Vapi ends the call on');

  if (!t1.toolName) {
    console.log('[conversation] no tool call; conversation ends here.');
    return finishUp(failures);
  }

  // ---- Execute the tool for real on EC2. ----
  const tool = await runTool(config, callId, t1.toolName, t1.toolArgs);
  console.log('  tool ' + t1.toolName + ' -> HTTP ' + tool.status);
  console.log('  tool result: ' + tool.result.slice(0, 160));
  console.log();
  if (tool.status !== 200) failures.push('tool execution returned HTTP ' + tool.status);

  // ---- Turn 2: model must SPEAK that result. This is the turn that hung up. ----
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_probe',
        type: 'function',
        function: { name: t1.toolName, arguments: t1.toolArgs },
      },
    ],
  });
  messages.push({ role: 'tool', tool_call_id: 'call_probe', content: tool.result });

  const t2 = await modelTurn(messages, tools, m.model);
  report('turn 2 (speak the result)', t2, failures);
  if (t2.status !== 200)
    failures.push(
      'turn 2 returned HTTP ' + t2.status + ' -- this is the custom-llm-llm-failed hang-up',
    );
  if (!t2.spoken.trim() && !t2.toolName) failures.push('turn 2 said nothing at all');

  finishUp(failures);
})().catch((e) => {
  console.error('[conversation] ERROR ' + e.message);
  process.exit(1);
});

function report(label, turn, failures) {
  console.log(label);
  console.log('  http            : ' + turn.status);
  console.log(
    '  first audio     : ' + (turn.firstAudibleMs === null ? 'NEVER' : turn.firstAudibleMs + 'ms'),
  );
  console.log('  turn total      : ' + turn.totalMs + 'ms');
  if (turn.toolName)
    console.log('  tool            : ' + turn.toolName + ' ' + turn.toolArgs.slice(0, 120));
  if (turn.spoken) console.log('  spoken          : ' + turn.spoken.slice(0, 240));
  const deadAir = turn.firstAudibleMs === null ? turn.totalMs : turn.firstAudibleMs;
  if (deadAir > MAX_DEAD_AIR_MS)
    failures.push(label + ': ' + deadAir + 'ms of dead air, limit is ' + MAX_DEAD_AIR_MS + 'ms');
  if (turn.totalMs > MAX_TURN_MS)
    failures.push(label + ': turn took ' + turn.totalMs + 'ms, limit is ' + MAX_TURN_MS + 'ms');
  for (const d of speechDefects(turn.spoken)) failures.push(label + ': ' + d);
  console.log();
}

function finishUp(failures) {
  if (!failures.length) {
    console.log('[conversation] PASS -- every turn answered inside its budget with clean speech.');
    process.exit(0);
  }
  console.log('[conversation] FAIL');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
