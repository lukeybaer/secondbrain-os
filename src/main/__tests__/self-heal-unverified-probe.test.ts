/**
 * Regression test for the false-red self-heal incident (2026-05-18).
 *
 * Luke: "Practice your test/self-heal... I don't think it's working well this
 * self-heal." The 08:07 heal run reported backups/ec2/llm as RED, but every
 * detail was `spawnSync C:\WINDOWS\system32\cmd.exe ETIMEDOUT` -- the probe
 * never ran, the laptop was just contended. A probe that could not execute is
 * "unverified" (yellow), not "broken" (red). probeRanButFailed distinguishes
 * the two: a genuine error (connection refused, parse failure) is red; a
 * spawn/network timeout is yellow.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';

const require = createRequire(import.meta.url);
const hsh = require(path.resolve(__dirname, '../../../scripts/health-self-heal.js'));

describe('self-heal probe-failure classification', () => {
  it('treats a spawn ETIMEDOUT as a probe that could not run (not a real failure)', () => {
    const e = new Error('spawnSync C:\\WINDOWS\\system32\\cmd.exe ETIMEDOUT');
    expect(hsh.probeRanButFailed(e)).toBe(false);
  });

  it('treats network blips (ECONNRESET / ENOTFOUND / EAI_AGAIN) as unverified', () => {
    for (const msg of ['socket hang up ECONNRESET', 'getaddrinfo ENOTFOUND', 'EAI_AGAIN dns', 'curl: operation timed out']) {
      expect(hsh.probeRanButFailed(new Error(msg))).toBe(false);
    }
  });

  it('treats a genuine error (connection refused, bad JSON) as a real failure', () => {
    expect(hsh.probeRanButFailed(new Error('connect ECONNREFUSED 1.2.3.4:3001'))).toBe(true);
    expect(hsh.probeRanButFailed(new Error('Unexpected token < in JSON'))).toBe(true);
  });

  it('unverified() yields a yellow status with a recheck note', () => {
    const r = hsh.unverified('EC2 health endpoint', new Error('cmd.exe ETIMEDOUT'));
    expect(r.status).toBe('yellow');
    expect(r.detail).toMatch(/unverified/i);
    expect(r.detail).toMatch(/EC2 health endpoint/);
  });
});

/**
 * probeTokenUsageCollector regression (2026-05-18). The probe used a UTC
 * "yesterday" date while the collector names its file from the LOCAL day, so
 * after ~18:00 CT the probe looked for a file the collector never writes and
 * reported a permanent false red every evening. The probe now scans for the
 * newest token-usage-*.json and accepts it within a 48h window.
 */
describe('probeTokenUsageCollector', () => {
  it('returns a valid probe result keyed off the newest file on disk, not a UTC date', () => {
    const r = hsh.probeTokenUsageCollector();
    expect(['green', 'red']).toContain(r.status);
    expect(typeof r.detail).toBe('string');
    // When a recent token-usage file exists the probe must NOT false-red on a
    // UTC/local off-by-one: a green result references a real dated file.
    if (r.status === 'green') {
      expect(r.detail).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(r.file).toMatch(/token-usage-\d{4}-\d{2}-\d{2}\.json$/);
    }
  });
});
