/**
 * Wiring-regression guard (nightly run 109).
 *
 * Nightly run 107 found 71 of 148 src/main modules orphaned (green tests, no
 * runtime importer) and then shipped THREE MORE orphans. The fix was to make
 * startup-checks.runStartupChecks() actually invoke the self-health audit at
 * every boot. This test locks that wiring so a future refactor cannot silently
 * re-orphan the audit modules.
 *
 * Source-text contract (Layer 1). The actual boot-time invocation is exercised
 * end to end when Electron starts; the runSelfHealthAudit body cannot be run in
 * a unit test because it depends on app.getAppPath() / app.getPath('userData').
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MAIN = path.join(__dirname, '..');
const STARTUP = fs.readFileSync(path.join(MAIN, 'startup-checks.ts'), 'utf8');
const DIGEST = path.join(MAIN, 'self-health-digest.ts');

describe('self-health audit is wired into startup-checks (run 109)', () => {
  it('the self-health-digest module exists on disk', () => {
    expect(fs.existsSync(DIGEST)).toBe(true);
  });

  it('startup-checks imports the digest builder and persister', () => {
    expect(STARTUP).toMatch(/from '\.\/self-health-digest'/);
    expect(STARTUP).toMatch(/buildSelfHealthDigest/);
    expect(STARTUP).toMatch(/persistSelfHealthDigest/);
  });

  it('runStartupChecks actually calls runSelfHealthAudit (not just defines it)', () => {
    const fn = STARTUP.slice(
      STARTUP.indexOf('export async function runStartupChecks'),
      STARTUP.indexOf('export async function runSelfHealthAudit'),
    );
    expect(fn).toMatch(/await runSelfHealthAudit\(\)/);
  });

  it('runSelfHealthAudit builds the digest and persists it', () => {
    const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));
    expect(fn).toMatch(/buildSelfHealthDigest\(/);
    expect(fn).toMatch(/persistSelfHealthDigest\(/);
  });

  it('runSelfHealthAudit surfaces each warning via warn() (no silent swallow)', () => {
    const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));
    expect(fn).toMatch(/for \(const w of digest\.warnings\)/);
    expect(fn).toMatch(/warn\('self-health audit', w\)/);
  });

  it('runSelfHealthAudit feeds real core-memory blocks to the eviction planner', () => {
    const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));
    expect(fn).toMatch(/getCoreBlocksDir/);
    expect(fn).toMatch(/coreBlocks/);
  });

  it('runSelfHealthAudit never throws out of boot (wrapped in try/catch)', () => {
    const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/self-health audit failed/);
  });

  it('fails loud: core-block and persist errors warn, never silently swallow', () => {
    // Codex run-109 review findings 6 + 7: empty catch blocks hid a missing
    // eviction feed and a missing persisted artifact. Lock the loud handling.
    const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));
    expect(fn).toMatch(/self-health: core-block read failed/);
    expect(fn).toMatch(/self-health: digest persist failed/);
    // No empty catch blocks remain in the audit body.
    expect(fn).not.toMatch(/catch\s*\{\s*\/\*[^}]*\*\/\s*\}/);
  });
});

describe('run-116 folds are activated in startup-checks (cost + outcomes)', () => {
  const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));

  it('derives the cost-ledger and outcome-log paths under the agent data dir', () => {
    expect(fn).toMatch(/toolCostLedgerPath\s*=\s*path\.join\(outDir, 'tool-cost-ledger\.jsonl'\)/);
    // outcomes.jsonl must match getDefaultTracker's production fallback name so
    // the producer and the consumer read the same file.
    expect(fn).toMatch(/outcomeLogPath\s*=\s*path\.join\(outDir, 'outcomes\.jsonl'\)/);
  });

  it('forwards both paths into buildSelfHealthDigest so the folds actually run', () => {
    const start = fn.indexOf('buildSelfHealthDigest({');
    const call = fn.slice(start, fn.indexOf('});', start));
    expect(call).toMatch(/toolCostLedgerPath/);
    expect(call).toMatch(/outcomeLogPath/);
  });
});

describe('run-118 folds are activated in startup-checks (skill/reflection/decision)', () => {
  const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));

  it('derives the capabilities dir and reflection/decision log paths', () => {
    // scheduled-tasks lives at the repo root, not under the agent data dir.
    expect(fn).toMatch(/capabilitiesDir\s*=\s*path\.join\(repoRoot, 'scheduled-tasks'\)/);
    expect(fn).toMatch(/reflectionLogPath\s*=\s*path\.join\(outDir, 'ea-reflection-log\.jsonl'\)/);
    expect(fn).toMatch(/decisionLogPath\s*=\s*path\.join\(outDir, 'agent-decisions\.jsonl'\)/);
  });

  it('forwards the run-118 inputs into buildSelfHealthDigest so the folds run', () => {
    const start = fn.indexOf('buildSelfHealthDigest({');
    const call = fn.slice(start, fn.indexOf('});', start));
    expect(call).toMatch(/capabilitiesDir/);
    expect(call).toMatch(/reflectionLogPath/);
    expect(call).toMatch(/decisionLogPath/);
  });
});

describe('run-143 fold is activated in startup-checks (cost-integrity)', () => {
  const fn = STARTUP.slice(STARTUP.indexOf('export async function runSelfHealthAudit'));

  it('derives the per-task claims path under the agent data dir', () => {
    expect(fn).toMatch(/taskCostClaimsPath\s*=\s*path\.join\(outDir, 'task-cost-claims\.jsonl'\)/);
  });

  it('forwards taskCostClaimsPath into buildSelfHealthDigest so the fold runs', () => {
    const start = fn.indexOf('buildSelfHealthDigest({');
    const call = fn.slice(start, fn.indexOf('});', start));
    expect(call).toMatch(/taskCostClaimsPath/);
  });
});
