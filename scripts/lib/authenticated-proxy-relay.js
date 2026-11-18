#!/usr/bin/env node
'use strict';

// A deliberately tiny loopback-only forward proxy. It receives the upstream
// credential through a mode-600 handoff file, never argv, and injects
// Proxy-Authorization before forwarding each client request to the paid
// provider. yt-dlp and ffmpeg only see the credential-free 127.0.0.1 endpoint.

const fs = require('fs');
const net = require('net');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

const listenPort = Number(argValue('--listen-port'));
const readyFile = argValue('--ready-file');
const errorFile = argValue('--error-file');
const credentialFile = argValue('--credential-file');
const usageFile = argValue('--usage-file');

// Byte meter for the paid provider. Every byte the relay moves crosses the
// provider gateway, so these totals are Amy's measured (not billed) usage.
const usage = { bytesUp: 0, bytesDown: 0, connections: 0, gatewayStatus: 'ok' };
const activeSockets = new Set();
let finalized = false;

function writeUsage(final = false) {
  if (!usageFile || finalized) return;
  if (final) finalized = true;
  try {
    fs.writeFileSync(usageFile, JSON.stringify({ ...usage, final }), { mode: 0o600 });
  } catch {
    // Metering never breaks a download.
  }
}

function fail(error) {
  const message = String(error && error.message ? error.message : error || 'proxy relay failed');
  try {
    if (errorFile) fs.writeFileSync(errorFile, message, { mode: 0o600 });
  } catch {
    // The parent also has a bounded readiness timeout.
  }
  process.exitCode = 1;
}

function injectProxyAuthorization(header, authHeader) {
  const lines = header
    .replace(/\r\n\r\n$/, '')
    .split('\r\n')
    .filter((line) => !/^proxy-authorization\s*:/i.test(line));
  lines.push(`Proxy-Authorization: ${authHeader}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

function start(rawProxyUrl) {
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new Error('invalid loopback proxy relay port');
  }
  if (!readyFile || !errorFile) throw new Error('proxy relay readiness paths required');

  const upstreamUrl = new URL(rawProxyUrl);
  if (upstreamUrl.protocol !== 'http:') {
    throw new Error('authenticated proxy relay currently requires an http upstream proxy');
  }
  if (!upstreamUrl.hostname || !upstreamUrl.port || !upstreamUrl.username) {
    throw new Error('authenticated proxy relay requires host, port, and credentials');
  }
  const username = decodeURIComponent(upstreamUrl.username);
  const password = decodeURIComponent(upstreamUrl.password);
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const server = net.createServer((client) => {
    let pending = Buffer.alloc(0);
    const onClientError = () => client.destroy();
    client.on('error', onClientError);
    client.on('data', function receive(chunk) {
      pending = Buffer.concat([pending, chunk]);
      const boundary = pending.indexOf('\r\n\r\n');
      if (boundary === -1) {
        if (pending.length > 64 * 1024) client.destroy();
        return;
      }
      client.removeListener('data', receive);
      const header = pending.subarray(0, boundary + 4).toString('latin1');
      const remainder = pending.subarray(boundary + 4);
      const firstLine = header.split('\r\n', 1)[0] || '';
      if (!/^(?:CONNECT|GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+\S+\s+HTTP\/1\.[01]$/i.test(firstLine)) {
        client.destroy();
        return;
      }

      const upstream = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);
      usage.connections += 1;
      activeSockets.add(client);
      activeSockets.add(upstream);
      client.on('close', () => activeSockets.delete(client));
      // The gateway reports exhaustion in its response head. Buffer the head
      // until it is complete (or 4 KB) because TCP may split the status line.
      let responseHead = Buffer.alloc(0);
      let headInspected = false;
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => {
        activeSockets.delete(upstream);
        writeUsage(false);
      });
      upstream.on('data', (data) => {
        usage.bytesDown += data.length;
        if (headInspected) return;
        responseHead = Buffer.concat([responseHead, data]);
        const head = responseHead.subarray(0, 4096).toString('latin1');
        if (!head.includes('\r\n\r\n') && responseHead.length < 4096) return;
        headInspected = true;
        responseHead = Buffer.alloc(0);
        if (/^HTTP\/1\.[01] 407\b/.test(head)) {
          usage.gatewayStatus = /TRAFFIC_EXHAUSTED/i.test(head)
            ? 'traffic_exhausted'
            : 'proxy_auth_required';
        }
      });
      upstream.on('connect', () => {
        const forwarded = injectProxyAuthorization(header, authHeader);
        usage.bytesUp += Buffer.byteLength(forwarded, 'latin1') + remainder.length;
        upstream.write(forwarded, 'latin1');
        if (remainder.length) upstream.write(remainder);
        client.on('data', (data) => {
          usage.bytesUp += data.length;
        });
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
  });

  server.on('error', fail);
  server.listen(listenPort, '127.0.0.1', () => {
    fs.writeFileSync(readyFile, `http://127.0.0.1:${listenPort}\n`, { mode: 0o600 });
  });
  // The parent stops the relay after its downloader exits. Close every
  // remaining socket first so no byte moves after the final usage snapshot.
  const stop = () => {
    server.close();
    for (const socket of activeSockets) socket.destroy();
    writeUsage(true);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  if (!credentialFile) throw new Error('proxy relay credential file required');
  const rawProxyUrl = fs.readFileSync(credentialFile, 'utf8').trim();
  if (rawProxyUrl.length > 16 * 1024) throw new Error('proxy credential input too large');
  start(rawProxyUrl);
} catch (error) {
  fail(error);
}
