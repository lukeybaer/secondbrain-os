/**
 * Regression guard — ec2-server.js deliverCommandResult must NOT dial ExampleCo
 * over Vapi when a dispatched command failed for infrastructure reasons
 * (ENOENT, ECONNREFUSED, claude CLI missing, etc.). Those errors end up
 * TTS'd as garbled voicemail ("Problem. Process error. SpawnClaud in
 * noent.") which trained ExampleCo to ignore Amy callbacks.
 *
 * Trigger: 2026-04-22 calls 019db830 + 019db840 (ExampleCo's phone rang twice
 * with the same spawn-error voicemail).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SRC = readFileSync(
  path.join(__dirname, '..', 'ec2-server.js'),
  'utf8',
);

describe('deliverCommandResult infrastructure-failure guard', () => {
  it('detects infrastructure failures from the result string', () => {
    // The guard must test for the common Node + shell error markers so no
    // future raw error escape surfaces on ExampleCo's voicemail.
    // Implementation uses inline `isInfra` variable with a regex test.
    expect(SRC).toMatch(/isInfra/);
    expect(SRC).toMatch(/claude cli \(not found\|could not start\)/);
    expect(SRC).toMatch(/ENOENT/);
    expect(SRC).toMatch(/ECONNREFUSED/);
    expect(SRC).toMatch(/spawn \\S\+ ENOENT/);
  });

  it('skips initiateVapiOutbound on infrastructure failures', () => {
    // Pattern: inside the isInfra branch we skip Vapi callback.
    const start = SRC.indexOf('isInfra');
    expect(start).toBeGreaterThan(0);
    const window = SRC.slice(start, start + 1500);
    expect(window).toMatch(/if \(isInfra\)/);
  });

  it('logs infrastructure failures to briefing-actions.jsonl for next briefing', () => {
    const start = SRC.indexOf('isInfra');
    const window = SRC.slice(start, start + 1500);
    expect(window).toMatch(/briefing-actions\.jsonl/);
    expect(window).toMatch(/dispatch_infra_failure/);
  });
});

describe('claude-runner.ts clean error message', () => {
  const RUNNER = readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'claude-runner.ts'),
    'utf8',
  );

  it('does not emit raw "Process error: spawn claude ENOENT" anymore', () => {
    // Legacy string that ended up on ExampleCo's voicemail. Must not survive.
    expect(RUNNER).not.toMatch(/Process error:\s*\$\{err\.message\}/);
  });

  it('maps ENOENT to a ExampleCo-safe message', () => {
    expect(RUNNER).toMatch(/ENOENT/);
    expect(RUNNER).toMatch(/Claude CLI not found/);
  });
});
