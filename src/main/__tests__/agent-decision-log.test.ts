import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DecisionLog, recordNoAction } from '../agent-decision-log';

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
  return path.join(dir, 'agent-decisions.jsonl');
}

describe('DecisionLog', () => {
  it('records a decision and reads it back', () => {
    const log = new DecisionLog(tempLog());
    const record = log.decide(
      'health-self-heal',
      's3Parity',
      [{ condition: 'canAutoHeal', result: true }, { condition: 'retryCount < 3', result: false }],
      'escalate',
      'retry count exhausted',
    );
    expect(record.decision_id).toHaveLength(12);
    expect(record.decision).toBe('escalate');
    expect(record.probe).toBe('s3Parity');
    expect(record.outcome).toBe('pending');
    expect(record.conditions_evaluated).toHaveLength(2);

    const all = log.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].decision_id).toBe(record.decision_id);
  });

  it('resolveOutcome appends an updated record', () => {
    const log = new DecisionLog(tempLog());
    const record = log.decide('task', 'probe', [], 'heal', 'trying');
    log.resolveOutcome(record.decision_id, 'success', 'sync completed');

    const all = log.readAll();
    expect(all).toHaveLength(2); // original + resolved
    const resolved = all[all.length - 1];
    expect(resolved.decision_id).toBe(record.decision_id);
    expect(resolved.outcome).toBe('success');
    expect(resolved.outcome_detail).toBe('sync completed');
    expect(resolved.outcome_at).toBeTruthy();
  });

  it('resolveOutcome is a no-op for unknown decision_id', () => {
    const log = new DecisionLog(tempLog());
    log.resolveOutcome('nonexistent-id', 'failure');
    expect(log.readAll()).toHaveLength(0);
  });

  it('lastDecisionFor returns most recent for task+probe pair', () => {
    const log = new DecisionLog(tempLog());
    log.decide('task', 'probe-a', [], 'heal', 'first');
    log.decide('task', 'probe-a', [], 'skip', 'second');
    log.decide('task', 'probe-b', [], 'escalate', 'other');

    const last = log.lastDecisionFor('task', 'probe-a');
    expect(last?.reason).toBe('second');
    expect(last?.decision).toBe('skip');
  });

  it('lastDecisionFor returns null when no match', () => {
    const log = new DecisionLog(tempLog());
    expect(log.lastDecisionFor('task', 'no-such-probe')).toBeNull();
  });

  it('countRecentDecisions counts by type within time window', () => {
    const log = new DecisionLog(tempLog());
    log.decide('task', 'probe', [], 'heal', 'r1');
    log.decide('task', 'probe', [], 'heal', 'r2');
    log.decide('task', 'probe', [], 'skip', 'r3');

    const healCount = log.countRecentDecisions('task', 'probe', 'heal', 24);
    expect(healCount).toBe(2);
    const skipCount = log.countRecentDecisions('task', 'probe', 'skip', 24);
    expect(skipCount).toBe(1);
    const escalateCount = log.countRecentDecisions('task', 'probe', 'escalate', 24);
    expect(escalateCount).toBe(0);
  });

  it('summarizeSince aggregates decisions by type', () => {
    const log = new DecisionLog(tempLog());
    log.decide('task', 'p1', [], 'heal', 'a');
    log.decide('task', 'p2', [], 'escalate', 'b');
    log.decide('task', 'p3', [], 'escalate', 'c');
    log.decide('task', 'p4', [], 'no_action', 'd');

    const summary = log.summarizeSince(24);
    expect(summary.total).toBe(4);
    expect(summary.byDecision.heal).toBe(1);
    expect(summary.byDecision.escalate).toBe(2);
    expect(summary.escalations).toHaveLength(2);
  });

  it('recordNoAction convenience function works', () => {
    const logPath = tempLog();
    recordNoAction(logPath, 'health-self-heal', 'backups');
    const log = new DecisionLog(logPath);
    const all = log.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].decision).toBe('no_action');
  });

  it('appendHeartbeat never throws on unwritable path', () => {
    const log = new DecisionLog('/nonexistent/readonly/path/log.jsonl');
    expect(() => log.decide('t', 'p', [], 'skip', 'r')).not.toThrow();
  });
});
