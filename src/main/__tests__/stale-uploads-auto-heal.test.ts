/**
 * Regression test for 2026-04-20 gap: 3 approved videos sat in
 * content-review/upload-queue.json for 18-19 days because:
 *   1. empire:approveVideo only wrote the local JSON, never pushed to EC2
 *   2. healStaleUploads sent a Telegram alert but did NOT push videos
 *   3. pre-briefing-diagnostic marked staleUploads as canAutoHeal: false
 *   4. ec2-server.js youtubeUploadQueue was in-memory and lost on restart
 *
 * This test locks in the mechanical fixes so the failure class cannot recur.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const REPO = path.resolve(__dirname, '..', '..', '..');

describe('stale-uploads auto-heal regression', () => {
  it('healStaleUploads is exported from health-self-heal.js', () => {
    const mod = require(path.join(REPO, 'scripts', 'health-self-heal.js'));
    expect(typeof mod.healStaleUploads).toBe('function');
  });

  it('pre-briefing-diagnostic marks staleUploads as auto-healable', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'scripts', 'pre-briefing-diagnostic.js'),
      'utf8',
    );
    // Must have an uncommented `staleUploads: true` entry in the healable map
    const match = src.match(/^\s*staleUploads:\s*true/m);
    expect(match).toBeTruthy();
  });

  it('healStaleUploads actually pushes to EC2, not just alerts', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'scripts', 'health-self-heal.js'),
      'utf8',
    );
    // The fixed healer must invoke scp + POST /youtube/queue
    expect(src).toMatch(/function healStaleUploads/);
    // Extract the healStaleUploads function body
    const fnStart = src.indexOf('function healStaleUploads');
    expect(fnStart).toBeGreaterThan(-1);
    // Grab a generous window (the healer is ~100 lines)
    const fnBody = src.slice(fnStart, fnStart + 6000);
    expect(fnBody).toMatch(/scp /);
    expect(fnBody).toMatch(/\/youtube\/queue/);
    // Must not be the old "only alert" implementation
    expect(fnBody).not.toMatch(/healed:\s*false,\s*\n\s*action:\s*'sent Telegram alert for stale uploads'/);
  });

  it('ec2-server.js persists the youtube upload queue to disk', () => {
    const src = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');
    // Queue must be loaded from disk, not `const youtubeUploadQueue = []`
    expect(src).toMatch(/loadPersistedYoutubeQueue/);
    expect(src).toMatch(/persistYoutubeQueue/);
    // Every shift / push should be followed by a persist call. Grep for the
    // pattern to ensure the mutations near markFired + Queued: are persisted.
    const slotMatch = src.match(/youtubeUploadQueue\.shift\([^)]*\);[^}]*persistYoutubeQueue\(\)/s);
    expect(slotMatch).toBeTruthy();
  });

  it('ec2-server.js dedupes on re-push so healer retries are idempotent', () => {
    const src = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');
    // Must have an existing-id check in the POST /youtube/queue handler
    expect(src).toMatch(/findIndex\s*\(\s*\(\s*q\s*\)\s*=>\s*q\.id === body\.id/);
  });

  it('empire:approveVideo auto-pushes to EC2 (closes the 18-day stall gap)', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'src', 'main', 'ipc-handlers.ts'),
      'utf8',
    );
    // Find the approveVideo handler
    const start = src.indexOf("ipcMain.handle('empire:approveVideo'");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);
    // Must invoke the helper that SCPs + POSTs to /youtube/queue
    expect(body).toMatch(/pushVideoToEc2/);
  });
});
