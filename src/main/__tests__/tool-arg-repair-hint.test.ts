import { describe, it, expect } from 'vitest';
import { repairHint, resolvePathSchema } from '../tool-arg-repair-hint';
import { validate, type Schema } from '../preflight-validator';

// Use the real validator so the hint is built from genuine Violation shapes,
// not hand-rolled ones. This keeps the two modules contractually coupled.
function hintFor(value: ExampleCo, schema: Schema) {
  const result = validate(value, schema);
  return repairHint(result.violations, schema, value);
}

describe('repairHint - no violations', () => {
  it('is not retryable and yields an empty instruction when args are valid', () => {
    const schema: Schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    const r = hintFor({ name: 'ok' }, schema);
    expect(r.retryable).toBe(false);
    expect(r.instruction).toBe('');
    expect(r.fieldFixes).toHaveLength(0);
  });
});

describe('repairHint - missing required field', () => {
  it('names the field and surfaces its description', () => {
    const schema: Schema = {
      type: 'object',
      required: ['phone'],
      properties: { phone: { type: 'string', description: 'callee number' } },
    };
    const r = hintFor({}, schema);
    expect(r.retryable).toBe(true);
    const fix = r.fieldFixes.find((f) => f.rule === 'required')!;
    expect(fix.instruction).toMatch(/required field/);
    expect(fix.instruction).toMatch(/phone/);
    expect(fix.instruction).toMatch(/callee number/);
  });
});

describe('repairHint - pattern failures get concrete, recognizable hints', () => {
  it('phrases an E.164 phone failure with a corrected example', () => {
    const schema: Schema = {
      type: 'object',
      properties: { phone: { type: 'string', pattern: '^\\+[1-9]\\d{9,14}$' } },
    };
    const r = hintFor({ phone: '2025550123' }, schema);
    const fix = r.fieldFixes.find((f) => f.rule === 'pattern')!;
    expect(fix.instruction).toMatch(/E\.164/);
    expect(fix.instruction).toMatch(/\+1/);
  });

  it('phrases an email failure as an email-address instruction', () => {
    const schema: Schema = {
      type: 'object',
      properties: { to: { type: 'string', pattern: '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' } },
    };
    const r = hintFor({ to: 'not-an-email' }, schema);
    const fix = r.fieldFixes.find((f) => f.rule === 'pattern')!;
    expect(fix.instruction).toMatch(/email address/);
  });
});

describe('repairHint - type, enum, and bound rules', () => {
  it('quotes the declared type on a type mismatch', () => {
    const schema: Schema = { type: 'object', properties: { count: { type: 'integer' } } };
    const r = hintFor({ count: 'five' }, schema);
    expect(r.fieldFixes.find((f) => f.rule === 'type')!.instruction).toMatch(/integer/);
  });

  it('lists the allowed values on an enum miss', () => {
    const schema: Schema = { type: 'object', properties: { mode: { enum: ['draft', 'send'] } } };
    const r = hintFor({ mode: 'yolo' }, schema);
    expect(r.fieldFixes.find((f) => f.rule === 'enum')!.instruction).toMatch(/draft/);
  });

  it('directs the model up to the minimum on a numeric bound', () => {
    const schema: Schema = { type: 'object', properties: { age: { type: 'integer', minimum: 18 } } };
    const r = hintFor({ age: 5 }, schema);
    expect(r.fieldFixes.find((f) => f.rule === 'minimum')!.instruction).toMatch(/>= 18/);
  });
});

describe('repairHint - combined instruction block', () => {
  it('numbers multiple fixes and headers with the field count', () => {
    const schema: Schema = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    };
    const r = hintFor({ b: 'wrong' }, schema);
    expect(r.fieldFixes.length).toBeGreaterThanOrEqual(2);
    expect(r.instruction).toMatch(/2 fields/);
    expect(r.instruction).toMatch(/^1\. /m);
    expect(r.instruction).toMatch(/^2\. /m);
  });
});

describe('resolvePathSchema', () => {
  it('walks dotted and indexed paths into nested item schemas', () => {
    const schema: Schema = {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'object', properties: { email: { type: 'string', description: 'recipient' } } },
        },
      },
    };
    const resolved = resolvePathSchema(schema, 'to[0].email');
    expect(resolved?.description).toBe('recipient');
  });

  it('returns undefined for an undeclared additionalProperties path', () => {
    const schema: Schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(resolvePathSchema(schema, 'surprise')).toBeUndefined();
  });
});
