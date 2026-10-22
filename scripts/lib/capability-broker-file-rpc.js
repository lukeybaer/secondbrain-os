'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 65_000;
const DEFAULT_POLL_MS = 20;

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function signedRequestFields(request) {
  return {
    schema: request.schema,
    request_id: request.request_id,
    operation: request.operation,
    turnId: request.turnId,
    tool: request.tool,
    args: request.args,
    evidence: request.evidence,
    decisionId: request.decisionId,
  };
}

function signRequest(request, secret) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(JSON.stringify(signedRequestFields(request)))
    .digest('hex');
}

function brokerRoot(workspace, turnId) {
  const suffix = crypto.createHash('sha256').update(String(turnId)).digest('hex').slice(0, 16);
  return path.join(path.resolve(workspace), '.amy-tool-broker', suffix);
}

function paths(root) {
  return {
    requests: path.join(root, 'requests'),
    processing: path.join(root, 'processing'),
    responses: path.join(root, 'responses'),
  };
}

function ensureDirectories(root) {
  const dirs = paths(root);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dirs;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function safeRequestName(name) {
  return /^[0-9a-f-]{36}\.json$/.test(String(name || ''));
}

function createCapabilityBrokerFileServer({
  broker,
  turnId,
  workspace,
  token,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (!broker || typeof broker.catalog !== 'function' || typeof broker.invoke !== 'function') {
    throw new Error('capability broker file RPC requires a broker');
  }
  if (!turnId) throw new Error('capability broker file RPC requires turnId');
  if (!workspace) throw new Error('capability broker file RPC requires workspace');
  const root = brokerRoot(workspace, turnId);
  const secret = token || crypto.randomBytes(32).toString('hex');
  let dirs = null;
  let timer = null;
  let scanning = false;
  let closing = false;
  const inFlight = new Set();

  async function dispatch(request) {
    if (!request || request.schema !== 'amy.capability-file-rpc-request.v1') {
      throw new Error('capability broker file RPC request schema is invalid');
    }
    if (!equalSecret(request.signature, signRequest(request, secret))) {
      throw new Error('capability broker file RPC authentication failed');
    }
    if (String(request.turnId || '') !== String(turnId)) {
      throw new Error('capability broker file RPC refused a different turn');
    }
    if (request.operation === 'catalog') return broker.catalog({ turnId });
    if (request.operation === 'invoke') {
      return broker.invoke({
        turnId,
        tool: request.tool,
        args: request.args || {},
        evidence: request.evidence || {},
        decisionId: request.decisionId || null,
      });
    }
    throw new Error('capability broker file RPC operation is invalid');
  }

  async function processRequest(name) {
    const requestFile = path.join(dirs.requests, name);
    const claimedFile = path.join(dirs.processing, name);
    const responseFile = path.join(dirs.responses, name);
    try {
      fs.renameSync(requestFile, claimedFile);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let response;
    try {
      const stats = fs.statSync(claimedFile);
      if (stats.size > MAX_REQUEST_BYTES) {
        throw new Error('capability broker file RPC request too large');
      }
      const request = JSON.parse(fs.readFileSync(claimedFile, 'utf8'));
      if (`${request.request_id}.json` !== name) {
        throw new Error('capability broker file RPC request id does not match its filename');
      }
      response = { transport_ok: true, result: await dispatch(request) };
    } catch (error) {
      response = {
        transport_ok: false,
        error: String(error?.message || error || 'capability broker file RPC failed').slice(0, 500),
      };
    }
    atomicJson(responseFile, response);
    try {
      fs.unlinkSync(claimedFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function scan({ duringClose = false } = {}) {
    if (!dirs || scanning || (closing && !duringClose)) return;
    scanning = true;
    try {
      const names = fs.readdirSync(dirs.requests).filter(safeRequestName);
      for (const name of names) {
        const work = processRequest(name);
        inFlight.add(work);
        work.finally(() => inFlight.delete(work));
      }
    } finally {
      scanning = false;
    }
  }

  async function start() {
    if (timer) return;
    closing = false;
    dirs = ensureDirectories(root);
    await scan();
    timer = setInterval(() => {
      scan().catch(() => {
        // A request-specific transport error is returned through its response file.
      });
    }, Math.max(5, Number(pollMs) || DEFAULT_POLL_MS));
    timer.unref?.();
  }

  async function close() {
    closing = true;
    if (timer) clearInterval(timer);
    timer = null;
    await scan({ duringClose: true });
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    dirs = null;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // The turn is already closed. A stale empty transport directory is harmless.
    }
  }

  return {
    root,
    environment: {
      AMY_TOOL_BROKER_DIR: root,
      AMY_TOOL_BROKER_TOKEN: secret,
    },
    start,
    close,
  };
}

async function requestCapabilityBrokerFile(
  { root, token, operation, turnId, tool, args = {}, evidence = {}, decisionId = null } = {},
  { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = {},
) {
  if (!root || !token) throw new Error('capability broker file RPC is not configured');
  const dirs = ensureDirectories(path.resolve(root));
  const requestId = crypto.randomUUID();
  const name = `${requestId}.json`;
  const requestFile = path.join(dirs.requests, name);
  const responseFile = path.join(dirs.responses, name);
  const request = {
    schema: 'amy.capability-file-rpc-request.v1',
    request_id: requestId,
    operation,
    turnId,
    tool,
    args,
    evidence,
    decisionId,
  };
  request.signature = signRequest(request, token);
  atomicJson(requestFile, request);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  try {
    while (Date.now() <= deadline) {
      if (fs.existsSync(responseFile)) {
        const stats = fs.statSync(responseFile);
        if (stats.size > MAX_REQUEST_BYTES) throw new Error('capability broker file RPC response too large');
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
        fs.unlinkSync(responseFile);
        if (response.transport_ok !== true) {
          throw new Error(String(response.error || 'capability broker file RPC failed'));
        }
        return response.result;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, Number(pollMs) || DEFAULT_POLL_MS)));
    }
    throw new Error(`capability broker file RPC timed out after ${timeoutMs}ms`);
  } finally {
    try {
      fs.unlinkSync(requestFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = {
  DEFAULT_POLL_MS,
  MAX_REQUEST_BYTES,
  atomicJson,
  brokerRoot,
  createCapabilityBrokerFileServer,
  equalSecret,
  requestCapabilityBrokerFile,
  signRequest,
  signedRequestFields,
};
