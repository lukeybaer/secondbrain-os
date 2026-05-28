/**
 * Regression test for probeBranchDivergence in scripts/health-self-heal.js.
 *
 * The probe is the health check for a stray branch becoming the de-facto main
 * while master goes stale, the exact 659-commit nightly-enhancement vs master
 * split. It shells out to git against the real repo, so this test asserts the
 * probe contract (shape, valid status, structured fields) rather than mocking
 * git. The probe is run once and reused. The briefing wiring
 * (h.branchdivergence) is separately locked by briefing-sections-lock via
 * REQUIRED_HEALTH_REFS.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';

const require = createRequire(import.meta.url);

describe('probeBranchDivergence', () => {
  const hsh = require(path.resolve(__dirname, '../../../scripts/health-self-heal.js'));
  let result: Record<string, unknown>;

  beforeAll(() => {
    expect(typeof hsh.probeBranchDivergence).toBe('function');
    result = hsh.probeBranchDivergence();
  }, 30000);

  it('returns a valid health probe result', () => {
    expect(result).toBeTypeOf('object');
    expect(['green', 'yellow', 'red']).toContain(result.status);
    expect(typeof result.detail).toBe('string');
    expect((result.detail as string).length).toBeGreaterThan(0);
  });

  it('reports structured divergence fields when the probe itself ran', () => {
    if ((result.detail as string).startsWith('branch-divergence probe failed')) return;
    expect(typeof result.onBranch).toBe('string');
    expect(Array.isArray(result.strayBranches)).toBe(true);
    expect(typeof result.masterBehindOrigin).toBe('number');
    expect(typeof result.dirtySource).toBe('number');
  });

  it('goes red when a branch is far enough ahead to be a de-facto trunk', () => {
    const stray = (result.strayBranches as unknown[]) || [];
    if (stray.length > 0) {
      expect(result.status).toBe('red');
    }
  });
});
