import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  summarizeToolHealth,
  readToolHealth,
  unhealthyTools,
  summarizeToolHealthLine,
} from '../tool-health-summary';
import { ToolTraceRecord } from '../tool-trace';

function rec(
  tool: string,
  success: boolean,
  duration_ms: number,
  timestamp = '2026-05-17T00:00:00.000Z',
): ToolTraceRecord {
  return {
    timestamp,
    tool,
    duration_ms,
    success,
    input_size: 0,
    output_size: 0,
    ...(success ? {} : { error: 'boom' }),
  };
}

describe('summarizeToolHealth', () => {
  it('computes success rate and call counts per tool', () => {
    const recs = [
      rec('gmail.search', true, 100),
      rec('gmail.search', true, 200),
      rec('gmail.search', false, 50),
      rec('gmail.search', true, 150),
    ];
    const summary = summarizeToolHealth(recs);
    expect(summary).toHaveLength(1);
    expect(summary[0].calls).toBe(4);
    expect(summary[0].failures).toBe(1);
    expect(summary[0].success_rate).toBe(0.75);
  });

  it('classifies a fully-failing tool as failing', () => {
    const recs = [
      rec('vapi.call', false, 10),
      rec('vapi.call', false, 20),
      rec('vapi.call', false, 30),
    ];
    expect(summarizeToolHealth(recs)[0].status).toBe('failing');
  });

  it('classifies a mostly-working tool as degraded', () => {
    const recs = [
      ...Array.from({ length: 8 }, () => rec('x', true, 10)),
      rec('x', false, 10),
      rec('x', false, 10),
    ];
    // 8/10 = 0.8 success -> below 0.9 degraded threshold, above 0.5.
    expect(summarizeToolHealth(recs)[0].status).toBe('degraded');
  });

  it('classifies a clean tool as healthy', () => {
    const recs = Array.from({ length: 5 }, () => rec('y', true, 10));
    expect(summarizeToolHealth(recs)[0].status).toBe('healthy');
  });

  it('does not condemn a tool with too few calls as failing', () => {
    const recs = [rec('z', false, 10), rec('z', true, 10)];
    // Only 2 calls, below MIN_CALLS_FOR_VERDICT -> degraded, not failing.
    expect(summarizeToolHealth(recs)[0].status).toBe('degraded');
  });

  it('computes p50 and p95 latency', () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const recs = durations.map((d) => rec('lat', true, d));
    const summary = summarizeToolHealth(recs);
    expect(summary[0].p50_ms).toBe(55);
    expect(summary[0].p95_ms).toBeGreaterThanOrEqual(90);
    expect(summary[0].p95_ms).toBeLessThanOrEqual(100);
  });

  it('sorts worst-first: failing before degraded before healthy', () => {
    const recs = [
      ...Array.from({ length: 5 }, () => rec('good', true, 10)),
      rec('bad', false, 10),
      rec('bad', false, 10),
      rec('bad', false, 10),
    ];
    const summary = summarizeToolHealth(recs);
    expect(summary[0].tool).toBe('bad');
    expect(summary[0].status).toBe('failing');
    expect(summary[1].tool).toBe('good');
  });

  it('returns empty array for empty input', () => {
    expect(summarizeToolHealth([])).toEqual([]);
  });
});

describe('readToolHealth', () => {
  it('reads traces from a jsonl file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolhealth-'));
    const tracePath = path.join(dir, 'tool-trace.jsonl');
    const lines = [
      JSON.stringify(rec('a', true, 10)),
      JSON.stringify(rec('a', false, 20)),
      'garbage line',
    ];
    fs.writeFileSync(tracePath, lines.join('\n') + '\n');
    const summary = readToolHealth(tracePath);
    expect(summary).toHaveLength(1);
    expect(summary[0].calls).toBe(2);
  });

  it('returns empty for a missing file', () => {
    expect(readToolHealth('/no/such/file.jsonl')).toEqual([]);
  });
});

describe('unhealthyTools', () => {
  it('filters out healthy tools', () => {
    const recs = [
      ...Array.from({ length: 5 }, () => rec('good', true, 10)),
      rec('bad', false, 10),
      rec('bad', false, 10),
      rec('bad', false, 10),
    ];
    const unhealthy = unhealthyTools(summarizeToolHealth(recs));
    expect(unhealthy).toHaveLength(1);
    expect(unhealthy[0].tool).toBe('bad');
  });
});

describe('summarizeToolHealthLine', () => {
  it('reports all healthy', () => {
    const recs = Array.from({ length: 4 }, () => rec('ok', true, 10));
    expect(summarizeToolHealthLine(summarizeToolHealth(recs))).toContain('healthy');
  });

  it('reports failing and degraded counts', () => {
    const recs = [
      rec('f', false, 10),
      rec('f', false, 10),
      rec('f', false, 10),
      ...Array.from({ length: 8 }, () => rec('d', true, 10)),
      rec('d', false, 10),
      rec('d', false, 10),
    ];
    const line = summarizeToolHealthLine(summarizeToolHealth(recs));
    expect(line).toContain('1 failing');
    expect(line).toContain('1 degraded');
  });

  it('handles empty input', () => {
    expect(summarizeToolHealthLine([])).toBe('No tool activity in window.');
  });
});
