import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildObservabilityDigest } from '../observability-digest';
import { ToolTraceRecord } from '../tool-trace';

function rec(
  tool: string,
  success: boolean,
  duration_ms: number,
  error?: string,
): ToolTraceRecord {
  return {
    timestamp: new Date().toISOString(),
    tool,
    duration_ms,
    success,
    input_size: 0,
    output_size: 0,
    ...(success ? {} : { error: error ?? 'failure' }),
  };
}

function writeTrace(records: ToolTraceRecord[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsdigest-'));
  const tracePath = path.join(dir, 'tool-trace.jsonl');
  fs.writeFileSync(tracePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return tracePath;
}

describe('buildObservabilityDigest', () => {
  it('reports all-clear when every tool is healthy', () => {
    const tracePath = writeTrace(Array.from({ length: 6 }, () => rec('gmail.search', true, 50)));
    const digest = buildObservabilityDigest(tracePath);
    expect(digest.all_clear).toBe(true);
    expect(digest.tier1).toContain('healthy');
    expect(digest.tier2).toEqual(['Nothing needs attention.']);
  });

  it('surfaces a failing tool in all three tiers', () => {
    const tracePath = writeTrace([
      rec('vapi.call', false, 100, 'connection refused'),
      rec('vapi.call', false, 100, 'connection refused'),
      rec('vapi.call', false, 100, 'connection refused'),
    ]);
    const digest = buildObservabilityDigest(tracePath);
    expect(digest.all_clear).toBe(false);
    expect(digest.tier1).toContain('failing');
    expect(digest.tier2.some((l) => l.includes('vapi.call'))).toBe(true);
    expect(digest.tier3.unhealthy[0].tool).toBe('vapi.call');
    expect(digest.tier3.error_clusters[0].count).toBe(3);
  });

  it('clusters identical errors into one tier-2 line', () => {
    const tracePath = writeTrace([
      rec('a', false, 10, 'timeout after 100ms'),
      rec('b', false, 10, 'timeout after 900ms'),
      rec('c', false, 10, 'timeout after 5ms'),
    ]);
    const digest = buildObservabilityDigest(tracePath);
    const clusterLines = digest.tier2.filter((l) => l.startsWith('Error cluster'));
    expect(clusterLines).toHaveLength(1);
    expect(clusterLines[0]).toContain('x3');
  });

  it('counts total calls and failures', () => {
    const tracePath = writeTrace([
      rec('t', true, 10),
      rec('t', true, 10),
      rec('t', false, 10),
    ]);
    const digest = buildObservabilityDigest(tracePath);
    expect(digest.tier3.total_calls).toBe(3);
    expect(digest.tier3.total_failures).toBe(1);
  });

  it('handles an empty / missing trace file', () => {
    const digest = buildObservabilityDigest('/no/such/trace.jsonl');
    expect(digest.tier1).toContain('no tool activity');
    expect(digest.all_clear).toBe(true);
    expect(digest.tier3.total_calls).toBe(0);
  });

  it('ExampleCos window_hours and a generated_at timestamp', () => {
    const tracePath = writeTrace([rec('t', true, 10)]);
    const digest = buildObservabilityDigest(tracePath, 12);
    expect(digest.window_hours).toBe(12);
    expect(() => new Date(digest.generated_at).toISOString()).not.toThrow();
  });
});
