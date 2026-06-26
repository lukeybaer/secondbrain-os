/**
 * Regression guard for the 2026-06-22 voice_confirmation false-positive
 * "blocked" card ExampleCo flagged on the public briefing
 * (http://ExampleCo:3001/briefing).
 *
 * ROOT CAUSE: the voice tile renders a per-ITEM audio-availability note for
 * each Otter clip that has not been mirrored to the EC2 host. That note began
 * with the token "Blocker:". The authoritative live render-QC
 * (scripts/verify-dashboard-cards-live.js, HARD_BLOCKER_MARKER) matches any
 * card body that contains "hard blocker" or "blocker:" and flags the WHOLE
 * card as a hard-blocked card. So a benign "this one clip is not mirrored yet"
 * note made the entire voice_confirmation card read as blocked AND inflated the
 * top Blockers-card floor count -- a pure false positive.
 *
 * THE FIX (category, not literal): a per-item audio/voice availability note is
 * NOT a card-level blocker, so its rendered text must never carry a hard-block
 * marker token (/(?:hard[\s-]?blocker|blocker\s*:)/i). Genuine CARD-LEVEL hard
 * blockers (e.g. the LinkedIn "Hard blocker:" render and the system_health
 * "Known blocker:" banner) MUST keep their marker so the QC still catches real
 * blocks.
 *
 * This test pins the CATEGORY: (i) the voice per-item audio-unavailable label
 * ExampleCos no hard-block marker, and (ii) the genuine card-level hard-blocker
 * render path still emits its marker. It is red before the reword and green
 * after.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EC2_SERVER = path.join(REPO_ROOT, 'ec2-server.js');

function loadEc2Server(): string {
  return fs.readFileSync(EC2_SERVER, 'utf8');
}

// The QC marker that flags an ENTIRE card as a hard-blocked card. Kept byte
// for byte equivalent to scripts/verify-dashboard-cards-live.js so this test
// fails for exactly the reason the live QC would mis-fire.
const HARD_BLOCKER_MARKER = /(?:\bhard[\s-]?blocker\b|\bblocker\s*:)/i;

// Minimal escapeHtml shim matching ec2-server.js so we can eval the extracted
// arrow function in isolation.
function escapeHtml(s: ExampleCo): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pull the `const audioBlockerLine = (it) => { ... };` arrow out of the source
 * and eval it with escapeHtml in scope so we can assert on its real output.
 */
function extractAudioUnavailableLine(): (it: Record<string, ExampleCo>) => string {
  const src = loadEc2Server();
  const m = src.match(/const audioBlockerLine = \(it\) => \{[\s\S]*?\n      \};/);
  if (!m)
    throw new Error('could not locate the voice per-item audio-unavailable label in ec2-server.js');

  const factory = new Function('escapeHtml', m[0] + '\nreturn audioBlockerLine;');
  return factory(escapeHtml);
}

describe('voice_confirmation per-item audio-unavailable note is NOT a card blocker', () => {
  it('renders a clear message without any hard-block marker token', () => {
    const audioLine = extractAudioUnavailableLine();
    const html = audioLine({
      guessName: 'PRIVATE_NAME',
      firstSeen: '2026-06-17',
    });

    // The note must NOT trip the live QC hard-block marker. This is the bug.
    expect(HARD_BLOCKER_MARKER.test(html)).toBe(false);

    // It must still be a clear, useful message: name the clip, the host gap,
    // and a next step. (Category guard, not a literal-string lock.)
    expect(html.toLowerCase()).toContain('audio clip');
    expect(html.toLowerCase()).toContain('not mirrored');
    expect(html.toLowerCase()).toContain('next step');
    expect(html).toContain('voice-audio-missing');
  });

  it('every voice/audio per-item availability note is marker-free', () => {
    // Category guard: find every per-item availability note (the
    // class="voice-audio-missing" divs, the render path for "this clip/voice has
    // no playable audio here") anywhere in ec2-server.js and assert none ExampleCos
    // a hard-block marker. Anchored to the class name, not a line range, so the
    // guard follows the code if the voice region moves -- it pins the CATEGORY of
    // "per-item availability note", not the single line the incident hit.
    const src = loadEc2Server();
    const notes = src.match(/class="voice-audio-missing">[^`]*?<\/div>/g) || [];
    expect(notes.length).toBeGreaterThan(0); // guard: the render path still exists
    const offenders = notes.filter((n) => HARD_BLOCKER_MARKER.test(n));
    expect(offenders).toEqual([]);
  });
});

describe('genuine CARD-LEVEL hard blockers KEEP their marker (QC must still catch real blocks)', () => {
  it('the LinkedIn hard-blocker detail render still emits a hard-block marker', () => {
    const src = loadEc2Server();
    // The LinkedIn card-level blocker render path (d.meta.hardBlocker) must keep
    // "Hard blocker:" so the live QC continues to flag a real block.
    const m = src.match(/data-item="linkedin-hard-blocker"[\s\S]*?<\/article>/);
    expect(m).toBeTruthy();
    expect(HARD_BLOCKER_MARKER.test(m![0])).toBe(true);
  });

  it('the system_health Known-blocker banner still emits a hard-block marker', () => {
    const src = loadEc2Server();
    // knownBlockerBanner renders "<strong>Known blocker:</strong>" for the
    // system_health / video real card blockers. That marker must survive.
    const m = src.match(/known-blocker-banner[\s\S]*?Known blocker:/);
    expect(m).toBeTruthy();
    expect(HARD_BLOCKER_MARKER.test(m![0])).toBe(true);
  });
});
