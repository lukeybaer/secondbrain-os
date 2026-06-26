import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  traceTool,
  makeFileWriter,
  readRecentTraces,
  readRecentFailures,
  ToolTraceRecord,
} from '../tool-trace';

describe('tool-trace', () => {
  it('records a successful invocation', async () => {
    const records: ToolTraceRecord[] = [];
    const writer = (r: ToolTraceRecord) => records.push(r);
    const result = await traceTool('add', { a: 1, b: 2 }, async () => 3, writer);
    expect(result).toBe(3);
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('add');
    expect(records[0].success).toBe(true);
    expect(records[0].input_size).toBeGreaterThan(0);
    expect(records[0].output_size).toBeGreaterThan(0);
    expect(records[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records and re-throws on failure', async () => {
    const records: ToolTraceRecord[] = [];
    const writer = (r: ToolTraceRecord) => records.push(r);
    await expect(
      traceTool(
        'boom',
        null,
        async () => {
          throw new Error('nope');
        },
        writer,
      ),
    ).rejects.toThrow('nope');
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
    expect(records[0].error).toBe('nope');
  });

  it('file writer appends JSONL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-trace-'));
    const file = path.join(dir, 'sub', 'trace.jsonl');
    const writer = makeFileWriter(file);
    await traceTool('a', {}, async () => 1, writer);
    await traceTool('b', {}, async () => 2, writer);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe('a');
    expect(JSON.parse(lines[1]).tool).toBe('b');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures input_snippet and output_snippet', async () => {
    const records: ToolTraceRecord[] = [];
    const writer = (r: ToolTraceRecord) => records.push(r);
    await traceTool('snap', { key: 'value' }, async () => ({ result: 'ok' }), writer);
    expect(records[0].input_snippet).toBeDefined();
    expect(records[0].output_snippet).toBeDefined();
    expect(records[0].input_snippet).toContain('value');
    expect(records[0].output_snippet).toContain('ok');
  });

  it('truncates long snippets at 200 chars', async () => {
    const longInput = 'x'.repeat(500);
    const records: ToolTraceRecord[] = [];
    const writer = (r: ToolTraceRecord) => records.push(r);
    await traceTool('long', longInput, async () => longInput, writer);
    expect(records[0].input_snippet!.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(records[0].output_snippet!.length).toBeLessThanOrEqual(203);
  });

  it('failure trace has input_snippet but no output_snippet', async () => {
    const records: ToolTraceRecord[] = [];
    const writer = (r: ToolTraceRecord) => records.push(r);
    await expect(
      traceTool('fail', { x: 1 }, async () => { throw new Error('fail'); }, writer),
    ).rejects.toThrow();
    expect(records[0].input_snippet).toBeDefined();
    expect(records[0].output_snippet).toBeUndefined();
  });

  it('readRecentTraces returns records newest-first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    const writer = makeFileWriter(file);
    await traceTool('first', {}, async () => 1, writer);
    await traceTool('second', {}, async () => 2, writer);
    const traces = readRecentTraces(file, 10);
    expect(traces).toHaveLength(2);
    expect(traces[0].tool).toBe('second'); // newest first
    expect(traces[1].tool).toBe('first');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readRecentTraces returns empty for missing file', () => {
    const traces = readRecentTraces('/nonexistent/path/trace.jsonl', 10);
    expect(traces).toHaveLength(0);
  });

  it('readRecentFailures filters to errors only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    const writer = makeFileWriter(file);
    await traceTool('ok', {}, async () => 1, writer);
    await expect(
      traceTool('broken', {}, async () => { throw new Error('oops'); }, writer),
    ).rejects.toThrow();
    const failures = readRecentFailures(file, 1); // 1-hour window
    expect(failures).toHaveLength(1);
    expect(failures[0].tool).toBe('broken');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
