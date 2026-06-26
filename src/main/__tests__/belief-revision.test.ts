import { describe, it, expect, beforeEach } from 'vitest';
import {
  openBelief,
  applyEvidence,
  applyEvidenceBatch,
  dissonance,
  detectContradictions,
  formatContradictionsForBriefing,
  shouldEscalate,
  auditBelief,
  confidenceBand,
  probToLogOdds,
  logOddsToProb,
  LOG_LR_CAP,
  InMemoryBeliefStore,
  type BeliefRecord,
} from '../belief-revision';

const fixedNow = () => new Date('2026-05-14T06:00:00.000Z');

describe('belief-revision: log-odds plumbing', () => {
  it('round-trips probability through log-odds', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.99]) {
      const back = logOddsToProb(probToLogOdds(p));
      expect(Math.abs(back - p)).toBeLessThan(1e-6);
    }
  });

  it('clamps endpoints so the log-odds stays finite', () => {
    // 0 and 1 would explode the log-odds; the helper must clamp before log.
    const lo0 = probToLogOdds(0);
    const lo1 = probToLogOdds(1);
    expect(Number.isFinite(lo0)).toBe(true);
    expect(Number.isFinite(lo1)).toBe(true);
  });
});

describe('belief-revision: openBelief', () => {
  it('captures the prior and starts the posterior equal to the prior', () => {
    const rec = openBelief('dentist accepts new patients', {
      surface: 'call',
      prior: 0.7,
      now: fixedNow,
    });
    expect(rec.prior).toBe(0.7);
    expect(rec.posterior).toBe(0.7);
    expect(rec.surface).toBe('call');
    expect(rec.created_at).toBe('2026-05-14T06:00:00.000Z');
  });

  it('records an initial evidence row when a source is provided', () => {
    const rec = openBelief('Alice I-140 was filed Oct 2025', {
      surface: 'task',
      prior: 0.85,
      source: { kind: 'memory:user_wife_family', note: 'recalled from file' },
      now: fixedNow,
    });
    expect(rec.evidence.length).toBe(1);
    expect(rec.evidence[0].source.kind).toBe('memory:user_wife_family');
    expect(rec.evidence[0].log_lr).toBe(0);
  });

  it('keeps prior strictly inside (0,1) to allow future updates', () => {
    // Prior 1.0 would mean no contradicting evidence could ever move the
    // posterior. The module must clamp away from the endpoints.
    const rec = openBelief('definitely true', { surface: 'task', prior: 1.0 });
    expect(rec.prior).toBeLessThan(1);
    expect(rec.prior).toBeGreaterThan(0.99);
  });
});

describe('belief-revision: applyEvidence', () => {
  let base: BeliefRecord;
  beforeEach(() => {
    base = openBelief('dentist accepts new patients', {
      surface: 'call',
      prior: 0.5,
      now: fixedNow,
    });
  });

  it('shifts posterior up on positive evidence', () => {
    const next = applyEvidence(base, {
      source: { kind: 'voicemail' },
      log_lr: 1.5,
      rationale: 'voicemail said currently accepting new patients',
    });
    expect(next.posterior).toBeGreaterThan(base.posterior);
    expect(next.evidence.length).toBe(1);
  });

  it('shifts posterior down on negative evidence', () => {
    const next = applyEvidence(base, {
      source: { kind: 'staff:says' },
      log_lr: -2.0,
      rationale: 'front desk said not accepting new patients this quarter',
    });
    expect(next.posterior).toBeLessThan(base.posterior);
  });

  it('caps individual log-likelihood ratios so one update cannot lock the belief', () => {
    // A caller supplies a huge LR (intentionally or by bug). The module
    // must cap it so the posterior never hits 0 or 1.
    const next = applyEvidence(base, {
      source: { kind: 'ExampleCo' },
      log_lr: 1000,
    });
    expect(next.posterior).toBeLessThan(1);
    expect(next.posterior).toBeGreaterThan(0);
    expect(next.evidence[0].log_lr).toBe(LOG_LR_CAP);
  });

  it('does not mutate the input record', () => {
    const beforePost = base.posterior;
    const beforeEvCount = base.evidence.length;
    applyEvidence(base, { source: { kind: 'x' }, log_lr: 1 });
    expect(base.posterior).toBe(beforePost);
    expect(base.evidence.length).toBe(beforeEvCount);
  });

  it('records the prior and posterior in the audit trail', () => {
    const next = applyEvidence(base, {
      source: { kind: 'gmail' },
      log_lr: 0.8,
    });
    expect(next.evidence[0].prior).toBeCloseTo(0.5, 5);
    expect(next.evidence[0].posterior).toBeCloseTo(next.posterior, 5);
  });

  it('tightens the confidence band as evidence accumulates', () => {
    let cur = base;
    const initialWidth =
      cur.confidence_band[1] - cur.confidence_band[0];
    for (let i = 0; i < 8; i++) {
      cur = applyEvidence(cur, {
        source: { kind: `step${i}` },
        log_lr: 0.5,
      });
    }
    const finalWidth = cur.confidence_band[1] - cur.confidence_band[0];
    expect(finalWidth).toBeLessThan(initialWidth);
  });
});

describe('belief-revision: applyEvidenceBatch', () => {
  it('applies evidence in order and accumulates the posterior', () => {
    const rec = openBelief('briefing went green tonight', {
      surface: 'briefing',
      prior: 0.5,
    });
    const out = applyEvidenceBatch(rec, [
      { source: { kind: 'briefing-log' }, log_lr: 0.8 },
      { source: { kind: 'dashboard-probe' }, log_lr: 0.6 },
      { source: { kind: 'telegram-receipt' }, log_lr: 0.4 },
    ]);
    expect(out.evidence.length).toBe(3);
    expect(out.posterior).toBeGreaterThan(0.7);
  });
});

describe('belief-revision: dissonance', () => {
  it('returns 0 for two identical beliefs', () => {
    const a = openBelief('x', { surface: 'task', prior: 0.7 });
    const b = openBelief('x', { surface: 'task', prior: 0.7 });
    expect(dissonance(a, b)).toBeCloseTo(0, 5);
  });

  it('returns near 1 for maximally opposing beliefs', () => {
    const a = openBelief('x', { surface: 'task', prior: 0.99 });
    const b = openBelief('x', { surface: 'task', prior: 0.01 });
    expect(dissonance(a, b)).toBeGreaterThan(0.9);
  });

  it('is symmetric', () => {
    const a = openBelief('x', { surface: 'task', prior: 0.8 });
    const b = openBelief('x', { surface: 'task', prior: 0.3 });
    expect(dissonance(a, b)).toBeCloseTo(dissonance(b, a), 10);
  });
});

describe('belief-revision: shouldEscalate', () => {
  it('flags genuinely unsure beliefs (posterior near 0.5) for escalation', () => {
    const rec = openBelief('x', { surface: 'task', prior: 0.5 });
    expect(shouldEscalate(rec)).toBe(true);
  });

  it('does not escalate confident beliefs with corroborating evidence', () => {
    let rec = openBelief('x', { surface: 'task', prior: 0.7 });
    for (let i = 0; i < 6; i++) {
      rec = applyEvidence(rec, { source: { kind: `s${i}` }, log_lr: 0.8 });
    }
    expect(rec.posterior).toBeGreaterThan(0.95);
    expect(shouldEscalate(rec)).toBe(false);
  });

  it('escalates when support and opposition are both strong', () => {
    // Active conflict: one strong-supporting and one strong-opposing
    // piece of evidence sitting on the same belief should escalate even
    // if the net posterior happens to land outside the unsure band.
    let rec = openBelief('x', { surface: 'task', prior: 0.85 });
    rec = applyEvidence(rec, { source: { kind: 's1' }, log_lr: 1.5 });
    rec = applyEvidence(rec, { source: { kind: 's2' }, log_lr: -1.5 });
    expect(shouldEscalate(rec)).toBe(true);
  });
});

describe('belief-revision: auditBelief', () => {
  it('reports the strongest support and strongest opposition separately', () => {
    let rec = openBelief('x', { surface: 'task', prior: 0.5 });
    rec = applyEvidence(rec, {
      source: { kind: 'corroborate', ref: 'A' },
      log_lr: 2.0,
    });
    rec = applyEvidence(rec, {
      source: { kind: 'weak-support', ref: 'B' },
      log_lr: 0.3,
    });
    rec = applyEvidence(rec, {
      source: { kind: 'contradict', ref: 'C' },
      log_lr: -1.0,
    });
    const audit = auditBelief(rec);
    expect(audit.strongest_support?.source.ref).toBe('A');
    expect(audit.strongest_oppose?.source.ref).toBe('C');
    expect(audit.evidence_count).toBe(3);
  });

  it('recommends gather_more when fewer than 2 evidence rows and unsure', () => {
    const rec = openBelief('x', { surface: 'task', prior: 0.5 });
    expect(auditBelief(rec).recommendation).toBe('gather_more');
  });

  it('recommends commit when posterior is confident and band is tight', () => {
    let rec = openBelief('x', { surface: 'task', prior: 0.6 });
    for (let i = 0; i < 8; i++) {
      rec = applyEvidence(rec, { source: { kind: `s${i}` }, log_lr: 1.0 });
    }
    expect(auditBelief(rec).recommendation).toBe('commit');
  });
});

describe('belief-revision: InMemoryBeliefStore', () => {
  it('round-trips a belief through save/load', () => {
    const store = new InMemoryBeliefStore();
    const rec = openBelief('x', { surface: 'task', prior: 0.6 });
    store.save(rec);
    const loaded = store.load(rec.id);
    expect(loaded?.claim).toBe('x');
    expect(loaded?.prior).toBe(0.6);
  });

  it('filters list by surface and tag', () => {
    const store = new InMemoryBeliefStore();
    store.save(openBelief('a', { surface: 'task', prior: 0.5, tags: ['briefing'] }));
    store.save(openBelief('b', { surface: 'call', prior: 0.5 }));
    store.save(openBelief('c', { surface: 'task', prior: 0.5, tags: ['briefing'] }));
    expect(store.list({ surface: 'task' }).length).toBe(2);
    expect(store.list({ tag: 'briefing' }).length).toBe(2);
    expect(store.list({ surface: 'call' }).length).toBe(1);
  });

  it('returns a defensive copy on load so external mutations are safe', () => {
    const store = new InMemoryBeliefStore();
    const rec = openBelief('x', { surface: 'task', prior: 0.5 });
    store.save(rec);
    const a = store.load(rec.id);
    if (a) a.claim = 'tampered';
    const b = store.load(rec.id);
    expect(b?.claim).toBe('x');
  });
});

describe('belief-revision: confidenceBand', () => {
  it('shrinks monotonically with accumulated information', () => {
    const w0 = confidenceBand(0.5, 0)[1] - confidenceBand(0.5, 0)[0];
    const w1 = confidenceBand(0.5, 1)[1] - confidenceBand(0.5, 1)[0];
    const w5 = confidenceBand(0.5, 5)[1] - confidenceBand(0.5, 5)[0];
    expect(w0).toBeGreaterThan(w1);
    expect(w1).toBeGreaterThan(w5);
  });
});

describe('belief-revision: detectContradictions', () => {
  function mk(claim: string, posterior: number, surface: 'call' | 'briefing' | 'task' = 'task'): BeliefRecord {
    // Build a record whose posterior matches the requested value by composing
    // openBelief + applyEvidence with a single shaping update.
    const base = openBelief(claim, { surface, prior: 0.5, now: fixedNow });
    // log-odds of posterior - log-odds of 0.5 is exactly probToLogOdds(posterior).
    const lr = probToLogOdds(posterior);
    return applyEvidence(base, { source: { kind: 'test' }, log_lr: lr }, { now: fixedNow });
  }

  it('flags pairs whose claims overlap and posteriors diverge', () => {
    const beliefs = [
      mk('dentist accepts new patients without xrays', 0.8, 'call'),
      mk('dentist accepts new patients without xrays', 0.15, 'call'),
      mk('briefing build went green tonight', 0.9, 'task'),
    ];
    const pairs = detectContradictions(beliefs);
    expect(pairs.length).toBe(1);
    expect(pairs[0].surface).toBe('call');
    expect(pairs[0].dissonance).toBeGreaterThan(0.3);
    expect(pairs[0].claim_overlap).toBeGreaterThan(0.3);
    expect(pairs[0].shared_tokens).toContain('dentist');
  });

  it('ignores low-overlap pairs even when their posteriors disagree', () => {
    const beliefs = [
      mk('alpha bravo charlie', 0.9),
      mk('delta echo foxtrot', 0.1),
    ];
    const pairs = detectContradictions(beliefs);
    expect(pairs.length).toBe(0);
  });

  it('ignores agreeing beliefs about the same proposition', () => {
    const beliefs = [
      mk('briefing went green tonight', 0.92, 'briefing'),
      mk('briefing went green tonight already', 0.88, 'briefing'),
    ];
    const pairs = detectContradictions(beliefs);
    expect(pairs.length).toBe(0);
  });

  it('honors min_overlap=0 when caller already pre-grouped by tag', () => {
    const beliefs = [
      mk('alpha bravo charlie', 0.9),
      mk('delta echo foxtrot', 0.1),
    ];
    const pairs = detectContradictions(beliefs, { min_overlap: 0 });
    expect(pairs.length).toBe(1);
  });

  it('skips cross-surface pairs by default but honors allow_cross_surface', () => {
    const beliefs = [
      mk('dentist accepts new patients', 0.9, 'call'),
      mk('dentist accepts new patients', 0.1, 'briefing'),
    ];
    expect(detectContradictions(beliefs).length).toBe(0);
    expect(detectContradictions(beliefs, { allow_cross_surface: true }).length).toBe(1);
  });

  it('sorts results by descending dissonance and caps at max_results', () => {
    const beliefs = [
      mk('dentist xray policy', 0.95),
      mk('dentist xray policy here', 0.05),
      mk('insurance policy renewal date', 0.9),
      mk('insurance policy renewal date again', 0.2),
    ];
    const pairs = detectContradictions(beliefs, { max_results: 1 });
    expect(pairs.length).toBe(1);
    expect(pairs[0].dissonance).toBeGreaterThanOrEqual(0.5);
  });

  it('produces stable lexical ordering of a_id/b_id', () => {
    const beliefs = [
      mk('dentist xray policy', 0.9),
      mk('dentist xray policy again', 0.1),
    ];
    const pairs = detectContradictions(beliefs);
    expect(pairs.length).toBe(1);
    expect(pairs[0].a_id <= pairs[0].b_id).toBe(true);
  });

  it('formats briefing lines with rounded posteriors and dissonance', () => {
    const beliefs = [
      mk('dentist xray policy', 0.9),
      mk('dentist xray policy again', 0.1),
    ];
    const pairs = detectContradictions(beliefs);
    const lines = formatContradictionsForBriefing(pairs);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^task:.*\d+%.*vs.*\d+%.*dissonance \d+%/);
  });

  it('returns an empty list for an empty input', () => {
    expect(detectContradictions([])).toEqual([]);
    expect(formatContradictionsForBriefing([])).toEqual([]);
  });
});
