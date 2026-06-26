import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkRules,
  critique,
  Rule,
  RuleIssue,
  RULE_NO_EM_OR_EN_DASH,
  RULE_NO_UTC_TIMES,
  RULE_NO_FABRICATED_URL,
  RULE_TIER_ONE_BREVITY,
  BRIEFING_DEFAULT_RULES,
  recordCritiqueRun,
  makeCritiqueFileWriter,
  CritiqueRunRecord,
} from '../output-critic';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

describe('output-critic checkRules', () => {
  it('returns no issues for clean text against the briefing default rules', () => {
    const issues = checkRules('Top story: immigration-case response due Friday.', BRIEFING_DEFAULT_RULES);
    expect(issues).toHaveLength(0);
  });

  it('flags em dashes', () => {
    const text = `Briefing${EM_DASH}top story.`;
    const issues = checkRules(text, [RULE_NO_EM_OR_EN_DASH]);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule_id).toBe('no_em_or_en_dash');
    expect(issues[0].severity).toBe('error');
  });

  it('flags en dashes', () => {
    const text = `Briefing${EN_DASH}top story.`;
    const issues = checkRules(text, [RULE_NO_EM_OR_EN_DASH]);
    expect(issues).toHaveLength(1);
    expect(issues[0].match).toBe(EN_DASH);
  });

  it('flags multiple em dashes with index information', () => {
    const text = `One${EM_DASH}two${EM_DASH}three`;
    const issues = checkRules(text, [RULE_NO_EM_OR_EN_DASH]);
    expect(issues).toHaveLength(2);
    expect(issues[0].index).toBe(3);
    expect(issues[1].index).toBe(7);
  });

  it('flags UTC times', () => {
    const text = 'Standup at 14:00 UTC and deploy at 18:30Z.';
    const issues = checkRules(text, [RULE_NO_UTC_TIMES]);
    expect(issues).toHaveLength(2);
    expect(issues[0].rule_id).toBe('no_utc_times');
  });

  it('flags ISO Z timestamps', () => {
    const text = 'Logged at 2026-05-01T03:14:59Z by the cron.';
    const issues = checkRules(text, [RULE_NO_UTC_TIMES]);
    expect(issues).toHaveLength(1);
    expect(issues[0].match).toMatch(/T03:14:59Z/);
  });

  it('does not false-positive on phone numbers or non-UTC times', () => {
    const text = 'Call (15550000000 at 9:30 CT for the briefing.';
    const issues = checkRules(text, [RULE_NO_UTC_TIMES]);
    expect(issues).toHaveLength(0);
  });

  it('flags fabricated URLs not in the source set', () => {
    const allowed = ['https://github.com/anthropics/claude-code'];
    const rule = RULE_NO_FABRICATED_URL(allowed);
    const text = 'See https://github.com/anthropics/claude-code and https://made-up.example/page.';
    const issues = checkRules(text, [rule]);
    expect(issues).toHaveLength(1);
    expect(issues[0].match).toBe('https://made-up.example/page');
  });

  it('strips trailing punctuation before checking URL allowlist', () => {
    const allowed = ['https://example.com/page'];
    const rule = RULE_NO_FABRICATED_URL(allowed);
    const text = 'See https://example.com/page.';
    const issues = checkRules(text, [rule]);
    expect(issues).toHaveLength(0);
  });

  it('tier-one brevity flags multi-sentence and over-length', () => {
    const rule = RULE_TIER_ONE_BREVITY(1, 60);
    const tooMany = checkRules('First. Second. Third.', [rule]);
    expect(tooMany.some((i) => i.message.includes('sentences'))).toBe(true);
    const tooLong = checkRules('a'.repeat(80) + '.', [rule]);
    expect(tooLong.some((i) => i.message.includes('chars'))).toBe(true);
  });
});

describe('output-critic critique loop', () => {
  it('returns immediately for clean draft when minSteps=1', async () => {
    const draft = 'Clean briefing line, no issues.';
    const result = await critique(draft, BRIEFING_DEFAULT_RULES, async () => 'unused', { maxSteps: 4 });
    expect(result.passed).toBe(true);
    expect(result.halt_reason).toBe('passed');
    expect(result.steps).toHaveLength(1);
    expect(result.final_text).toBe(draft);
  });

  it('iterates the producer with structured failedRules until clean', async () => {
    const dirty = `Hello${EM_DASH}world.`;
    let producerCalls = 0;
    const producer = async (current: string, issues: RuleIssue[]) => {
      producerCalls += 1;
      expect(issues.length).toBeGreaterThan(0);
      // simulate producer reading issues and replacing the bad char
      return current.replace(new RegExp(EM_DASH, 'g'), ', ');
    };
    const result = await critique(dirty, BRIEFING_DEFAULT_RULES, producer, { maxSteps: 4 });
    expect(result.passed).toBe(true);
    expect(producerCalls).toBe(1);
    expect(result.steps).toHaveLength(2);
    expect(result.final_text).toBe('Hello, world.');
  });

  it('halts at max_steps when producer cannot fix the issue', async () => {
    const dirty = `Stuck${EM_DASH}forever.`;
    const producer = async (current: string) => current + ' (unchanged)';
    const result = await critique(dirty, [RULE_NO_EM_OR_EN_DASH], producer, { maxSteps: 3 });
    expect(result.passed).toBe(false);
    expect(result.halt_reason).toBe('max_steps');
    expect(result.steps).toHaveLength(3);
    expect(result.open_issues.length).toBeGreaterThan(0);
  });

  it('halts when producer returns the same text twice', async () => {
    const dirty = `Stuck${EM_DASH}forever.`;
    const producer = async (current: string) => current; // never changes
    const result = await critique(dirty, [RULE_NO_EM_OR_EN_DASH], producer, { maxSteps: 5 });
    expect(result.passed).toBe(false);
    expect(result.halt_reason).toBe('producer_returned_same_text');
    expect(result.steps).toHaveLength(1);
  });

  it('respects minSteps so a critic forces at least N revisions', async () => {
    const draft = 'Clean.';
    let producerCalls = 0;
    const producer = async (current: string) => {
      producerCalls += 1;
      return current + ` v${producerCalls}`;
    };
    const result = await critique(draft, [], producer, { minSteps: 3, maxSteps: 5 });
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(producerCalls).toBe(2);
    expect(result.final_text).toBe('Clean. v1 v2');
  });

  it('strict mode treats warnings as failing too', async () => {
    const warnRule: Rule = {
      id: 'warn_only',
      description: 'warns on the letter w',
      severity: 'warning',
      check: (t) => (t.includes('w') ? { rule_id: 'warn_only', severity: 'warning', message: 'has w' } : null),
    };
    const draftDirty = 'wave';
    let calls = 0;
    const producer = async (cur: string) => {
      calls += 1;
      return cur.replace('w', 'v');
    };
    const lenient = await critique(draftDirty, [warnRule], producer, { maxSteps: 3, strict: false });
    expect(lenient.passed).toBe(true);
    expect(calls).toBe(0);
    expect(lenient.open_issues).toHaveLength(1);

    calls = 0;
    const strict = await critique(draftDirty, [warnRule], producer, { maxSteps: 3, strict: true });
    expect(strict.passed).toBe(true);
    expect(calls).toBe(1);
    expect(strict.final_text).toBe('vave');
  });

  it('records a run summary that the briefing system-health can read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-runs-'));
    const file = path.join(dir, 'critic.jsonl');
    const writer = makeCritiqueFileWriter(file);
    const fakeResult = {
      passed: true,
      final_text: 'ok',
      steps: [{ step: 1, draft: 'ok', issues: [], next_action: 'FINAL_ANSWER' as const, duration_ms: 0 }],
      open_issues: [],
      halt_reason: 'passed' as const,
    };
    recordCritiqueRun('briefing', 'briefing-default-v1', fakeResult, writer);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as CritiqueRunRecord;
    expect(rec.surface).toBe('briefing');
    expect(rec.rubric_id).toBe('briefing-default-v1');
    expect(rec.passed).toBe(true);
    expect(rec.steps).toBe(1);
  });
});
