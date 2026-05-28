/**
 * Tests for scripts/structured-output-validator.js
 *
 * Locks PydanticAI-style schema validation + auto-retry loop for LLM JSON
 * outputs (briefing JSON, manifest entries, shorts proposals). Frugal
 * regression tests, tiny inputs, no LLM calls.
 */

import { describe, it, expect } from 'vitest';

function loadModuleFresh() {
  const modPath = require.resolve('../../../scripts/structured-output-validator.js');
  delete require.cache[modPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../scripts/structured-output-validator.js');
}

describe('structured-output-validator: schema validation', () => {
  const mod = loadModuleFresh();
  const schema = {
    name: 'briefing-card',
    fields: {
      title: { type: 'string', required: true, maxLength: 80 },
      priority: { type: 'integer', required: true, min: 1, max: 10 },
      tags: { type: 'array', itemType: 'string' },
      summary: { type: 'string', required: true, minLength: 10 },
      status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
    },
    extraFields: 'strip' as const,
  };

  it('passes a fully-conformant object', () => {
    const result = mod.validate(schema, {
      title: 'BAI invoice due',
      priority: 5,
      tags: ['finance', 'bai'],
      summary: 'April invoice still unpaid',
      status: 'warn',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.sanitized.title).toBe('BAI invoice due');
  });

  it('strips extra fields when policy is strip', () => {
    const result = mod.validate(schema, {
      title: 't', priority: 1, summary: 'short summary text',
      bogus: 'ignore me',
    });
    expect(result.valid).toBe(true);
    expect(result.sanitized.bogus).toBeUndefined();
  });

  it('errors on extra fields when policy is error', () => {
    const strict = { ...schema, extraFields: 'error' as const };
    const result = mod.validate(strict, {
      title: 't', priority: 1, summary: 'short summary text', bogus: 'x',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: any) => e.field === 'bogus' && e.code === 'extra_field')).toBe(true);
  });

  it('reports missing required fields', () => {
    const result = mod.validate(schema, { priority: 5 });
    const codes = result.errors.map((e: any) => e.code);
    expect(codes).toContain('missing_required');
    expect(result.errorMessage).toContain('title');
    expect(result.errorMessage).toContain('summary');
  });

  it('reports wrong type with field name', () => {
    const result = mod.validate(schema, {
      title: 't', priority: 'high', summary: 'ten chars+',
    });
    const err = result.errors.find((e: any) => e.field === 'priority');
    expect(err.code).toBe('wrong_type');
    expect(err.message).toContain('integer');
    expect(err.message).toContain('string');
  });

  it('reports below_min and above_max for number ranges', () => {
    const low = mod.validate(schema, { title: 't', priority: 0, summary: 'ten chars+' });
    expect(low.errors.find((e: any) => e.code === 'below_min')).toBeDefined();
    const high = mod.validate(schema, { title: 't', priority: 11, summary: 'ten chars+' });
    expect(high.errors.find((e: any) => e.code === 'above_max')).toBeDefined();
  });

  it('reports enum violations with the allowed set', () => {
    const result = mod.validate(schema, {
      title: 't', priority: 1, summary: 'ten chars+', status: 'broken',
    });
    const err = result.errors.find((e: any) => e.field === 'status');
    expect(err.code).toBe('not_in_enum');
    expect(err.message).toContain('ok');
    expect(err.message).toContain('warn');
    expect(err.message).toContain('fail');
  });

  it('reports array item-type mismatches', () => {
    const result = mod.validate(schema, {
      title: 't', priority: 1, summary: 'ten chars+',
      tags: ['a', 42, 'c'],
    });
    const err = result.errors.find((e: any) => e.field === 'tags[1]');
    expect(err.code).toBe('wrong_item_type');
  });

  it('predicate failures surface a custom message when supplied', () => {
    const result = mod.validate({
      name: 's', fields: {
        url: {
          type: 'string', required: true,
          predicate: (v: string) => v.startsWith('https://'),
          predicateMessage: 'url must be https',
        },
      },
    }, { url: 'http://example.com' });
    expect(result.errors[0].code).toBe('predicate_failed');
    expect(result.errors[0].message).toBe('url must be https');
  });

  it('non-object roots are rejected with a clear message', () => {
    const result = mod.validate(schema, [1, 2, 3]);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('single JSON object');
  });

  it('errorMessage is suitable as a re-prompt fragment', () => {
    const result = mod.validate(schema, { priority: 'high' });
    expect(result.errorMessage).toContain('Your previous output failed validation');
    expect(result.errorMessage).toContain('return a single JSON object');
  });
});

describe('structured-output-validator: extractJsonObject', () => {
  const mod = loadModuleFresh();

  it('parses pure JSON', () => {
    const { parsed } = mod.extractJsonObject('{"a":1}');
    expect(parsed).toEqual({ a: 1 });
  });

  it('strips fenced markdown', () => {
    const { parsed } = mod.extractJsonObject('```json\n{"a":2}\n```');
    expect(parsed).toEqual({ a: 2 });
  });

  it('slices from the first brace when prose surrounds JSON', () => {
    const { parsed } = mod.extractJsonObject('Here is the JSON: {"a":3} -- end');
    expect(parsed).toEqual({ a: 3 });
  });

  it('returns parseError for unrecoverable garbage', () => {
    const { parsed, parseError } = mod.extractJsonObject('not json at all');
    expect(parsed).toBeNull();
    expect(parseError).toBeTruthy();
  });
});

describe('structured-output-validator: validateOrRetry', () => {
  const mod = loadModuleFresh();
  const schema = {
    name: 's',
    fields: {
      title: { type: 'string', required: true },
      score: { type: 'integer', required: true, min: 0, max: 100 },
    },
  };

  it('returns the validated value on the first valid attempt', async () => {
    let calls = 0;
    const result = await mod.validateOrRetry(schema, async () => {
      calls++;
      return '{"title":"hi","score":50}';
    });
    expect(result.ok).toBe(true);
    expect(result.value.title).toBe('hi');
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('retries with the prior error message until valid', async () => {
    const responses = [
      'not json',
      '{"title":"hi"}',           // missing score
      '{"title":"hi","score":50}',
    ];
    const seenErrors: string[] = [];
    const result = await mod.validateOrRetry(schema, async (attempt: number, lastError: string) => {
      seenErrors.push(lastError);
      return responses[attempt - 1];
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(seenErrors[0]).toBe('');
    expect(seenErrors[1]).toMatch(/JSON|json/);
    expect(seenErrors[2]).toMatch(/score|missing/);
  });

  it('returns ok=false once retries exhausted with the final error', async () => {
    const result = await mod.validateOrRetry(schema, async () => {
      return '{"title":"hi"}';
    }, { maxRetries: 2 });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.errorMessage).toContain('score');
  });

  it('history contains an entry per attempt', async () => {
    const result = await mod.validateOrRetry(schema, async (attempt: number) => {
      if (attempt < 2) return 'bad';
      return '{"title":"x","score":1}';
    });
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toHaveProperty('parseError');
    expect(result.history[1].ok).toBe(true);
  });
});
