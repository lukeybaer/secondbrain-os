/**
 * 2026-05-24 Luke ask: "Full life data backup card looks like crap, use the
 * nicer format like health checks. Actually consolidate with health checks
 * so it's just one of them. And I can click into it to see detail."
 *
 * This contract test pins that ec2-server.js wires the consolidation. The
 * parser + merger pure functions have their own unit tests in
 * scripts/__tests__/parse-full-life-backup.test.js.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EC2 = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf-8');

describe('ec2-server FULL-LIFE DATA BACKUP / System Health consolidation', () => {
  it('routes FULL-LIFE DATA BACKUP sections through parseFullLifeBackupBody', () => {
    expect(EC2).toMatch(/parseSectionData\b[\s\S]{0,2000}FULL-LIFE DATA BACKUP[\s\S]{0,200}parseFullLifeBackupBody/);
  });

  it('loads the lib with both /opt and local fallback', () => {
    expect(EC2).toContain("require('/opt/secondbrain/scripts/lib/parse-full-life-backup.js')");
    expect(EC2).toContain("require('./scripts/lib/parse-full-life-backup.js')");
  });

  it('calls mergeFullLifeBackupIntoSystemHealth after parsing sections so the standalone life-backup tile is dropped', () => {
    expect(EC2).toContain('mergeFullLifeBackupIntoSystemHealth');
  });
});

describe('synthetic systemHealth blockers: dedup + red-only', () => {
  // 2026-05-24 Luke: dashboard showed "3 hard blockers" when the markdown
  // only had 1. The other two were dupes from buildDashboardSyntheticBlockers
  // promoting every non-green systemHealth item, including yellow rows
  // (e.g. a 79% Gmail backfill in progress) and rows already named by a
  // markdown blocker.
  it('only promotes RED systemHealth items to synthetic blockers (yellow stays as a chip)', () => {
    const blockRe = /if \(d\.kind === 'systemHealth'\)[\s\S]{0,1500}?if \(it\.status [^)]+\)/;
    const m = EC2.match(blockRe);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/it\.status !== 'red'/);
    expect(m![0]).not.toMatch(/it\.status === 'green'/);
  });

  it('skips synthetic blocker when a markdown blocker already names the same subsystem', () => {
    const blockRe = /if \(d\.kind === 'systemHealth'\)[\s\S]{0,1800}?const existingHaystack[\s\S]{0,1000}?continue;[\s\S]{0,500}?add\(\s*`System Health:/;
    expect(EC2).toMatch(blockRe);
    expect(EC2).toMatch(/existingHaystack\.includes\(itemNameLower\)/);
  });
});
