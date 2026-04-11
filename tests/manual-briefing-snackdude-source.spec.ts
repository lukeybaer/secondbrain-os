/**
 * Regression guard: the daily briefing script (scripts/manual-briefing-v3.js)
 * MUST query the Snack Dude PRODUCTION DynamoDB table, not the dev one.
 *
 * Context (2026-04-11): a briefing shipped saying Snack Dude had 0 invoices
 * in the last 24h / 72h / 7d while the production UI at
 * d2i5ku6m411t9h.cloudfront.net showed live invoices #4219 and #4220 the
 * prior evening. Root cause: the script scanned `snackdude-dev-invoices`
 * under the default AWS profile. The live data lives in `snackdude-invoices`
 * under the `snackdude` profile in us-east-2.
 *
 * This test is a pure string check on the script source so it runs fast,
 * requires no AWS credentials, and catches any future regression where the
 * dev table creeps back in.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js Snack Dude DynamoDB source', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('scans the prod snackdude-invoices table, not the dev one', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('snackdude'));
    expect(scanLine, 'no dynamodb scan line found in briefing script').toBeTruthy();
    expect(scanLine!).toContain('--table-name snackdude-invoices');
    expect(scanLine!).not.toContain('snackdude-dev-invoices');
  });

  it('uses the snackdude AWS profile for the scan', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('snackdude'))!;
    expect(scanLine).toContain('--profile snackdude');
  });

  it('targets us-east-2 region', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('snackdude'))!;
    expect(scanLine).toContain('--region us-east-2');
  });

  it('reports the prod source string in the briefing output', () => {
    expect(src).toContain(
      "source: 'snackdude-invoices DynamoDB table (us-east-2, snackdude profile)'",
    );
  });
});
