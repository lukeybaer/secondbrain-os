import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRetryPressureReport,
  readAttemptRecords,
  summarizeRetryPressure,
  DEFAULT_THRESHOLDS,
} from '../retry-pressure-report';
import type { RetryAttemptRecord } from '../model-retry-loop';

function rec(
  toolName: string,
  attempts: number,
  terminal: RetryAttemptRecord['terminal'],
  rules: string[] = [],
): RetryAttemptRecord {
  return {
    timestamp: '2026-06-03T00:00:00.000Z',
    toolName,
    attempts,
    corrections: Math.max(0, attempts - 1),
    terminal,
    violationRules: rules,
  };
}

describe('retry-pressure-report', () => {
  it('aggregates per-tool correction and exhaustion rates', () => {
    const report = buildRetryPressureReport([
      rec('dial', 1, 'ok'),
      rec('dial', 2, 'ok', ['pattern']),
      rec('dial', 3, 'exhausted_validation', ['pattern', 'required']),
      rec('email', 1, 'ok'),
    ]);
    const dial = report.tools.find((t) => t.toolName === 'dial')!;
    expect(dial.calls).toBe(3);
    expect(dial.totalCorrections).toBe(0 + 1 + 2);
    expect(dial.avgCorrectionsPerCall).toBeCloseTo(1, 5);
    expect(dial.exhausted).toBe(1);
    expect(dial.exhaustionRate).toBeCloseTo(1 / 3, 5);
    expect(dial.topRules[0].rule).toBe('pattern'); // fired twice
    expect(report.totalCalls).toBe(4);
  });

  it('ranks worst-first: an exhausting tool beats a merely chatty one', () => {
    const report = buildRetryPressureReport([
      // 'chatty' needs lots of corrections but always succeeds
      rec('chatty', 3, 'ok', ['type']),
      rec('chatty', 3, 'ok', ['type']),
      rec('chatty', 3, 'ok', ['type']),
      // 'giverupper' exhausts once
      rec('giverupper', 1, 'ok'),
      rec('giverupper', 3, 'exhausted_validation', ['required']),
    ]);
    expect(report.tools[0].toolName).toBe('giverupper');
  });

  it('flags tools over threshold, ignoring low-signal tools', () => {
    const report = buildRetryPressureReport(
      [
        // high pressure but only 2 calls => below minCalls, not flagged
        rec('rare', 3, 'exhausted_validation', ['required']),
        rec('rare', 3, 'exhausted_validation', ['required']),
        // clean tool, never flagged
        rec('clean', 1, 'ok'),
        rec('clean', 1, 'ok'),
        rec('clean', 1, 'ok'),
        // chronic offender, enough calls
        rec('chronic', 3, 'ok', ['pattern']),
        rec('chronic', 3, 'ok', ['pattern']),
        rec('chronic', 2, 'exhausted_validation', ['pattern']),
      ],
      DEFAULT_THRESHOLDS,
    );
    const flaggedNames = report.flagged.map((f) => f.toolName);
    expect(flaggedNames).toContain('chronic');
    expect(flaggedNames).not.toContain('clean');
    expect(flaggedNames).not.toContain('rare'); // below minCalls
  });

  it('summarizes flagged tools into briefing one-liners', () => {
    const report = buildRetryPressureReport([
      rec('chronic', 3, 'ok', ['pattern']),
      rec('chronic', 3, 'ok', ['pattern']),
      rec('chronic', 2, 'exhausted_validation', ['pattern']),
    ]);
    const lines = summarizeRetryPressure(report);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('chronic');
    expect(lines[0]).toContain('corrections/call');
    expect(lines[0]).toContain('pattern');
  });

  it('returns no flagged lines when every tool is clean', () => {
    const report = buildRetryPressureReport([
      rec('a', 1, 'ok'),
      rec('a', 1, 'ok'),
      rec('a', 1, 'ok'),
    ]);
    expect(summarizeRetryPressure(report)).toEqual([]);
  });

  it('reads JSONL records, tolerating blank and corrupt lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrylog-'));
    const f = path.join(dir, 'attempts.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify(rec('dial', 2, 'ok', ['pattern'])),
        '',
        'not valid json {{{',
        JSON.stringify(rec('dial', 1, 'ok')),
      ].join('\n'),
    );
    const records = readAttemptRecords(f);
    expect(records).toHaveLength(2);
    expect(records[0].toolName).toBe('dial');
  });

  it('returns [] for a missing log file', () => {
    expect(readAttemptRecords('/no/such/path/attempts.jsonl')).toEqual([]);
  });
});
