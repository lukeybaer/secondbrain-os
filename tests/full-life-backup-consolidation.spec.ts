/**
 * 2026-05-24 ExampleCo ask: "Full life data backup card looks like crap, use the
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

describe('systemHealth measurements never become synthetic Blockers rows', () => {
  // 2026-05-24 ExampleCo: the dashboard showed "3 hard blockers" when the markdown
  // had 1, because buildDashboardSyntheticBlockers promoted every non-green
  // systemHealth item. That was first narrowed to red-only plus a dedup against
  // markdown blockers (`existingHaystack`).
  //
  // 2026-07-21 (dd70ab32) went further and deleted the promotion entirely:
  // dev-plans/core/briefing.md invariants 4 and 9 now make each System Health
  // measurement a first-class work unit owned and counted ONLY on the System
  // Health card, so Blockers cannot double-count it at all. This pins that
  // stronger contract; the red-only/dedup guards it replaced are gone with the
  // branch they guarded.
  const builder = EC2.match(/function buildDashboardSyntheticBlockers\(sections\)[\s\S]*?\n}\n/);

  it('the synthetic-blocker builder states the never-synthesize rule', () => {
    expect(builder).not.toBeNull();
    expect(builder![0]).toContain(
      'System Health measurements are first-class work units on their own card.',
    );
    expect(builder![0]).toContain('Never synthesize them into the general Blockers list.');
  });

  it('has no systemHealth promotion branch and adds no "System Health: ..." row', () => {
    expect(builder![0]).not.toMatch(/d\.kind === 'systemHealth'/);
    expect(builder![0]).not.toMatch(/add\(\s*`System Health:/);
    // The red/blocked catch-all must not reintroduce it through the back door:
    // the System Health card is filtered out by the shared identity gate.
    expect(builder![0]).toContain('if (!isGeneralBlockerCard(cardIdentity)) continue;');
  });
});
