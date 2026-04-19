// Locks in the 2026-04-18 #gap fix: health-self-heal's s3Parity heal must not
// report healed:true unless the orphan count actually decreased. Prior bug:
// execSync returned 0 (because --sync-orphaned silently skipped an
// unrecoverable orphan), heal claimed success, and the briefing stayed red
// for 5 consecutive days while reporting "healed nightly".

import { describe, it, expect } from 'vitest';

// health-self-heal.js is CommonJS; pull via require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideS3ParityHealStatus } = require('../scripts/health-self-heal.js');

describe('decideS3ParityHealStatus', () => {
  it('reports healed:true when the orphan count decreased', () => {
    const r = decideS3ParityHealStatus({
      beforeCount: 3,
      afterCount: 1,
      execFailed: false,
      execErr: '',
      rawOutput: 'Orphan sync complete: 2 uploaded, 0 pruned unrecoverable, 0 failed.',
      durSec: 120,
    });
    expect(r.healed).toBe(true);
    expect(r.orphansBefore).toBe(3);
    expect(r.orphansAfter).toBe(1);
    expect(r.error).toBeUndefined();
  });

  it('reports healed:false when orphan count is unchanged even if exec reported success (THE BUG)', () => {
    const r = decideS3ParityHealStatus({
      beforeCount: 1,
      afterCount: 1,
      execFailed: false,
      execErr: '',
      rawOutput: 'Orphan sync complete: 0 uploaded, 0 pruned unrecoverable, 0 failed.',
      durSec: 48,
    });
    expect(r.healed).toBe(false);
    expect(r.orphansBefore).toBe(1);
    expect(r.orphansAfter).toBe(1);
    expect(r.error).toMatch(/orphan count unchanged|stuck orphan|silent skip/);
  });

  it('reports healed:false when exec itself failed', () => {
    const r = decideS3ParityHealStatus({
      beforeCount: 2,
      afterCount: 2,
      execFailed: true,
      execErr: 'ts-node: command not found',
      rawOutput: '',
      durSec: 3,
    });
    expect(r.healed).toBe(false);
    expect(r.error).toContain('ts-node');
  });

  it('reports healed:false when orphan count increased (never a heal)', () => {
    const r = decideS3ParityHealStatus({
      beforeCount: 1,
      afterCount: 2,
      execFailed: false,
      execErr: '',
      rawOutput: '',
      durSec: 40,
    });
    expect(r.healed).toBe(false);
  });

  it('captures outputTail for postmortem diagnosis when heal fails', () => {
    const longOutput = 'x'.repeat(1000) + 'IMPORTANT_TAIL_MARKER';
    const r = decideS3ParityHealStatus({
      beforeCount: 1,
      afterCount: 1,
      execFailed: false,
      execErr: '',
      rawOutput: longOutput,
      durSec: 50,
    });
    expect(r.healed).toBe(false);
    expect(r.outputTail).toContain('IMPORTANT_TAIL_MARKER');
    expect(r.outputTail.length).toBeLessThanOrEqual(600);
  });
});
