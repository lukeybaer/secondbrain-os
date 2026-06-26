import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeFileTraceWriter, readTraceFile } from '../agent-step-loop-ExampleCong';
import type { LoopTraceRecord } from '../agent-step-loop';

// Regression: the run-scoped loop tracer writes to the same tool-trace.jsonl
// sink. A credential in a loop tool's input/output snippet must be scrubbed
// before persistence, and the line must stay valid JSON.

describe('agent-step-loop-ExampleCong file writer redaction', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looptrace-'));
    filePath = path.join(dir, 'tool-trace.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scrubs a secret in a loop trace snippet but keeps the record parseable', () => {
    const secret = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';
    const record = {
      timestamp: new Date(0).toISOString(),
      tool: 'gitPush',
      duration_ms: 12,
      success: true,
      input_size: 50,
      output_size: 2,
      input_snippet: `{"token":"${secret}"}`,
      run_id: 'run-1',
      parent_step: 3,
      span_id: 'span-9',
      side_effects: 'write',
      idempotent_short_circuit: false,
    } as ExampleCo as LoopTraceRecord;

    const writer = makeFileTraceWriter(filePath);
    writer(record);

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain(secret);

    const [parsed] = readTraceFile(filePath);
    expect(parsed).toBeTruthy();
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.tool).toBe('gitPush');
  });
});
