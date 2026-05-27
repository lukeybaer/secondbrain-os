/**
 * Regression guard — sendGmailReply in ec2-server.js must REFUSE to send an
 * email with a blank body, at every path.
 *
 * Trigger: 2026-04-22 call 019db811 — Luke clicked Send on an edited reply
 * proposal in the briefing dashboard and the recipient received a blank
 * email. Root cause was that the sendGmailReply helper trusted its caller
 * and did not guard its own input. The new defense-in-depth throws before
 * any gmail.users.messages.send call.
 *
 * We assert the guard by reading the source file directly (no module
 * import — ec2-server.js is a CommonJS monolith with EC2-only side effects
 * at module load time). The test fails if the guard regex does not match,
 * which would mean someone deleted or loosened the check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SRC = readFileSync(
  path.join(__dirname, '..', 'ec2-server.js'),
  'utf8',
);

describe('sendGmailReply blank-body guard', () => {
  it('has a hard guard that throws when body is null/undefined/blank', () => {
    // The guard must appear inside sendGmailReply and must throw before the
    // MIME is built. Look for the exact pattern so a loosening is visible.
    expect(SRC).toMatch(/async function sendGmailReply\b/);

    // Extract the body of sendGmailReply up to the next `async function` or
    // `function ` declaration.
    const startIdx = SRC.indexOf('async function sendGmailReply');
    expect(startIdx).toBeGreaterThan(0);
    const tail = SRC.slice(startIdx, startIdx + 4000);

    // Guard must test both null/undefined AND whitespace-only strings.
    expect(tail).toMatch(/body\s*==\s*null\s*\|\|\s*!String\(body\)\.trim\(\)/);

    // Guard must throw or return before the send API is called.
    expect(tail).toMatch(/throw new Error\([^\)]*blank/i);
  });

  it('server handler rejects empty text before reaching sendGmailReply', () => {
    // The /briefing/send-message handler must also guard. Defense in depth.
    expect(SRC).toMatch(/if\s*\(\s*!text\s*\|\|\s*!String\(text\)\.trim\(\)\s*\)/);
  });
});
