// scripts/lib/llm-spend-endpoint.js
//
// Pure decision logic for the central LLM spend ledger endpoints (D3, ExampleCo
// 2026-07-11). ec2-server.js mounts GET /llm-spend and POST /llm-spend/settle
// as thin HTTP glue over this function so the token gate, validation, and
// bucket settlement are unit-testable without booting the monolith.
//
// EC2 is the single source of truth for the $30/month + $10/night (6pm-6am CT)
// OpenAI floor budget; desktop reads and settles here so both machines share
// ONE budget instead of each burning the full caps. Access requires the
// x-sb-spend-token header to match the server's SB_SPEND_TOKEN; with no server
// token set the ledger is disabled (503) rather than silently open. Clients
// fall back to their local file on any non-2xx, so the briefing is never
// blocked by this endpoint.

'use strict';

// req: { method, urlPath, token } where token is the x-sb-spend-token header.
// serverToken: process.env.SB_SPEND_TOKEN on the server.
// body: parsed POST body (only for /settle), or null.
// lib: injected { readSpend, recordSpend, resolveSpendFile } (scripts/lib/ask-ai.js).
// Returns { status, body } with no side effects beyond lib.recordSpend on settle.
function handleLlmSpendRequest(req, { serverToken, body, lib }) {
  const method = String((req && req.method) || '').toUpperCase();
  const urlPath = (req && req.urlPath) || '';
  const token = (req && req.token) || '';

  if (!serverToken) {
    return {
      status: 503,
      body: { error: 'spend-ledger-disabled', detail: 'SB_SPEND_TOKEN not set' },
    };
  }
  if (token !== serverToken) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (urlPath === '/llm-spend' && method === 'GET') {
    return { status: 200, body: lib.readSpend() };
  }

  if (urlPath === '/llm-spend/settle' && method === 'POST') {
    const estUsd = Number(body && body.estUsd);
    if (!Number.isFinite(estUsd) || estUsd < 0) {
      return { status: 400, body: { error: 'invalid-estUsd' } };
    }
    const state = lib.recordSpend(estUsd, lib.resolveSpendFile(), (body && body.at) || new Date());
    return { status: 200, body: state };
  }

  return { status: 405, body: { error: 'method-not-allowed' } };
}

module.exports = { handleLlmSpendRequest };
