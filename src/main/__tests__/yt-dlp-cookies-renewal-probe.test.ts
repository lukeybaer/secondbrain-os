/**
 * 2026-05-25: cookies for yt-dlp at /opt/secondbrain/.yt-dlp-cookies.txt
 * expire roughly every 60 days when YouTube rotates the session token.
 * The pre-briefing diagnostic needs a probe that surfaces a stale-cookies
 * warning before the file actually breaks the build pipeline.
 *
 * Probe contract:
 *   green  : cookies file exists and mtime is less than 55 days old
 *   yellow : 55 to 70 days old (re-export soon)
 *   red    : older than 70 days OR file missing entirely
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HEAL = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'health-self-heal.js'), 'utf8');
const DIAG = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'pre-briefing-diagnostic.js'), 'utf8');

describe('yt-dlp cookies renewal probe', () => {
  it('probeYtDlpCookies function is defined in health-self-heal.js', () => {
    expect(HEAL).toMatch(/function probeYtDlpCookies/);
  });

  it('probe reads the cookies-file mtime from the deployed path', () => {
    expect(HEAL).toContain('/opt/secondbrain/.yt-dlp-cookies.txt');
    expect(HEAL).toMatch(/probeYtDlpCookies[\s\S]{0,1500}fs\.statSync/);
  });

  it('probe uses 55/70 day thresholds for yellow/red bands', () => {
    expect(HEAL).toMatch(/probeYtDlpCookies[\s\S]{0,2500}\b55\b/);
    expect(HEAL).toMatch(/probeYtDlpCookies[\s\S]{0,2500}\b70\b/);
  });

  it('probeYtDlpCookies is exported from health-self-heal.js', () => {
    expect(HEAL).toMatch(/probeYtDlpCookies,/);
  });

  it('pre-briefing-diagnostic registers the cookies probe', () => {
    expect(DIAG).toContain('probeYtDlpCookies');
    expect(DIAG).toMatch(/\[\s*['"]ytdlpCookies['"]\s*,\s*probeYtDlpCookies\s*\]/);
  });
});
