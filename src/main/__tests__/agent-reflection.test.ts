import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReflection, appendReflection, readReflections } from '../agent-reflection';

describe('agent-reflection', () => {
  it('builds a record with required fields', () => {
    const r = buildReflection(
      'dentist-call',
      'book a cleaning without x-rays',
      ['researched 5 clinics', 'called 3'],
      'partial',
      ['script too formal'],
    );
    expect(r.task).toBe('dentist-call');
    expect(r.outcome).toBe('partial');
    expect(r.steps).toHaveLength(2);
    expect(r.related_files).toBeUndefined();
    expect(new Date(r.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('includes related_files when provided', () => {
    const r = buildReflection('x', 'y', [], 'success', [], ['a.ts', 'b.ts']);
    expect(r.related_files).toEqual(['a.ts', 'b.ts']);
  });

  it('appends and reads back JSONL records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-'));
    const file = path.join(dir, 'nested', 'log.jsonl');
    appendReflection(file, buildReflection('t1', 'g1', ['s1'], 'success', []));
    appendReflection(file, buildReflection('t2', 'g2', ['s2'], 'failure', ['l2']));
    const all = readReflections(file);
    expect(all).toHaveLength(2);
    expect(all[0].task).toBe('t1');
    expect(all[1].outcome).toBe('failure');
    expect(all[1].learnings).toEqual(['l2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array for missing log', () => {
    expect(readReflections('/nonexistent/path/log.jsonl')).toEqual([]);
  });
});
