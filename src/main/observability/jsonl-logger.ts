import * as fs from 'fs';
import * as path from 'path';
import { errorToRecord, redactSecrets, safeStringify } from './redaction';

export type LogLevel = 'info' | 'warn' | 'error';

export interface JsonlLogRecord {
  timestamp: string;
  level: LogLevel;
  source: string;
  event: string;
  payload?: unknown;
}

export class JsonlLogger {
  constructor(
    private readonly filePath: string,
    private readonly source: string,
  ) {}

  info(event: string, payload?: unknown): void {
    this.write('info', event, payload);
  }

  warn(event: string, payload?: unknown): void {
    this.write('warn', event, payload);
  }

  error(event: string, error: unknown, payload?: unknown): void {
    this.write('error', event, {
      ...(payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}),
      error: errorToRecord(error),
    });
  }

  private write(level: LogLevel, event: string, payload?: unknown): void {
    appendJsonl(this.filePath, {
      timestamp: new Date().toISOString(),
      level,
      source: this.source,
      event,
      ...(payload === undefined ? {} : { payload }),
    });
  }
}

export function appendJsonl(filePath: string, record: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, safeStringify(record) + '\n', 'utf-8');
  } catch {
    // Observability must never break the app path it is observing.
  }
}

export function createObservabilityLogger(userData: string, source: string): JsonlLogger {
  return new JsonlLogger(path.join(userData, 'data', 'observability', 'system.jsonl'), source);
}

export function createAuditLogger(userData: string, source: string): JsonlLogger {
  return new JsonlLogger(path.join(userData, 'data', 'observability', 'audit.jsonl'), source);
}

export function redactForDisplay(value: unknown): unknown {
  return redactSecrets(value);
}
