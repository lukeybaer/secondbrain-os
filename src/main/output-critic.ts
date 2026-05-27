// output-critic.ts
//
// Multi-step rubric verifier for any text output (briefing sections, Gmail
// drafts, Telegram messages, video script captions). Inspired by
// agno-agi/agno libs/agno/agno/reasoning/manager.py:830 _run_default_reasoning_events
// loop: a critic agent runs N <= max_steps cycles, each step parses a
// structured ReasoningStep, and get_next_action() returns CONTINUE or
// FINAL_ANSWER. Bounded by reasoning_min_steps and reasoning_max_steps.
//
// Why SecondBrain needs this:
//   - The video pipeline has a quality rubric (data/agent/video-quality-rubric.json)
//     and run-quality-check.py enforces thresholds before promotion. Briefings,
//     Gmail drafts, and Telegram messages have no equivalent gate.
//   - Memory rules like "no em dashes anywhere" and "times in CT, never UTC"
//     are mechanically enforced for code (em-dash hook) but not for outbound
//     content. A briefing with an em dash escapes today.
//   - Each rule today is enforced in a different test or hook with no shared
//     spec; a critic with a typed rubric centralizes the spec and lets new
//     rules attach without forking the producer.
//
// Two layers:
//   1) checkRules() runs every Rule against text in pure JS for fast O(rules)
//      structural checks (regex, presence, count). No LLM. Ships first.
//   2) critique() wraps an iterative producer loop: producer drafts text,
//      checkRules judges, on failure the rule list is fed back to the producer
//      as structured "failedRules" so the next draft sees the specific issue.
//      Bounded by minSteps and maxSteps. Producer is injected so the critic
//      stays LLM-agnostic and unit-testable.

import * as fs from 'fs';
import * as path from 'path';

// Types

export type Severity = 'error' | 'warning';

export interface RuleIssue {
  rule_id: string;
  severity: Severity;
  message: string;
  // optional location for callers that want to highlight in UI
  index?: number;
  match?: string;
}

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  // returns null when text passes, otherwise one or more issues to surface
  check: (text: string) => RuleIssue | RuleIssue[] | null;
}

export interface CritiqueRunStep {
  step: number;
  draft: string;
  issues: RuleIssue[];
  next_action: 'CONTINUE' | 'FINAL_ANSWER';
  duration_ms: number;
}

export interface CritiqueOpts {
  minSteps?: number;     // default 1, mirrors agno reasoning_min_steps
  maxSteps?: number;     // default 4, mirrors agno reasoning_max_steps
  // When true, treat warning-severity issues as failing too. Default false:
  // only error-severity issues block FINAL_ANSWER.
  strict?: boolean;
}

export interface CritiqueResult {
  passed: boolean;
  final_text: string;
  steps: CritiqueRunStep[];
  open_issues: RuleIssue[];
  halt_reason: 'passed' | 'max_steps' | 'producer_returned_same_text';
}

export type Producer = (draft: string, issues: RuleIssue[]) => Promise<string>;

// Rule running

export function checkRules(text: string, rules: ReadonlyArray<Rule>): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const rule of rules) {
    const out = rule.check(text);
    if (out == null) continue;
    if (Array.isArray(out)) issues.push(...out);
    else issues.push(out);
  }
  return issues;
}

function blocking(issues: RuleIssue[], strict: boolean): RuleIssue[] {
  return strict ? issues : issues.filter((i) => i.severity === 'error');
}

// Critique loop

export async function critique(
  initialDraft: string,
  rules: ReadonlyArray<Rule>,
  produceRevision: Producer,
  opts: CritiqueOpts = {},
): Promise<CritiqueResult> {
  const minSteps = Math.max(1, opts.minSteps ?? 1);
  const maxSteps = Math.max(minSteps, opts.maxSteps ?? 4);
  const strict = opts.strict ?? false;

  let draft = initialDraft;
  const steps: CritiqueRunStep[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const start = Date.now();
    const issues = checkRules(draft, rules);
    const blockers = blocking(issues, strict);
    const passes = blockers.length === 0 && step >= minSteps;
    const next_action: CritiqueRunStep['next_action'] = passes ? 'FINAL_ANSWER' : 'CONTINUE';

    steps.push({
      step,
      draft,
      issues,
      next_action,
      duration_ms: Date.now() - start,
    });

    if (passes) {
      return {
        passed: true,
        final_text: draft,
        steps,
        open_issues: issues.filter((i) => !blockers.includes(i)),
        halt_reason: 'passed',
      };
    }
    if (step === maxSteps) {
      return {
        passed: false,
        final_text: draft,
        steps,
        open_issues: issues,
        halt_reason: 'max_steps',
      };
    }
    const revised = await produceRevision(draft, issues);
    if (revised === draft) {
      return {
        passed: false,
        final_text: draft,
        steps,
        open_issues: issues,
        halt_reason: 'producer_returned_same_text',
      };
    }
    draft = revised;
  }

  // unreachable: loop returns inside
  return {
    passed: false,
    final_text: draft,
    steps,
    open_issues: checkRules(draft, rules),
    halt_reason: 'max_steps',
  };
}

// Built-in rules for the briefing surface.
//
// These match Luke's existing memory rules so the critic enforces them at
// publish time instead of relying on producer discipline:
//   - no em dashes (U+2014) or en dashes (U+2013): feedback_no_em_dashes.md
//   - times in CT, never UTC: feedback_times_in_ct_never_utc.md
//   - no fabricated URLs (heuristic: every URL must appear in the source set)

export const RULE_NO_EM_OR_EN_DASH: Rule = {
  id: 'no_em_or_en_dash',
  description: 'No em dashes (U+2014) or en dashes (U+2013) anywhere in output (Luke rule).',
  severity: 'error',
  check: (text) => {
    const issues: RuleIssue[] = [];
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    let i = text.indexOf(emDash);
    while (i >= 0) {
      issues.push({
        rule_id: 'no_em_or_en_dash',
        severity: 'error',
        message: 'Em dash (U+2014) found. Use commas, periods, or plain hyphens.',
        index: i,
        match: emDash,
      });
      i = text.indexOf(emDash, i + 1);
    }
    let j = text.indexOf(enDash);
    while (j >= 0) {
      issues.push({
        rule_id: 'no_em_or_en_dash',
        severity: 'error',
        message: 'En dash (U+2013) found. Use commas, periods, or plain hyphens.',
        index: j,
        match: enDash,
      });
      j = text.indexOf(enDash, j + 1);
    }
    return issues.length ? issues : null;
  },
};

export const RULE_NO_UTC_TIMES: Rule = {
  id: 'no_utc_times',
  description: 'Times must be in CT, not UTC (Luke rule, feedback_times_in_ct_never_utc.md).',
  severity: 'error',
  check: (text) => {
    // catches "14:00 UTC", "14:00Z", "T14:00:00Z" tokens. Phone-number-style
    // strings stay safe because the regex demands a UTC marker.
    const patterns = [
      /\b\d{1,2}:\d{2}\s*UTC\b/gi,
      /\b\d{1,2}:\d{2}Z\b/g,
      /T\d{2}:\d{2}:\d{2}Z/g,
    ];
    const hits: { start: number; end: number; text: string }[] = [];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    // dedupe overlapping ranges so an ISO timestamp does not double-count
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: typeof hits = [];
    for (const h of hits) {
      const last = merged[merged.length - 1];
      if (last && h.start < last.end) {
        if (h.end > last.end) last.end = h.end;
        if (h.text.length > last.text.length) last.text = h.text;
        continue;
      }
      merged.push({ ...h });
    }
    const issues: RuleIssue[] = merged.map((h) => ({
      rule_id: 'no_utc_times',
      severity: 'error',
      message: `UTC time found ("${h.text}"). Convert to CT and append " CT".`,
      index: h.start,
      match: h.text,
    }));
    return issues.length ? issues : null;
  },
};

export const RULE_NO_FABRICATED_URL = (allowedUrls: ReadonlyArray<string>): Rule => ({
  id: 'no_fabricated_url',
  description: 'Every URL in the output must come from the source set (Luke rule, no fabrication).',
  severity: 'error',
  check: (text) => {
    const re = /https?:\/\/[^\s)\]"'<>]+/g;
    const allowed = new Set(allowedUrls);
    const issues: RuleIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (!allowed.has(url)) {
        issues.push({
          rule_id: 'no_fabricated_url',
          severity: 'error',
          message: `URL not in source set: ${url}. Either remove it or add a citation.`,
          index: m.index,
          match: url,
        });
      }
    }
    return issues.length ? issues : null;
  },
});

export const RULE_TIER_ONE_BREVITY = (maxSentences = 1, maxChars = 200): Rule => ({
  id: 'tier_one_brevity',
  description: `Tier-1 lines must be one sentence (max ${maxSentences}) and under ${maxChars} chars.`,
  severity: 'error',
  check: (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const issues: RuleIssue[] = [];
    if (trimmed.length > maxChars) {
      issues.push({
        rule_id: 'tier_one_brevity',
        severity: 'error',
        message: `Tier-1 line is ${trimmed.length} chars (limit ${maxChars}).`,
      });
    }
    // count sentences as runs ending in . ! ? followed by whitespace or end
    const sentenceCount = (trimmed.match(/[.!?](?=\s|$)/g) ?? []).length || 1;
    if (sentenceCount > maxSentences) {
      issues.push({
        rule_id: 'tier_one_brevity',
        severity: 'error',
        message: `Tier-1 line has ${sentenceCount} sentences (limit ${maxSentences}).`,
      });
    }
    return issues.length ? issues : null;
  },
});

export const BRIEFING_DEFAULT_RULES: ReadonlyArray<Rule> = [
  RULE_NO_EM_OR_EN_DASH,
  RULE_NO_UTC_TIMES,
];

// Persistence

export interface CritiqueRunRecord {
  timestamp: string;
  surface: string;
  rubric_id: string;
  passed: boolean;
  halt_reason: CritiqueResult['halt_reason'];
  steps: number;
  open_issues: RuleIssue[];
  final_text_size: number;
}

export type CritiqueWriter = (record: CritiqueRunRecord) => void;

export function makeCritiqueFileWriter(filePath: string): CritiqueWriter {
  return (record: CritiqueRunRecord) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best effort
    }
  };
}

export function recordCritiqueRun(
  surface: string,
  rubric_id: string,
  result: CritiqueResult,
  writer: CritiqueWriter,
): CritiqueRunRecord {
  const record: CritiqueRunRecord = {
    timestamp: new Date().toISOString(),
    surface,
    rubric_id,
    passed: result.passed,
    halt_reason: result.halt_reason,
    steps: result.steps.length,
    open_issues: result.open_issues,
    final_text_size: result.final_text.length,
  };
  writer(record);
  return record;
}
