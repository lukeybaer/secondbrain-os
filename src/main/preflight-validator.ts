// preflight-validator.ts
//
// Run 44 of the nightly enhancement cycle (2026-05-07).
//
// Schema-as-data validator that runs BEFORE invoking a side-effecting tool.
// Returns a structured list of violations the caller can show the user, log
// to a JSONL, or feed back to an LLM for repair (the BAML / pydantic-ai
// "ModelRetry with error context" pattern).
//
// Zero deps, intentionally a small subset of JSON Schema. The full ajv
// surface is overkill for tool-arg validation and adds 200kB of bundle
// weight. This module covers what SecondBrain's outbound tools actually
// need: required keys, types, enum, pattern, length bounds, array item
// schema, nested object schema.
//
// Inspired by:
//   - pydantic-ai @tool decorators (pydantic.dev/articles/pydantic-ai):
//     args validated against a TypedDict / pydantic model BEFORE the tool
//     body runs; failure raises a ToolRetryableError with a structured
//     reason the model can read on retry.
//   - BAML "schema-aligned parsing" (boundaryml.com/blog/schema-aligned-parsing):
//     when an LLM emits malformed JSON, parse against a typed schema and
//     return the specific field that failed, not a generic JSON error.
//   - Letta strict tool schemas (letta-ai/letta v0.7+): every tool ships a
//     JSON-Schema dict; the runtime rejects calls whose args do not match
//     before any API egress.
//   - Composio tool metadata: every action carries a JSON-Schema for inputs
//     and outputs, used for type-safe wiring across frameworks.
//
// Why SecondBrain needs this:
//   - calls.ts initiateCall() can be called with a phone number missing the
//     +1 prefix or a missing assistant_id. The error surfaces as a Vapi 400
//     after the API round-trip, costing latency and noise in the logs.
//   - Gmail send (reference_gmail_send_pipeline.md) accepts a malformed
//     recipient and fails at the SMTP boundary; the briefing then writes a
//     "send failed" entry without explaining WHY.
//   - Telegram POST silently truncates messages over 4096 chars. We have no
//     pre-check.
//   - Vapi end-of-call handler in scripts/vapi-end-of-call.js receives JSON
//     that is supposed to have specific fields; an upstream version bump can
//     break the contract and the handler crashes obscurely.

// Schema types

export type Primitive = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type SchemaType = Primitive | 'object' | 'array';

export interface Schema {
  type?: SchemaType | SchemaType[];
  required?: string[];                   // for type=object
  properties?: Record<string, Schema>;   // for type=object
  additionalProperties?: boolean;        // default true
  items?: Schema;                        // for type=array
  minItems?: number;
  maxItems?: number;
  enum?: ReadonlyArray<unknown>;
  pattern?: string;                      // RegExp source
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  // Custom: caller-provided predicate that returns true when valid.
  // Use sparingly; prefer composition of declarative fields.
  predicate?: (value: unknown) => true | string;
  description?: string;                  // optional, for documentation
}

export interface Violation {
  path: string;          // dotted path to the field, e.g. 'to[0].email'
  message: string;       // human-readable reason
  rule: string;          // 'required' | 'type' | 'pattern' | 'minLength' | etc
  got?: unknown;         // the offending value (truncated)
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

// Implementation

function typeOf(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (t === 'string' || t === 'boolean') return t;
  return 'null'; // undefined / function / symbol fall here; treated as null
}

function typeMatches(allowed: SchemaType | SchemaType[] | undefined, actual: SchemaType): boolean {
  if (!allowed) return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  // 'integer' satisfies a 'number' constraint; 'number' does not satisfy 'integer'.
  for (const a of list) {
    if (a === actual) return true;
    if (a === 'number' && actual === 'integer') return true;
  }
  return false;
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 80 ? value.slice(0, 77) + '...' : value;
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `{${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',...' : ''}}`;
  }
  return value;
}

function validateNode(value: unknown, schema: Schema, pathStr: string, out: Violation[]): void {
  const actualType = typeOf(value);

  if (!typeMatches(schema.type, actualType)) {
    out.push({
      path: pathStr,
      rule: 'type',
      message: `expected type ${JSON.stringify(schema.type)}, got ${actualType}`,
      got: truncate(value),
    });
    return; // further checks would produce noise on a wrong type
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    out.push({
      path: pathStr,
      rule: 'enum',
      message: `value must be one of ${JSON.stringify(schema.enum)}`,
      got: truncate(value),
    });
  }

  if (typeof value === 'string') {
    if (schema.pattern) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          out.push({
            path: pathStr,
            rule: 'pattern',
            message: `does not match pattern /${schema.pattern}/`,
            got: truncate(value),
          });
        }
      } catch {
        out.push({
          path: pathStr,
          rule: 'pattern',
          message: `schema pattern is invalid regex: ${schema.pattern}`,
        });
      }
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({
        path: pathStr,
        rule: 'minLength',
        message: `length ${value.length} < minLength ${schema.minLength}`,
        got: truncate(value),
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({
        path: pathStr,
        rule: 'maxLength',
        message: `length ${value.length} > maxLength ${schema.maxLength}`,
        got: truncate(value),
      });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push({
        path: pathStr,
        rule: 'minimum',
        message: `${value} < minimum ${schema.minimum}`,
        got: value,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push({
        path: pathStr,
        rule: 'maximum',
        message: `${value} > maximum ${schema.maximum}`,
        got: value,
      });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({
        path: pathStr,
        rule: 'minItems',
        message: `array length ${value.length} < minItems ${schema.minItems}`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({
        path: pathStr,
        rule: 'maxItems',
        message: `array length ${value.length} > maxItems ${schema.maxItems}`,
      });
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateNode(value[i], schema.items, `${pathStr}[${i}]`, out);
      }
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const k of schema.required) {
        if (!(k in obj)) {
          out.push({
            path: pathStr ? `${pathStr}.${k}` : k,
            rule: 'required',
            message: `required key missing`,
          });
        }
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in obj) {
          validateNode(obj[k], sub, pathStr ? `${pathStr}.${k}` : k, out);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) {
          out.push({
            path: pathStr ? `${pathStr}.${k}` : k,
            rule: 'additionalProperties',
            message: `unexpected key (additionalProperties: false)`,
          });
        }
      }
    }
  }

  if (schema.predicate) {
    const result = schema.predicate(value);
    if (result !== true) {
      out.push({
        path: pathStr,
        rule: 'predicate',
        message: typeof result === 'string' ? result : 'predicate returned false',
        got: truncate(value),
      });
    }
  }
}

/**
 * Validate `value` against `schema`. Returns { valid, violations[] }. Never
 * throws on a malformed schema; that surfaces as a violation instead.
 */
export function validate(value: unknown, schema: Schema): ValidationResult {
  const out: Violation[] = [];
  validateNode(value, schema, '', out);
  return { valid: out.length === 0, violations: out };
}

/**
 * Throw a structured error if validation fails. Use at the boundary of a
 * side-effecting tool when you want a hard fail rather than a result object.
 */
export class PreflightError extends Error {
  readonly violations: Violation[];
  constructor(toolName: string, violations: Violation[]) {
    const summary = violations
      .slice(0, 5)
      .map((v) => `${v.path || '<root>'}: ${v.message}`)
      .join('; ');
    super(`preflight failed for ${toolName}: ${summary}${violations.length > 5 ? ` (+${violations.length - 5} more)` : ''}`);
    this.violations = violations;
    this.name = 'PreflightError';
  }
}

export function assertValid(toolName: string, value: unknown, schema: Schema): void {
  const r = validate(value, schema);
  if (!r.valid) {
    throw new PreflightError(toolName, r.violations);
  }
}

/**
 * Wrap a tool action so its args are validated before invocation. Returns
 * the action's result on success; throws PreflightError on validation
 * failure (the action never runs).
 */
export async function preflight<TArgs, TResult>(
  toolName: string,
  schema: Schema,
  args: TArgs,
  action: (args: TArgs) => Promise<TResult>,
): Promise<TResult> {
  assertValid(toolName, args, schema);
  return action(args);
}

// Pre-built schemas for SecondBrain's outbound tools

/**
 * E.164 phone number (Vapi initiateCall). Permits optional leading +,
 * 10 to 15 digits.
 */
export const E164_PATTERN = '^\\+?[1-9]\\d{9,14}$';

/**
 * Email address (Gmail send). Pragmatic regex; not RFC 5322. Catches the
 * 99% case of typos like missing @ or trailing comma.
 */
export const EMAIL_PATTERN = '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$';

/**
 * Vapi initiateCall args. Matches what calls.ts hands to the Vapi REST API.
 */
export const vapiInitiateCallSchema: Schema = {
  type: 'object',
  required: ['phoneNumber', 'assistantId'],
  properties: {
    phoneNumber: { type: 'string', pattern: E164_PATTERN },
    assistantId: { type: 'string', minLength: 36, maxLength: 36 },
    instructions: { type: 'string', maxLength: 8000 },
    metadata: { type: 'object' },
  },
  additionalProperties: true,
};

/**
 * Gmail send args.
 */
export const gmailSendSchema: Schema = {
  type: 'object',
  required: ['to', 'subject', 'body'],
  properties: {
    to: { type: 'string', pattern: EMAIL_PATTERN, minLength: 5, maxLength: 254 },
    cc: { type: 'string', pattern: EMAIL_PATTERN },
    bcc: { type: 'string', pattern: EMAIL_PATTERN },
    subject: { type: 'string', minLength: 1, maxLength: 998 },
    body: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
};

/**
 * Telegram sendMessage args. Telegram silently truncates over 4096 UTF-16
 * code units; we reject early so the briefing logs the truncation.
 */
export const telegramSendSchema: Schema = {
  type: 'object',
  required: ['chat_id', 'text'],
  properties: {
    chat_id: { type: ['string', 'number'] },
    text: { type: 'string', minLength: 1, maxLength: 4096 },
    parse_mode: { type: 'string', enum: ['Markdown', 'MarkdownV2', 'HTML'] },
    disable_web_page_preview: { type: 'boolean' },
  },
  additionalProperties: true,
};
