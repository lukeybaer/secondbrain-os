// self-health-digest-autonomy-fold.test.ts
//
// Regression test for wiring the otherwise-orphaned per-run autonomy rollup
// into the self-health digest. Encodes the category (loop-trace path present =>
// autonomy tier folded; failed runs become warnings + reach the headline;
// run-less base records sharing the file are ignored; absent/empty file leaves
// the fold null), not one literal trigger. Per feedback_frugal_regression_tests.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSelfHealthDigest, persistSelfHealthDigest } from '../self-health-digest';

const srcDir = path.join(__dirname, '..');

function loopRec(over: Record<string, ExampleCo>): string {
  return JSON.stringify({
    timestamp: '2026-06-21T00:00:00Z',
    tool: 'lookup',
    duration_ms: 10,
    success: true,
    input_size: 0,
    output_size: 0,
    span_id: 'sp_x',
    parent_step: 1,
    side_effects: 'read',
    ...over,
  });
}

describe('self-health digest autonomy fold', () => {
  it('leaves autonomy null when no loop-trace path is supplied', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' });
    expect(digest.autonomy).toBeNull();
    expect(digest.autonomyLine).toBeNull();
  });

  it('folds run summaries and turns a failed run into a warning + headline line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-auto-'));
    const traceFile = path.join(dir, 'tool-trace.jsonl');
    try {
      fs.writeFileSync(
        traceFile,
        [
          // A base record sharing the sink (no run_id): must be ignored.
          JSON.stringify({ timestamp: 't', tool: 'ipc:x', duration_ms: 1, success: true }),
          // A clean run.
          loopRec({ run_id: 'run_ok', tool: 'lookup', success: true, side_effects: 'read' }),
          // A run with a failure.
          loopRec({ run_id: 'run_bad', tool: 'send', success: false, side_effects: 'write' }),
        ].join('\n') + '\n',
      );

      const digest = buildSelfHealthDigest({
        srcDir,
        indexContent: 'tiny',
        loopTracePath: traceFile,
      });

      expect(digest.autonomy).not.toBeNull();
      // Only the two real runs counted; the run-less base record dropped.
      expect(digest.autonomy!.tier3.total_runs).toBe(2);
      expect(digest.autonomy!.tier3.total_failures).toBe(1);
      expect(digest.autonomy!.all_clear).toBe(false);
      // The failed run drives a warning and the autonomy line is in the headline.
      expect(digest.warnings.some((w) => w.includes('run_bad'))).toBe(true);
      expect(digest.autonomyLine).toBe(digest.autonomy!.tier1);
      expect(digest.headline).toContain(digest.autonomy!.tier1);

      // Persisted artifact ExampleCos the autonomy block the briefing reads.
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-auto-out-'));
      const p = persistSelfHealthDigest(outDir, digest, '2026-06-21T08:00:00Z');
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(parsed.autonomy.total_runs).toBe(2);
      expect(parsed.autonomy.total_failures).toBe(1);
      fs.rmSync(outDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
