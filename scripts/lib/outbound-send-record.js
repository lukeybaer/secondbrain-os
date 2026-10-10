'use strict';

// Every send that reaches another human writes one comms.out record naming its
// authorization, so laws g2 and g5 can judge each send from the record itself
// (ExampleCo 2026-09-24: cover every outbound channel). Recording is fail-soft and
// runs only after the send succeeded; it never blocks or retries a send.
//
// authorization values:
//   owner-only        every recipient is ExampleCo himself
//   jev:<choice>      Jev outreach approval accepted this exact message
//   amy | ExampleCo-approved   AMY_SEND_OK attestation from the outbound send guard
//   principal-test    a verified test call to ExampleCo's own number
//   standing:<name>   a durable owner authorization (named)
//   none              sent with no authorization: a g2 violation

const crypto = require('node:crypto');

function recipientDomains(recipients) {
  return [...new Set(String(recipients || '')
    .split(/[,;\s]+/)
    .map((entry) => (entry.match(/@([A-Za-z0-9.-]+)/) || [])[1])
    .filter(Boolean)
    .map((domain) => domain.toLowerCase()))];
}

function recordOutboundSend({ surface, authorization, recipients = '', content = '', details = {}, dataDir, record } = {}) {
  // Test runs never write the live ledger; they pass an explicit dataDir.
  if (process.env.VITEST && !dataDir) return { recorded: false, reason: 'test-run' };
  try {
    const { recordCommsCycle } = require('./comms-surface-manifest.js');
    const contentSha256 = content ? crypto.createHash('sha256').update(String(content)).digest('hex') : '';
    return recordCommsCycle({
      surface,
      direction: 'out',
      count: 1,
      contentSha256,
      details: {
        authorization: String(authorization || 'none'),
        recipient_domains: recipientDomains(recipients),
        ...details,
      },
      dataDir,
      ...(record ? { record } : {}),
    });
  } catch (error) {
    return { recorded: false, reason: String(error?.message || error) };
  }
}

module.exports = { recordOutboundSend, recipientDomains };
