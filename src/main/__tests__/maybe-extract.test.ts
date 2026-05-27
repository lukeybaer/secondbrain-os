import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  maybeExtract,
  buildMaybePrompt,
  parseMaybeJson,
} from '../maybe-extract';

function tempLog(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abstain-')), 'abstentions.jsonl');
}

interface Person {
  name: string;
  phone: string;
}
const validatePerson = (raw: unknown): Person | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.phone !== 'string') return null;
  return { name: r.name, phone: r.phone };
};

describe('parseMaybeJson', () => {
  it('parses a clean JSON object', () => {
    const out = parseMaybeJson('{"result":{"x":1},"confidence":0.9,"citations":["x"]}');
    expect(out.confidence).toBe(0.9);
    expect(out.citations).toEqual(['x']);
  });

  it('strips a ```json fence when the model adds one', () => {
    const raw = '```json\n{"result":null,"confidence":0.1,"citations":[]}\n```';
    const out = parseMaybeJson(raw);
    expect(out.result).toBeNull();
    expect(out.confidence).toBe(0.1);
  });

  it('throws on missing confidence', () => {
    expect(() => parseMaybeJson('{"result":1}')).toThrow(/confidence/);
  });
});

describe('buildMaybePrompt', () => {
  it('mentions the description and the result-or-null contract', () => {
    const p = buildMaybePrompt('a contact phone number');
    expect(p).toContain('a contact phone number');
    expect(p).toContain('result');
    expect(p).toContain('null');
    expect(p).toContain('citations');
  });
});

describe('maybeExtract', () => {
  it('returns a confident result when the model is confident and citation is grounded', async () => {
    const source = 'Call Luke at +15551234567 if you need anything.';
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'name and phone',
      sourceText: source,
      runExtractor: () =>
        JSON.stringify({
          result: { name: 'Luke', phone: '+15551234567' },
          confidence: 0.95,
          citations: ['+15551234567'],
        }),
      abstentionsLogPath: tempLog(),
    });

    expect(out.result).toEqual({ name: 'Luke', phone: '+15551234567' });
    expect(out.confident).toBe(true);
    expect(out.confidence).toBe(0.95);
  });

  it('abstains and returns null when citations are not in the source', async () => {
    const log = tempLog();
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'name and phone',
      sourceText: 'No phone here.',
      runExtractor: () =>
        JSON.stringify({
          result: { name: 'Luke', phone: '555-FAKE' },
          confidence: 0.99,
          citations: ['555-FAKE'],
        }),
      abstentionsLogPath: log,
    });
    expect(out.result).toBeNull();
    expect(out.confident).toBe(false);
    expect(out.reason).toMatch(/ungrounded/);
    const written = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).reason).toMatch(/ungrounded/);
  });

  it('abstains when the model returns null result, propagating its reason', async () => {
    const log = tempLog();
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'no phone here',
      runExtractor: () =>
        JSON.stringify({
          result: null,
          confidence: 0.4,
          abstain_reason: 'no phone in text',
          citations: [],
        }),
      abstentionsLogPath: log,
    });
    expect(out.result).toBeNull();
    expect(out.reason).toBe('no phone in text');
    const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(entry.confidence).toBe(0.4);
  });

  it('abstains when confidence is below the floor', async () => {
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'maybe +15551234567 maybe not',
      runExtractor: () =>
        JSON.stringify({
          result: { name: 'Luke', phone: '+15551234567' },
          confidence: 0.3,
          citations: ['+15551234567'],
        }),
      minConfidence: 0.6,
      abstentionsLogPath: tempLog(),
    });
    expect(out.result).toBeNull();
    expect(out.reason).toMatch(/confidence/);
  });

  it('abstains when validate() rejects the extracted shape', async () => {
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'Luke is here',
      runExtractor: () =>
        JSON.stringify({
          result: { name: 'Luke' }, // missing phone
          confidence: 0.9,
          citations: ['Luke'],
        }),
      abstentionsLogPath: tempLog(),
    });
    expect(out.result).toBeNull();
    expect(out.reason).toMatch(/validation/);
  });

  it('abstains when the extractor returns unparseable output', async () => {
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'irrelevant',
      runExtractor: () => 'this is not json',
      abstentionsLogPath: tempLog(),
    });
    expect(out.result).toBeNull();
    expect(out.reason).toMatch(/unparseable/);
  });

  it('abstains when the extractor throws', async () => {
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'irrelevant',
      runExtractor: () => {
        throw new Error('claude offline');
      },
      abstentionsLogPath: tempLog(),
    });
    expect(out.result).toBeNull();
    expect(out.reason).toMatch(/claude offline/);
  });

  it('clamps invalid confidence values to [0,1]', async () => {
    const out = await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'Luke at +15551234567',
      runExtractor: () =>
        JSON.stringify({
          result: { name: 'Luke', phone: '+15551234567' },
          confidence: 5,
          citations: ['+15551234567'],
        }),
      abstentionsLogPath: tempLog(),
    });
    expect(out.confidence).toBe(1);
    expect(out.confident).toBe(true);
  });

  it('rejects out-of-range minConfidence', async () => {
    await expect(
      maybeExtract<Person>({
        validate: validatePerson,
        description: 'p',
        sourceText: 's',
        runExtractor: () => '{}',
        minConfidence: 2,
      }),
    ).rejects.toThrow(/minConfidence/);
  });

  it('logs the extractor tag for grouping in the briefing', async () => {
    const log = tempLog();
    await maybeExtract<Person>({
      validate: validatePerson,
      description: 'phone',
      sourceText: 'no phone',
      runExtractor: () =>
        JSON.stringify({ result: null, confidence: 0.1, citations: [] }),
      abstentionsLogPath: log,
      extractorTag: 'briefing.parser',
    });
    const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(entry.extractor_tag).toBe('briefing.parser');
  });
});
