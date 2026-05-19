import * as path from 'path';

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

const CONFIG_STRING_FIELDS = new Set([
  'otterEmail',
  'otterPassword',
  'openaiApiKey',
  'dataDir',
  'openaiModel',
  'openaiLightModel',
  'openaiEmbeddingModel',
  'whatsappPhoneNumberId',
  'whatsappAccessToken',
  'vapiApiKey',
  'vapiPhoneNumberId',
  'callbackAssistantId',
  'telegramBotToken',
  'telegramChatId',
  'ownerPrivateSim',
  'ec2BaseUrl',
  'anthropicApiKey',
  'groqApiKey',
  'newsApiKey',
  'youtubeClientId',
  'youtubeClientSecret',
  'otterSessionCookie',
  'otterUserId',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
  'xApiKey',
  'xApiSecret',
  'xAccessToken',
  'xAccessTokenSecret',
  'ownerName',
]);

const CONFIG_NUMBER_FIELDS = new Set(['maxContextConversations', 'amyVersion']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new IpcValidationError(`${label} must be an object`);
  return value;
}

export function assertString(value: unknown, label: string, maxLength = 4000): string {
  if (typeof value !== 'string') throw new IpcValidationError(`${label} must be a string`);
  if (value.includes('\0')) throw new IpcValidationError(`${label} contains invalid characters`);
  if (value.length > maxLength) throw new IpcValidationError(`${label} is too long`);
  return value;
}

export function assertOptionalString(
  value: unknown,
  label: string,
  maxLength = 4000,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, label, maxLength);
}

export function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new IpcValidationError(`${label} must be a boolean`);
  return value;
}

export function assertOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return assertBoolean(value, label);
}

export function assertInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value)) throw new IpcValidationError(`${label} must be an integer`);
  const n = value as number;
  if (n < min || n > max) throw new IpcValidationError(`${label} is outside the allowed range`);
  return n;
}

export function assertOptionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return assertInteger(value, label, min, max);
}

export function assertSafeId(value: unknown, label = 'id'): string {
  const s = assertString(value, label, 200).trim();
  if (!s) throw new IpcValidationError(`${label} is required`);
  if (!/^[A-Za-z0-9@._:+-]+$/.test(s)) throw new IpcValidationError(`${label} is invalid`);
  return s;
}

export function assertDateString(value: unknown, label = 'date'): string {
  const s = assertString(value, label, 20).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new IpcValidationError(`${label} must be YYYY-MM-DD`);
  return s;
}

export function assertStringArray(value: unknown, label: string, maxItems = 100): string[] {
  if (!Array.isArray(value)) throw new IpcValidationError(`${label} must be an array`);
  if (value.length > maxItems) throw new IpcValidationError(`${label} has too many items`);
  return value.map((item, i) => assertString(item, `${label}[${i}]`, 300).trim()).filter(Boolean);
}

export function validateConfigPatch(value: unknown): Record<string, unknown> {
  const input = assertPlainObject(value, 'config');
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (CONFIG_STRING_FIELDS.has(key)) {
      output[key] = assertString(raw, key, 20000);
      continue;
    }
    if (CONFIG_NUMBER_FIELDS.has(key)) {
      output[key] = assertInteger(raw, key, 0, 100000);
      continue;
    }
    throw new IpcValidationError(`Unknown config field: ${key}`);
  }
  return output;
}

export function validateMessageSend(input: {
  to: unknown;
  body?: unknown;
  text?: unknown;
  mediaUrl?: unknown;
}): { to: string; body: string; mediaUrl?: string } {
  const to = assertString(input.to, 'recipient', 200).trim();
  if (!/^[+\d@.\-\s()]+$/.test(to)) throw new IpcValidationError('recipient is invalid');
  const body = assertString(input.body ?? input.text, 'message body', 2000).trim();
  if (!body) throw new IpcValidationError('message body is required');
  const mediaUrl = assertOptionalString(input.mediaUrl, 'mediaUrl', 2000);
  if (mediaUrl && !isSafeExternalUrl(mediaUrl)) {
    throw new IpcValidationError('mediaUrl must be http or https');
  }
  return { to, body, mediaUrl };
}

export function validateCallInitiateArgs(
  phoneNumber: unknown,
  instructions: unknown,
  personalContext: unknown,
  personaId?: unknown,
  leaveVoicemail?: unknown,
  options?: unknown,
): {
  phoneNumber: string;
  instructions: string;
  personalContext: string;
  personaId?: string;
  leaveVoicemail?: boolean;
  options?: {
    silenceTimeoutSeconds?: number;
    maxDurationSeconds?: number;
    amyVersion?: number;
  };
} {
  const parsedOptions = options === undefined || options === null ? undefined : assertPlainObject(options, 'options');
  return {
    phoneNumber: assertString(phoneNumber, 'phoneNumber', 100).trim(),
    instructions: assertString(instructions, 'instructions', 12000).trim(),
    personalContext: assertString(personalContext ?? '', 'personalContext', 12000),
    personaId: assertOptionalString(personaId, 'personaId', 200),
    leaveVoicemail: assertOptionalBoolean(leaveVoicemail, 'leaveVoicemail'),
    options: parsedOptions
      ? {
          silenceTimeoutSeconds: assertOptionalInteger(
            parsedOptions.silenceTimeoutSeconds,
            'silenceTimeoutSeconds',
            1,
            120,
          ),
          maxDurationSeconds: assertOptionalInteger(
            parsedOptions.maxDurationSeconds,
            'maxDurationSeconds',
            30,
            7200,
          ),
          amyVersion: assertOptionalInteger(parsedOptions.amyVersion, 'amyVersion', 1, 100),
        }
      : undefined,
  };
}

export function validateRelativePath(value: unknown, label = 'path'): string {
  const s = assertString(value, label, 1000).replace(/\\/g, '/').trim();
  if (!s) throw new IpcValidationError(`${label} is required`);
  if (path.isAbsolute(s) || s.startsWith('/') || s.includes('../') || s === '..') {
    throw new IpcValidationError(`${label} must be relative`);
  }
  return path.posix.normalize(s);
}

export function validateOptionalRelativePath(value: unknown, label = 'path'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return validateRelativePath(value, label);
}

export function validateReadOnlySql(value: unknown): string {
  const sql = assertString(value, 'sql', 10000).trim();
  const withoutComments = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(withoutComments)) {
    throw new IpcValidationError('Only read-only SELECT queries are allowed');
  }
  if (withoutComments.includes(';')) {
    throw new IpcValidationError('Multiple SQL statements are not allowed');
  }
  if (
    /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex)\b/i.test(
      withoutComments,
    )
  ) {
    throw new IpcValidationError('SQL contains a blocked keyword');
  }
  return sql;
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateExternalUrl(value: unknown): string {
  const url = assertString(value, 'url', 4000).trim();
  if (!isSafeExternalUrl(url)) throw new IpcValidationError('Only http and https URLs are allowed');
  return url;
}

export function validatePathUnderBase(
  value: unknown,
  baseDir: string,
  label = 'path',
): string | null {
  if (value === undefined || value === null) return null;
  const raw = assertString(value, label, 2000);
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(raw);
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new IpcValidationError(`${label} is outside the allowed data directory`);
  }
  return resolved;
}

export function validateS3Key(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const key = assertString(value, 's3Key', 2000).trim();
  if (key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new IpcValidationError('s3Key is invalid');
  }
  return key;
}
