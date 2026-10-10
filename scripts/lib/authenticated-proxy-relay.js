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
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        upstream.write(injectProxyAuthorization(header, authHeader), 'latin1');
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
  });

  server.on('error', fail);
  server.listen(listenPort, '127.0.0.1', () => {
    fs.writeFileSync(readyFile, `http://127.0.0.1:${listenPort}\n`, { mode: 0o600 });
  });
  const stop = () => server.close(() => process.exit(0));
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
