#!/usr/bin/env node
'use strict';

/**
 * Probe the production Vapi webhook path for ExampleCo's vague owner follow-ups.
 *
 * Typical use after a voice deploy:
 *   node scripts/probe-vapi-owner-status-context.js --seed-topic "update blocker card diagnostics" --query "active session" --expect "update blocker card diagnostics"
 *
 * The optional seed goes through end-of-call-report, so it tests the same
 * durable recent-topic breadcrumb a real finished call writes. The status check
 * then goes through tool-calls/check_spine, the same live path Vapi uses.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_WEBHOOK_URL = 'http://ExampleCo:3001/vapi/webhook';
const DEFAULT_OWNER_PHONE = '+ExampleCo';

function usage() {
  console.log(`Usage:
  node scripts/probe-vapi-owner-status-context.js [options]

Options:
  --seed-topic <text>   Write a recent owner call topic through end-of-call-report before probing.
  --query <text>        check_spine query to send. Default: "active session".
  --expect <text>       Required text in the check_spine result. Repeatable.
  --forbid <text>       Text that must not appear in the result. Repeatable.
  --url <url>           Webhook URL. Defaults to config.vapiServerUrl or ${DEFAULT_WEBHOOK_URL}.
  --owner-phone <phone> Owner phone to put on the synthetic Vapi call.
  --secret <secret>     x-vapi-secret header. Defaults to config.vapiWebhookSecret or env.
  --help                Show this message.
`);
}

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadConfig() {
  return readJsonIfExists(path.join(appDataDir(), 'secondbrain', 'config.json')) || {};
}

function loadOwnerPhone(config) {
  if (process.env.OWNER_PHONE) return process.env.OWNER_PHONE;
  if (config.ownerPhone) return config.ownerPhone;
  const contacts = readJsonIfExists(
    path.join(appDataDir(), 'secondbrain', 'data', 'agent', 'contacts.json'),
  );
  if (contacts && Array.isArray(contacts.owner_phones) && contacts.owner_phones[0]) {
    return contacts.owner_phones[0];
  }
  return DEFAULT_OWNER_PHONE;
}

function parseArgs(argv) {
  const opts = {
    query: 'active session',
    expect: [],
    forbid: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--seed-topic') {
      opts.seedTopic = argv[++i] || '';
    } else if (arg === '--query') {
      opts.query = argv[++i] || '';
    } else if (arg === '--expect') {
      opts.expect.push(argv[++i] || '');
    } else if (arg === '--forbid') {
      opts.forbid.push(argv[++i] || '');
    } else if (arg === '--url') {
      opts.url = argv[++i] || '';
    } else if (arg === '--owner-phone') {
      opts.ownerPhone = argv[++i] || '';
    } else if (arg === '--secret') {
      opts.secret = argv[++i] || '';
    } else {
      throw new Error('PRIVATE_NAME argument: ' + arg);
    }
  }
  return opts;
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
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            // Keep raw text for diagnostics.
          }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function callObject(ownerPhone, callId) {
  return {
    id: callId,
    customer: { number: ownerPhone },
    startedAt: new Date().toISOString(),
  };
}

function seedPayload(topic, ownerPhone, callId) {
  return {
    message: {
      type: 'end-of-call-report',
      call: callObject(ownerPhone, callId),
      transcript: [
        'AI: Hey, ExampleCo.',
        'User: How is the ' + topic + ' session going?',
        "AI: I'm checking the live spine.",
      ].join('\n'),
      analysis: {
        summary: 'ExampleCo asked for the ' + topic + ' session status.',
      },
    },
  };
}

function checkSpinePayload(query, ownerPhone, callId) {
  return {
    message: {
      type: 'tool-calls',
      call: callObject(ownerPhone, callId),
      toolCalls: [
        {
          id: 'probe_check_spine_' + Date.now(),
          function: {
            name: 'check_spine',
            arguments: JSON.stringify({ query, detail: true }),
          },
        },
      ],
    },
  };
}

function resultText(response) {
  const body = response && response.body;
  if (body && Array.isArray(body.results) && body.results[0]) {
    return String(body.results[0].result || '');
  }
  return typeof body === 'string' ? body : JSON.stringify(body || {});
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const config = loadConfig();
  const webhookUrl =
    opts.url ||
    process.env.VAPI_WEBHOOK_URL ||
    config.vapiServerUrl ||
    DEFAULT_WEBHOOK_URL;
  const secret =
    opts.secret ||
    process.env.VAPI_WEBHOOK_SECRET ||
    config.vapiWebhookSecret ||
    '';
  const ownerPhone = opts.ownerPhone || loadOwnerPhone(config);
  const checks = [...opts.expect];
  if (opts.seedTopic && checks.length === 0) checks.push(opts.seedTopic);

  console.log('[probe] webhook=' + webhookUrl);
  console.log('[probe] ownerPhone=' + ownerPhone);

  if (opts.seedTopic) {
    const seedId = 'probe_recent_context_' + Date.now();
    const seed = await postJson(webhookUrl, seedPayload(opts.seedTopic, ownerPhone, seedId), secret);
    if (seed.status < 200 || seed.status >= 300) {
      throw new Error('seed failed: HTTP ' + seed.status + ' ' + seed.raw.slice(0, 300));
    }
    console.log('[probe] seeded recent owner topic "' + opts.seedTopic + '" with callId=' + seedId);
  }

  const statusId = 'probe_status_context_' + Date.now();
  const response = await postJson(webhookUrl, checkSpinePayload(opts.query, ownerPhone, statusId), secret);
  if (response.status < 200 || response.status >= 300) {
    throw new Error('check_spine failed: HTTP ' + response.status + ' ' + response.raw.slice(0, 300));
  }

  const text = resultText(response);
  console.log('[probe] check_spine("' + opts.query + '") result:');
  console.log(text);

  const lower = text.toLowerCase();
  let failed = false;
  for (const expected of checks.filter(Boolean)) {
    if (!lower.includes(String(expected).toLowerCase())) {
      console.error('[probe] missing expected text: ' + expected);
      failed = true;
    }
  }
  for (const forbidden of opts.forbid.filter(Boolean)) {
    if (lower.includes(String(forbidden).toLowerCase())) {
      console.error('[probe] forbidden text appeared: ' + forbidden);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log('[probe] PASS');
}

main().catch((err) => {
  console.error('[probe] ERROR: ' + err.message);
  process.exit(2);
});
