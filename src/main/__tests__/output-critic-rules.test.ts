import { describe, it, expect } from 'vitest';
import {
  RULE_NO_FORBIDDEN_PEOPLE,
  RULE_NO_HEDGING,
  RULE_NO_FILLER,
  RULE_REQUIRES_ExampleCo_SIGNATURE,
  RULE_MAX_ExampleCoRAPHS,
  RULE_NO_LATE_NIGHT_TELEGRAM,
  BRIEFING_FULL_RULES,
  GMAIL_DEFAULT_RULES,
  TELEGRAM_DEFAULT_RULES,
  VAPI_CALLEE_DEFAULT_RULES,
  rulesForSurface,
  FORBIDDEN_PEOPLE,
} from '../output-critic-rules';
import { checkRules } from '../output-critic';

describe('RULE_NO_FORBIDDEN_PEOPLE', () => {
  it('flags every forbidden name', () => {
    const text = 'Met with Andrea today; Julia called. Marie-Louise asked.';
    const out = RULE_NO_FORBIDDEN_PEOPLE.check(text);
    expect(out).not.toBeNull();
    const issues = Array.isArray(out) ? out : [out!];
    expect(issues.length).toBe(3);
    expect(issues.map((i) => i.match).sort()).toEqual(['Andrea', 'Julia', 'Marie-Louise']);
  });

  it('matches case-insensitive', () => {
    const out = RULE_NO_FORBIDDEN_PEOPLE.check('ANDREA and julia were here');
    expect(out).not.toBeNull();
    const issues = Array.isArray(out) ? out : [out!];
    expect(issues.length).toBe(2);
  });

  it('does not trip on superstrings (Andreas, Juliana)', () => {
    const out = RULE_NO_FORBIDDEN_PEOPLE.check('Andreas Mueller met Juliana Schmidt.');
    expect(out).toBeNull();
  });

  it('matches at start, end, with punctuation', () => {
    const out = RULE_NO_FORBIDDEN_PEOPLE.check('Andrea, Julia: Marie-Louise.');
    expect(out).not.toBeNull();
    const issues = Array.isArray(out) ? out : [out!];
    expect(issues.length).toBe(3);
  });

  it('passes clean text', () => {
    const out = RULE_NO_FORBIDDEN_PEOPLE.check('Spoke with Alice and Bob today.');
    expect(out).toBeNull();
  });

  it('exports FORBIDDEN_PEOPLE list as immutable contract', () => {
    expect(FORBIDDEN_PEOPLE).toContain('Andrea');
    expect(FORBIDDEN_PEOPLE).toContain('Julia');
    expect(FORBIDDEN_PEOPLE).toContain('Marie-Louise');
    expect(FORBIDDEN_PEOPLE.length).toBe(3);
  });
});

describe('RULE_NO_HEDGING', () => {
  it('flags "I think"', () => {
    const out = RULE_NO_HEDGING.check('I think we should ship this.');
    expect(out).not.toBeNull();
  });

  it('flags "approximately" with word boundary', () => {
    const out = RULE_NO_HEDGING.check('Approximately 30 contacts updated.');
    expect(out).not.toBeNull();
  });

  it('does not match inside a longer word', () => {
    const out = RULE_NO_HEDGING.check('The approximation was off.');
    expect(out).toBeNull();
  });

  it('flags multiple hedges in one text', () => {
    const out = RULE_NO_HEDGING.check('I think it seems like ExampleCo would prefer this.');
    expect(out).not.toBeNull();
    const issues = Array.isArray(out) ? out : [out!];
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('passes terse direct text', () => {
    const out = RULE_NO_HEDGING.check('Shipped. Tests passed. Pushed to origin.');
    expect(out).toBeNull();
  });
});

describe('RULE_NO_FILLER', () => {
  it('flags "Great question"', () => {
    const out = RULE_NO_FILLER.check('Great question! Here is the answer.');
    expect(out).not.toBeNull();
  });

  it("flags I'd be happy to", () => {
    const out = RULE_NO_FILLER.check("I'd be happy to help with that.");
    expect(out).not.toBeNull();
  });

  it('flags "As an AI"', () => {
    const out = RULE_NO_FILLER.check('As an AI, I cannot do that.');
    expect(out).not.toBeNull();
  });

  it('flags "This will just take a second"', () => {
    const out = RULE_NO_FILLER.check('This will just take a second while I look that up.');
    expect(out).not.toBeNull();
  });

  it('flags "Bear with me"', () => {
    const out = RULE_NO_FILLER.check('Bear with me for a moment.');
    expect(out).not.toBeNull();
  });

  it('flags "Hang tight"', () => {
    const out = RULE_NO_FILLER.check('Hang tight, I will check on that.');
    expect(out).not.toBeNull();
  });

  it('flags "Just give me a second"', () => {
    const out = RULE_NO_FILLER.check('Just give me a second to pull that up.');
    expect(out).not.toBeNull();
  });

  it('passes a terse reply', () => {
    const out = RULE_NO_FILLER.check('Done. The dentist agreed to skip X-rays.');
    expect(out).toBeNull();
  });
});

describe('RULE_REQUIRES_ExampleCo_SIGNATURE', () => {
  const rule = RULE_REQUIRES_ExampleCo_SIGNATURE('ExampleCo');

  it('passes when signature is on its own line at the end', () => {
    const text = 'Dear PRIVATE_NAME,\n\nLet us catch up Friday.\n\nExampleCo';
    expect(rule.check(text)).toBeNull();
  });

  it('passes with trailing whitespace after the name', () => {
    const text = 'Hi,\n\nThanks.\n\nExampleCo\n\n';
    expect(rule.check(text)).toBeNull();
  });

  it('fails when the body ends without the signature line', () => {
    const text = 'Hi PRIVATE_NAME,\n\nLet us sync Friday.';
    const out = rule.check(text);
    expect(out).not.toBeNull();
  });

  it('fails on empty body', () => {
    const out = rule.check('');
    expect(out).not.toBeNull();
  });

  it('does not accept "ExampleCo" inline only', () => {
    const text = 'Hi, this is ExampleCo speaking. Thanks for the call.';
    const out = rule.check(text);
    expect(out).not.toBeNull();
  });

  it('accepts a configurable required string', () => {
    const r = RULE_REQUIRES_ExampleCo_SIGNATURE('Amy');
    expect(r.check('Hello there,\n\nThanks.\n\nAmy')).toBeNull();
    expect(r.check('Hello there,\n\nThanks.\n\nExampleCo')).not.toBeNull();
  });
});

describe('RULE_MAX_ExampleCoRAPHS', () => {
  it('passes when ExampleCoraph count is within limit', () => {
    const rule = RULE_MAX_ExampleCoRAPHS(4);
    const text = ['P1.', 'P2.', 'P3.'].join('\n\n');
    expect(rule.check(text)).toBeNull();
  });

  it('fails when ExampleCoraph count exceeds limit', () => {
    const rule = RULE_MAX_ExampleCoRAPHS(2);
    const text = ['P1.', 'P2.', 'P3.', 'P4.'].join('\n\n');
    const out = rule.check(text);
    expect(out).not.toBeNull();
  });

  it('collapses multi-blank-line runs', () => {
    const rule = RULE_MAX_ExampleCoRAPHS(2);
    const text = 'A.\n\n\n\nB.';
    expect(rule.check(text)).toBeNull();
  });

  it('ignores leading and trailing blank lines', () => {
    const rule = RULE_MAX_ExampleCoRAPHS(1);
    expect(rule.check('\n\nP1.\n\n')).toBeNull();
  });
});

describe('RULE_NO_LATE_NIGHT_TELEGRAM', () => {
  it('blocks at 23:00 CT (UTC-6, so 05:00 UTC)', () => {
    const rule = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 5, 0, 0)),
    });
    const out = rule.check('Briefing draft');
    expect(out).not.toBeNull();
  });

  it('blocks at 02:00 CT (08:00 UTC)', () => {
    const rule = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 8, 0, 0)),
    });
    const out = rule.check('Anything');
    expect(out).not.toBeNull();
  });

  it('allows at 14:00 CT (20:00 UTC)', () => {
    const rule = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 20, 0, 0)),
    });
    expect(rule.check('Anything')).toBeNull();
  });

  it('respects override window', () => {
    // 03:00 CT (09:00 UTC) inside 0-6 quiet window -> blocked
    const ruleNarrowBlock = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 9, 0, 0)),
      quietStartHourCT: 0,
      quietEndHourCT: 6,
    });
    expect(ruleNarrowBlock.check('x')).not.toBeNull();

    // 23:00 CT (05:00 UTC) outside 0-6 quiet window -> allowed
    const ruleNarrowAllow = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 5, 0, 0)),
      quietStartHourCT: 0,
      quietEndHourCT: 6,
    });
    expect(ruleNarrowAllow.check('x')).toBeNull();

    // 14:00 CT (20:00 UTC) inside 12-18 window -> blocked
    const ruleDay = RULE_NO_LATE_NIGHT_TELEGRAM({
      now: () => new Date(Date.UTC(2026, 4, 12, 20, 0, 0)),
      quietStartHourCT: 12,
      quietEndHourCT: 18,
    });
    expect(ruleDay.check('x')).not.toBeNull();
  });
});

describe('surface packs', () => {
  it('BRIEFING_FULL_RULES includes baseline and forbidden-people', () => {
    const ids = BRIEFING_FULL_RULES.map((r) => r.id);
    expect(ids).toContain('no_em_or_en_dash');
    expect(ids).toContain('no_utc_times');
    expect(ids).toContain('no_forbidden_people');
    expect(ids).toContain('no_hedging');
  });

  it('GMAIL_DEFAULT_RULES enforces signature', () => {
    const rules = GMAIL_DEFAULT_RULES();
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('requires_ExampleCo_signature');
    expect(ids).toContain('no_forbidden_people');
    expect(ids).toContain('no_filler');
  });

  it('TELEGRAM_DEFAULT_RULES enforces brevity and quiet hours', () => {
    const rules = TELEGRAM_DEFAULT_RULES({
      quietHours: { now: () => new Date(Date.UTC(2026, 4, 12, 20, 0, 0)) },
    });
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('tier_one_brevity');
    expect(ids).toContain('no_late_night_telegram');
  });

  it('VAPI_CALLEE_DEFAULT_RULES bans forbidden people and filler', () => {
    const ids = VAPI_CALLEE_DEFAULT_RULES.map((r) => r.id);
    expect(ids).toContain('no_forbidden_people');
    expect(ids).toContain('no_filler');
  });

  it('rulesForSurface dispatches to the right pack', () => {
    expect(rulesForSurface('briefing').length).toBe(BRIEFING_FULL_RULES.length);
    expect(rulesForSurface('vapi_callee').length).toBe(VAPI_CALLEE_DEFAULT_RULES.length);
    expect(rulesForSurface('gmail').some((r) => r.id === 'requires_ExampleCo_signature')).toBe(true);
  });
});

describe('end-to-end via checkRules', () => {
  it('briefing catches em-dash + forbidden person + hedging in one pass', () => {
    const dash = String.fromCharCode(0x2014);
    const text = `I think Andrea will visit on Friday${dash}we should prepare.`;
    const issues = checkRules(text, BRIEFING_FULL_RULES);
    const ids = new Set(issues.map((i) => i.rule_id));
    expect(ids.has('no_em_or_en_dash')).toBe(true);
    expect(ids.has('no_forbidden_people')).toBe(true);
    expect(ids.has('no_hedging')).toBe(true);
  });

  it('gmail draft missing signature fails GMAIL_DEFAULT_RULES', () => {
    const text = 'Hi PRIVATE_NAME,\n\nLet us sync Friday.';
    const issues = checkRules(text, GMAIL_DEFAULT_RULES());
    expect(issues.some((i) => i.rule_id === 'requires_ExampleCo_signature')).toBe(true);
  });

  it('gmail draft with signature and no other violations passes', () => {
    const text = 'Hi PRIVATE_NAME,\n\nLet us sync Friday.\n\nExampleCo';
    const issues = checkRules(text, GMAIL_DEFAULT_RULES());
    expect(issues).toEqual([]);
  });
});
