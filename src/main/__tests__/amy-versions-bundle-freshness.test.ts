// Bundle-freshness guard: source-only tests pass while the running Electron
// process loads a stale out/main/index.js. This bit ExampleCo twice — PRIVATE_NAME call
// 2026-04-27 and Bob call 2026-04-29 — both showed Amy reading old prompt
// strings even though source had the fix. See:
//   memory/feedback_amy_outbound_must_drive_call.md
//   memory/feedback_verify_deployed_file_not_source.md
//
// Rule: every load-bearing prompt string must be asserted against the compiled
// bundle, not just the source. If this test fails with "bundle stale", run
// `npm run build` and commit the rebuild before pushing.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'out', 'main', 'index.js');
const SRC_AMY = path.join(REPO_ROOT, 'src', 'main', 'amy-versions.ts');

describe('amy-versions compiled bundle (out/main/index.js)', () => {
  it('bundle exists — run `npm run build` if missing', () => {
    expect(fs.existsSync(BUNDLE)).toBe(true);
  });

  it('bundle is at least as fresh as src/main/amy-versions.ts — run `npm run build` if stale', () => {
    const bundleMtime = fs.statSync(BUNDLE).mtimeMs;
    const srcMtime = fs.statSync(SRC_AMY).mtimeMs;
    expect(
      bundleMtime,
      `out/main/index.js (${new Date(bundleMtime).toISOString()}) is older than src/main/amy-versions.ts (${new Date(srcMtime).toISOString()}). Run \`npm run build\` and commit before pushing.`,
    ).toBeGreaterThanOrEqual(srcMtime);
  });

  describe('outbound call direction guards (must survive into compiled bundle)', () => {
    let bundle: string;
    beforeAll(() => {
      bundle = fs.readFileSync(BUNDLE, 'utf-8');
    });

    it('contains the "MAKING this call" outbound annotation', () => {
      expect(bundle).toContain('MAKING this call');
    });

    it('contains the "RECEIVING this call" inbound annotation', () => {
      expect(bundle).toContain('RECEIVING this call');
    });

    it('forbids the "How can I help you" receptionist greeting in outbound prompt', () => {
      expect(bundle).toContain('NEVER greet with');
      expect(bundle).toContain('How can I help you');
    });

    it('outbound firstMessage primer "Hi." is present so Amy speaks first', () => {
      expect(bundle).toMatch(/firstMessage\s*:\s*["']Hi\.["']/);
    });
  });
});

import { beforeAll } from 'vitest';
