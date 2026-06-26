/**
 * ExampleCo 2026-06-03 (live dashboard): "This videos I can't reject for no reason."
 * Rejecting a thumbnail or video MUST require a reason, and that reason MUST
 * reach the auto-regen pipeline so Amy regenerates a fix addressing it. This is
 * already implemented; this test PINS the contract so it cannot silently
 * regress on a refactor (the encoding-so-it-self-heals requirement).
 *
 * Category, not literal trigger: both reject endpoints refuse an empty reason
 * BEFORE mutating the manifest, and the field they write is the field
 * auto-regen-rejected-videos.js consumes. A rename on either side fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const server = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');
const autoRegen = fs.readFileSync(
  path.join(REPO, 'scripts', 'auto-regen-rejected-videos.js'),
  'utf8',
);

// Extract the body of a POST handler block so we can assert ordering within it.
function handlerBlock(src: string, route: string): string {
  const start = src.indexOf(`urlPath === '${route}' && req.method === 'POST'`);
  expect(start, `${route} handler must exist`).toBeGreaterThan(-1);
  // Grab a generous window; the guard + manifest write are within ~60 lines.
  return src.slice(start, start + 3500);
}

describe('video/thumbnail reject requires a reason that reaches auto-regen', () => {
  for (const { route, field } of [
    { route: '/briefing/reject-video', field: 'video_rejection_note' },
    { route: '/briefing/reject-thumbnail', field: 'thumbnail_rejection_note' },
  ]) {
    const block = handlerBlock(server, route);

    it(`${route} refuses an empty reason with 400 BEFORE writing the manifest`, () => {
      const guardIdx = block.search(/if \(!note\)[\s\S]*?\b400\b/);
      const writeIdx = block.indexOf(`${field} = note`);
      expect(guardIdx, `${route} must 400 on empty note`).toBeGreaterThan(-1);
      expect(writeIdx, `${route} must write ${field}`).toBeGreaterThan(-1);
      // The empty-note guard must come BEFORE the manifest mutation, so an
      // empty reason never changes state.
      expect(guardIdx).toBeLessThan(writeIdx);
    });

    it(`${route} writes ${field}, the exact field auto-regen consumes`, () => {
      expect(block).toContain(`${field} = note`);
      expect(autoRegen, `auto-regen must read ${field}`).toContain(field);
    });
  }

  it('the client reject handlers bail when the reason prompt is empty', () => {
    // Both client branches prompt for a reason and early-return on empty, so a
    // dismissed/empty prompt never POSTs a reasonless reject.
    for (const action of ['reject-video', 'reject-thumbnail']) {
      const idx = server.indexOf(`action === '${action}'`);
      expect(idx, `client handler for ${action}`).toBeGreaterThan(-1);
      const branch = server.slice(idx, idx + 900);
      expect(branch).toMatch(/prompt\(/);
      expect(branch).toMatch(/if \(!note\)/);
    }
  });
});
