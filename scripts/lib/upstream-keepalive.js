'use strict';

// Keep-alive windows for the :3001 server behind API Gateway (Voice provider's custom-LLM
// URL and webhooks reach Node through the HTTP API proxy, unay54a6jh). Node's
// default keepAliveTimeout is 5 s; the gateway reuses idle upstream connections
// longer than that, so under a webhook burst a request can land on a socket
// Node is closing and the gateway answers 503 without Node ever logging it
// (2026-10-21 news self-call: 36 gateway 5xx in the burst minute, none in Node).
// The server must outlive the proxy's idle window, and headersTimeout must stay
// above keepAliveTimeout.

const UPSTREAM_KEEP_ALIVE_MS = 65_000;
const UPSTREAM_HEADERS_TIMEOUT_MS = 66_000;

function applyUpstreamKeepAlive(server) {
  server.keepAliveTimeout = UPSTREAM_KEEP_ALIVE_MS;
  server.headersTimeout = UPSTREAM_HEADERS_TIMEOUT_MS;
  return server;
}

module.exports = { applyUpstreamKeepAlive, UPSTREAM_KEEP_ALIVE_MS, UPSTREAM_HEADERS_TIMEOUT_MS };
