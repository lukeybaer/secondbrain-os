// tool-arg-repair-hint.ts
//
// Turn preflight-validator violations into a tight, model-readable corrective
// instruction so an autonomous agent can self-fix bad tool arguments WITHOUT a
// paid round-trip. This closes the validate -> repair -> retry loop:
//
//   validate()    (preflight-validator)  -> Violation[]  (DETECTS bad args)
//   repairHint()  (this module)          -> instruction  (CRAFTS the fix nudge)
//
// Pattern synthesized from:
//   - Letta strict tool schemas: every tool ships a JSON-Schema and the
//     runtime rejects malformed args before egress. The missing half is
//     telling the model HOW to fix them.
//   - pydantic-ai / BAML ModelRetry: raise a structured error carrying the
//     exact field and constraint so the model self-corrects on the next turn
//     rather than failing at the API boundary.
//
// Why SecondBrain needs this:
//   preflight-validator DETECTS bad tool args (a Vapi number missing +1, a
//   Gmail recipient that fails the email pattern) but hands the caller a raw
//   Violation[]. When Amy autonomously builds a call/Gmail/Telegram payload
//   and gets an arg wrong, she needs a precise one-line correction to retry
//   on, not a generic "invalid". This synthesizes that correction from the
//   schema constraint + the offending value.
//
// Pure module: no electron, no network, no fs. Input -> output only.

import type { Violation, Schema } from './preflight-validator';

export interface FieldFix {
  path: string;
  rule: string;
  // One-line, model-readable corrective instruction.
  instruction: string;
}

export interface RepairHint {
  // False only when there is nothing actionable to fix (no violations).
  retryable: boolean;
  // A single combined instruction block the caller can append to the retry
  // prompt. Empty string when retryable is false.
  instruction: string;
  fieldFixes: FieldFix[];
}

// ── Schema path resolution ──────────────────────────────────────────────────

// Resolve the sub-schema for a dotted/indexed violation path like
// 'to[0].email' so we can quote the EXACT constraint the model violated.
// Returns undefined when the path cannot be resolved (e.g. additionalProperties
// keys that are not declared in the schema).
export function resolvePathSchema(root: Schema, path: string): Schema | undefined {
  if (!path) return root;
  // Split 'a[0].b' into ['a', '0', 'b'].
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);

  let current: Schema | undefined = root;
  for (const seg of segments) {
    if (!current) return undefined;
    if (/^\d+$/.test(seg)) {
      // Array index -> descend into items.
      current = current.items;
    } else {
      current = current.properties?.[seg];
    }
  }
  return current;
}

function describe(schema: Schema | undefined): string {
  return schema?.description ? ` (${schema.description})` : '';
}

function show(value: ExampleCo): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Recognize common patterns so the hint is concrete, not just a raw regex.
function patternHint(pattern: string, got: ExampleCo): string {
  const p = pattern;
  if (p.includes('@')) {
    return `must be a valid email address; you sent ${show(got)}`;
  }
  if (p.includes('+') && /\\d|\d/.test(p) && (p.includes('[1-9]') || p.includes('\\+'))) {
    return `must be an E.164 phone number (leading + and country code, e.g. +12025550123); you sent ${show(got)}`;
  }
  return `must match the pattern ${p}; you sent ${show(got)}`;
}

// ── Per-rule corrective synthesis ────────────────────────────────────────────

function fixFor(v: Violation, root: Schema): string {
  const at = resolvePathSchema(root, v.path);
  const field = v.path || '(root)';
  switch (v.rule) {
    case 'required':
      // preflight reports the missing key inside the message; keep the field
      // pointer plus any schema description so the model knows what to supply.
      return `add the required field \`${field}\`${describe(at)}: ${v.message}`;
    case 'type': {
      const want = at?.type ? JSON.stringify(at.type) : 'the declared type';
      return `\`${field}\` must be of type ${want}; ${v.message}`;
    }
    case 'enum': {
      const allowed = at?.enum ? JSON.stringify(at.enum) : 'the allowed set';
      return `\`${field}\` must be one of ${allowed}; ${v.message}`;
    }
    case 'pattern': {
      const pat = at?.pattern;
      return `\`${field}\` ${pat ? patternHint(pat, v.got) : v.message}`;
    }
    case 'minLength':
      return `\`${field}\` is too short (${v.message}); lengthen it to satisfy minLength ${at?.minLength ?? ''}`.trimEnd();
    case 'maxLength':
      return `\`${field}\` is too long (${v.message}); shorten it to satisfy maxLength ${at?.maxLength ?? ''}`.trimEnd();
    case 'minimum':
      return `\`${field}\` is below the minimum (${v.message}); raise it to >= ${at?.minimum ?? ''}`.trimEnd();
    case 'maximum':
      return `\`${field}\` exceeds the maximum (${v.message}); lower it to <= ${at?.maximum ?? ''}`.trimEnd();
    case 'minItems':
      return `\`${field}\` needs more items (${v.message}); add entries to reach minItems ${at?.minItems ?? ''}`.trimEnd();
    case 'maxItems':
      return `\`${field}\` has too many items (${v.message}); remove entries to reach maxItems ${at?.maxItems ?? ''}`.trimEnd();
    case 'additionalProperties':
      return `remove the unexpected field \`${field}\`; it is not part of this tool's schema (${v.message})`;
    case 'predicate':
      // The custom predicate already returned a human reason in the message.
      return `\`${field}\` failed validation: ${v.message}`;
    default:
      return `\`${field}\`: ${v.message}`;
  }
}

/**
 * Build a model-readable repair instruction from a set of preflight
 * violations. `schema` is the same Schema passed to validate(), used to quote
 * the exact constraint per field. `attemptedArgs` is optional and only used
 * to enrich the header line.
 */
export function repairHint(
  violations: ReadonlyArray<Violation>,
  schema: Schema,
  attemptedArgs?: ExampleCo,
): RepairHint {
  if (violations.length === 0) {
    return { retryable: false, instruction: '', fieldFixes: [] };
  }

  const fieldFixes: FieldFix[] = violations.map((v) => ({
    path: v.path,
    rule: v.rule,
    instruction: fixFor(v, schema),
  }));

  const header =
    violations.length === 1
      ? 'Your tool arguments failed validation. Fix this and call the tool again:'
      : `Your tool arguments failed validation on ${violations.length} fields. Fix all of these and call the tool again:`;

  const lines = fieldFixes.map((f, i) => `${i + 1}. ${f.instruction}`);
  const instruction = [header, ...lines].join('\n');
  void attemptedArgs; // reserved for richer diffs; intentionally unused for now

  return { retryable: true, instruction, fieldFixes };
}
