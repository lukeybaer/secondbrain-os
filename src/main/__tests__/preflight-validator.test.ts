// preflight-validator.test.ts
//
// Tests the schema-as-data validator and the pre-built schemas for SecondBrain
// outbound tools. Frugal: no fixtures, no network. Each test exercises one
// rule in isolation plus a few integration tests over the real schemas.

import { describe, it, expect } from 'vitest';
import {
  validate,
  assertValid,
  preflight,
  PreflightError,
  vapiInitiateCallSchema,
  gmailSendSchema,
  telegramSendSchema,
  E164_PATTERN,
  EMAIL_PATTERN,
  type Schema,
} from '../preflight-validator';

describe('validate: type checking', () => {
  it('passes a matching primitive', () => {
    expect(validate('hi', { type: 'string' }).valid).toBe(true);
    expect(validate(42, { type: 'integer' }).valid).toBe(true);
    expect(validate(3.14, { type: 'number' }).valid).toBe(true);
    expect(validate(true, { type: 'boolean' }).valid).toBe(true);
    expect(validate(null, { type: 'null' }).valid).toBe(true);
  });

  it('integer satisfies number, but not the reverse', () => {
    expect(validate(42, { type: 'number' }).valid).toBe(true);
    expect(validate(3.14, { type: 'integer' }).valid).toBe(false);
  });

  it('union types accept any of the listed types', () => {
    const s: Schema = { type: ['string', 'number'] };
    expect(validate('x', s).valid).toBe(true);
    expect(validate(1, s).valid).toBe(true);
    expect(validate(true, s).valid).toBe(false);
  });

  it('mismatch produces a single rule:type violation', () => {
    const r = validate(42, { type: 'string' });
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].rule).toBe('type');
  });
});

describe('validate: enum / pattern / length / range', () => {
  it('enum rejects out-of-set values', () => {
    const r = validate('purple', { type: 'string', enum: ['red', 'green', 'blue'] });
    expect(r.violations[0].rule).toBe('enum');
  });

  it('pattern rejects non-matching strings', () => {
    const r = validate('not-a-number', { type: 'string', pattern: '^\\d+$' });
    expect(r.violations[0].rule).toBe('pattern');
  });

  it('invalid pattern surfaces as a violation, not a thrown error', () => {
    const r = validate('x', { type: 'string', pattern: '[' });
    expect(r.valid).toBe(false);
    expect(r.violations[0].rule).toBe('pattern');
  });

  it('minLength / maxLength bound string length', () => {
    expect(validate('a', { type: 'string', minLength: 2 }).valid).toBe(false);
    expect(validate('abcdef', { type: 'string', maxLength: 3 }).valid).toBe(false);
    expect(validate('ab', { type: 'string', minLength: 2, maxLength: 3 }).valid).toBe(true);
  });

  it('minimum / maximum bound numbers', () => {
    expect(validate(5, { type: 'integer', minimum: 10 }).valid).toBe(false);
    expect(validate(15, { type: 'integer', maximum: 10 }).valid).toBe(false);
    expect(validate(10, { type: 'integer', minimum: 5, maximum: 15 }).valid).toBe(true);
  });
});

describe('validate: object schema', () => {
  const personSchema: Schema = {
    type: 'object',
    required: ['name', 'age'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer', minimum: 0 },
      email: { type: 'string', pattern: EMAIL_PATTERN },
    },
    additionalProperties: false,
  };

  it('reports all missing required keys, not just the first', () => {
    const r = validate({}, personSchema);
    const missing = r.violations.filter((v) => v.rule === 'required').map((v) => v.path);
    expect(missing).toContain('name');
    expect(missing).toContain('age');
  });

  it('descends into nested properties', () => {
    const r = validate({ name: '', age: -1 }, personSchema);
    const paths = r.violations.map((v) => v.path);
    expect(paths).toContain('name');
    expect(paths).toContain('age');
  });

  it('rejects unexpected keys when additionalProperties is false', () => {
    const r = validate({ name: 'a', age: 1, extra: 1 }, personSchema);
    const extra = r.violations.find((v) => v.rule === 'additionalProperties');
    expect(extra?.path).toBe('extra');
  });

  it('allows unexpected keys when additionalProperties defaults to true', () => {
    const open: Schema = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    expect(validate({ a: 'x', b: 'y' }, open).valid).toBe(true);
  });
});

describe('validate: array schema', () => {
  const numbersSchema: Schema = {
    type: 'array',
    items: { type: 'integer', minimum: 0 },
    minItems: 1,
    maxItems: 3,
  };

  it('passes a valid array', () => {
    expect(validate([1, 2, 3], numbersSchema).valid).toBe(true);
  });

  it('reports out-of-range item with index in path', () => {
    const r = validate([1, -5, 3], numbersSchema);
    expect(r.violations[0].path).toBe('[1]');
    expect(r.violations[0].rule).toBe('minimum');
  });

  it('enforces minItems and maxItems', () => {
    expect(validate([], numbersSchema).valid).toBe(false);
    expect(validate([1, 2, 3, 4], numbersSchema).valid).toBe(false);
  });
});

describe('validate: predicate', () => {
  it('predicate true means valid', () => {
    const s: Schema = {
      type: 'string',
      predicate: (v) => ((v as string).startsWith('+1') ? true : 'must start with +1'),
    };
    expect(validate('+15551234567', s).valid).toBe(true);
  });

  it('predicate string return is the violation message', () => {
    const s: Schema = { type: 'string', predicate: () => 'must be a US number' };
    const r = validate('+447777777777', s);
    expect(r.violations[0].rule).toBe('predicate');
    expect(r.violations[0].message).toBe('must be a US number');
  });
});

describe('assertValid + PreflightError', () => {
  it('passes silently when valid', () => {
    expect(() => assertValid('t', { name: 'x' }, { type: 'object', required: ['name'] })).not.toThrow();
  });

  it('throws PreflightError with violations attached', () => {
    try {
      assertValid('t', {}, { type: 'object', required: ['x', 'y'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PreflightError);
      expect((e as PreflightError).violations).toHaveLength(2);
      expect((e as PreflightError).message).toContain('preflight failed for t');
    }
  });

  it('error message truncates after 5 violations', () => {
    const schema: Schema = {
      type: 'object',
      required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    };
    try {
      assertValid('t', {}, schema);
    } catch (e) {
      expect((e as PreflightError).message).toContain('+2 more');
    }
  });
});

describe('preflight wrapper', () => {
  it('runs the action when valid', async () => {
    const r = await preflight(
      't',
      { type: 'object', required: ['x'] },
      { x: 1 },
      async (args) => args.x,
    );
    expect(r).toBe(1);
  });

  it('throws without running the action when invalid', async () => {
    let ran = false;
    await expect(
      preflight(
        't',
        { type: 'object', required: ['x'] },
        {},
        async () => {
          ran = true;
          return 'never';
        },
      ),
    ).rejects.toThrow(PreflightError);
    expect(ran).toBe(false);
  });
});

describe('SecondBrain pre-built schemas', () => {
  it('vapi initiateCall accepts a valid call', () => {
    const r = validate(
      {
        phoneNumber: '+15550001234',
        assistantId: 'ExampleCo-2da6-45b2-9379-1b575634a337',
        instructions: 'Call the dentist.',
      },
      vapiInitiateCallSchema,
    );
    expect(r.valid).toBe(true);
  });

  it('vapi initiateCall rejects malformed phone', () => {
    const r = validate(
      { phoneNumber: '15550000000', assistantId: 'ExampleCo-2da6-45b2-9379-1b575634a337' },
      vapiInitiateCallSchema,
    );
    const phone = r.violations.find((v) => v.path === 'phoneNumber');
    expect(phone?.rule).toBe('pattern');
  });

  it('vapi initiateCall rejects wrong-length assistantId', () => {
    const r = validate(
      { phoneNumber: '+15550001234', assistantId: 'short' },
      vapiInitiateCallSchema,
    );
    expect(r.violations.some((v) => v.path === 'assistantId')).toBe(true);
  });

  it('gmail send rejects malformed recipient', () => {
    const r = validate(
      { to: 'not-an-email', subject: 'hi', body: 'hello' },
      gmailSendSchema,
    );
    expect(r.violations.find((v) => v.path === 'to')?.rule).toBe('pattern');
  });

  it('gmail send rejects empty body', () => {
    const r = validate(
      { to: 'a@b.co', subject: 'hi', body: '' },
      gmailSendSchema,
    );
    expect(r.violations.some((v) => v.path === 'body')).toBe(true);
  });

  it('telegram rejects messages over 4096 chars', () => {
    const long = 'a'.repeat(4097);
    const r = validate({ chat_id: '123', text: long }, telegramSendSchema);
    expect(r.violations.find((v) => v.path === 'text')?.rule).toBe('maxLength');
  });

  it('telegram parse_mode enum is enforced', () => {
    const r = validate(
      { chat_id: '123', text: 'hi', parse_mode: 'BogusMode' },
      telegramSendSchema,
    );
    expect(r.violations.find((v) => v.path === 'parse_mode')?.rule).toBe('enum');
  });

  it('E164_PATTERN compiles and matches expected forms', () => {
    const re = new RegExp(E164_PATTERN);
    expect(re.test('+15550001234')).toBe(true);
    expect(re.test('15550001234')).toBe(true);
    expect(re.test('+447700900123')).toBe(true);
    expect(re.test('15550000000')).toBe(false);
    expect(re.test('+0123456789')).toBe(false); // leading 0 after + is invalid
  });
});
