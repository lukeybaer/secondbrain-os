'use strict';

// The one HTTP fetch for news, viral, values and LinkedIn source pulls.
//
// One request keeps one short, fixed limit everywhere: 20 seconds for the whole
// chain including redirects. It is not a watched job limit. On 2026-11-10 a
// private clone wrapped in watchedLimitMs gave one feed request a 3 hour timer
// and held news open for 45 minutes. Do not add another fetchUrl; require this.
// The limit is listed under single-network-request in work-limit-exemptions.json.

const https = require('node:https');

const FETCH_URL_TIMEOUT_MS = 20000;
const FETCH_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'SecondBrain/1.0';

// Full response: { status, headers, body }. Rejects on a bad redirect, a
// redirect loop, a socket error, or the 20 s hard deadline (never reset per hop).
function fetchResponse(url, options = {}) {
  const timeoutMs =
    Number(options.timeoutMs) > 0
      ? Math.min(Number(options.timeoutMs), FETCH_URL_TIMEOUT_MS)
      : FETCH_URL_TIMEOUT_MS;
  const method = options.method || 'GET';
  const getImpl = options.getImpl || (options.body || method !== 'GET' ? https.request : https.get);
  const deadline = options.deadline != null ? options.deadline : Date.now() + timeoutMs;
  const redirectsLeft = options.redirectsLeft != null ? options.redirectsLeft : FETCH_MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return reject(new Error(`fetchUrl hard timeout (deadline exceeded across redirects): ${url}`));
    }
    let settled = false;
    let req = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      fn(arg);
    };
    // The hard timer fires after the REMAINING budget no matter how the body
    // trickles; the socket-idle timeout below cannot catch a trickle.
    const hard = setTimeout(() => {
      const error = new Error(`fetchUrl hard timeout after ${timeoutMs}ms: ${url}`);
      try {
        if (req) req.destroy(error);
      } catch {
        /* already closed */
      }
      done(reject, error);
    }, remaining);
    const headers = { 'User-Agent': DEFAULT_USER_AGENT, ...(options.headers || {}) };
    try {
      req = getImpl(url, { method, headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          clearTimeout(hard);
          if (settled) return;
          settled = true;
          if (redirectsLeft <= 0) {
            return reject(new Error(`fetchUrl too many redirects (>${FETCH_MAX_REDIRECTS}): ${url}`));
          }
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url).toString();
          } catch {
            return reject(
              new Error(`fetchUrl bad redirect location "${res.headers.location}" from ${url}`),
            );
          }
          return resolve(
            fetchResponse(nextUrl, { ...options, deadline, redirectsLeft: redirectsLeft - 1 }),
          );
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          done(resolve, {
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
        res.on('error', (error) => done(reject, error));
      });
    } catch (error) {
      return done(reject, error);
    }
    req.on('error', (error) => done(reject, error));
    req.setTimeout(remaining, () => {
      const error = new Error(`fetchUrl socket-idle timeout after ${timeoutMs}ms: ${url}`);
      try {
        req.destroy(error);
      } catch {
        /* already closed */
      }
      done(reject, error);
    });
    if (options.body && typeof req.write === 'function') req.write(options.body);
    if (typeof req.end === 'function') req.end();
  });
}

// Body text only, the shape feed and article callers want.
async function fetchUrl(url, timeoutMs = FETCH_URL_TIMEOUT_MS, getImpl = https.get, opts = {}) {
  const response = await fetchResponse(url, { ...opts, timeoutMs, getImpl });
  return response.body;
}

// A fetch()-compatible wrapper for callers that take an injected fetchImpl
// (LinkedIn content pipe). The signal can only shorten the 20 s limit.
function fetchWeb(url, init = {}) {
  const cap = AbortSignal.timeout(FETCH_URL_TIMEOUT_MS);
  const signal =
    init.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, cap])
      : init.signal || cap;
  return fetch(url, { ...init, signal });
}

module.exports = { FETCH_URL_TIMEOUT_MS, FETCH_MAX_REDIRECTS, fetchResponse, fetchUrl, fetchWeb };
