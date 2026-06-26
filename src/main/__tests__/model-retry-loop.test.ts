import { describe, it, expect } from 'vitest';
import {
  runWithModelRetry,
  ModelRetry,
  RetryExhaustedError,
  RetryBudget,
  buildCorrectionPrompt,
  buildSemanticCorrectionPrompt,
  type RetryAttemptRecord,
} from '../model-retry-loop';
import { validate, type Schema } from '../preflight-validator';

const phoneSchema: Schema = {
  type: 'object',
  required: ['phone'],
  properties: { phone: { type: 'string', pattern: '^\\+1\\d{10}$' } },
};

const fixedClock = () => 1_700_000_000_000;

describe('model-retry-loop', () => {
  it('succeeds on the first attempt with no corrections', async () => {
    const records: RetryAttemptRecord[] = [];
    const res = await runWithModelRetry<{ phone: string }, string>({
      toolName: 'dial',
      initialArgs: { phone: '+15555550100' },
      validate: (a) => validate(a, phoneSchema),
      regenerate: async () => {
        throw new Error('should not be called');
      },
      execute: async (a) => `dialed ${a.phone}`,
      writer: (r) => records.push(r),
      now: fixedClock,
    });
    expect(res.result).toBe('dialed +15555550100');
    expect(res.attempts).toBe(1);
    expect(res.corrections).toBe(0);
    expect(records[0].terminal).toBe('ok');
    expect(records[0].corrections).toBe(0);
  });

  it('feeds the violation back and succeeds after a bounded correction', async () => {
    const prompts: string[] = [];
    const res = await runWithModelRetry<{ phone: string }, string>({
      toolName: 'dial',
      initialArgs: { phone: '5555550100' }, // missing +1, fails pattern
      validate: (a) => validate(a, phoneSchema),
      regenerate: async (prompt) => {
        prompts.push(prompt);
        return { phone: '+15555550100' }; // model fixes it
      },
      execute: async (a) => `dialed ${a.phone}`,
      now: fixedClock,
    });
    expect(res.result).toBe('dialed +15555550100');
    expect(res.attempts).toBe(2);
    expect(res.corrections).toBe(1);
    // the correction prompt names the failing field and rule
    expect(prompts[0]).toContain('dial');
    expect(prompts[0]).toContain('pattern');
    expect(prompts[0]).toContain('phone');
  });

  it('fails loud with RetryExhaustedError when the model never fixes it', async () => {
    let regenCalls = 0;
    await expect(
      runWithModelRetry<{ phone: string }, string>({
        toolName: 'dial',
        initialArgs: { phone: 'bad' },
        validate: (a) => validate(a, phoneSchema),
        regenerate: async () => {
          regenCalls += 1;
          return { phone: 'still-bad' }; // never valid
        },
        execute: async () => 'unreachable',
        policy: { perToolMax: 2, aggregateMax: 8 },
        now: fixedClock,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    // perToolMax=2 => 1 initial + 2 corrections = 2 regenerate calls
    expect(regenCalls).toBe(2);
  });

  it('honors a semantic ModelRetry from execute()', async () => {
    let attempt = 0;
    const res = await runWithModelRetry<{ contact: string }, string>({
      toolName: 'email',
      initialArgs: { contact: 'ghost' },
      validate: () => ({ valid: true, violations: [] }), // type-valid
      regenerate: async () => ({ contact: 'real-person' }),
      execute: async (a) => {
        attempt += 1;
        if (a.contact === 'ghost') throw new ModelRetry('no contact named ghost exists');
        return `emailed ${a.contact}`;
      },
      now: fixedClock,
    });
    expect(res.result).toBe('emailed real-person');
    expect(res.corrections).toBe(1);
    expect(attempt).toBe(2);
  });

  it('shares an aggregate cap across multiple tools', () => {
    const budget = new RetryBudget({ perToolMax: 5, aggregateMax: 2 });
    expect(budget.canRetry('a')).toBe(true);
    budget.consume('a');
    expect(budget.canRetry('b')).toBe(true);
    budget.consume('b');
    // aggregate of 2 reached even though per-tool caps are far from hit
    expect(budget.canRetry('a')).toBe(false);
    expect(budget.canRetry('c')).toBe(false);
    expect(budget.totalUsed()).toBe(2);
  });

  it('propagates non-ModelRetry execute errors unchanged (not a retry signal)', async () => {
    await expect(
      runWithModelRetry({
        toolName: 'boom',
        initialArgs: {},
        validate: () => ({ valid: true, violations: [] }),
        regenerate: async () => ({}),
        execute: async () => {
          throw new Error('real bug');
        },
        now: fixedClock,
      }),
    ).rejects.toThrow('real bug');
  });

  it('emits an exhausted_validation terminal record on give-up', async () => {
    const records: RetryAttemptRecord[] = [];
    await runWithModelRetry({
      toolName: 'dial',
      initialArgs: { phone: 'x' },
      validate: (a) => validate(a, phoneSchema),
      regenerate: async () => ({ phone: 'y' }),
      execute: async () => 'no',
      policy: { perToolMax: 1, aggregateMax: 8 },
      writer: (r) => records.push(r),
      now: fixedClock,
    }).catch(() => {});
    expect(records).toHaveLength(1);
    expect(records[0].terminal).toBe('exhausted_validation');
    expect(records[0].violationRules).toContain('pattern');
  });

  it('builds correction prompts that count down the budget', () => {
    const p = buildCorrectionPrompt(
      'dial',
      [{ path: 'phone', rule: 'pattern', message: 'bad', got: '9' }],
      1,
      2,
    );
    expect(p).toContain('Attempt 1 of 2');
    expect(p).toContain('1 correction(s) left');
    const s = buildSemanticCorrectionPrompt('email', 'no such contact', 2, 2);
    expect(s).toContain('no such contact');
    expect(s).toContain('0 left');
  });
});
