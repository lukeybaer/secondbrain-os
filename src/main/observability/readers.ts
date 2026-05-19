import * as fs from 'fs';
import * as path from 'path';
import { redactForDisplay } from './jsonl-logger';

const MAX_LOG_BYTES = 768 * 1024;

export type EventStatus = 'ok' | 'warn' | 'error' | 'info';

export interface AuditEvent {
  timestamp: string;
  source: string;
  action: string;
  status: EventStatus;
  summary: string;
  detail?: string;
  metadata?: unknown;
}

export interface ActivityEvent {
  timestamp: string;
  source: string;
  kind: 'audit' | 'tool';
  title: string;
  status: EventStatus;
  detail?: string;
  durationMs?: number;
  metadata?: unknown;
}

export interface ToolFailure {
  timestamp: string;
  tool: string;
  durationMs: number;
  error: string;
}

interface ReaderOptions {
  userData: string;
  appRoot?: string;
  limit?: number;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function readJsonlTail(filePath: string, limit: number): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      const bytes = fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.subarray(0, bytes).toString('utf-8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter((record) => record !== null);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function stringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function nestedStringField(
  record: Record<string, unknown>,
  objectKey: string,
  fields: string[],
): string | undefined {
  const nested = record[objectKey];
  if (!nested || typeof nested !== 'object') return undefined;
  return stringField(nested as Record<string, unknown>, fields);
}

function timestampOf(record: Record<string, unknown>): string {
  const direct = stringField(record, [
    'timestamp',
    'sent_at',
    'created_at',
    'createdAt',
    'updatedAt',
    'flagged_at',
    'rejectedAt',
    'ts',
    'at',
  ]);
  if (direct && !Number.isNaN(new Date(direct).getTime())) return new Date(direct).toISOString();
  return new Date().toISOString();
}

function statusOf(record: Record<string, unknown>): EventStatus {
  if (record.level === 'error' || record.success === false || record.ok === false) return 'error';
  const status = stringField(record, ['status', 'outcome', 'result', 'level'])?.toLowerCase();
  if (!status) return record.success === true || record.ok === true ? 'ok' : 'info';
  if (/(fail|error|denied|timeout|red|critical)/.test(status)) return 'error';
  if (/(warn|partial|queued|pending|yellow|dry-run)/.test(status)) return 'warn';
  if (/(ok|success|done|green|approved|complete|healthy)/.test(status)) return 'ok';
  return 'info';
}

function truncate(text: string | undefined, limit: number): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? clean.slice(0, limit - 3) + '...' : clean;
}

function summaryFor(source: string, record: Record<string, unknown>): string {
  if (source === 'system-audit') {
    const event = stringField(record, ['event']) ?? 'system event';
    const channel = nestedStringField(record, 'payload', ['channel']);
    return channel ? `${event}: ${channel}` : event;
  }
  if (source === 'briefing-dispatch') {
    return (
      stringField(record, ['subject']) ??
      stringField(record, ['action_summary']) ??
      'Briefing dispatch'
    );
  }
  if (source === 'agent-reflection') {
    const contact = stringField(record, ['contact']) ?? 'unknown contact';
    const outcome = stringField(record, ['outcome']) ?? 'reflection';
    return `Reflection for ${contact}: ${outcome}`;
  }
  if (source === 'escalation') {
    return `Escalation: ${stringField(record, ['probe', 'target', 'name']) ?? 'system'}`;
  }
  if (source === 'health-heal') {
    return `Health heal: ${stringField(record, ['target', 'probe', 'action']) ?? 'system'}`;
  }
  if (source === 'nightly-enhancement') {
    return `Nightly enhancement: ${stringField(record, ['title', 'skill', 'name']) ?? 'recorded'}`;
  }
  return stringField(record, ['event', 'action', 'title', 'subject', 'message']) ?? source;
}

function detailFor(record: Record<string, unknown>): string | undefined {
  return truncate(
    stringField(record, [
      'error',
      'detail',
      'description',
      'action_summary',
      'comment',
      'reflection',
      'message',
      'note',
    ]) ?? nestedStringField(record, 'payload', ['error', 'detail', 'message']),
    260,
  );
}

function auditLogPaths(userData: string, appRoot?: string): Array<{ filePath: string; source: string }> {
  const agentRoots = unique([
    path.join(userData, 'data', 'agent'),
    appRoot ? path.join(appRoot, 'data', 'agent') : '',
  ]);

  return [
    {
      filePath: path.join(userData, 'data', 'observability', 'audit.jsonl'),
      source: 'system-audit',
    },
    ...agentRoots.flatMap((root) => [
      { filePath: path.join(root, 'amy-dispatch-log.jsonl'), source: 'briefing-dispatch' },
      { filePath: path.join(root, 'escalations.jsonl'), source: 'escalation' },
      { filePath: path.join(root, 'ea-reflection-log.jsonl'), source: 'agent-reflection' },
      { filePath: path.join(root, 'health-heal.jsonl'), source: 'health-heal' },
      { filePath: path.join(root, 'nightly-enhancements.jsonl'), source: 'nightly-enhancement' },
    ]),
  ];
}

export function listAuditEvents(options: ReaderOptions): AuditEvent[] {
  const limit = options.limit ?? 50;
  const events: AuditEvent[] = [];

  for (const log of auditLogPaths(options.userData, options.appRoot)) {
    const records = readJsonlTail(log.filePath, limit);
    for (const raw of records) {
      if (!raw || typeof raw !== 'object') continue;
      const record = redactForDisplay(raw) as Record<string, unknown>;
      const source = stringField(record, ['source']) ?? log.source;
      events.push({
        timestamp: timestampOf(record),
        source,
        action: stringField(record, ['event', 'action']) ?? log.source,
        status: statusOf(record),
        summary: summaryFor(log.source, record),
        detail: detailFor(record),
        metadata: record,
      });
    }
  }

  return events
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

function tracePath(userData: string): string {
  return path.join(userData, 'data', 'agent', 'tool-trace.jsonl');
}

function listToolTraceRecords(userData: string, limit: number): Record<string, unknown>[] {
  return readJsonlTail(tracePath(userData), limit)
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object')
    .map((raw) => redactForDisplay(raw) as Record<string, unknown>);
}

export function listToolFailures(userData: string, windowHours = 24, limit = 20): ToolFailure[] {
  const cutoff = Date.now() - windowHours * 3_600_000;
  return listToolTraceRecords(userData, limit * 10)
    .filter((record) => {
      const timestamp = timestampOf(record);
      return record.success === false && new Date(timestamp).getTime() >= cutoff;
    })
    .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)))
    .slice(0, limit)
    .map((record) => ({
      timestamp: timestampOf(record),
      tool: stringField(record, ['tool']) ?? 'unknown',
      durationMs: Number(record.duration_ms ?? record.durationMs ?? 0),
      error: truncate(stringField(record, ['error']) ?? 'Unknown error', 180) ?? 'Unknown error',
    }));
}

export function listActivityEvents(options: ReaderOptions): ActivityEvent[] {
  const limit = options.limit ?? 80;
  const auditEvents = listAuditEvents({ ...options, limit }).map<ActivityEvent>((event) => ({
    timestamp: event.timestamp,
    source: event.source,
    kind: 'audit',
    title: event.summary,
    status: event.status,
    detail: event.detail,
    metadata: event.metadata,
  }));

  const toolEvents = listToolTraceRecords(options.userData, limit).map<ActivityEvent>((record) => {
    const success = record.success !== false;
    const tool = stringField(record, ['tool']) ?? 'unknown tool';
    return {
      timestamp: timestampOf(record),
      source: 'tool-trace',
      kind: 'tool',
      title: tool,
      status: success ? 'ok' : 'error',
      detail: success
        ? truncate(stringField(record, ['output_snippet']) ?? 'Completed', 220)
        : truncate(stringField(record, ['error']) ?? 'Failed', 220),
      durationMs: Number(record.duration_ms ?? 0),
      metadata: record,
    };
  });

  return [...auditEvents, ...toolEvents]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
