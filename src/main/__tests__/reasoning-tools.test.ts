import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  REASONING_TOOLS,
  executeReasoningTool,
  readReasoning,
  isReasoningTool,
  appendReasoning,
} from '../reasoning-tools';

describe('reasoning-tools', () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-trace-'));
    logPath = path.join(dir, 'reasoning-trace.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes think and analyze as Anthropic tool definitions', () => {
    const names = REASONING_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['analyze', 'think']);
    for (const tool of REASONING_TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
      expect(tool.input_schema.required.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('think appends a record with kind=think and conclusion=plan', () => {
    const result = executeReasoningTool(
      'think',
      { thought: 'Dentist call needs new framing.', plan: 'Rewrite script before next dial.' },
      { logPath, source: 'dentist-project', turn_id: 'turn_1' },
    );
    expect(result.success).toBe(true);
    expect(result.record?.kind).toBe('think');
    expect(result.record?.conclusion).toBe('Rewrite script before next dial.');
    expect(result.record?.source).toBe('dentist-project');
    expect(result.record?.turn_id).toBe('turn_1');

    const records = readReasoning(logPath);
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe('Dentist call needs new framing.');
  });

  it('analyze appends a record with kind=analyze and observation/conclusion', () => {
    const result = executeReasoningTool(
      'analyze',
      {
        observation: 'Twelve dentists declined without prior x-rays.',
        conclusion: 'Switch from cleaning to consult-only request.',
      },
      { logPath },
    );
    expect(result.success).toBe(true);
    expect(result.record?.kind).toBe('analyze');
    expect(result.record?.body).toContain('Twelve dentists');
    expect(result.record?.conclusion).toContain('consult-only');
  });

  it('rejects missing required fields without writing to the log', () => {
    const r1 = executeReasoningTool('think', { thought: 'x' }, { logPath });
    expect(r1.success).toBe(false);
    expect(r1.output).toMatch(/plan is required/);

    const r2 = executeReasoningTool('analyze', { conclusion: 'x' }, { logPath });
    expect(r2.success).toBe(false);
    expect(r2.output).toMatch(/observation is required/);

    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('rejects unknown tool names', () => {
    const result = executeReasoningTool('ruminate', { thought: 'x', plan: 'y' }, { logPath });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Unknown reasoning tool/);
  });

  it('isReasoningTool identifies only the canonical names', () => {
    expect(isReasoningTool('think')).toBe(true);
    expect(isReasoningTool('analyze')).toBe(true);
    expect(isReasoningTool('memory_search')).toBe(false);
    expect(isReasoningTool('hallucinate')).toBe(false);
  });

  it('appendReasoning writes raw records to the ledger', () => {
    appendReasoning(logPath, { kind: 'think', body: 'a', conclusion: 'b' });
    appendReasoning(logPath, { kind: 'analyze', body: 'c', conclusion: 'd' });
    const records = readReasoning(logPath);
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('think');
    expect(records[1].kind).toBe('analyze');
    expect(records[0].reasoning_id).not.toBe(records[1].reasoning_id);
  });
});
