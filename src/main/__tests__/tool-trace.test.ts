import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { traceTool, makeFileWriter, ToolTraceRecord } from '../tool-trace';

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
});
