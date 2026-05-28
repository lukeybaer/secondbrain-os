/**
 * 2026-05-25 Path 1: bgutil-pot-provider Docker sidecar on EC2
 * (127.0.0.1:4416) mints PoTokens for yt-dlp. A stopped container or a
 * misconfigured port would silently turn viral-clip builds back into
 * 403s. probePotokenProvider hits the sidecar's /ping endpoint so a
 * stopped container surfaces as red in the briefing System Health card.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HEAL = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'health-self-heal.js'), 'utf8');
const DIAG = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'pre-briefing-diagnostic.js'), 'utf8');

describe('PoToken provider health probe', () => {
  it('probePotokenProvider is defined in health-self-heal.js', () => {
    expect(HEAL).toMatch(/function probePotokenProvider/);
  });

  it('probe hits the bgutil sidecar at 127.0.0.1:4416', () => {
    // The port literal lives in the POTOKEN_PROVIDER_URL constant above
    // the function; the function references the constant by name.
    expect(HEAL).toMatch(/POTOKEN_PROVIDER_URL\s*=[^;]*127\.0\.0\.1:4416/);
    expect(HEAL).toMatch(/probePotokenProvider[\s\S]{0,1500}POTOKEN_PROVIDER_URL/);
  });

  it('probe is platform-aware (Windows dev stays quiet)', () => {
    expect(HEAL).toMatch(/probePotokenProvider[\s\S]{0,1500}process\.platform === ['"]win32['"]/);
  });

  it('probePotokenProvider is exported', () => {
    expect(HEAL).toMatch(/probePotokenProvider,/);
  });

  it('pre-briefing-diagnostic registers the probe as potokenProvider', () => {
    expect(DIAG).toContain('probePotokenProvider');
    expect(DIAG).toMatch(/\[\s*['"]potokenProvider['"]\s*,\s*probePotokenProvider\s*\]/);
  });
});
