import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TELEGRAM = path.resolve(__dirname, '..', 'telegram.ts');

describe('desktop Telegram raw-provider egress guard', () => {
  const source = fs.readFileSync(TELEGRAM, 'utf8');

  it('loads the shared provider-error matcher', () => {
    expect(source).toContain('../../scripts/lib/cli-output-guard.js');
    expect(source).toContain('function isRawProviderError');
  });

  it.each(['sendMessage', 'sendVideo', 'sendPhoto'])(
    '%s suppresses raw provider output before Telegram transport',
    (name) => {
      const start = source.indexOf(`export async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const next = source.indexOf('export async function ', start + 10);
      const body = source.slice(start, next === -1 ? source.length : next);
      expect(body).toContain('isRawProviderError(');
      expect(body.indexOf('isRawProviderError(')).toBeLessThan(body.indexOf('post'));
    },
  );
});
