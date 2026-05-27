/**
 * pii-screen.spec.ts
 *
 * Replaces the old hardcoded-name-list tests (no-pii-in-source.test.ts +
 * public-sync-pii.spec.ts) with a single gate that:
 *
 *   1. Builds the public-sync payload (mirrors .github/workflows/sync-to-public.yml)
 *   2. Runs Layer 1 (auto-derived denylist) against the payload
 *   3. Asserts ZERO hits
 *
 * Layer 1 alone is the local hard gate — deterministic, fast, runs in <1s.
 * Layer 2 (Presidio NER) and Layer 3 (Claude Haiku semantic) run in CI as
 * additional gates because they need Python + claude CLI respectively.
 *
 * If this test fails: fix the source, do NOT add to allowlist. Names belong
 * in memory/, not in source code.
 */

import { describe, it, expect } from 'vitest';
import { buildPayload } from '../scripts/simulate-public-sync.js';
import { scan, loadDenylist } from '../scripts/pii-screen.js';
import * as fs from 'fs';

describe('PII screen gate (3-layer defense, Layer 1 local)', () => {
  // Building the payload + scanning takes ~10-20s standalone. Under parallel
  // load (full suite, 1200+ tests) it can stretch past the default 5s timeout.
  it('public-sync payload contains zero auto-derived PII tokens', { timeout: 60_000 }, () => {
    const payloadDir = buildPayload(true);
    try {
      const denylist = loadDenylist(false);
      const hits = scan(payloadDir, payloadDir, denylist.denylist);

      if (hits.length > 0) {
        const sample = hits.slice(0, 20).map(
          (h: any) => `  ${h.file}:${h.line} [${h.kind}=${h.match}] ${h.context}`
        ).join('\n');
        const msg =
          `PII leak into public-sync payload (${hits.length} hits).\n` +
          `Layer 1 (auto-derived denylist) flagged these. Fix the source — do NOT widen the allowlist.\n\n` +
          sample +
          (hits.length > 20 ? `\n  ... +${hits.length - 20} more` : '');
        expect(hits, msg).toEqual([]);
      }
    } finally {
      try {
        fs.rmSync(payloadDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
