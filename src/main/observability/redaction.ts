const SENSITIVE_KEY_RE =
  /(^|_|\b)(apiKey|api_key|authToken|auth_token|accessToken|access_token|refreshToken|refresh_token|token|password|secret|credential|authorization|cookie|sessionCookie|session_cookie|privateSim|private_sim|clientSecret|client_secret)(\b|_|$)/i;

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
  'cookie',
  'sessioncookie',
  'privatesim',
  'clientsecret',
];

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [
    /((?:"?[\w-]*(?:apiKey|api_key|authToken|auth_token|accessToken|access_token|refreshToken|refresh_token|password|secret|credential|token|cookie|authorization|clientSecret|client_secret|privateSim|private_sim)[\w-]*"?\s*[:=]\s*")([^"]*)(")/gi,
    '$1[REDACTED]$3',
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|vapi_[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]'],
  [/\b(EAA[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]'],
  [
    /\b(api[_-]?key|token|secret|password|cookie|authorization)=([^;\s&]+)/gi,
    '$1=[REDACTED]',
  ],
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_RE.test(key) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactString(value: string): string {
  return TOKEN_PATTERNS.reduce((text, [pattern, replacement]) => {
    return text.replace(pattern, replacement);
  }, value);
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSecrets(item, seen);
  }
  return out;
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(redactSecrets(value));
  } catch {
    return JSON.stringify({ error: 'unserializable_log_record' });
  }
}

export function errorToRecord(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack) : undefined,
    };
  }
  return { message: redactString(String(error)) };
}
