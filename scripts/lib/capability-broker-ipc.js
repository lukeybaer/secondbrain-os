'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 35_000;

function socketAddress(workspace, turnId) {
  const suffix = crypto.createHash('sha256').update(String(turnId)).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\amy-broker-${process.pid}-${suffix}`;
  return path.join(workspace, `.amy-broker-${suffix}.sock`);
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function writeResponse(socket, payload) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(payload)}\n`);
}

function createCapabilityBrokerIpcServer({ broker, turnId, workspace, token } = {}) {
  if (!broker || typeof broker.catalog !== 'function' || typeof broker.invoke !== 'function') {
    throw new Error('capability broker IPC requires a broker');
  }
  if (!turnId) throw new Error('capability broker IPC requires turnId');
  if (!workspace) throw new Error('capability broker IPC requires workspace');
  const address = socketAddress(workspace, turnId);
  const secret = token || crypto.randomBytes(32).toString('hex');
  let server = null;

  async function dispatch(request) {
    if (!request || !equalSecret(request.token, secret)) {
      throw new Error('capability broker IPC authentication failed');
    }
    if (String(request.turnId || '') !== String(turnId)) {
      throw new Error('capability broker IPC refused a different turn');
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
    throw new Error('capability broker IPC operation is invalid');
  }

  async function start() {
    if (server) return;
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.dirname(address), { recursive: true });
      try {
        fs.unlinkSync(address);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    server = net.createServer((socket) => {
      let raw = '';
      let handled = false;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        if (handled) return;
        raw += chunk;
        if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
          handled = true;
          writeResponse(socket, { transport_ok: false, error: 'capability broker IPC request too large' });
          return;
        }
        const newline = raw.indexOf('\n');
        if (newline < 0) return;
        handled = true;
        let request;
        try {
          request = JSON.parse(raw.slice(0, newline));
        } catch {
          writeResponse(socket, { transport_ok: false, error: 'capability broker IPC request is invalid JSON' });
          return;
        }
        Promise.resolve(dispatch(request)).then(
          (result) => writeResponse(socket, { transport_ok: true, result }),
          (error) =>
            writeResponse(socket, {
              transport_ok: false,
              error: String(error?.message || error || 'capability broker IPC failed').slice(0, 500),
            }),
        );
      });
      socket.on('error', () => {
        // The caller receives its own transport failure. Never crash the owner session.
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(address);
    });
    server.on('error', () => {
      // A late turn-scoped transport failure is observed by the connected
      // client. It must not crash the long-lived Telegram session host.
    });
  }

  async function close() {
    const current = server;
    server = null;
    if (current) {
      await new Promise((resolve) => current.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(address);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  return {
    address,
    environment: {
      AMY_TOOL_BROKER_SOCKET: address,
      AMY_TOOL_BROKER_TOKEN: secret,
    },
    start,
    close,
  };
}

function requestCapabilityBrokerIpc(
  { address, token, operation, turnId, tool, args = {}, evidence = {}, decisionId = null } = {},
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (!address || !token) return Promise.reject(new Error('capability broker IPC is not configured'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    let raw = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`capability broker IPC timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ token, operation, turnId, tool, args, evidence, decisionId })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      raw += chunk;
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(raw.slice(0, newline));
      } catch {
        finish(new Error('capability broker IPC returned invalid JSON'));
        return;
      }
      if (response.transport_ok !== true) {
        finish(new Error(String(response.error || 'capability broker IPC failed')));
        return;
      }
      finish(null, response.result);
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled && !raw.includes('\n')) finish(new Error('capability broker IPC closed without a result'));
    });
  });
}

module.exports = {
  MAX_REQUEST_BYTES,
  createCapabilityBrokerIpcServer,
  equalSecret,
  requestCapabilityBrokerIpc,
  socketAddress,
};
