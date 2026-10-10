// vapi-signature.js
//
// Request validation for POST /vapi/webhook (E0 workstream A, 2026-06-11).
// Vapi sends the secret through assistant/phone-number server.headers as
// 'x-vapi-secret' on every webhook call. Before this, the endpoint accepted
// any POST from anywhere, meaning anyone could forge tool-calls or
// end-of-call reports.
//
// Policy:
//  - Secret configured (VAPI_WEBHOOK_SECRET set): exact match required, fail
//    closed on mismatch or missing header.
//  - Secret NOT configured: pass with reason 'no-secret-configured-warn' so
//    existing deploys keep working; the caller logs one warning per process.

const crypto = require('node:crypto');

function timingSafeMatch(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// headers: node req.headers (lowercased keys). Returns { valid, reason }.
function isValidVapiRequest(headers, configuredSecret) {
  const secret = String(configuredSecret || '');
  if (!secret) {
    return { valid: true, reason: 'no-secret-configured-warn' };
  }
  const h = headers || {};
  const presented = String(h['x-vapi-secret'] || h['X-Vapi-Secret'] || '');
  if (!presented) {
    return { valid: false, reason: 'missing-secret-header' };
  }
  if (timingSafeMatch(presented, secret)) {
    return { valid: true, reason: 'secret-match' };
  }
  return { valid: false, reason: 'secret-mismatch' };
}

module.exports = { isValidVapiRequest };
