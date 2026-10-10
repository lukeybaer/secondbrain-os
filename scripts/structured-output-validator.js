// structured-output-validator.js
//
// PydanticAI-style schema validation with auto-retry for LLM JSON outputs.
//
// Amy generates many structured outputs (briefing JSON, video metadata,
// contact updates, backlog entries, shorts proposals) where a malformed
// response silently corrupts downstream state. The current pattern is to
// JSON.parse() and hope; if a field is missing the briefing card renders
// blank, if the type is wrong a downstream comparison throws hours later.
//
// Patterns synthesized from:
//   * pydantic/pydantic-ai retries.py + durable_exec/ -- when output fails
//     schema validation, the ValidationError is injected back into the
//     model's conversation as a structured message before retry, not a
//     silent restart. Per-attempt failure modes are tracked.
//   * openai/openai-agents-python output_schema.py -- typed output schemas
//     with auto-retry on validation failure; the schema's own error
//     messages become the next prompt's correction.
//   * microsoft/taskweaver memory/experience.py -- failed validations are
//     persisted as ExperienceEntry instances so the next attempt has the
//     prior failure mode in context.
//
// This module is intentionally tiny: no dependency on Pydantic or Zod.
// Schemas are plain objects describing required fields + types + predicates.
// The caller supplies a generate() async function; the validator handles
// extraction, parsing, validating, and retrying with a structured error
// message until valid or maxRetries exhausted.

// ── Schema primitives ─────────────────────────────────────────────────────────

const SUPPORTED_TYPES = new Set([
  'string', 'number', 'integer', 'boolean', 'array', 'object',
  'string|null', 'number|null', 'integer|null', 'boolean|null',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected.endsWith('|null') && actual === 'null') return true;
  if (expected.endsWith('|null') && expected.slice(0, -5) === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a parsed object against a flat schema.
 *
 * Schema shape:
 *   {
 *     name: 'briefing-card',
 *     fields: {
 *       title:       { type: 'string',  required: true,  maxLength: 80 },
 *       priority:    { type: 'integer', required: true,  min: 1, max: 10 },
 *       tags:        { type: 'array',   itemType: 'string' },
 *       summary:     { type: 'string',  required: true,  predicate: (v) => v.length >= 20 },
 *     },
 *     extraFields: 'allow' | 'strip' | 'error'  (default: 'allow')
 *   }
 *
 * Returns { valid, errors[], errorMessage, sanitized }.
 * On success, sanitized is a shallow copy with extra fields stripped if
 * extraFields === 'strip'. On failure, errorMessage is a single-paragraph
 * prompt fragment safe to feed back into the LLM for self-correction.
 */
function validate(schema, candidate) {
  const errors = [];
  if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      valid: false,
      errors: [{ field: '<root>', code: 'not_object', message: 'expected a JSON object at the root' }],
      errorMessage: `The output must be a single JSON object. Received ${typeOf(candidate)}.`,
      sanitized: null,
    };
  }

  const sanitized = {};
  const fieldNames = Object.keys(schema.fields || {});
  const extraPolicy = schema.extraFields || 'allow';

  for (const name of fieldNames) {
    const spec = schema.fields[name];
    if (!SUPPORTED_TYPES.has(spec.type)) {
      errors.push({
        field: name, code: 'schema_bug',
        message: `schema declares unsupported type "${spec.type}"`,
      });
      continue;
    }
    const present = Object.prototype.hasOwnProperty.call(candidate, name);
    const value = present ? candidate[name] : undefined;

    if (!present) {
      if (spec.required) {
        errors.push({
          field: name, code: 'missing_required',
          message: `required field "${name}" is missing`,
        });
      } else if (spec.default !== undefined) {
        sanitized[name] = spec.default;
      }
      continue;
    }

    const actualType = typeOf(value);
    if (!typeMatches(spec.type, actualType)) {
      errors.push({
        field: name, code: 'wrong_type',
        message: `field "${name}" must be ${spec.type}; received ${actualType}`,
      });
      continue;
    }

    if (spec.type === 'array' && spec.itemType) {
      for (let i = 0; i < value.length; i++) {
        const t = typeOf(value[i]);
        if (!typeMatches(spec.itemType, t)) {
          errors.push({
            field: `${name}[${i}]`, code: 'wrong_item_type',
            message: `item ${i} of "${name}" must be ${spec.itemType}; received ${t}`,
          });
        }
      }
    }

    if (typeof spec.minLength === 'number' && typeof value === 'string' && value.length < spec.minLength) {
      errors.push({
        field: name, code: 'too_short',
        message: `"${name}" must be at least ${spec.minLength} chars; received ${value.length}`,
      });
    }
    if (typeof spec.maxLength === 'number' && typeof value === 'string' && value.length > spec.maxLength) {
      errors.push({
        field: name, code: 'too_long',
        message: `"${name}" must be at most ${spec.maxLength} chars; received ${value.length}`,
      });
    }
    if (typeof spec.min === 'number' && typeof value === 'number' && value < spec.min) {
      errors.push({
        field: name, code: 'below_min',
        message: `"${name}" must be >= ${spec.min}; received ${value}`,
      });
    }
    if (typeof spec.max === 'number' && typeof value === 'number' && value > spec.max) {
      errors.push({
        field: name, code: 'above_max',
        message: `"${name}" must be <= ${spec.max}; received ${value}`,
      });
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      errors.push({
        field: name, code: 'not_in_enum',
        message: `"${name}" must be one of [${spec.enum.join(', ')}]; received ${JSON.stringify(value)}`,
      });
    }
    if (typeof spec.predicate === 'function') {
      let ok = true;
      let predicateError = '';
      try {
        ok = spec.predicate(value);
      } catch (e) {
        ok = false;
        predicateError = e && e.message ? e.message : String(e);
      }
      if (!ok) {
        errors.push({
          field: name, code: 'predicate_failed',
          message: spec.predicateMessage
            || `"${name}" failed the schema predicate${predicateError ? ': ' + predicateError : ''}`,
        });
      }
    }
    sanitized[name] = value;
  }

  if (extraPolicy !== 'allow') {
    for (const key of Object.keys(candidate)) {
      if (!fieldNames.includes(key)) {
        if (extraPolicy === 'error') {
          errors.push({
            field: key, code: 'extra_field',
            message: `unexpected field "${key}" not in schema`,
          });
        }
        // 'strip' policy: simply do not copy into sanitized
      }
    }
  } else {
    for (const key of Object.keys(candidate)) {
      if (!fieldNames.includes(key)) sanitized[key] = candidate[key];
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    errorMessage: valid ? '' : buildErrorMessage(schema, errors),
    sanitized: valid ? sanitized : null,
  };
}

function buildErrorMessage(schema, errors) {
  const head = `Your previous output failed validation against schema "${schema.name || 'unnamed'}". Fix every issue below and return a single JSON object that satisfies all constraints.`;
  const bullets = errors.map((e) => `- ${e.field}: ${e.message}`).join('\n');
  return `${head}\n\n${bullets}`;
}

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * Best-effort extraction of a JSON object from an LLM response. Tolerates
 * fenced code blocks and surrounding prose. Returns { parsed, parseError }.
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') {
    return { parsed: null, parseError: `output was ${typeOf(text)}, expected string` };
  }
  let body = text.trim();

  // Strip fenced markdown if present
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/m);
  if (fenceMatch) body = fenceMatch[1].trim();

  // If the body is not pure JSON, try to slice from the first { to the
  // matching closing brace. This handles prose like "Here is the JSON: { ... }"
  if (body[0] !== '{') {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }

  try {
    return { parsed: JSON.parse(body), parseError: null };
  } catch (e) {
    return { parsed: null, parseError: (e && e.message) || 'parse failed' };
  }
}

// ── Validate-or-retry loop ────────────────────────────────────────────────────

/**
 * Run an async generator function, parse + validate the result, and retry
 * with the structured error message if invalid. Caller supplies generate()
 * with signature: (attempt: number, lastError: string) => Promise<string>.
 *
 * Returns { ok, value, attempts, history, errorMessage }.
 *   - history is the array of attempt records for debugging / logging.
 *   - When ok=false, errorMessage is the final validation error suitable
 *     for surfacing in the briefing or a Telegram alert.
 */
async function validateOrRetry(schema, generate, opts) {
  const maxRetries = opts && opts.maxRetries != null ? opts.maxRetries : 3;
  const history = [];
  let lastError = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const raw = await generate(attempt, lastError);
    const { parsed, parseError } = extractJsonObject(raw);
    if (parseError) {
      lastError = `Your previous output was not valid JSON: ${parseError}. Return a single JSON object with no surrounding prose.`;
      history.push({ attempt, parseError, rawPreview: (raw || '').slice(0, 200) });
      continue;
    }
    const result = validate(schema, parsed);
    if (result.valid) {
      history.push({ attempt, ok: true });
      return { ok: true, value: result.sanitized, attempts: attempt, history, errorMessage: '' };
    }
    lastError = result.errorMessage;
    history.push({ attempt, ok: false, errors: result.errors });
  }
  return { ok: false, value: null, attempts: maxRetries, history, errorMessage: lastError };
}

module.exports = {
  validate,
  validateOrRetry,
  extractJsonObject,
  buildErrorMessage,
};
