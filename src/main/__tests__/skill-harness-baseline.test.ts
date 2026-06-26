/**
 * Tests for scripts/skill-harness-baseline.js, Phase 4 of harness-evolution-loop.
 *
 * Captures a baseline (SKILL.md hash + quality metrics) and compares current
 * metrics against it to flag degradations and recommend reverts.
 *
 * Frugal: isolated tmp dir, no real skill state touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORIGINAL_ROOT = process.env.SECONDBRAIN_ROOT;
let tmpRoot: string;

function loadFresh() {
  const modPath = require.resolve('../../../scripts/skill-harness-baseline.js');
  delete require.cache[modPath];
  return require('../../../scripts/skill-harness-baseline.js');
}

function makeSkill(skillName: string, body = '# skill body\n') {
  const dir = path.join(tmpRoot, 'scheduled-tasks', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

describe('skill-harness-baseline', () => {
  let mod: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-harness-'));
    process.env.SECONDBRAIN_ROOT = tmpRoot;
    mod = loadFresh();
  });

  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.SECONDBRAIN_ROOT;
    else process.env.SECONDBRAIN_ROOT = ORIGINAL_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('saveBaseline persists skill content hash plus metrics', () => {
    makeSkill('demo', '# original skill\n');
    const baseline = mod.saveBaseline('demo', { quality: 85, approvalRate: 0.8 });
    expect(baseline.skillName).toBe('demo');
    expect(typeof baseline.skillHash).toBe('string');
    expect(baseline.skillHash.length).toBe(64);
    expect(baseline.metrics.quality).toBe(85);
    expect(fs.existsSync(path.join(tmpRoot, 'scheduled-tasks', 'demo', 'harness-baseline.json'))).toBe(true);
  });

  it('compareToBaseline returns no degradation when metrics match or improve', () => {
    makeSkill('demo');
    mod.saveBaseline('demo', { quality: 85, approvalRate: 0.8 });
    const cmp = mod.compareToBaseline('demo', { quality: 90, approvalRate: 0.85 });
    expect(cmp.degraded).toBe(false);
    expect(cmp.degradations).toHaveLength(0);
  });

  it('compareToBaseline flags degradations when metrics drop beyond tolerance', () => {
    makeSkill('demo');
    mod.saveBaseline('demo', { quality: 85, approvalRate: 0.8 });
    const cmp = mod.compareToBaseline('demo', { quality: 70, approvalRate: 0.5 });
    expect(cmp.degraded).toBe(true);
    expect(cmp.degradations.length).toBeGreaterThanOrEqual(1);
    const qualityDrop = cmp.degradations.find((d: any) => d.metric === 'quality');
    expect(qualityDrop).toBeDefined();
    expect(qualityDrop.baseline).toBe(85);
    expect(qualityDrop.current).toBe(70);
  });

  it('recommendRevert returns true when quality dropped and SKILL.md hash changed', () => {
    makeSkill('demo', '# original\n');
    mod.saveBaseline('demo', { quality: 85 });
    makeSkill('demo', '# different content\n');
    const rec = mod.recommendRevert('demo', { quality: 60 });
    expect(rec.shouldRevert).toBe(true);
    expect(rec.reason).toMatch(/quality dropped/i);
    expect(rec.skillChanged).toBe(true);
  });

  it('recommendRevert returns false when SKILL.md unchanged even if metrics dropped', () => {
    makeSkill('demo', '# original\n');
    mod.saveBaseline('demo', { quality: 85 });
    const rec = mod.recommendRevert('demo', { quality: 60 });
    expect(rec.shouldRevert).toBe(false);
    expect(rec.skillChanged).toBe(false);
  });

  it('saveBaseline throws when SKILL.md does not exist', () => {
    expect(() => mod.saveBaseline('does-not-exist', { quality: 85 })).toThrow();
  });

  // Regression: a baseline metric the live rollup no longer emits (current value
  // undefined) must NOT register as a degradation. Absence of a measurement is
  // not a quality drop -- this was producing nightly false-positive reverts.
  it('compareToBaseline ignores baseline metrics that are absent from current metrics', () => {
    makeSkill('demo');
    mod.saveBaseline('demo', { quality: 85, blankFrameRate: 0, readabilityScore: 0.8 });
    const cmp = mod.compareToBaseline('demo', { quality: 85 });
    expect(cmp.degraded).toBe(false);
    expect(cmp.degradations).toHaveLength(0);
  });

  it('recommendRevert returns false when the only "drops" are unmeasured baseline metrics', () => {
    makeSkill('demo', '# original\n');
    mod.saveBaseline('demo', { quality: 85, pixelHistogramPass: 1 });
    makeSkill('demo', '# changed\n');
    const rec = mod.recommendRevert('demo', { quality: 85 });
    expect(rec.shouldRevert).toBe(false);
  });

  // Codex finding 3: a corrupt / non-finite CURRENT value against a real numeric
  // baseline is a degradation, not "absence of data". NaN must not slip through
  // the numeric comparison silently. (undefined/null still mean absent -> ignored.)
  it('compareToBaseline flags a NaN current value against a numeric baseline as degraded', () => {
    makeSkill('demo');
    mod.saveBaseline('demo', { contactsScraped: 80 });
    const cmp = mod.compareToBaseline('demo', { contactsScraped: NaN });
    expect(cmp.degraded).toBe(true);
  });

  it('compareToBaseline still ignores an absent (undefined) current value', () => {
    makeSkill('demo');
    mod.saveBaseline('demo', { contactsScraped: 80, quality: 85 });
    const cmp = mod.compareToBaseline('demo', { quality: 85 });
    expect(cmp.degraded).toBe(false);
  });
});
