// behavior-tripwire.test.ts
//
// Frugal vitest suite. Pure functions, deterministic Date inputs, no I/O.
// NOTE: tests reference em (U+2014) and en (U+2013) dash characters via
// String.fromCharCode so the source file contains no literal em or en dash
// characters (the em-dash-guard.mjs PreToolUse hook would otherwise reject it).

import { describe, it, expect } from 'vitest';
import {
  check,
  assertSafe,
  applyAutoFix,
  BehaviorTripwireError,
  RULE_IDS,
} from '../behavior-tripwire';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

// Build a Date at a specific UTC hour, used for late-night-telegram tests.
function utcDate(year: number, monthIdx: number, day: number, hour: number, min = 0): Date {
  return new Date(Date.UTC(year, monthIdx, day, hour, min));
}

describe('RULE_IDS catalog', () => {
  it('contains all expected rule ids', () => {
    expect(RULE_IDS).toEqual(expect.arrayContaining([
      'em-dash',
      'en-dash-prose',
      'forbidden-name',
      'late-night-telegram',
      'telegram-too-long',
      'multi-option-reco',
    ]));
  });
});

describe('em-dash rule', () => {
  it('flags U+2014', () => {
    const r = check(`hello ${EM} world`);
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe('em-dash');
    expect(r.violations[0].fix).toBe(',');
  });

  it('passes plain prose', () => {
    const r = check('hello, world. nothing fancy here.');
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('flags multiple em dashes by index', () => {
    const r = check(`a ${EM} b ${EM} c`);
    expect(r.violations.filter(v => v.rule === 'em-dash')).toHaveLength(2);
    expect(r.violations[0].idx).toBeLessThan(r.violations[1].idx);
  });
});

describe('en-dash rule', () => {
  it('flags en dash in prose', () => {
    const r = check(`this is a thought ${EN} not a great one`);
    expect(r.violations.find(v => v.rule === 'en-dash-prose')).toBeDefined();
  });

  it('allows en dash in numeric range', () => {
    const r = check(`see pages 12${EN}15 of the report`);
    expect(r.violations.find(v => v.rule === 'en-dash-prose')).toBeUndefined();
  });

  it('en-dash in prose is warn-level only, does not block by default', () => {
    const r = check(`one ${EN} two`);
    expect(r.ok).toBe(true); // default threshold is block, en-dash is warn
    expect(r.violations.find(v => v.rule === 'en-dash-prose')).toBeDefined();
  });

  it('threshold warn turns en-dash into a blocker', () => {
    const r = check(`one ${EN} two`, { threshold: 'warn' });
    expect(r.ok).toBe(false);
  });
});

describe('forbidden-name rule', () => {
  it('flags Andrea by exact word match', () => {
    const r = check('the meeting with Andrea ran late');
    const v = r.violations.find(x => x.rule === 'forbidden-name');
    expect(v).toBeDefined();
  });

  it('does NOT flag Andreas (different name)', () => {
    const r = check('Andreas joined the call');
    expect(r.violations.find(v => v.rule === 'forbidden-name')).toBeUndefined();
  });

  it('does NOT flag Julianna or Juliana', () => {
    expect(check('Julianna is here').violations.find(v => v.rule === 'forbidden-name')).toBeUndefined();
    expect(check('Juliana is here').violations.find(v => v.rule === 'forbidden-name')).toBeUndefined();
  });

  it('flags Julia at word boundary', () => {
    const r = check('Julia called yesterday');
    expect(r.violations.find(v => v.rule === 'forbidden-name')).toBeDefined();
  });

  it('flags Marie-Louise', () => {
    const r = check('reach out to Marie-Louise');
    expect(r.violations.find(v => v.rule === 'forbidden-name')).toBeDefined();
  });

  it('allowContacts overrides for one call (e.g., literally addressing Andrea)', () => {
    const r = check('the meeting with Andrea ran late', { allowContacts: ['Andrea'] });
    expect(r.violations.find(v => v.rule === 'forbidden-name')).toBeUndefined();
  });
});

describe('late-night-telegram rule', () => {
  it('blocks at 23:00 CT on telegram channel', () => {
    // 04:00 UTC + offset -300 = -1:00 == 23:00 prior day CT
    const now = utcDate(2026, 4, 9, 4, 0);
    const r = check('hello', { channel: 'telegram', now, tzOffsetMinutes: -300 });
    const v = r.violations.find(x => x.rule === 'late-night-telegram');
    expect(v).toBeDefined();
  });

  it('allows at 09:00 CT on telegram channel', () => {
    // 14:00 UTC + (-300) = 09:00 CT
    const now = utcDate(2026, 4, 9, 14, 0);
    const r = check('hello', { channel: 'telegram', now, tzOffsetMinutes: -300 });
    expect(r.violations.find(v => v.rule === 'late-night-telegram')).toBeUndefined();
  });

  it('does not apply to non-telegram channels', () => {
    const now = utcDate(2026, 4, 9, 4, 0);
    const r = check('hello', { channel: 'gmail', now, tzOffsetMinutes: -300 });
    expect(r.violations.find(v => v.rule === 'late-night-telegram')).toBeUndefined();
  });

  it('URGENT marker overrides the late-night block', () => {
    const now = utcDate(2026, 4, 9, 4, 0);
    const r = check('URGENT: server down', { channel: 'telegram', now, tzOffsetMinutes: -300 });
    expect(r.violations.find(v => v.rule === 'late-night-telegram')).toBeUndefined();
  });

  it('EMERGENCY marker also overrides', () => {
    const now = utcDate(2026, 4, 9, 4, 0);
    const r = check('EMERGENCY situation', { channel: 'telegram', now, tzOffsetMinutes: -300 });
    expect(r.violations.find(v => v.rule === 'late-night-telegram')).toBeUndefined();
  });
});

describe('telegram-too-long rule', () => {
  it('flags messages over 4096 chars on telegram channel', () => {
    const big = 'a'.repeat(4097);
    const r = check(big, { channel: 'telegram' });
    const v = r.violations.find(x => x.rule === 'telegram-too-long');
    expect(v).toBeDefined();
  });

  it('does not flag at exactly 4096', () => {
    const exact = 'a'.repeat(4096);
    const r = check(exact, { channel: 'telegram' });
    expect(r.violations.find(v => v.rule === 'telegram-too-long')).toBeUndefined();
  });

  it('does not apply to non-telegram channels', () => {
    const big = 'a'.repeat(5000);
    const r = check(big, { channel: 'gmail' });
    expect(r.violations.find(v => v.rule === 'telegram-too-long')).toBeUndefined();
  });
});

describe('multi-option-reco rule', () => {
  it('flags Option 1 / Option 2 patterns', () => {
    const t = 'You could go with Option 1: faster but riskier. Option 2: slower but safer.';
    const r = check(t);
    expect(r.violations.find(v => v.rule === 'multi-option-reco')).toBeDefined();
  });

  it('allows a single recommendation', () => {
    const t = 'My recommendation is to ship the bundled PR. Splitting it would just be churn.';
    const r = check(t);
    expect(r.violations.find(v => v.rule === 'multi-option-reco')).toBeUndefined();
  });

  it('multi-option is warn-level (does not block by default)', () => {
    const t = 'Option 1: ... Option 2: ... which option do you prefer?';
    const r = check(t);
    expect(r.violations.find(v => v.rule === 'multi-option-reco')).toBeDefined();
    // default threshold is block, so warn-only violations leave ok=true
    expect(r.ok).toBe(true);
  });
});

describe('disable option', () => {
  it('skips disabled rules entirely', () => {
    const r = check(`hello ${EM} world`, { disable: ['em-dash'] });
    expect(r.violations.find(v => v.rule === 'em-dash')).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});

describe('assertSafe', () => {
  it('throws BehaviorTripwireError on a blocking violation', () => {
    let caught: ExampleCo = undefined;
    try { assertSafe(`hello ${EM} world`); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BehaviorTripwireError);
    expect((caught as BehaviorTripwireError).violations[0].rule).toBe('em-dash');
  });

  it('does not throw when threshold is block and only warn-level violations exist', () => {
    expect(() => assertSafe(`see also ${EN} the docs`)).not.toThrow();
  });

  it('does throw when threshold is warn and a warn violation exists', () => {
    expect(() => assertSafe(`see also ${EN} the docs`, { threshold: 'warn' })).toThrow(BehaviorTripwireError);
  });

  it('does not throw on clean input', () => {
    expect(() => assertSafe('the quick brown fox jumps over')).not.toThrow();
  });
});

describe('applyAutoFix', () => {
  it('replaces em dashes with commas', () => {
    const t = `hello ${EM} world`;
    const r = check(t);
    expect(applyAutoFix(t, r.violations)).toBe('hello , world');
  });

  it('handles multiple fixes by walking right-to-left to keep indices valid', () => {
    const t = `a ${EM} b ${EM} c`;
    const r = check(t);
    expect(applyAutoFix(t, r.violations)).toBe('a , b , c');
  });

  it('leaves un-fixable violations in place', () => {
    const t = 'reach out to Julia today';
    const r = check(t);
    // forbidden-name has no fix; applyAutoFix should be a no-op for it.
    expect(applyAutoFix(t, r.violations)).toBe(t);
  });

  it('mixed fixable and non-fixable input is partially fixed', () => {
    const t = `tell Julia ${EM} thanks`;
    const r = check(t);
    expect(applyAutoFix(t, r.violations)).toBe('tell Julia , thanks');
  });
});

describe('violation ordering', () => {
  it('violations are sorted by idx ascending', () => {
    const t = `Julia ${EM} something Andrea`;
    const r = check(t);
    const idxs = r.violations.map(v => v.idx);
    const sorted = [...idxs].sort((a, b) => a - b);
    expect(idxs).toEqual(sorted);
  });
});
