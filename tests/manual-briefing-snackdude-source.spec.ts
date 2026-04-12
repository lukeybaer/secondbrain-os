/**
 * Regression guard: the daily briefing script (scripts/manual-briefing-v3.js)
 * MUST query the ProjectC PRODUCTION DynamoDB table, not the dev one.
 *
 * Context (2026-04-11): a briefing shipped saying ProjectC had 0 invoices
 * in the last 24h / 72h / 7d while the production UI at
 * d2i5ku6m411t9h.cloudfront.net showed live invoices #4219 and #4220 the
 * prior evening. Root cause: the script scanned `projectc-dev-invoices`
 * under the default AWS profile. The live data lives in `projectc-invoices`
 * under the `projectc` profile in us-east-2.
 *
 * This test is a pure string check on the script source so it runs fast,
 * requires no AWS credentials, and catches any future regression where the
 * dev table creeps back in.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js ProjectC DynamoDB source', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('scans the prod projectc-invoices table, not the dev one', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('projectc'));
    expect(scanLine, 'no dynamodb scan line found in briefing script').toBeTruthy();
    expect(scanLine!).toContain('--table-name projectc-invoices');
    expect(scanLine!).not.toContain('projectc-dev-invoices');
  });

  it('uses the projectc AWS profile for the scan', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('projectc'))!;
    expect(scanLine).toContain('--profile projectc');
  });

  it('targets us-east-2 region', () => {
    const scanLine = src
      .split('\n')
      .find((l) => l.includes('aws dynamodb scan') && l.includes('projectc'))!;
    expect(scanLine).toContain('--region us-east-2');
  });

  it('reports the prod source string in the briefing output', () => {
    expect(src).toContain(
      "source: 'projectc-invoices DynamoDB table (us-east-2, projectc profile)'",
    );
  });
});
