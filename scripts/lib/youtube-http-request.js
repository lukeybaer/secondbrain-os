'use strict';
// One YouTube API request with an enforced deadline (Codex review
// 1e96b5fc94a6 R4). The server's helper used to wait forever on a socket
// that never answered and to resolve a response the far end cut off mid-body
// as if it were whole, so a publish or a rollback write could keep the
// upload lock indefinitely, and a partial body could be read as proof. Every
// request now has an idle timeout (options.timeout, else the default) and a
// hard deadline (options.deadline, else three idle timeouts), and a response
// that ends before it is complete rejects.
const https = require('node:https');

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const HARD_DEADLINE_MULTIPLIER = 3;

function describeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.host + parsed.pathname;
  } catch {
    return String(url).slice(0, 80);
  }
}

function requestWithDeadline(
  url,
  options = {},
  body = undefined,
  { transport = https, defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {},
) {
  const timeoutMs = Number(options && options.timeout) > 0 ? Number(options.timeout) : defaultTimeoutMs;
  const deadlineMs =
    Number(options && options.deadline) > 0 ? Number(options.deadline) : timeoutMs * HARD_DEADLINE_MULTIPLIER;
  const label = `${String((options && options.method) || 'GET').toUpperCase()} ${describeUrl(url)}`;
  const { deadline: _deadline, ...requestOptions } = options || {};
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      settle(value);
    };
    const incomplete = () => new Error(`response ended before completing (${label})`);
    const req = transport.request(url, { ...requestOptions, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => finish(reject, err));
      res.on('aborted', () => finish(reject, incomplete()));
      res.on('close', () => {
        if (!res.complete) finish(reject, incomplete());
      });
      res.on('end', () => {
        if (!res.complete) {
          finish(reject, incomplete());
          return;
        }
        finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs} ms (${label})`));
    });
    deadlineTimer = setTimeout(() => {
      req.destroy(new Error(`request exceeded its ${deadlineMs} ms deadline (${label})`));
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    req.on('error', (err) => finish(reject, err));
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { DEFAULT_REQUEST_TIMEOUT_MS, HARD_DEADLINE_MULTIPLIER, requestWithDeadline };
