import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const indexSource = () => fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

describe('desktop light startup', () => {
  it('uses a plain app title instead of a git hash title', () => {
    const source = indexSource();

    expect(source).toContain(": 'SecondBrain'");
    expect(source).not.toContain('SecondBrain [${');
  });

  it('keeps WhatsApp auto-connect behind explicit full startup mode', () => {
    const source = indexSource();
    const lightStartupIndex = source.indexOf('SECONDBRAIN_LIGHT_STARTUP');
    const fullStartupIndex = source.indexOf('if (ENABLE_BACKGROUND_STARTUP)');
    const autoConnectIndex = source.indexOf('autoConnectIfSession().catch');

    expect(lightStartupIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain('const ENABLE_BACKGROUND_STARTUP = !ENABLE_LIGHT_STARTUP');
    expect(fullStartupIndex).toBeGreaterThanOrEqual(0);
    expect(autoConnectIndex).toBeGreaterThan(fullStartupIndex);
  });
});
