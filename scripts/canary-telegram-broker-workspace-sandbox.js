#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildCodexCliEnv } = require('./lib/cli-output-guard.js');
const { CAPABILITY_REGISTRY } = require('./lib/capability-registry.js');
const { createCapabilityBrokerFileServer } = require('./lib/capability-broker-file-rpc.js');

function run(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

async function canary({
  command = process.env.AMY_CODEX_COMMAND || 'codex',
  timeoutMs = Number(process.env.AMY_TELEGRAM_BROKER_CANARY_TIMEOUT_MS || 3 * 60 * 1000),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-telegram-broker-canary-'));
  const workspace = path.join(root, 'workspace');
  const outputFile = path.join(root, 'last-message.txt');
  const turnId = `canary_${Date.now()}`;
  fs.mkdirSync(workspace, { recursive: true });
  let catalogCalls = 0;
  const broker = {
    catalog: ({ turnId: requestedTurn }) => {
      catalogCalls += 1;
      return {
        ok: true,
        schema: 'amy.capability-catalog.v1',
        turn_id: requestedTurn,
        capabilities: CAPABILITY_REGISTRY.map((descriptor) => ({ name: descriptor.name, available: true })),
      };
    },
    invoke: async () => ({ ok: false, error: 'canary_invocation_not_supported' }),
  };
  const rpc = createCapabilityBrokerFileServer({ broker, turnId, workspace });
  try {
    await rpc.start();
    const brokerCli = path.join(__dirname, 'amy-tool-broker.js').replace(/\\/g, '/');
    const result = await run(
      command,
      [
        'exec',
        '--skip-git-repo-check',
        '-s',
        'workspace-write',
        '-C',
        workspace,
        '--output-last-message',
        outputFile,
        '-',
      ],
      {
        cwd: workspace,
        env: {
          ...buildCodexCliEnv(process.env),
          ...rpc.environment,
          AMY_CURRENT_TURN_ID: turnId,
          AMY_TOOL_BROKER_REQUIRED: '1',
        },
        input: [
          'Run this exact shell command now and inspect its JSON output:',
          `node ${brokerCli} catalog --turn-id ${turnId}`,
          `Then answer only: BROKER_OK ${CAPABILITY_REGISTRY.length}`,
        ].join('\n'),
        timeoutMs,
      },
    );
    let lastMessage = '';
    try { lastMessage = fs.readFileSync(outputFile, 'utf8').trim(); } catch { /* no output */ }
    const ok = result.ok && catalogCalls > 0 && lastMessage.includes(`BROKER_OK ${CAPABILITY_REGISTRY.length}`);
    return {
      ok,
      schema: 'amy.telegram-broker-workspace-canary.v1',
      sandbox: 'workspace-write',
      transport: 'workspace-file-rpc',
      capability_count: CAPABILITY_REGISTRY.length,
      catalog_calls: catalogCalls,
      model_result_ok: result.ok,
      timed_out: result.timedOut,
      last_message: lastMessage.slice(0, 500),
      error: ok ? null : String(result.error || result.stderr || 'canary did not observe the broker catalog').slice(0, 1000),
    };
  } finally {
    await rpc.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  canary()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { canary, run };
