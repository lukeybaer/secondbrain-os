// behavior-tripwire.ts
//
// Run 50 of the nightly enhancement cycle (2026-05-09).
//
// Output safety guard. Scans every outbound LLM-generated text right before it
// hits a send channel (Telegram, Gmail draft, briefing render, voice line) and
// flags violations of Luke's behavioral rules. The em-dash hook (run 49 era)
// catches one rule mechanically but the rest of the rules in
// secondbrain/memory/RULES_INDEX.md sit only as memory files. This module
// turns them into a single import the renderers can call before send so the
// rule survives a model that does not read memory perfectly.
//
// Inspired by:
//   - LangSmith "evaluator-before-send" pattern: the LLM output passes through
//     a pure-function evaluator with a pass/fail rubric BEFORE the side-effect.
//   - Anthropic constitutional AI critic step: a second pass scans the candidate
//     output for rule violations and surfaces them as structured feedback.
//   - Letta block-before-publish: archival memory writes go through a guard
//     that blocks PII leaks based on a static deny list plus regex.
//   - Pydantic Output Validators (pydantic-ai 0.5+): output schema with custom
//     validators that raise typed errors the LLM can read on retry.
//   - Composio guardrails kit: tool-output sanitization step with severity
//     levels (warn vs block) that the runtime can act on.
//
// Why SecondBrain needs this:
//   - feedback_no_em_dashes.md is enforced by em-dash-guard.mjs hook on Bash/
//     Edit/Write. But Telegram and Gmail drafts go out via API, not via Edit,
//     so the hook never sees them. A model regression slips an em dash into
//     an outbound briefing and Luke notices, not the system.
//   - feedback_no_late_night_telegram.md ("nothing to Telegram between 21:00
//     and 06:00 CT unless flagged urgent") is a memory rule with no enforcement.
//   - "Never share non-public info about Andrea/Julia/Marie-Louise" is a
//     zero-tolerance rule that today depends on the model remembering. A
//     deny-list scanner makes it mechanical.
//   - feedback_recommend_one_thing.md says responses should give ONE
//     recommendation, not a multi-option menu. A pattern probe ("Option 1 ...
//     Option 2 ...") lets us catch regressions.
//
// Design (zero deps, pure function, no I/O):
//   1. check(text, opts?) returns {ok, violations} where violations is an
//      array of {rule, severity, idx, snippet, fix?}. Pure: same input, same
//      output, no clock unless opts.now is supplied.
//   2. assertSafe(text, opts?) throws BehaviorTripwireError on any violation
//      with severity >= the configured threshold. For callers that want a
//      hard stop.
//   3. applyAutoFix(text, violations) applies safe rewrites for rules that
//      have a deterministic fix (em dash -> comma, en dash in prose -> hyphen).
//      Rules without a fix are left for the caller to address.
//   4. The rule set is composable: callers can disable specific rules per
//      channel (a voice line is allowed to mention Andrea if the call IS to
//      Andrea, etc).
//
// Critical invariants:
//   1. Pure when opts.now is supplied. Tests should always supply opts.now.
//   2. The deny-list match is word-boundary-aware to avoid false positives on
//      similar names (e.g. "Andreas" should not match "Andrea").
//   3. severity 'block' is hard-stop in assertSafe; 'warn' is soft and is only
//      blocked if opts.threshold === 'warn'.
//   4. Rule IDs are stable strings; tests pin against them so adding a new rule
//      does not break existing assertions.

// Types

export type Severity = 'warn' | 'block';

export interface Violation {
  rule: string;            // stable id like 'em-dash', 'late-night-telegram'
  severity: Severity;
  idx: number;             // character index in text where the violation starts
  snippet: string;         // up to 60 chars around idx for forensics
  fix?: string;            // suggested replacement for the matched substring
  suggestion?: string;     // human-readable note about how to fix
}

export interface CheckOptions {
  channel?: 'telegram' | 'gmail' | 'briefing' | 'voice' | 'general';
  now?: Date;              // for late-night/sabbath checks; defaults to current time
  /** Disable specific rule ids. Useful per-channel. */
  disable?: string[];
  /** Custom timezone offset minutes from UTC. Default Central Time -> -360 (CDT) / -360 (CST static for tests). Tests pin via opts.now. */
  tzOffsetMinutes?: number;
  /** Allow specific contact references for this call (e.g., Andrea is the actual addressee on a different person's email). */
  allowContacts?: string[];
  /** Threshold: 'warn' blocks on warn+block; 'block' blocks only on block. Default 'block'. */
  threshold?: Severity;
}

export interface CheckResult {
  ok: boolean;             // true iff no violations at or above threshold
  violations: Violation[]; // all violations regardless of threshold
}

export class BehaviorTripwireError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super(`Behavior tripwire blocked output: ${violations.map(v => v.rule).join(', ')}`);
    this.name = 'BehaviorTripwireError';
    this.violations = violations;
  }
}

// Helper: snippet around a match, clipped to 60 chars centered on idx.
function snippetAround(text: string, idx: number, len = 60): string {
  const half = Math.floor(len / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + half);
  const slice = text.slice(start, end).replace(/\s+/g, ' ');
  return slice;
}

// Rules

interface Rule {
  id: string;
  severity: Severity;
  scan(text: string, opts: CheckOptions): Violation[];
}

const RULE_EM_DASH: Rule = {
  id: 'em-dash',
  severity: 'block',
  scan(text) {
    const out: Violation[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x2014) {
        out.push({
          rule: 'em-dash',
          severity: 'block',
          idx: i,
          snippet: snippetAround(text, i),
          fix: ',',
          suggestion: 'replace U+2014 em dash with a comma or period',
        });
      }
    }
    return out;
  },
};

const RULE_EN_DASH_IN_PROSE: Rule = {
  id: 'en-dash-prose',
  severity: 'warn',
  scan(text) {
    const out: Violation[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x2013) {
        // en dash is fine for numeric ranges like 2026-05-09 or "pages 12-15".
        // Heuristic: surrounded by digits (with optional spaces) -> ok.
        const before = text.charAt(i - 1);
        const after = text.charAt(i + 1);
        const numericContext = /\d/.test(before) && /\d/.test(after);
        if (!numericContext) {
          out.push({
            rule: 'en-dash-prose',
            severity: 'warn',
            idx: i,
            snippet: snippetAround(text, i),
            fix: '-',
            suggestion: 'replace U+2013 en dash with a hyphen-minus or restructure the sentence',
          });
        }
      }
    }
    return out;
  },
};

// Names that must NOT appear in any output (zero-tolerance, see global CLAUDE.md
// "no ex-wife tracking" rule). Word-boundary aware so "Andreas" or "Julianna"
// do not false-match.
const FORBIDDEN_NAMES = ['Andrea', 'Julia', 'Marie-Louise', 'Marie Louise'];

const RULE_FORBIDDEN_NAME: Rule = {
  id: 'forbidden-name',
  severity: 'block',
  scan(text, opts) {
    const out: Violation[] = [];
    const allowed = new Set((opts.allowContacts || []).map(s => s.toLowerCase()));
    for (const name of FORBIDDEN_NAMES) {
      if (allowed.has(name.toLowerCase())) continue;
      // Build a regex with word boundaries on both sides. For names containing
      // spaces or hyphens, we still want \b behavior at the boundary chars.
      const escaped = name.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp(`(^|[^A-Za-z])(${escaped})(?=[^A-Za-z]|$)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const idx = m.index + m[1].length;
        out.push({
          rule: 'forbidden-name',
          severity: 'block',
          idx,
          snippet: snippetAround(text, idx),
          suggestion: `remove or replace reference to "${name}"`,
        });
      }
    }
    return out;
  },
};

const RULE_LATE_NIGHT_TELEGRAM: Rule = {
  id: 'late-night-telegram',
  severity: 'block',
  scan(_text, opts) {
    if (opts.channel !== 'telegram') return [];
    // Allow callers to mark a message URGENT. We look at the full text body
    // for an explicit URGENT or EMERGENCY token; if present, the rule is
    // suppressed.
    if (/\bURGENT\b|\bEMERGENCY\b/.test(_text)) return [];
    const now = opts.now ?? new Date();
    const offsetMin = opts.tzOffsetMinutes ?? -300; // Central daylight time UTC-5; CST is -6. Tests pin opts.now.
    const ctMillis = now.getTime() + offsetMin * 60_000;
    const ct = new Date(ctMillis);
    const hour = ct.getUTCHours();
    // Block 21:00 -> 06:00 CT
    if (hour >= 21 || hour < 6) {
      return [{
        rule: 'late-night-telegram',
        severity: 'block',
        idx: 0,
        snippet: snippetAround(_text, 0),
        suggestion: `Telegram send blocked: current CT hour ${hour}, allowed window 06:00-21:00. Add the URGENT marker to override.`,
      }];
    }
    return [];
  },
};

const RULE_TELEGRAM_TOO_LONG: Rule = {
  id: 'telegram-too-long',
  severity: 'block',
  scan(text, opts) {
    if (opts.channel !== 'telegram') return [];
    if (text.length <= 4096) return [];
    return [{
      rule: 'telegram-too-long',
      severity: 'block',
      idx: 4096,
      snippet: snippetAround(text, 4096),
      suggestion: `Telegram message is ${text.length} chars, max 4096. Split or summarize.`,
    }];
  },
};

const MULTI_OPTION_RE =
  /(\boption\s+1\b[\s\S]{0,400}?\boption\s+2\b)|(\b1\.\s+[^\n]{1,200}\n[\s\S]{0,400}?\b2\.\s+[^\n]{1,200}\n[\s\S]{0,400}?\bwhich\s+(option|approach|one)\b)/i;

const RULE_MULTI_OPTION_RECO: Rule = {
  id: 'multi-option-reco',
  severity: 'warn',
  scan(text) {
    const m = MULTI_OPTION_RE.exec(text);
    if (!m) return [];
    return [{
      rule: 'multi-option-reco',
      severity: 'warn',
      idx: m.index,
      snippet: snippetAround(text, m.index),
      suggestion: 'feedback_recommend_one_thing.md: pick one recommendation, name the alternatives you rejected and why; do not present a menu',
    }];
  },
};

// Stable rule registry.
const ALL_RULES: Rule[] = [
  RULE_EM_DASH,
  RULE_EN_DASH_IN_PROSE,
  RULE_FORBIDDEN_NAME,
  RULE_LATE_NIGHT_TELEGRAM,
  RULE_TELEGRAM_TOO_LONG,
  RULE_MULTI_OPTION_RECO,
];

// Public API

export function check(text: string, opts: CheckOptions = {}): CheckResult {
  const disabled = new Set(opts.disable || []);
  const threshold: Severity = opts.threshold ?? 'block';
  const violations: Violation[] = [];
  for (const rule of ALL_RULES) {
    if (disabled.has(rule.id)) continue;
    violations.push(...rule.scan(text, opts));
  }
  // Sort by idx so callers iterating left-to-right get a stable order.
  violations.sort((a, b) => a.idx - b.idx);
  const blocking = violations.filter(v => severityRank(v.severity) >= severityRank(threshold));
  return { ok: blocking.length === 0, violations };
}

export function assertSafe(text: string, opts: CheckOptions = {}): void {
  const result = check(text, opts);
  if (!result.ok) {
    const threshold: Severity = opts.threshold ?? 'block';
    const blocking = result.violations.filter(v => severityRank(v.severity) >= severityRank(threshold));
    throw new BehaviorTripwireError(blocking);
  }
}

/**
 * Apply deterministic auto-fixes for violations that have a 'fix' field.
 * Iterates from end to start so character indices remain valid as we splice.
 * Returns the rewritten text. Violations without a fix are left in place.
 */
export function applyAutoFix(text: string, violations: Violation[]): string {
  const fixable = violations.filter(v => v.fix !== undefined);
  // Sort descending by idx so earlier fixes do not shift later indices.
  fixable.sort((a, b) => b.idx - a.idx);
  let out = text;
  for (const v of fixable) {
    // The matched substring length depends on the rule. em-dash and en-dash
    // are single chars. We rely on rule.fix being a suitable replacement for
    // the SINGLE character at idx. Rules with multi-char matches must encode
    // the full replacement themselves (none currently do).
    out = out.slice(0, v.idx) + (v.fix ?? '') + out.slice(v.idx + 1);
  }
  return out;
}

function severityRank(s: Severity): number {
  return s === 'block' ? 2 : 1;
}

// Convenience exported list for tests and callers that want to introspect.
export const RULE_IDS = ALL_RULES.map(r => r.id);
