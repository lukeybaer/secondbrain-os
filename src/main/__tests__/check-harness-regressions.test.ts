/**
 * Tests for scripts/check-harness-regressions.js, the Phase 5 nightly check
 * that loops over priority skills, calls recommendRevert(), and appends any
 * recommendations to data/agent/revert-recommendations.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFresh() {
  for (const rel of [
    '../../../scripts/check-harness-regressions.js',
    '../../../scripts/skill-harness-baseline.js',
  ]) {
    try {
      const p = require.resolve(rel);
      delete require.cache[p];
    } catch {}
  }
  return require('../../../scripts/check-harness-regressions.js');
}

function makeSkill(name: string, body = '# orig\n') {
  const dir = path.join(tmpRoot, 'scheduled-tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

describe('check-harness-regressions', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-regress-'));
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty results when no skills have baselines', () => {
    makeSkill('alpha');
    makeSkill('beta');
    const result = mod.checkRegressions({
      skillNames: ['alpha', 'beta'],
      currentMetricsBySkill: { alpha: { quality: 80 }, beta: { quality: 80 } },
    });
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
  });

  it('appends a recommendation to JSONL when a skill degraded after SKILL.md change', () => {
    const baseline = require('../../../scripts/skill-harness-baseline.js');
    makeSkill('alpha', '# original\n');
    baseline.saveBaseline('alpha', { quality: 90 });
    makeSkill('alpha', '# changed\n');
    const result = mod.checkRegressions({
      skillNames: ['alpha'],
      currentMetricsBySkill: { alpha: { quality: 60 } },
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].skillName).toBe('alpha');
    expect(result.recommendations[0].shouldRevert).toBe(true);
    const jsonlPath = path.join(tmpRoot, 'data', 'agent', 'revert-recommendations.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.skillName).toBe('alpha');
    expect(parsed.shouldRevert).toBe(true);
  });

  it('does not append when no degradation detected', () => {
    const baseline = require('../../../scripts/skill-harness-baseline.js');
    makeSkill('alpha');
    baseline.saveBaseline('alpha', { quality: 80 });
    const result = mod.checkRegressions({
      skillNames: ['alpha'],
      currentMetricsBySkill: { alpha: { quality: 82 } },
    });
    expect(result.recommendations).toHaveLength(0);
    const jsonlPath = path.join(tmpRoot, 'data', 'agent', 'revert-recommendations.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it('skips skills flagged insufficientData and never recommends a revert from an empty window', () => {
    const baseline = require('../../../scripts/skill-harness-baseline.js');
    makeSkill('alpha', '# original\n');
    baseline.saveBaseline('alpha', { quality: 90 });
    makeSkill('alpha', '# changed\n'); // SKILL.md changed since baseline
    // Current metrics show a quality "drop" but the window had no real signal.
    const result = mod.checkRegressions({
      skillNames: ['alpha'],
      currentMetricsBySkill: { alpha: { quality: 0, insufficientData: true } },
    });
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/insufficient/i);
    const jsonlPath = path.join(tmpRoot, 'data', 'agent', 'revert-recommendations.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it('does not count a baseline metric missing from current rollup as a degradation', () => {
    const baseline = require('../../../scripts/skill-harness-baseline.js');
    makeSkill('alpha', '# original\n');
    // Baseline ExampleCos a richer metric set than the rollup emits.
    baseline.saveBaseline('alpha', { quality: 85, blankFrameRate: 0 });
    makeSkill('alpha', '# changed\n');
    // Current omits blankFrameRate entirely and quality is steady.
    const result = mod.checkRegressions({
      skillNames: ['alpha'],
      currentMetricsBySkill: { alpha: { quality: 85 } },
    });
    expect(result.recommendations).toHaveLength(0);
  });

  it('handles multiple skills, records only degraded ones', () => {
    const baseline = require('../../../scripts/skill-harness-baseline.js');
    makeSkill('alpha', '# a1\n');
    baseline.saveBaseline('alpha', { quality: 90 });
    makeSkill('alpha', '# a2\n');
    makeSkill('beta');
    baseline.saveBaseline('beta', { quality: 70 });
    const result = mod.checkRegressions({
      skillNames: ['alpha', 'beta'],
      currentMetricsBySkill: { alpha: { quality: 50 }, beta: { quality: 75 } },
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].skillName).toBe('alpha');
  });
});
