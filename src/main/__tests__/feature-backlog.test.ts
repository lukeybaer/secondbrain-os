/**
 * Tests for scripts/feature-backlog.js scoring module.
 *
 * Validates:
 * - Pain event scoring (+15 to +25)
 * - Research confirmation scoring (+5 to +15)
 * - Daily decay (-5 per day with no signal)
 * - Score clamping (floor 0, ceiling 100)
 * - Rank ordering (descending by score)
 * - Trim to max 10 items
 * - Feature creation and lookup
 * - Briefing output format
 */

import { describe, it, expect, beforeEach } from 'vitest';

const backlog = require('../../../scripts/feature-backlog.js');

function makeBlankBacklog() {
  return { version: 1, last_updated: new Date().toISOString(), features: [] };
}

describe('feature-backlog scoring', () => {
  let bl: any;

  beforeEach(() => {
    bl = makeBlankBacklog();
  });

  it('creates a feature with initial score', () => {
    backlog.createFeature(bl, {
      id: 'test-feature',
      title: 'Test Feature',
      description: 'A test',
      category: 'general',
      initialScore: 30,
    });
    expect(bl.features).toHaveLength(1);
    expect(bl.features[0].priority_score).toBe(30);
    expect(bl.features[0].id).toBe('test-feature');
    expect(bl.features[0].status).toBe('proposed');
  });

  it('adds pain events with correct scoring', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 20 });
    backlog.addPainEvent(bl, 'f1', { source: 'rejection', detail: 'video rejected', severity: 'rejection' });
    expect(bl.features[0].priority_score).toBe(40); // 20 + 20 (rejection severity)
    expect(bl.features[0].pain_events).toHaveLength(1);
  });

  it('adds research confirmations with correct scoring', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 20 });
    backlog.addResearchConfirmation(bl, 'f1', { repo: 'CrewAI', finding: 'scene graph', relevance: 'high' });
    expect(bl.features[0].priority_score).toBe(35); // 20 + 15 (high relevance)
    expect(bl.features[0].research_confirmations).toHaveLength(1);
  });

  it('applies daily decay to items with no signal', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 30 });
    // Set last_signal_date to yesterday so decay fires
    bl.features[0].last_signal_date = '2020-01-01';
    backlog.applyDailyDecay(bl);
    expect(bl.features[0].priority_score).toBe(25); // 30 - 5
  });

  it('does not decay items that received signal today', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 30 });
    // last_signal_date is set to today by createFeature
    backlog.applyDailyDecay(bl);
    expect(bl.features[0].priority_score).toBe(30); // unchanged
  });

  it('clamps score at ceiling 100', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 95 });
    backlog.addPainEvent(bl, 'f1', { source: 'test', detail: 'big pain', severity: 'gap_trigger' });
    expect(bl.features[0].priority_score).toBe(100); // 95 + 25 = 120, clamped to 100
  });

  it('clamps score at floor 0', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'F1', description: '', category: 'test', initialScore: 3 });
    bl.features[0].last_signal_date = '2020-01-01';
    backlog.applyDailyDecay(bl);
    expect(bl.features[0].priority_score).toBe(0); // 3 - 5 = -2, clamped to 0
  });

  it('rankAndTrim sorts descending and removes items at 0', () => {
    backlog.createFeature(bl, { id: 'low', title: 'Low', description: '', category: 'test', initialScore: 10 });
    backlog.createFeature(bl, { id: 'high', title: 'High', description: '', category: 'test', initialScore: 80 });
    backlog.createFeature(bl, { id: 'zero', title: 'Zero', description: '', category: 'test', initialScore: 5 });
    // Manually set to 0 to simulate full decay
    bl.features[2].priority_score = 0;
    backlog.rankAndTrim(bl);
    expect(bl.features).toHaveLength(2); // zero removed
    expect(bl.features[0].id).toBe('high');
    expect(bl.features[1].id).toBe('low');
  });

  it('rankAndTrim caps at 10 items', () => {
    for (let i = 0; i < 15; i++) {
      backlog.createFeature(bl, { id: `f${i}`, title: `Feature ${i}`, description: '', category: 'test', initialScore: 10 + i });
    }
    backlog.rankAndTrim(bl);
    expect(bl.features).toHaveLength(10);
    expect(bl.features[0].priority_score).toBe(24); // highest score (10 + 14)
  });

  it('findFeatureByKeywords matches on title and description', () => {
    backlog.createFeature(bl, { id: 'broll', title: 'Multi-shot B-roll composition', description: 'video gen', category: 'video' });
    const match = backlog.findFeatureByKeywords(bl, ['b-roll']);
    expect(match).toBeDefined();
    expect(match.id).toBe('broll');
  });

  it('getBacklogForBriefing returns formatted items', () => {
    backlog.createFeature(bl, { id: 'f1', title: 'Feature 1', description: '', category: 'test', initialScore: 50 });
    backlog.createFeature(bl, { id: 'f2', title: 'Feature 2', description: '', category: 'test', initialScore: 30 });
    backlog.rankAndTrim(bl);
    const result = backlog.getBacklogForBriefing(bl);
    expect(result.count).toBe(2);
    expect(result.items[0].rank).toBe(1);
    expect(result.items[0].score).toBe(50);
  });

  it('returns false when adding pain to nonexistent feature', () => {
    const result = backlog.addPainEvent(bl, 'nonexistent', { source: 'test', detail: 'test', severity: 'rejection' });
    expect(result).toBe(false);
  });
});

describe('feature-backlog clampScore', () => {
  it('clamps within range', () => {
    expect(backlog.clampScore(-10)).toBe(0);
    expect(backlog.clampScore(50)).toBe(50);
    expect(backlog.clampScore(150)).toBe(100);
  });
});
