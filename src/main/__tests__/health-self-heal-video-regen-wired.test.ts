/**
 * Regression guard for Luke's 2026-04-29 followup dispatch:
 *   "you're not done until any rejected / stuck videos are regenerated --
 *    that should be part of the daily heal sequence."
 *
 * Before this fix healVideoFeedbackLoop() in scripts/health-self-heal.js
 * just sent a Telegram alert ("Cannot auto-regen videos -- requires build
 * pipeline on EC2"). The build pipeline existed (scripts/auto-regen-rejected-
 * videos.js), it just wasn't wired into the daily heal cycle. This test
 * locks the wiring so future refactors can't silently re-orphan it.
 *
 * Layer 1: source-text contract. Layer 2 (actual SCP/SSH) is not mockable in
 * unit tests; it's verified end-to-end when the heal cycle fires.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..', '..');
const HEALTH_HEAL = path.join(REPO, 'scripts', 'health-self-heal.js');
const REGEN_SCRIPT = path.join(REPO, 'scripts', 'auto-regen-rejected-videos.js');

describe("healVideoFeedbackLoop actually triggers regen (Luke 2026-04-29)", () => {
  const src = fs.readFileSync(HEALTH_HEAL, 'utf8');
  const fn = src.slice(src.indexOf('function healVideoFeedbackLoop'), src.indexOf('function healVideoFeedbackLoop') + 4000);

  it('the auto-regen script exists on disk', () => {
    expect(fs.existsSync(REGEN_SCRIPT)).toBe(true);
  });

  it('healVideoFeedbackLoop references auto-regen-rejected-videos.js', () => {
    expect(fn).toMatch(/auto-regen-rejected-videos\.js/);
  });

  it('healVideoFeedbackLoop actually invokes the script via execSync (not just an alert)', () => {
    // Must call execSync on the regenScript path. The previous version only
    // called sendTelegramAlert and returned healed:false.
    expect(fn).toMatch(/execSync\(`?node /);
    expect(fn).toMatch(/regenScript/);
  });

  it('healVideoFeedbackLoop reports healed:true when no stuck videos (idempotent)', () => {
    expect(fn).toMatch(/stuckCount === 0[\s\S]{0,200}healed:\s*true/);
  });

  it('healVideoFeedbackLoop reports healed:true when regen succeeds', () => {
    // The success branch must return healed:true so the next probe goes
    // green and the briefing reflects the actual queue clearing.
    expect(fn).toMatch(/healed:\s*true,\s*\n\s*action:\s*'ran auto-regen-rejected-videos\.js'/);
  });

  it('healVideoFeedbackLoop surfaces failures with errorinfo (no silent swallow)', () => {
    expect(fn).toMatch(/healed:\s*false,\s*\n\s*action:\s*'ran auto-regen-rejected-videos\.js \(failed\)'/);
    expect(fn).toMatch(/sendTelegramAlert\(`\[Amy Health\] auto-regen failed/);
  });
});
