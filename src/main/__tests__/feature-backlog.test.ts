/**
 * Tests for scripts/feature-backlog.js scoring module.
 *
 * 2026-05-10 rewrite locks in ExampleCo's three complaints as regressions:
 *  1) Strong, well-researched ideas must not decay to zero just because the
 *     last 24h lacked a surface pain signal ("the opinion is strong because
 *     it is real").
 *  2) Items must NEVER be deleted from existence -- below-threshold items
 *     are archived to feature-backlog-archive.jsonl and recoverable.
 *  3) MAX_ITEMS allows breadth so deep research is not truncated at 10.
 *  4) Research relevance can match pain severity (no structural bias toward
 *     recent-pain over deep-research findings).
 *  5) Independent-source breadth (multiple repos confirming the same gap)
 *     raises strategic_impact, the permanent dimension that decay cannot
 *     touch.
 *
 * Algorithm under test (see scripts/feature-backlog.js header):
 *   priority_score = round(strategic_impact * 0.45 + signal_score * 0.55)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Tests run against a temp REPO so the real archive file is never touched.
let tmpRoot: string;
let backlog: any;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'data', 'agent'), { recursive: true });
  process.env.SECONDBRAIN_ROOT = tmpRoot;
  // Force fresh require so module-level paths bind to the new tmpRoot
  delete require.cache[require.resolve('../../../scripts/feature-backlog.js')];
  backlog = require('../../../scripts/feature-backlog.js');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.SECONDBRAIN_ROOT;
});

function makeBlankBacklog() {
  return { version: 1, last_updated: new Date().toISOString(), features: [] };
}

// createFeature now hard-gates on the quality bar (validateProposal): every
// proposal must carry a concrete problem_statement, evidence, and an
// implementation_plan with a file path. These scoring tests only care about
// score math, so mkFeature injects valid quality fields when a test does not
// supply them, keeping the scoring assertions focused.
function mkFeature(bl: any, opts: any) {
  return backlog.createFeature(bl, {
    problemStatement:
      opts.problemStatement ||
      'Concrete problem grounded in real pain signal that this scoring fixture needs to satisfy the quality gate.',
    evidence: opts.evidence || [{ source: 'data/agent/health-heal.jsonl', detail: 'fixture evidence' }],
    implementationPlan:
      opts.implementationPlan || 'Edit scripts/feature-backlog.js to address the gap described above.',
    ...opts,
  });
}

describe('feature-backlog scoring (2026-05-10 rewrite)', () => {
  let bl: any;
  beforeEach(() => { bl = makeBlankBacklog(); });

  it('creates a feature with strategic_impact + signal_score + composite priority', () => {
    mkFeature(bl, {
      id: 'test-feature',
      title: 'Test Feature',
      description: 'A test',
      category: 'general',
      initialScore: 30,
      strategicImpact: 60,
    });
    expect(bl.features).toHaveLength(1);
    expect(bl.features[0].strategic_impact).toBe(60);
    expect(bl.features[0].signal_score).toBe(30);
    // priority_score = round(60 * 0.45 + 30 * 0.55) = round(27 + 16.5) = 44
    expect(bl.features[0].priority_score).toBe(44);
  });

  it('defaults strategic_impact above 20 when not provided (no item enters the backlog without architectural weight)', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 10 });
    expect(bl.features[0].strategic_impact).toBeGreaterThanOrEqual(20);
  });

  it('pain events boost signal_score (not strategic_impact)', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 20, strategicImpact: 50 });
    const beforeStrategic = bl.features[0].strategic_impact;
    backlog.addPainEvent(bl, 'f1', { source: 'rejection', detail: 'video rejected', severity: 'rejection' });
    expect(bl.features[0].signal_score).toBe(40); // 20 + 20
    expect(bl.features[0].strategic_impact).toBe(beforeStrategic);
  });

  it('research relevance can match pain severity (no structural research downgrade)', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 0, strategicImpact: 0 });
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'memgpt', finding: 'agent-side episodic store', relevance: 'high' });
    expect(bl.features[0].signal_score).toBe(25); // research high = 25, matches pain rejection = 20
  });

  it('independent sources raise strategic_impact (breadth-of-evidence bonus)', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 0, strategicImpact: 30 });
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'memgpt', finding: 'a', relevance: 'high' });
    const afterFirst = bl.features[0].strategic_impact;
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'letta', finding: 'b', relevance: 'high' });
    const afterSecond = bl.features[0].strategic_impact;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it('same-source research does NOT inflate strategic_impact twice', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 0, strategicImpact: 30 });
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'memgpt', finding: 'a', relevance: 'high' });
    const afterFirst = bl.features[0].strategic_impact;
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'MemGPT', finding: 'b', relevance: 'high' });
    expect(bl.features[0].strategic_impact).toBe(afterFirst);
  });

  it('decay does NOT fire within the quiet-window grace period (3 days)', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 30, strategicImpact: 60 });
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    bl.features[0].last_signal_date = yesterday;
    backlog.applyDailyDecay(bl);
    expect(bl.features[0].signal_score).toBe(30); // unchanged within grace
  });

  it('decay is multiplicative, not flat -- 1 quiet day past grace = ~3% drop, not -5', () => {
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 80, strategicImpact: 60 });
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    bl.features[0].last_signal_date = old;
    backlog.applyDailyDecay(bl);
    expect(bl.features[0].signal_score).toBe(Math.floor(80 * 0.97)); // 77, not 75
  });

  it('REGRESSION: strong well-researched item cannot decay to zero (strategic_impact floor)', () => {
    mkFeature(bl, { id: 'strong', title: 'Strong idea', description: '', category: 'test', initialScore: 80, strategicImpact: 80 });
    backlog.addResearchConfirmation(bl, 'strong', { repo: 'memgpt', finding: 'matches', relevance: 'high' });
    // Simulate 120 quiet days
    bl.features[0].last_signal_date = '2020-01-01';
    for (let i = 0; i < 120; i++) backlog.applyDailyDecay(bl);
    const floorExpected = Math.floor(bl.features[0].strategic_impact * 0.5);
    expect(bl.features[0].signal_score).toBeGreaterThanOrEqual(floorExpected);
    expect(bl.features[0].strategic_impact).toBeGreaterThanOrEqual(60); // permanent dimension untouched
  });

  it('item with no research confirmation can decay below the research floor (signal floor = 0)', () => {
    mkFeature(bl, { id: 'thin', title: 'Thin idea', description: '', category: 'test', initialScore: 10, strategicImpact: 20 });
    bl.features[0].last_signal_date = '2020-01-01';
    for (let i = 0; i < 200; i++) backlog.applyDailyDecay(bl);
    expect(bl.features[0].signal_score).toBe(0);
    // Strategic impact still preserved as the "this is real" axis
    expect(bl.features[0].strategic_impact).toBe(20);
  });

  it('composite priority preserves strong items even with zero signal_score', () => {
    mkFeature(bl, { id: 'pure-strategic', title: 'Pure', description: '', category: 'test', initialScore: 0, strategicImpact: 80 });
    bl.features[0].signal_score = 0;
    bl.features[0].priority_score = backlog.computePriority(bl.features[0]);
    expect(bl.features[0].priority_score).toBe(Math.round(80 * 0.45));
  });

  it('REGRESSION: rankAndTrim archives below-cutoff items instead of deleting them', () => {
    for (let i = 0; i < 30; i++) {
      mkFeature(bl, { id: `f${i}`, title: `Feature ${i}`, description: '', category: 'test', initialScore: 10 + i, strategicImpact: 20 });
    }
    backlog.rankAndTrim(bl);
    expect(bl.features.length).toBe(backlog.MAX_ITEMS);
    const archive = backlog.loadArchive();
    expect(archive.length).toBeGreaterThan(0);
    const archivedIds = archive.map((e: any) => e.feature.id);
    // Lowest-scoring items should be in archive, not /dev/null
    expect(archivedIds).toContain('f0');
  });

  it('rePromoteIfMatched restores an archived item when a new matching signal arrives', () => {
    mkFeature(bl, { id: 'will-be-archived', title: 'Drop me', description: '', category: 'test', initialScore: 1, strategicImpact: 1 });
    // Force into archive
    backlog.archiveItem(bl.features[0], 'manual test eviction');
    bl.features = [];
    const restored = backlog.rePromoteIfMatched(bl, 'will-be-archived');
    expect(restored).not.toBeNull();
    expect(bl.features.find((f: any) => f.id === 'will-be-archived')).toBeDefined();
  });

  it('MAX_ITEMS is 25, not 10 (deep research breadth)', () => {
    expect(backlog.MAX_ITEMS).toBe(25);
  });

  it('rankAndTrim caps at MAX_ITEMS but keeps pinned overflow', () => {
    for (let i = 0; i < 30; i++) {
      mkFeature(bl, { id: `f${i}`, title: `Feature ${i}`, description: '', category: 'test', initialScore: 50 + i, strategicImpact: 50 });
    }
    mkFeature(bl, { id: 'pinned-low', title: 'Pinned', description: '', category: 'test', initialScore: 1, strategicImpact: 5 });
    bl.features[bl.features.length - 1].pinned = true;
    backlog.rankAndTrim(bl);
    expect(bl.features.find((f: any) => f.id === 'pinned-low')).toBeDefined();
    expect(bl.features.length).toBeLessThanOrEqual(backlog.MAX_ITEMS + 1);
  });

  it('clampScore stays within [0, 100]', () => {
    expect(backlog.clampScore(-10)).toBe(0);
    expect(backlog.clampScore(50)).toBe(50);
    expect(backlog.clampScore(150)).toBe(100);
  });

  it('addPainEvent returns false for ExampleCo feature id', () => {
    expect(backlog.addPainEvent(bl, 'nope', { source: 's', detail: 'd', severity: 'rejection' })).toBe(false);
  });

  it('findFeatureByKeywords matches on title and description', () => {
    mkFeature(bl, { id: 'broll', title: 'Multi-shot B-roll composition', description: 'video gen', category: 'video' });
    const match = backlog.findFeatureByKeywords(bl, ['b-roll']);
    expect(match).toBeDefined();
    expect(match.id).toBe('broll');
  });

  it('getBacklogForBriefing exposes strategic_impact + signal_score for the dashboard', () => {
    mkFeature(bl, { id: 'f1', title: 'Feature 1', description: '', category: 'test', initialScore: 50, strategicImpact: 70 });
    backlog.rankAndTrim(bl);
    const result = backlog.getBacklogForBriefing(bl);
    expect(result.items[0].strategic_impact).toBe(70);
    expect(result.items[0].signal_score).toBe(50);
  });

  it('loadBacklog migrates legacy items missing strategic_impact + signal_score', () => {
    const legacy = {
      version: 5,
      last_updated: '2026-04-30T06:00:00Z',
      features: [
        {
          id: 'legacy',
          title: 'Legacy',
          description: '',
          category: 'test',
          priority_score: 60,
          score_history: [],
          pain_events: [{ date: '2026-04-01', source: 's', detail: 'd' }, { date: '2026-04-02', source: 's', detail: 'd' }],
          research_confirmations: [{ date: '2026-04-03', repo: 'r1', finding: 'f' }],
          last_signal_date: '2026-04-30',
          status: 'proposed',
        },
      ],
    };
    fs.writeFileSync(path.join(tmpRoot, 'data', 'agent', 'feature-backlog.json'), JSON.stringify(legacy));
    const loaded = backlog.loadBacklog();
    expect(loaded.features[0].strategic_impact).toBeGreaterThanOrEqual(20);
    expect(loaded.features[0].signal_score).toBeGreaterThanOrEqual(0);
    expect(loaded.features[0].priority_score).toBeGreaterThan(0);
  });

  it('saveBacklog recomputes priority_score from strategic_impact + signal_score', () => {
    const target = path.join(tmpRoot, 'data', 'agent', 'feature-backlog.json');
    mkFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 40, strategicImpact: 60 });
    bl.features[0].priority_score = 999; // deliberately wrong
    backlog.saveBacklog(bl);
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(saved.features[0].priority_score).toBe(Math.round(60 * 0.45 + 40 * 0.55));
  });
});
