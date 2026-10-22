#!/usr/bin/env node
'use strict';

const https = require('https');
const os = require('os');
const path = require('path');
const { createBroker } = require('./lib/credential-broker');

const QUOTA_FAILURE = /quota|credit|character.{0,20}limit|exceeds.{0,40}(limit|credit)/i;
const EXPLICIT_INACTIVE = /inactive|cancelled|canceled|expired|past_due|unpaid/i;

function runtimeDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data');
  }
  return '/opt/secondbrain/data';
}

function requestSubscription(apiKey, request = https.request) {
  return new Promise((resolve, reject) => {
    const req = request(
      'https://api.elevenlabs.io/v1/user/subscription',
      {
        method: 'GET',
        headers: { accept: 'application/json', 'xi-api-key': apiKey },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(body);
          } catch {
            json = {};
          }
          resolve({ statusCode: Number(res.statusCode || 0), body: json, bodyText: body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function safeSubscription(body = {}) {
  return {
    tier: body.tier || null,
    status: body.status || null,
    character_count: Number.isFinite(body.character_count) ? body.character_count : null,
    character_limit: Number.isFinite(body.character_limit) ? body.character_limit : null,
  };
}

async function checkElevenLabsAccess(options = {}) {
  const broker = options.broker || createBroker({ dataDir: runtimeDataDir() });
  const probe = options.requestSubscription || requestSubscription;
  const runtime = broker.diagnoseCredential('elevenlabs', 'apiKey');
  const credential = broker.resolveCredential('elevenlabs', 'apiKey');

  if (!credential.present) {
    broker.recordOutcome('elevenlabs', {
      ok: false,
      missing: true,
      source: 'none',
      ssmReadable: runtime.canonical_ssm.readable,
    });
    return {
      status: 'runtime_unwired',
      runtime,
      subscription: { state: 'unknown' },
      explanation:
        'No ElevenLabs credential is reachable from the runtime. This does not prove that the subscription or provider-side keys are inactive.',
    };
  }

  let response;
  try {
    response = await probe(credential.value);
  } catch (error) {
    broker.recordOutcome('elevenlabs', {
      ok: false,
      error: error && error.message ? error.message : String(error),
      source: credential.source,
      ssmReadable: runtime.canonical_ssm.readable,
      fingerprint: credential.fingerprint,
    });
    return {
      status: 'provider_unavailable',
      runtime,
      subscription: { state: 'unknown' },
      explanation: 'The credential resolved, but the provider health request did not complete.',
    };
  }

  const statusCode = Number(response.statusCode || 0);
  const body = response.body || {};
  const bodyText = String(response.bodyText || JSON.stringify(body));
  let status = 'provider_error';
  let explanation = `ElevenLabs returned HTTP ${statusCode || 'unknown'}.`;

  if (statusCode === 200) {
    if (body.status && EXPLICIT_INACTIVE.test(String(body.status))) {
      status = 'subscription_inactive';
      explanation = `ElevenLabs explicitly reports subscription status ${body.status}.`;
    } else {
      status = 'subscription_healthy';
      explanation = 'The runtime credential authenticated and ElevenLabs reports the subscription endpoint healthy.';
    }
  } else if (statusCode === 401 || statusCode === 403) {
    status = 'auth_failed';
    explanation = 'The runtime reached ElevenLabs, but the provider rejected the API key.';
  } else if (statusCode >= 400 && statusCode < 500 && QUOTA_FAILURE.test(bodyText)) {
    status = 'api_key_quota_limited';
    explanation = 'The API key authenticated but its per-key quota or credit limit blocked the request.';
  } else if (statusCode >= 500 || statusCode === 0) {
    status = 'provider_unavailable';
    explanation = 'The runtime credential resolved, but ElevenLabs is unavailable or returned a server error.';
  }

  const ok = status === 'subscription_healthy';
  broker.recordOutcome('elevenlabs', {
    ok,
    error: ok ? null : `${status}: HTTP ${statusCode}`,
    source: credential.source,
    ssmReadable: runtime.canonical_ssm.readable,
    fingerprint: credential.fingerprint,
  });

  return {
    status,
    runtime,
    credential: {
      present: true,
      source: credential.source,
      fingerprint: credential.fingerprint,
    },
    provider_http_status: statusCode,
    subscription: { state: status === 'subscription_healthy' ? 'healthy' : status, ...safeSubscription(body) },
    explanation,
  };
}

function formatHuman(report) {
  const lines = [
    `ElevenLabs access: ${report.status}`,
    `Runtime: ${report.runtime.state} via ${report.runtime.source}`,
  ];
  if (report.subscription && report.subscription.state !== 'unknown') {
    const plan = [report.subscription.tier, report.subscription.status].filter(Boolean).join(', ');
    lines.push(`Subscription: ${report.subscription.state}${plan ? ` (${plan})` : ''}`);
    if (
      report.subscription.character_count !== null &&
      report.subscription.character_limit !== null
    ) {
      lines.push(
        `Credits: ${report.subscription.character_count} of ${report.subscription.character_limit} used`,
      );
    }
  } else {
    lines.push('Subscription: unknown (runtime storage cannot establish provider account state)');
  }
  lines.push(report.explanation);
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const report = await checkElevenLabsAccess();
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify(report, null, 2) : formatHuman(report)}\n`);
  process.exitCode = report.status === 'subscription_healthy' ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ElevenLabs access check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  checkElevenLabsAccess,
  formatHuman,
  requestSubscription,
  runtimeDataDir,
  safeSubscription,
};
