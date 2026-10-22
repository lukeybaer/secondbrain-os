#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { approveOutreach } = require('./lib/jev-control-plane.js');

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const result = await approveOutreach({
    recipientName: payload.recipient_name || payload.recipientName || '',
    recipientAddress: [payload.to, payload.cc, payload.bcc].filter(Boolean).join(','),
    message: payload.body || payload.message || '',
    context: payload.context || `Subject: ${payload.subject || ''}`,
    channel: payload.channel || 'email',
    purpose: payload.purpose || '',
  });
  process.stdout.write(`${JSON.stringify({ accepted: result.accepted, choice: result.choice, confidence: result.minProbability, threshold: result.threshold, reason: result.reason || null })}\n`);
  if (!result.accepted) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`Jev outreach approval failed closed: ${error.message || error}\n`);
  process.exitCode = 3;
});
