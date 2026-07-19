#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  advisorPaths,
  buildAdvisorPromptBlock,
  createDispositionReceipt,
  createGraphitiAdvisor,
  formatGraphitiImpact,
  recordDispositionReceipt,
  runtimeDataDir,
} = require('./lib/graphiti-brain-advisor');
const { writeGraphitiAdvisorHealth } = require('./lib/graphiti-advisor-health');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function stdinText() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function requestFrom(args) {
  let body = {};
  if (args.requestFile) body = readJson(path.resolve(args.requestFile), {}) || {};
  else {
    const raw = stdinText().trim();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { prompt: raw };
      }
    }
  }
  return {
    ...body,
    prompt: args.prompt || body.prompt || body.user_prompt || '',
    action: args.action || body.action || '',
    actionType: args.actionType || body.actionType || body.action_type || '',
    surface: args.surface || body.surface || 'ExampleCo',
    conversationId:
      args.conversationId || body.conversationId || body.conversation_id || body.session_id || '',
    project: args.project || body.project || 'SecondBrain',
    recipient: args.recipient || body.recipient || '',
    visibility: args.visibility || body.visibility || 'owner_private',
    timeoutMs: Number(args.timeoutMs || body.timeoutMs || body.timeout_ms) || undefined,
    advisorId: args.advisorId || body.advisorId || body.advisor_id || undefined,
  };
}

function updateSession(paths, sessionId, advisorId) {
  if (!sessionId) return;
  const sessions = readJson(paths.sessions, {}) || {};
  sessions[String(sessionId)] = { advisor_id: advisorId, updated_at: new Date().toISOString() };
  writeJson(paths.sessions, sessions);
}

function resolveAdvisorId(args, paths) {
  if (args.advisorId) return String(args.advisorId);
  if (args.sessionId) {
    const sessions = readJson(paths.sessions, {}) || {};
    return sessions[String(args.sessionId)] && sessions[String(args.sessionId)].advisor_id;
  }
  return null;
}

function resultPath(paths, advisorId) {
  return path.join(paths.results, `${advisorId}.json`);
}

function pendingEnvelope(request, advisorId, waitMs) {
  return {
    schema: 'amy.graphiti_advisor.v1',
    advisor_id: advisorId,
    surface: request.surface || 'ExampleCo',
    conversation_id: request.conversationId || '',
    project: request.project || '',
    visibility: request.visibility || 'owner_private',
    status: 'pending',
    consulted_about: request.consulted_about || [
      `current intent: ${request.prompt || request.action || 'the pending Amy action'}`,
      "ExampleCo's relevant preferences, constraints, and definition of helpfulness",
      'prior decisions and approach changes',
      'recent experience with the people and project involved',
    ],
    facts: [],
    error: `Graphiti consultation is still running after ${waitMs}ms`,
  };
}

async function waitForResult(paths, advisorId, waitMs, request) {
  const file = resultPath(paths, advisorId);
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    const found = readJson(file);
    if (found) return found;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
    );
  } while (Date.now() <= deadline);
  return pendingEnvelope(request || {}, advisorId, waitMs);
}

async function startDetached(args, dataDir, paths) {
  const request = requestFrom(args);
  const advisorId =
    request.advisorId || `ga_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  request.advisorId = advisorId;
  request.started_at = new Date().toISOString();
  const requestFile = path.join(paths.requests, `${advisorId}.json`);
  writeJson(requestFile, request);
  updateSession(paths, request.conversationId || args.sessionId, advisorId);
  if (process.platform === 'win32') {
    // Start-Process is the reliable Windows detach boundary. Native detached
    // spawn can close a Claude hook's capture pipe, while non-detached children
    // are killed with the short-lived hook process.
    const launched = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Start-Process -FilePath $env:GRAPHITI_ADVISOR_NODE -ArgumentList @($env:GRAPHITI_ADVISOR_SCRIPT,'query-request','--request-file',$env:GRAPHITI_ADVISOR_REQUEST) -WindowStyle Hidden",
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
        env: {
          ...process.env,
          SECONDBRAIN_DATA_DIR: dataDir,
          GRAPHITI_ADVISOR_NODE: process.execPath,
          GRAPHITI_ADVISOR_SCRIPT: __filename,
          GRAPHITI_ADVISOR_REQUEST: requestFile,
        },
      },
    );
    if (launched.error || launched.status !== 0) {
      throw launched.error || new Error(`Windows advisor launch exited ${launched.status}`);
    }
  } else {
    const child = spawn(
      process.execPath,
      [__filename, 'query-request', '--request-file', requestFile],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDir },
      },
    );
    child.unref();
  }
  return {
    schema: 'amy.graphiti_advisor_start.v1',
    advisor_id: advisorId,
    status: 'started',
    started_at: request.started_at,
    surface: request.surface,
    conversation_id: request.conversationId,
  };
}

async function queryRequest(args) {
  const request = requestFrom(args);
  if (!request.advisorId) throw new Error('query-request requires advisorId in the request');
  const advisor = createGraphitiAdvisor();
  return advisor.begin(request).completion;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  const dataDir = runtimeDataDir(args.dataDir);
  const paths = advisorPaths(dataDir);
  let output;

  if (command === 'start' || command === 'start-detached') {
    output = await startDetached(args, dataDir, paths);
  } else if (command === 'query-request') {
    output = await queryRequest(args);
  } else if (command === 'await' || command === 'context') {
    const advisorId = resolveAdvisorId(args, paths);
    if (!advisorId) throw new Error('await/context requires --advisor-id or --session-id');
    const request = readJson(path.join(paths.requests, `${advisorId}.json`), {}) || {};
    const envelope = await waitForResult(paths, advisorId, Number(args.waitMs) || 0, request);
    output =
      command === 'context'
        ? { envelope, prompt_block: buildAdvisorPromptBlock(envelope) }
        : envelope;
  } else if (command === 'receipt') {
    const advisorId = resolveAdvisorId(args, paths);
    if (!advisorId) throw new Error('receipt requires --advisor-id or --session-id');
    const request = readJson(path.join(paths.requests, `${advisorId}.json`), {}) || {};
    const envelope =
      readJson(resultPath(paths, advisorId)) || pendingEnvelope(request, advisorId, 0);
    const answer = args.outputFile
      ? fs.readFileSync(path.resolve(args.outputFile), 'utf8')
      : stdinText();
    const receipt = createDispositionReceipt({
      envelope,
      output: answer,
      answerActionId:
        args.answerActionId || `answer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      visibility: args.visibility || envelope.visibility,
    });
    recordDispositionReceipt(receipt, { dataDir });
    output = { envelope, receipt, graphiti_impact: formatGraphitiImpact(envelope, receipt) };
  } else if (command === 'health') {
    output = writeGraphitiAdvisorHealth({ dataDir });
  } else {
    output = {
      usage:
        'graphiti-brain-advisor.js start|await|context|receipt|health [--advisor-id ID] [--session-id ID] [--wait-ms N]',
    };
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main()
  .then(() => {
    // The tunneled Graphiti client may leave a transport handle alive after a
    // completed or timed-out detached query. Its durable result is already on
    // disk, so the one-shot worker must terminate instead of leaking a process.
    if (process.argv[2] === 'query-request') process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`graphiti-brain-advisor: ${error.message}\n`);
    process.exitCode = 1;
  });
