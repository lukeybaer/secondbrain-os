#!/usr/bin/env node
'use strict';

const {
  detectApprovalOrigin,
  requestRemoteOwnerApproval,
} = require('./lib/owner-approval-client.js');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

async function main() {
  const description = arg('description');
  if (!description) throw new Error('--description is required');
  const origin = detectApprovalOrigin(process.env);
  const surface = arg('surface');
  const conversationId = arg('conversation-id');
  if (surface) origin.surface = surface;
  if (conversationId) origin.conversation_id = conversationId;
  const result = await requestRemoteOwnerApproval(
    {
      request_type: arg('request-type', 'share_pii'),
      description,
      data_category: arg('data-category'),
      origin,
    },
    {
      wait: !process.argv.includes('--no-wait'),
      maxWaitMs: Number(arg('wait-ms', 15 * 60 * 1000)),
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok || result.answer === 'denied') process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`[owner-approval] ${error.message}\n`);
  process.exitCode = 1;
});
