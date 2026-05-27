import { describe, it, expect } from 'vitest';
import {
  recordPrediction,
  resolveOutcome,
  calibration,
  detectDrift,
  computeDeviation,
  InMemoryLedger,
  type PredictionRecord,
} from '../prediction-ledger';

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe('prediction-ledger: recordPrediction', () => {
  it('appends a prediction record with stable id derived from inputs', async () => {
    const io = new InMemoryLedger();
    const rec = await recordPrediction(io, {
      skill: 'daily-briefing',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.9,
      basis: 'last 7 runs were green',
      now: fixedClock('2026-05-13T05:30:00.000Z'),
    });
    expect(rec.id.length).toBe(16);
    expect(rec.type).toBe('prediction');
    expect(rec.skill).toBe('daily-briefing');
    expect((io.readSince() as unknown[]).length).toBe(1);
  });

  it('produces distinct ids for same skill+ts when idx differs', async () => {
    const io = new InMemoryLedger();
    const a = await recordPrediction(io, {
      skill: 'video-aurora',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'first run',
      now: fixedClock('2026-05-13T07:00:00.000Z'),
      idx: 0,
    });
    const b = await recordPrediction(io, {
      skill: 'video-aurora',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'second run, same ms',
      now: fixedClock('2026-05-13T07:00:00.000Z'),
      idx: 1,
    });
    expect(a.id).not.toBe(b.id);
  });

  it('validates confidence range', async () => {
    const io = new InMemoryLedger();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 1.5,
        basis: 'oops',
      })
    ).rejects.toThrow();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: -0.1,
        basis: 'oops',
      })
    ).rejects.toThrow();
  });

  it('validates outcome_kind matches expected_value type', async () => {
    const io = new InMemoryLedger();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'numeric',
        expected_value: 'not-a-number',
        confidence: 0.5,
        basis: 'b',
      })
    ).rejects.toThrow();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'boolean',
        expected_value: 'true' as unknown as boolean,
        confidence: 0.5,
        basis: 'b',
      })
    ).rejects.toThrow();
  });

  it('rejects categorical expected_space with fewer than two options', async () => {
    const io = new InMemoryLedger();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'categorical',
        expected_value: 'green',
        expected_space: ['green'],
        confidence: 0.5,
        basis: 'b',
      })
    ).rejects.toThrow();
  });

  it('rejects numeric expected_space where min >= max', async () => {
    const io = new InMemoryLedger();
    await expect(
      recordPrediction(io, {
        skill: 's',
        outcome_kind: 'numeric',
        expected_value: 100,
        expected_space: [50, 50],
        confidence: 0.5,
        basis: 'b',
      })
    ).rejects.toThrow();
  });
});

describe('prediction-ledger: computeDeviation', () => {
  it('boolean match returns deviation 0', () => {
    const p: PredictionRecord = {
      type: 'prediction',
      id: 'x',
      ts: '',
      skill: 's',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.9,
      basis: 'b',
    };
    expect(computeDeviation(p, true)).toEqual({ matched: true, deviation: 0 });
    expect(computeDeviation(p, false)).toEqual({ matched: false, deviation: 1 });
  });

  it('categorical with ordered space returns normalised index distance', () => {
    const p: PredictionRecord = {
      type: 'prediction',
      id: 'x',
      ts: '',
      skill: 's',
      outcome_kind: 'categorical',
      expected_value: 'green',
      expected_space: ['green', 'amber', 'red'],
      confidence: 0.9,
      basis: 'b',
    };
    expect(computeDeviation(p, 'amber').deviation).toBeCloseTo(0.5);
    expect(computeDeviation(p, 'red').deviation).toBeCloseTo(1);
    expect(computeDeviation(p, 'unknown').deviation).toBe(1);
  });

  it('numeric within 5% of expected_space range counts as matched', () => {
    const p: PredictionRecord = {
      type: 'prediction',
      id: 'x',
      ts: '',
      skill: 's',
      outcome_kind: 'numeric',
      expected_value: 100,
      expected_space: [0, 200],
      confidence: 0.5,
      basis: 'b',
    };
    expect(computeDeviation(p, 105).matched).toBe(true);
    expect(computeDeviation(p, 150).matched).toBe(false);
  });

  it('rejects type-mismatched actual values', () => {
    const p: PredictionRecord = {
      type: 'prediction',
      id: 'x',
      ts: '',
      skill: 's',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'b',
    };
    expect(() => computeDeviation(p, 'true' as unknown as boolean)).toThrow();
  });
});

describe('prediction-ledger: resolveOutcome', () => {
  it('records outcome + joined deviation with correct brier contribution', async () => {
    const io = new InMemoryLedger();
    const pred = await recordPrediction(io, {
      skill: 'daily-briefing',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.8,
      basis: 'b',
      now: fixedClock('2026-05-13T05:30:00.000Z'),
    });
    const joined = await resolveOutcome(io, {
      prediction_id: pred.id,
      actual_value: false,
      now: fixedClock('2026-05-13T06:00:00.000Z'),
      evidence_path: 'data/briefings/briefing-2026-05-13.md',
    });
    expect(joined.matched).toBe(false);
    expect(joined.brier_contribution).toBeCloseTo((0.8 - 0) ** 2);
    const all = io.readSince() as unknown[];
    expect(all.length).toBe(3); // prediction + outcome + joined
  });

  it('throws if prediction_id is unknown', async () => {
    const io = new InMemoryLedger();
    await expect(
      resolveOutcome(io, { prediction_id: 'missing', actual_value: true })
    ).rejects.toThrow('no prediction found');
  });
});

describe('prediction-ledger: calibration', () => {
  it('aggregates by skill with accuracy and brier', async () => {
    const io = new InMemoryLedger();
    const skill = 'video-aurora';
    for (let i = 0; i < 4; i++) {
      const pred = await recordPrediction(io, {
        skill,
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 0.7,
        basis: 'b',
        now: fixedClock(`2026-05-${10 + i}T07:00:00.000Z`),
        idx: i,
      });
      await resolveOutcome(io, {
        prediction_id: pred.id,
        // 3 hits, 1 miss
        actual_value: i < 3,
        now: fixedClock(`2026-05-${10 + i}T08:00:00.000Z`),
      });
    }
    const cal = await calibration(io);
    expect(cal.by_skill).toHaveLength(1);
    expect(cal.by_skill[0].skill).toBe(skill);
    expect(cal.by_skill[0].total).toBe(4);
    expect(cal.by_skill[0].matched).toBe(3);
    expect(cal.by_skill[0].accuracy).toBeCloseTo(0.75);
    expect(cal.by_skill[0].mean_brier).toBeGreaterThan(0);
    expect(cal.overall.skills).toBe(1);
  });

  it('filters by skill argument', async () => {
    const io = new InMemoryLedger();
    for (const skill of ['a', 'b']) {
      const p = await recordPrediction(io, {
        skill,
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 0.5,
        basis: 'b',
      });
      await resolveOutcome(io, { prediction_id: p.id, actual_value: true });
    }
    const cal = await calibration(io, { skill: 'a' });
    expect(cal.by_skill).toHaveLength(1);
    expect(cal.by_skill[0].skill).toBe('a');
  });

  it('returns zeros for empty input', async () => {
    const io = new InMemoryLedger();
    const cal = await calibration(io);
    expect(cal.by_skill).toEqual([]);
    expect(cal.overall.total).toBe(0);
    expect(cal.overall.accuracy).toBe(0);
  });
});

describe('prediction-ledger: detectDrift', () => {
  it('flags skills whose recent accuracy dropped versus all-time', async () => {
    const io = new InMemoryLedger();
    // 5 early hits, then 5 misses recently -> accuracy 0.5, trend 0.0, drop 0.5
    for (let i = 0; i < 10; i++) {
      const p = await recordPrediction(io, {
        skill: 'captions-aurora',
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 0.6,
        basis: 'b',
        idx: i,
        now: fixedClock(`2026-04-${(10 + i).toString().padStart(2, '0')}T00:00:00.000Z`),
      });
      await resolveOutcome(io, {
        prediction_id: p.id,
        actual_value: i < 5,
        now: fixedClock(`2026-04-${(10 + i).toString().padStart(2, '0')}T01:00:00.000Z`),
      });
    }
    const drift = await detectDrift(io, { drop_threshold: 0.3 });
    expect(drift).toHaveLength(1);
    expect(drift[0].skill).toBe('captions-aurora');
    expect(drift[0].drop).toBeGreaterThanOrEqual(0.3);
  });

  it('does not flag stable skills', async () => {
    const io = new InMemoryLedger();
    for (let i = 0; i < 10; i++) {
      const p = await recordPrediction(io, {
        skill: 'daily-briefing',
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 0.6,
        basis: 'b',
        idx: i,
      });
      await resolveOutcome(io, { prediction_id: p.id, actual_value: true });
    }
    const drift = await detectDrift(io);
    expect(drift).toEqual([]);
  });

  it('honours min_samples', async () => {
    const io = new InMemoryLedger();
    for (let i = 0; i < 3; i++) {
      const p = await recordPrediction(io, {
        skill: 's',
        outcome_kind: 'boolean',
        expected_value: true,
        confidence: 0.6,
        basis: 'b',
        idx: i,
      });
      await resolveOutcome(io, { prediction_id: p.id, actual_value: false });
    }
    // Three samples; default min_samples is 5 -> not flagged.
    const drift = await detectDrift(io);
    expect(drift).toEqual([]);
  });
});

describe('prediction-ledger: InMemoryLedger', () => {
  it('readSince filters by ISO timestamp', async () => {
    const io = new InMemoryLedger();
    await recordPrediction(io, {
      skill: 'a',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'b',
      now: fixedClock('2026-05-01T00:00:00.000Z'),
    });
    await recordPrediction(io, {
      skill: 'a',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'b',
      now: fixedClock('2026-05-10T00:00:00.000Z'),
    });
    const all = io.readSince() as unknown[];
    const filtered = io.readSince('2026-05-05T00:00:00.000Z') as unknown[];
    expect(all.length).toBe(2);
    expect(filtered.length).toBe(1);
  });

  it('defensive copies prevent mutation leaks', async () => {
    const io = new InMemoryLedger();
    const rec = await recordPrediction(io, {
      skill: 'a',
      outcome_kind: 'boolean',
      expected_value: true,
      confidence: 0.5,
      basis: 'b',
    });
    rec.skill = 'mutated';
    const stored = io.readSince() as PredictionRecord[];
    expect(stored[0].skill).toBe('a');
  });
});
