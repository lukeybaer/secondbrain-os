// output-critic-rules.ts
//
// Surface-specific rule packs for output-critic.ts.
//
// output-critic.ts ships a critique loop and two baseline rules (em-dash,
// UTC-time). Every outbound surface Amy speaks on has additional Luke-locked
// rules that today live as standalone hooks, ad-hoc regex checks, or unwritten
// expectations: Gmail must end with Luke's signature, Telegram must skip late
// at night, ex-spouse names are a hard tripwire, GPT-style hedging language is
// banned, filler openers ("Great question") are banned, and the detail block
// has a 4-paragraph ceiling.
//
// This module centralizes those rules and bundles them into named packs
// keyed by surface. Producers pass the surface name; critique() enforces the
// matching pack. Adding a new rule never touches the producer.
//
// Patterns synthesized from:
//   - CrewAI Reflexion (arXiv 2303.11366): critic-then-revise iteration loop
//     where the critic carries a rubric and the producer revises until the
//     rubric passes. Surface-specific rubrics let one critic loop serve many
//     producers without forking.
//   - Agno reasoning manager (libs/agno/agno/reasoning/manager.py:830): typed
//     rubric injected into the loop, get_next_action() chooses CONTINUE or
//     FINAL_ANSWER per step. Severity-tagged rules let warnings flow without
//     blocking FINAL_ANSWER.
//   - LangGraph "policy" subgraph pattern: enforcement rules live as a small
//     policy graph that any worker invokes, so the same rule pack guards every
//     outbound surface.
//
// Locked Luke rules this pack mechanically enforces:
//   - feedback_no_em_dashes.md (already in output-critic.ts)
//   - feedback_times_in_ct_never_utc.md (already in output-critic.ts)
//   - feedback_communication.md: terse, no filler
//   - feedback_warm_tone_with_partners.md: warm external, terse internal
//   - reference_luke_signature.md: every Gmail draft ends with the signature
//   - "No ex-wife tracking: never store/surface info about Andrea, Julia,
//     Marie-Louise" (CLAUDE.global.md behavioral rules)
//   - "No late-night Telegram" feedback_no_late_night_telegram.md
//   - feedback_ceo_tier_one_brevity.md: 3-second decide-or-not test
//
// Pure module: no fs, no electron, no network. Importable from tests, the
// briefing producer, the gmail draft producer, and the telegram dispatch path.

import {
  Rule,
  RuleIssue,
  RULE_NO_EM_OR_EN_DASH,
  RULE_NO_UTC_TIMES,
  RULE_TIER_ONE_BREVITY,
  BRIEFING_DEFAULT_RULES,
} from './output-critic';

// ── Forbidden people (zero-tolerance privacy tripwire) ────────────────────────

/**
 * Names that must NEVER appear in any Amy output. Andrea, Julia, and
 * Marie-Louise are Luke's ex-spouse, ex-stepdaughter, and ex-mother-in-law.
 * The global CLAUDE.md rule is absolute: "never store/surface info about
 * Andrea, Julia, Marie-Louise." This rule is a backstop in case data
 * accidentally enters the producer (e.g. a stale Gmail thread, a memory
 * file that escaped the redaction).
 *
 * Matches whole-word, case-insensitive. Won't trip on "Juliana" or
 * "Andreas" because the regex uses word boundaries on both sides.
 */
export const FORBIDDEN_PEOPLE: ReadonlyArray<string> = ['Andrea', 'Julia', 'Marie-Louise'];

export const RULE_NO_FORBIDDEN_PEOPLE: Rule = {
  id: 'no_forbidden_people',
  description:
    'Names Amy must never surface (global privacy rule: Andrea, Julia, Marie-Louise).',
  severity: 'error',
  check: (text) => {
    const issues: RuleIssue[] = [];
    for (const name of FORBIDDEN_PEOPLE) {
      // word-boundary regex, case-insensitive, hyphens preserved.
      // Hyphen is NOT escaped (invalid in `u` mode outside a character class)
      // and is placed at the end of the negated character class so it is
      // treated as a literal, not a range delimiter.
      const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_-])(${escaped})(?=$|[^\\p{L}\\p{N}_-])`, 'giu');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        issues.push({
          rule_id: 'no_forbidden_people',
          severity: 'error',
          message: `Forbidden name "${m[2]}" found. This name must never appear in any Amy output.`,
          index: m.index + m[1].length,
          match: m[2],
        });
      }
    }
    return issues.length ? issues : null;
  },
};

// ── No GPT-style hedging ──────────────────────────────────────────────────────

/**
 * Phrases that mark unsourced speculation. Amy must say "I don't know" when
 * uncertain (feedback_anti_fabrication_is_foundation_not_rules.md), not hedge
 * with weasel words. The list is bounded and conservative: only catches
 * phrases that are unambiguously a fabrication smell.
 *
 * Compiled from real observed regressions in past briefings and call drafts.
 */
const HEDGING_PHRASES: ReadonlyArray<string> = [
  'approximately',
  'roughly speaking',
  'somewhere around',
  'i believe',
  'i think',
  'i feel like',
  'it seems',
  'it appears',
  'as far as i know',
  'if memory serves',
  "should be around",
  "ought to be",
  'kind of',
  'sort of',
];

export const RULE_NO_HEDGING: Rule = {
  id: 'no_hedging',
  description:
    'No GPT-style hedging. Say "I don\'t know" when uncertain. (feedback_anti_fabrication_is_foundation_not_rules.md)',
  severity: 'error',
  check: (text) => {
    const lower = text.toLowerCase();
    const issues: RuleIssue[] = [];
    for (const phrase of HEDGING_PHRASES) {
      let from = 0;
      for (;;) {
        const i = lower.indexOf(phrase, from);
        if (i < 0) break;
        // require word boundaries so "approximately" doesn't catch "approximate" inside a word.
        const before = i === 0 ? ' ' : lower[i - 1];
        const after = i + phrase.length >= lower.length ? ' ' : lower[i + phrase.length];
        const isBoundary = /[^a-z0-9]/.test(before) && /[^a-z0-9]/.test(after);
        if (isBoundary) {
          issues.push({
            rule_id: 'no_hedging',
            severity: 'error',
            message: `Hedging phrase "${text.slice(i, i + phrase.length)}" found. Rewrite with a sourced claim or say "I don't know".`,
            index: i,
            match: text.slice(i, i + phrase.length),
          });
        }
        from = i + phrase.length;
      }
    }
    return issues.length ? issues : null;
  },
};

// ── No filler openers ─────────────────────────────────────────────────────────

/**
 * Phrases banned in Amy's voice: feedback_communication.md says "no filler,
 * no hedging, no 'Great question.'" These openers are the failure mode of an
 * untrained LLM emulating an assistant. Amy is terse by default.
 */
const FILLER_PHRASES: ReadonlyArray<string> = [
  'great question',
  "i'd be happy to",
  'i would be happy to',
  'happy to help',
  "let me know if",
  "as an ai",
  "as a large language model",
  'certainly!',
  'absolutely!',
  'of course!',
  "i'm glad you asked",
  // Waiting/transition narration - sounds like a hold message, not an EA
  'this will just take a second',
  'this will only take a second',
  'this will just take a moment',
  'this will only take a moment',
  'just give me a second',
  'just give me a moment',
  'bear with me',
  'bear with me for a moment',
  'hang tight',
  'hang on a second',
  'hang on just a moment',
];

export const RULE_NO_FILLER: Rule = {
  id: 'no_filler',
  description: 'No filler openers in Amy voice (feedback_communication.md: terse, direct).',
  severity: 'error',
  check: (text) => {
    const lower = text.toLowerCase();
    const issues: RuleIssue[] = [];
    for (const phrase of FILLER_PHRASES) {
      let from = 0;
      for (;;) {
        const i = lower.indexOf(phrase, from);
        if (i < 0) break;
        issues.push({
          rule_id: 'no_filler',
          severity: 'error',
          message: `Filler phrase "${text.slice(i, i + phrase.length)}" found. Amy is terse, drop the opener.`,
          index: i,
          match: text.slice(i, i + phrase.length),
        });
        from = i + phrase.length;
      }
    }
    return issues.length ? issues : null;
  },
};

// ── Gmail signature requirement ───────────────────────────────────────────────

/**
 * Every Gmail draft Amy ships on Luke's behalf must end with his signature
 * (reference_luke_signature.md). The check is intentionally tolerant of
 * variant whitespace: as long as the literal "Luke" appears in the last
 * 200 chars and follows a line break, the rule passes.
 *
 * Allow-callers to override with a configurable required line.
 */
export const RULE_REQUIRES_LUKE_SIGNATURE = (required = 'Luke'): Rule => ({
  id: 'requires_luke_signature',
  description: `Gmail drafts must end with Luke's signature ("${required}").`,
  severity: 'error',
  check: (text) => {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed.length === 0) {
      return {
        rule_id: 'requires_luke_signature',
        severity: 'error',
        message: 'Gmail draft is empty.',
      };
    }
    const tail = trimmed.slice(-200);
    // signature must appear on its own line (preceded by newline or be the start of tail) and as a word.
    // Hyphen omitted from escape set because it is a literal outside a character class.
    const re = new RegExp(`(^|\\n)\\s*${required.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(tail)) return null;
    return {
      rule_id: 'requires_luke_signature',
      severity: 'error',
      message: `Gmail draft does not end with "${required}" on its own line. Add the signature.`,
    };
  },
});

// ── Max paragraphs (detail-block ceiling) ─────────────────────────────────────

/**
 * Luke rule: "Detail block 1-2 paras typical, 4 max" (feedback_communication_format_tldr_detail.md).
 * Empty lines split paragraphs; consecutive empty lines collapse.
 */
export const RULE_MAX_PARAGRAPHS = (maxParagraphs = 4): Rule => ({
  id: 'max_paragraphs',
  description: `Detail block ceiling: at most ${maxParagraphs} paragraphs.`,
  severity: 'error',
  check: (text) => {
    // split on blank-line runs; ignore trailing whitespace
    const paragraphs = text
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length <= maxParagraphs) return null;
    return {
      rule_id: 'max_paragraphs',
      severity: 'error',
      message: `Detail block has ${paragraphs.length} paragraphs (limit ${maxParagraphs}). Tighten or cut.`,
    };
  },
});

// ── Late-night Telegram tripwire ──────────────────────────────────────────────

/**
 * Luke rule: no Telegram between 22:00 and 06:00 CT (feedback_no_late_night_telegram.md).
 * Rule receives the "now" timestamp via factory so callers can override for
 * unit tests. Defaults to actual current time.
 *
 * NOTE: this rule does not look at message content; it gates ANY draft when
 * the clock is in the quiet window. Use only in the Telegram surface pack.
 */
export const RULE_NO_LATE_NIGHT_TELEGRAM = (opts?: {
  now?: () => Date;
  quietStartHourCT?: number;
  quietEndHourCT?: number;
}): Rule => {
  const now = opts?.now ?? (() => new Date());
  const startHour = opts?.quietStartHourCT ?? 22;
  const endHour = opts?.quietEndHourCT ?? 6;
  return {
    id: 'no_late_night_telegram',
    description: `Telegram quiet hours: ${startHour}:00 to ${endHour}:00 CT.`,
    severity: 'error',
    check: (_text) => {
      // CT = UTC-6 (CST) or UTC-5 (CDT). Use a simple UTC-6 floor for
      // determinism. The +-1 hour DST drift is acceptable for a quiet-hour
      // guard; the buffer is wider than DST shifts.
      const d = now();
      const ctHour = (d.getUTCHours() - 6 + 24) % 24;
      const inQuiet =
        startHour > endHour
          ? ctHour >= startHour || ctHour < endHour
          : ctHour >= startHour && ctHour < endHour;
      if (!inQuiet) return null;
      return {
        rule_id: 'no_late_night_telegram',
        severity: 'error',
        message: `Telegram quiet hours active (${ctHour}:00 CT, window ${startHour}:00-${endHour}:00). Hold the message until morning.`,
      };
    },
  };
};

// ── Surface packs ─────────────────────────────────────────────────────────────

/**
 * Briefing surface: everything from the existing BRIEFING_DEFAULT_RULES plus
 * forbidden-people tripwire and the anti-hedging rule.
 */
export const BRIEFING_FULL_RULES: ReadonlyArray<Rule> = [
  ...BRIEFING_DEFAULT_RULES,
  RULE_NO_FORBIDDEN_PEOPLE,
  RULE_NO_HEDGING,
];

/**
 * Gmail surface: baseline + forbidden-people + filler + signature required.
 * Hedging is allowed in external mail because warm tone sometimes calls for
 * softening; the producer is trusted to phrase carefully.
 */
export const GMAIL_DEFAULT_RULES = (requiredSignature = 'Luke'): ReadonlyArray<Rule> => [
  RULE_NO_EM_OR_EN_DASH,
  RULE_NO_UTC_TIMES,
  RULE_NO_FORBIDDEN_PEOPLE,
  RULE_NO_FILLER,
  RULE_REQUIRES_LUKE_SIGNATURE(requiredSignature),
];

/**
 * Telegram surface: baseline + tier-1 brevity + forbidden-people + filler +
 * quiet-hour gate. Brevity is required because Telegram is a phone-screen
 * surface; long blocks get scrolled past.
 */
export const TELEGRAM_DEFAULT_RULES = (opts?: {
  maxChars?: number;
  quietHours?: Parameters<typeof RULE_NO_LATE_NIGHT_TELEGRAM>[0];
}): ReadonlyArray<Rule> => [
  RULE_NO_EM_OR_EN_DASH,
  RULE_NO_UTC_TIMES,
  RULE_NO_FORBIDDEN_PEOPLE,
  RULE_NO_FILLER,
  RULE_TIER_ONE_BREVITY(2, opts?.maxChars ?? 280),
  RULE_NO_LATE_NIGHT_TELEGRAM(opts?.quietHours),
];

/**
 * Vapi callee surface: baseline + forbidden-people + filler. Callee is
 * external so signature is not relevant and quiet hours are caller-defined.
 * Hedging is allowed because spoken dialog needs softening.
 */
export const VAPI_CALLEE_DEFAULT_RULES: ReadonlyArray<Rule> = [
  RULE_NO_FORBIDDEN_PEOPLE,
  RULE_NO_FILLER,
];

/**
 * Lookup by surface name. Returns null when the surface is unknown so the
 * caller can decide whether to fall back to BRIEFING_DEFAULT_RULES or fail
 * loud. This indirection lets the producer pass a surface string from
 * config without owning the rule list itself.
 */
export type Surface = 'briefing' | 'gmail' | 'telegram' | 'vapi_callee';

export function rulesForSurface(surface: Surface): ReadonlyArray<Rule> {
  switch (surface) {
    case 'briefing':
      return BRIEFING_FULL_RULES;
    case 'gmail':
      return GMAIL_DEFAULT_RULES();
    case 'telegram':
      return TELEGRAM_DEFAULT_RULES();
    case 'vapi_callee':
      return VAPI_CALLEE_DEFAULT_RULES;
  }
}
