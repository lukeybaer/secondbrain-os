/**
 * File size regression guard (2026-04-26).
 *
 * Luke dispatch: "Where are the tests that make sure key files aren't blowing
 * up or shrinking down?"
 *
 * The fear: a runaway log write or an accidental copy-paste corrupts a
 * load-bearing file by 10x and nobody notices until the next briefing
 * silently drops sections. This test locks expected size envelopes for
 * every load-bearing file in the briefing/dashboard/memory pipeline.
 *
 * Rules:
 *   - bytes are measured against the on-disk file (LF and CRLF both count).
 *   - min/max defines the acceptable envelope. If the file legitimately
 *     grows or shrinks past the envelope, update both ends here in the
 *     same commit -- never widen one side without auditing what changed.
 *   - "soft cap" envelopes are 2x current size; "hard floor" is 0.6x
 *     current size. So if ec2-server.js is 340KB today, the test passes
 *     between ~204KB and ~680KB. A 10x balloon or a 0-byte truncation
 *     fails immediately.
 */

import { describe, it, expect } from 'vitest';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

interface FileEnvelope {
  path: string;
  minBytes: number;
  maxBytes: number;
  why: string;
}

// Each file's envelope = floor(0.6 * current) to ceil(2 * current). Recompute
// by running `wc -c <file>` and adjusting both ends if a deliberate change
// pushes outside. Non-deliberate drift inside the envelope is fine.
const ENVELOPES: FileEnvelope[] = [
  {
    path: 'ec2-server.js',
    // 2026-05-27: envelope widened from 200_000..700_000 to 480_000..1_500_000.
    // File grew to ~795KB legitimately: askAmyViaCodex + askAmyViaAnthropicAPI
    // (2026-05-23/25 brain fallback chain), LinkedIn empty-draft builder,
    // video-regen hard-block rendering, snack-dude retry, dashboard tile
    // surgical fixes. Floor still guards against accidental truncation.
    minBytes: 480_000,
    maxBytes: 1_500_000,
    why: 'Backend service for EC2 dashboard + dispatch + briefing endpoints',
  },
  {
    path: 'scripts/manual-briefing-v3.js',
    minBytes: 120_000,
    maxBytes: 420_000,
    why: 'Daily briefing generator (5:30 AM CT)',
  },
  {
    path: 'memory/MEMORY.md',
    minBytes: 8_000,
    maxBytes: 50_000,
    why: 'Tier 1 pointer file -- truncates at 200 lines / ~30KB',
  },
  {
    path: 'CLAUDE.md',
    minBytes: 3_000,
    maxBytes: 15_000,
    why: 'Project CLAUDE.md instructions',
  },
  {
    path: 'claude-config/CLAUDE.global.md',
    minBytes: 6_000,
    maxBytes: 25_000,
    why: 'Global CLAUDE.md instructions',
  },
  {
    path: 'data/briefing-action-items.json',
    minBytes: 200,
    maxBytes: 200_000,
    why: 'Briefing action items + open commitments',
  },
  {
    path: 'content-review/pending/manifest.json',
    minBytes: 200,
    maxBytes: 100_000,
    why: 'Video pipeline manifest',
  },
  {
    path: 'content-review/upload-queue.json',
    minBytes: 2,
    maxBytes: 50_000,
    why: 'Video upload queue',
  },
];

describe('file-size regression guard (key files cannot 10x or shrink to 0)', () => {
  for (const env of ENVELOPES) {
    it(`${env.path} stays within ${env.minBytes}-${env.maxBytes} bytes`, () => {
      const abs = join(REPO_ROOT, env.path);
      if (!existsSync(abs)) {
        // If the file genuinely shouldn't exist (e.g., briefing-action-items
        // hasn't been generated yet on a fresh checkout), skip.
        return;
      }
      const size = statSync(abs).size;
      expect(
        size,
        `${env.path} is ${size} bytes -- expected ${env.minBytes}..${env.maxBytes}. ${env.why}. ` +
          `If this is a deliberate change, update min/max in file-size-regression.test.ts in the same commit.`,
      ).toBeGreaterThanOrEqual(env.minBytes);
      expect(size).toBeLessThanOrEqual(env.maxBytes);
    });
  }
});
