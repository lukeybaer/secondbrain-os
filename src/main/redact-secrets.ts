// redact-secrets.ts
//
// Pure, dependency-free credential / token scrubber for observability sinks.
//
// THE GAP THIS FILLS
//   pii-scanner.ts covers HUMAN PII (SSN, credit card, email, phone) and fires
//   a Telegram alert when it sees one. It does NOT scrub machine credentials,
//   and it does not transform a string for safe persistence. Meanwhile the
//   autonomous-run observability sinks serialize raw tool inputs/outputs and
//   error strings to append-only JSONL:
//       data/agent/tool-trace.jsonl        (tool-trace.ts, agent-step-loop-ExampleCong.ts)
//       data/agent/agent-decisions.jsonl   (agent-decision-log.ts)
//   Those files are read by the briefing observability card AND shipped to S3
//   in the session meta by the Stop hook. So any API key, OAuth/bearer token,
//   AWS key, Telegram bot token, or PEM key passed to a traced tool lands
//   verbatim on disk and in the cloud archive. This module redacts those
//   shapes at the writer boundary before the line is persisted.
//
// DESIGN
//   - Pure string transform. No fs, no electron, no network. Safe to call from
//     any sink writer.
//   - Redacts by SHAPE (token prefixes, keyed secret fields, PEM blocks), never
//     by a single literal value, so it generalizes to future leaks.
//   - Quote-agnostic for standalone token shapes, so it still catches secrets
//     nested inside an already-JSON-stringified snippet (escaped quotes).
//   - Conservative: prefixed/keyed shapes only, so ordinary prose, ISO dates,
//     run ids, and durations are left untouched (no false positives).
//
// SOURCES (research 2026-06-17)
//   - Letta / Composio action-log redaction practice (scrub tool args before
//     persisting traces).  https://github.com/letta-ai/letta
//   - GitHub secret-scanning token patterns (provider prefixes).
//     https://docs.github.com/code-security/secret-scanning

const REDACTED = '[REDACTED]';

// Field names whose value is a secret when seen as `"<key>": "<value>"`.
const SECRET_KEYS = [
  'authorization',
  'api[_-]?key',
  'apikey',
  'access[_-]?token',
  'refresh[_-]?token',
  'client[_-]?secret',
  'secret[_-]?key',
  'secret',
  'password',
  'passwd',
  'bot[_-]?token',
  'bearer',
  'token',
  'x-api-key',
].join('|');

// Standalone token shapes. Each is specific enough (provider prefix or a fixed
// structural shape) that matching it in arbitrary text is overwhelmingly a real
// credential, not prose. Order matters only for readability; matches do not
// overlap. All are applied with the global flag.
const TOKEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // PEM private key block (multiline). Redact the whole body.
  {
    name: 'pem',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  // Authorization: Bearer <jwt-ish>
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  // OpenAI / Anthropic style sk- keys (sk-, sk-proj-, sk-ant-...)
  { name: 'sk', re: /\bsk-[A-Za-z0-9_-]{12,}/g },
  // Google OAuth client secret
  { name: 'google-oauth', re: /\bGOCSPX-[A-Za-z0-9_-]{16,}/g },
  // AWS access key id
  { name: 'aws-akid', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub fine-grained PAT
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  // GitHub classic tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  // Slack tokens
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Telegram bot token: <8-10 digit bot id>:<~35 char secret>. No leading
  // boundary because it is often embedded right after "bot" in an API URL
  // (.../bot<token>/sendMessage); the digit-colon-secret shape is distinctive
  // enough on its own. Length tolerant (>=30) since the secret part varies.
  { name: 'telegram-bot', re: /\d{8,10}:[A-Za-z0-9_-]{30,}/g },
];

// Keyed secret: `"<key>"<sep>:<sep>"<value>"`, tolerant of escaped quotes so it
// works on both a raw JSON object and a JSON snippet nested inside another
// JSON string. We keep the key, redact the value.
const KEYED_RE = new RegExp(
  '(\\\\?["\'](?:' +
    SECRET_KEYS +
    ')\\\\?["\']\\s*:\\s*)\\\\?["\'](?:[^"\'\\\\]|\\\\.)*?\\\\?["\']',
  'gi',
);

/**
 * Redact credential / token shapes from a string. Pure and idempotent: a value
 * already replaced with [REDACTED] contains no secret shape, so re-running is a
 * no-op. Non-string input is returned unchanged so writers can pass it through
 * defensively.
 */
export function redactSecrets<T>(input: T): T {
  if (typeof input !== 'string') return input;
  let out: string = input;
  // Keyed values first (covers generic secrets like password/secret by name),
  // preserving the key and the surrounding (possibly escaped) quotes.
  out = out.replace(KEYED_RE, (_m, prefix: string) => `${prefix}"${REDACTED}"`);
  // Then standalone provider/structural token shapes.
  for (const { name, re } of TOKEN_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out as ExampleCo as T;
}

/**
 * Recursively redact every string value in an object/array, returning a new
 * structure. Use this at a JSONL writer boundary: redacting the parsed record
 * (then JSON.stringify) keeps the output valid JSON, whereas redacting the
 * already-serialized line can reinsert unescaped quotes inside a nested snippet
 * and corrupt the line. Non-string leaves are returned unchanged.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as ExampleCo as T;
  if (value && typeof value === 'object') {
    const out: Record<string, ExampleCo> = {};
    for (const [k, v] of Object.entries(value as Record<string, ExampleCo>)) {
      out[k] = redactDeep(v);
    }
    return out as ExampleCo as T;
  }
  return value;
}

/**
 * True when the string contains at least one recognizable credential shape.
 * Useful for a leak self-audit over an existing sink file.
 */
export function hasSecret(input: ExampleCo): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  if (KEYED_RE.test(input)) {
    KEYED_RE.lastIndex = 0;
    return true;
  }
  for (const { re } of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(input)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}
