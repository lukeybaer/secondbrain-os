/**
 * Luke 2026-04-29 dispatch (second pass):
 *   "Last refresh 69h ago, that should be a failed test, why are you saying
 *    you're done when this LinkedIn reputation scan isn't done."
 *
 * The reputation scan source for LinkedIn DMs lives at
 * %APPDATA%/secondbrain/data/agent/linkedin-dms.json with a `lastCrawl`
 * timestamp. If the crawler hasn't run in > 36h, the briefing renders a
 * red ✗ on the reputation tile but no test fails -- so "all tests green"
 * gives a false sense of completeness.
 *
 * This test asserts the crawl is fresh. Failing means the LinkedIn DM
 * scraper has not run within the freshness window. Remediation:
 *   - First time: `scripts/linkedin-bulk-scan-login.cmd` (interactive login)
 *   - Subsequent: `node scripts/linkedin-dm-scan.js` (uses persistent profile)
 *   - Schedule: add a daily cron at the OS scheduler so it self-heals.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const FRESHNESS_HOURS = 36;

function dmPath(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'agent', 'linkedin-dms.json');
}

describe("LinkedIn DM crawl freshness gate (Luke 2026-04-29)", () => {
  it("linkedin-dms.json exists (scan has been run at least once)", () => {
    const p = dmPath();
    expect(
      fs.existsSync(p),
      `linkedin-dms.json missing at ${p}. Run scripts/linkedin-bulk-scan-login.cmd once to seed the persistent profile, then schedule scripts/linkedin-dm-scan.js daily.`
    ).toBe(true);
  });

  it(`linkedin-dms.json lastCrawl is within ${FRESHNESS_HOURS}h`, () => {
    const p = dmPath();
    if (!fs.existsSync(p)) return; // first test handles missing
    const dm = JSON.parse(fs.readFileSync(p, 'utf8'));
    const lastCrawl = dm.lastCrawl;
    expect(lastCrawl, "linkedin-dms.json has no lastCrawl field").toBeTruthy();
    const ageHr = (Date.now() - new Date(lastCrawl).getTime()) / 3600000;
    expect(
      ageHr,
      `LinkedIn DM crawl is stale: last refresh ${ageHr.toFixed(1)}h ago, threshold ${FRESHNESS_HOURS}h. ` +
      `Run \`node scripts/linkedin-dm-scan.js\` (persistent Chromium profile must be logged in). ` +
      `Until this test passes, the morning briefing's LinkedIn reputation source is stale -- the "all green" claim is incomplete.`
    ).toBeLessThan(FRESHNESS_HOURS);
  });
});
