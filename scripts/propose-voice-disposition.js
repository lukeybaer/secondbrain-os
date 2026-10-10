#!/usr/bin/env node
'use strict';

const { writeVoiceDispositionSuggestion } = require('./lib/voice-disposition-suggestions');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

function main() {
  const result = writeVoiceDispositionSuggestion({
    acousticId: arg('id'),
    disposition: arg('disposition'),
    ownerRequestText: arg('owner-request-text'),
    reason: arg('reason'),
    membershipFingerprint: arg('membership-fingerprint'),
  });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        id: result.row.acoustic_unknown_id,
        disposition: result.row.disposition,
        status: result.row.status,
        requires_owner_confirmation: true,
        suppresses_queue: false,
      },
      null,
      2,
    ) + '\n',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`voice disposition proposal failed: ${error.message}\n`);
    process.exit(1);
  }
}
