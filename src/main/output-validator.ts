// output-validator.ts
//
// Schema-validated structured output with an auto-correction retry loop.
//
// Backlog id structured-output-validation (priority 100, 2026-05-16).
//
// Amy produces many structured outputs (briefing JSON, video metadata,
// contact updates, backlog entries) and today each callsite reinvents its
// own ad-hoc "try { JSON.parse } catch { regen }" loop. When the loop is
// missing entirely (briefing news cards, x-publisher metadata, video-quality
// rubric writes) the malformed output silently lands on disk and a
// downstream surface (dashboard, x-publisher, video pipeline) breaks.
//
// Pattern sources (from prior nightly research, 2026-05-16):
//   - PydanticAI structured-output retry loop (2026-04 docs): define output
//     as a typed schema, validate after generation, re-prompt the model
//     with the validation error as feedback until it passes or attempts
//     run out. PydanticAI ships the retry as a first-class generator
//     pattern, not a per-callsite open-coded loop.
//   - Outlines (dottxt-ai/outlines): same shape, biased toward constrained
//     generation, but the validate+retry contract is the part SecondBrain
//     needs.
//   - Instructor (jxnl/instructor): schema-as-contract. Pass the schema
//     into the prompt builder so the model knows what shape to emit, then
//     repair on miss.
//
// What we ship here:
//   - A pure, dependency-free Validator<T> protocol (returns {ok, value?,
//     errors?}). Same shape as zod's safeParse without the zod dependency.
//   - A handful of primitive validators (required, oneOf, regex, range,
//     stringNonEmpty, isoTimestamp, isFiniteNumber) so callers can compose
//     a schema with a few lines instead of hand-rolling.
//   - object() composer that runs per-key validators and aggregates errors.
//   - validateAndRepair() loop: validate, on miss call a caller-supplied
//     repair(value, errors) returning the next attempt, recurse up to
//     maxAttempts. Records every attempt to data/agent/output-validation.jsonl
//     when a writer is wired in (telemetry parity with tool-trace + route).
//
// Pure module: no electron, no network. The writer is injected so tests do
// not have to mock fs.

import * as fs from 'fs';
import * as path from 'path';

// ── Validator protocol ─────────────────────────────────────────────────────

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationFail {
  ok: false;
  errors: ValidationError[];
}

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

export interface ValidationError {
  // Dotted path into the value where the error occurred.
  path: string;
  // Human-readable hint suitable for feeding back to the model as repair
  // feedback. Avoid jargon: the LLM sees this verbatim.
  message: string;
  // Expected and actual hints. Optional; for primitive validators.
  expected?: string;
  actual?: string;
}

export type Validator<T> = (value: ExampleCo, path?: string) => ValidationResult<T>;

// Compose a list of errors with a parent path prefix into the standard
// {ok:false, errors} shape. Used by object() and array() composers.
function fail(errors: ValidationError[]): ValidationFail {
  return { ok: false, errors };
}

function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

function err(path: string, message: string, expected?: string, actual?: string): ValidationError {
  return { path, message, expected, actual };
}

// ── Primitive validators ───────────────────────────────────────────────────

export const stringNonEmpty: Validator<string> = (value, p = '$') => {
  if (typeof value !== 'string') {
    return fail([err(p, `expected non-empty string, got ${typeof value}`, 'string', typeof value)]);
  }
  if (value.length === 0) {
    return fail([err(p, 'expected non-empty string, got empty string', 'string (length>0)', '""')]);
  }
  return ok(value);
};

export const isFiniteNumber: Validator<number> = (value, p = '$') => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail([err(p, `expected finite number, got ${value}`, 'number', String(value))]);
  }
  return ok(value);
};

export const isoTimestamp: Validator<string> = (value, p = '$') => {
  if (typeof value !== 'string') {
    return fail([err(p, `expected ISO timestamp string, got ${typeof value}`, 'string', typeof value)]);
  }
  // Accept ISO 8601 with optional fractional seconds and Z or +HH:MM offset.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+\-]\d{2}:\d{2})$/;
  if (!iso.test(value)) {
    return fail([err(p, `not a valid ISO 8601 timestamp: ${value}`, 'YYYY-MM-DDTHH:MM:SS(.sss)?(Z|+HH:MM)', value)]);
  }
  return ok(value);
};

export function oneOf<T extends string | number>(...allowed: T[]): Validator<T> {
  return (value, p = '$') => {
    if (!allowed.includes(value as T)) {
      return fail([err(
        p,
        `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`,
        JSON.stringify(allowed),
        JSON.stringify(value),
      )]);
    }
    return ok(value as T);
  };
}

export function regex(pattern: RegExp, label = 'pattern match'): Validator<string> {
  return (value, p = '$') => {
    if (typeof value !== 'string') {
      return fail([err(p, `expected string for ${label}, got ${typeof value}`, 'string', typeof value)]);
    }
    if (!pattern.test(value)) {
      return fail([err(p, `expected ${label} (${pattern}), got ${value}`, pattern.toString(), value)]);
    }
    return ok(value);
  };
}

export function range(min: number, max: number): Validator<number> {
  return (value, p = '$') => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail([err(p, `expected number in [${min}, ${max}], got ${typeof value}`, `[${min},${max}]`, String(value))]);
    }
    if (value < min || value > max) {
      return fail([err(p, `expected number in [${min}, ${max}], got ${value}`, `[${min},${max}]`, String(value))]);
    }
    return ok(value);
  };
}

export const boolean: Validator<boolean> = (value, p = '$') => {
  if (typeof value !== 'boolean') {
    return fail([err(p, `expected boolean, got ${typeof value}`, 'boolean', typeof value)]);
  }
  return ok(value);
};

// ── Composers ──────────────────────────────────────────────────────────────

// object({field: validator, ...}) returns a Validator<{...}> that runs
// every field validator and aggregates errors. Missing required keys are
// reported per key. Extra keys are allowed silently (additive contract,
// PydanticAI default).
export function object<Shape extends Record<string, Validator<ExampleCo>>>(
  shape: Shape,
  opts: { strict?: boolean } = {},
): Validator<{ [K in keyof Shape]: Shape[K] extends Validator<infer U> ? U : never }> {
  return (value, p = '$') => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail([err(p, `expected object, got ${Array.isArray(value) ? 'array' : typeof value}`, 'object', Array.isArray(value) ? 'array' : typeof value)]);
    }
    const v = value as Record<string, ExampleCo>;
    const errors: ValidationError[] = [];
    const out: Record<string, ExampleCo> = {};
    for (const [key, validator] of Object.entries(shape)) {
      const childPath = `${p}.${key}`;
      if (!(key in v)) {
        errors.push(err(childPath, `missing required field "${key}"`, 'present', 'undefined'));
        continue;
      }
      const r = validator(v[key], childPath);
      if (r.ok) out[key] = r.value;
      else errors.push(...r.errors);
    }
    if (opts.strict) {
      for (const key of Object.keys(v)) {
        if (!(key in shape)) {
          errors.push(err(`${p}.${key}`, `unexpected field "${key}" not in strict schema`, 'absent', 'present'));
        }
      }
    }
    if (errors.length > 0) return fail(errors);
    return ok(out as never);
  };
}

export function arrayOf<T>(item: Validator<T>, opts: { min?: number; max?: number } = {}): Validator<T[]> {
  return (value, p = '$') => {
    if (!Array.isArray(value)) {
      return fail([err(p, `expected array, got ${typeof value}`, 'array', typeof value)]);
    }
    if (opts.min !== undefined && value.length < opts.min) {
      return fail([err(p, `expected at least ${opts.min} items, got ${value.length}`, `length>=${opts.min}`, `length=${value.length}`)]);
    }
    if (opts.max !== undefined && value.length > opts.max) {
      return fail([err(p, `expected at most ${opts.max} items, got ${value.length}`, `length<=${opts.max}`, `length=${value.length}`)]);
    }
    const errors: ValidationError[] = [];
    const out: T[] = [];
    value.forEach((entry, i) => {
      const r = item(entry, `${p}[${i}]`);
      if (r.ok) out.push(r.value);
      else errors.push(...r.errors);
    });
    if (errors.length > 0) return fail(errors);
    return ok(out);
  };
}

// optional(validator) accepts undefined OR null OR a value that passes the
// inner validator. Used for fields that the LLM may omit.
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, p = '$') => {
    if (value === undefined || value === null) return ok(undefined);
    return inner(value, p);
  };
}

// ── Repair loop ────────────────────────────────────────────────────────────

export interface RepairContext<T> {
  attempt: number;          // 1-indexed
  errors: ValidationError[];
  last_value: ExampleCo;
  schema_name: string;
}

export type Repairer<T> = (ctx: RepairContext<T>) => Promise<ExampleCo> | ExampleCo;

export interface ValidationAttempt {
  attempt: number;
  ok: boolean;
  errors: ValidationError[];
  timestamp: string;
}

export interface ValidateAndRepairResult<T> {
  ok: boolean;
  value?: T;
  attempts: ValidationAttempt[];
  schema_name: string;
  // Final error list when ok === false (last attempt's errors).
  errors?: ValidationError[];
}

export interface ValidateAndRepairOpts<T> {
  schema_name: string;
  validator: Validator<T>;
  initial: ExampleCo;
  repair: Repairer<T>;
  max_attempts?: number;     // default 3 (initial + 2 repairs)
  writer?: ValidationWriter; // optional telemetry sink
}

// Telemetry record appended once per validateAndRepair call.
export interface ValidationRecord {
  timestamp: string;
  schema_name: string;
  ok: boolean;
  attempts: number;
  final_errors: ValidationError[];
}

export type ValidationWriter = (record: ValidationRecord) => void;

export function makeValidationFileWriter(filePath: string): ValidationWriter {
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best effort
    }
  };
}

/**
 * Validate `initial`, and on miss call `repair(ctx)` and validate again, up
 * to `max_attempts` times. Returns the final value on success or the last
 * attempt's errors on failure.
 *
 * The repair function receives the prior errors and is expected to return
 * a corrected candidate (usually by re-prompting an LLM with the error
 * feedback inlined). When repair is impossible (e.g. the LLM is offline),
 * the caller can return the same value to short-circuit the loop.
 */
export async function validateAndRepair<T>(
  opts: ValidateAndRepairOpts<T>,
): Promise<ValidateAndRepairResult<T>> {
  const max = Math.max(1, opts.max_attempts ?? 3);
  const attempts: ValidationAttempt[] = [];
  let current: ExampleCo = opts.initial;
  let lastErrors: ValidationError[] = [];

  for (let i = 1; i <= max; i += 1) {
    const r = opts.validator(current, '$');
    if (r.ok) {
      attempts.push({ attempt: i, ok: true, errors: [], timestamp: new Date().toISOString() });
      if (opts.writer) {
        opts.writer({
          timestamp: new Date().toISOString(),
          schema_name: opts.schema_name,
          ok: true,
          attempts: i,
          final_errors: [],
        });
      }
      return { ok: true, value: r.value, attempts, schema_name: opts.schema_name };
    }
    lastErrors = r.errors;
    attempts.push({ attempt: i, ok: false, errors: r.errors, timestamp: new Date().toISOString() });
    if (i === max) break;
    const repaired = await opts.repair({
      attempt: i,
      errors: r.errors,
      last_value: current,
      schema_name: opts.schema_name,
    });
    // If the repairer returns the same value (e.g. it cannot fix), bail
    // early instead of burning attempts on identical input.
    if (repaired === current) break;
    current = repaired;
  }

  if (opts.writer) {
    opts.writer({
      timestamp: new Date().toISOString(),
      schema_name: opts.schema_name,
      ok: false,
      attempts: attempts.length,
      final_errors: lastErrors,
    });
  }
  return { ok: false, attempts, schema_name: opts.schema_name, errors: lastErrors };
}

/**
 * Format a list of validation errors as a single human-readable feedback
 * string suitable for inlining into a model repair prompt. Each error is
 * one line: "path: message (expected X, got Y)".
 */
export function formatErrorsForModel(errors: ValidationError[]): string {
  return errors.map((e) => {
    const tail = (e.expected || e.actual)
      ? ` (expected ${e.expected ?? '?'}, got ${e.actual ?? '?'})`
      : '';
    return `${e.path}: ${e.message}${tail}`;
  }).join('\n');
}
