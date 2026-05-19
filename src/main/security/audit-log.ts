import { randomUUID } from 'crypto';
import { getDb } from '../database-sqlite';

export type AuditRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AuditDecision =
  | 'allowed'
  | 'blocked'
  | 'approval_required'
  | 'approved'
  | 'denied'
  | 'timed_out'
  | 'executed'
  | 'failed'
  | 'recorded';

export interface AuditLogEntry {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id?: string;
  source: string;
  action: string;
  risk_level: AuditRiskLevel;
  decision: AuditDecision | string;
  approval_id?: string;
  target_type?: string;
  target_id?: string;
  summary: string;
  metadata_json?: string;
}

export interface RecordAuditInput {
  actorType: string;
  actorId?: string;
  source: string;
  action: string;
  riskLevel: AuditRiskLevel;
  decision: AuditDecision | string;
  approvalId?: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

function toJson(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export function recordAuditEvent(input: RecordAuditInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    actor_type: input.actorType,
    source: input.source,
    action: input.action,
    risk_level: input.riskLevel,
    decision: input.decision,
    summary: input.summary,
  };
  if (input.actorId) entry.actor_id = input.actorId;
  if (input.approvalId) entry.approval_id = input.approvalId;
  if (input.targetType) entry.target_type = input.targetType;
  if (input.targetId) entry.target_id = input.targetId;
  const metadataJson = toJson(input.metadata);
  if (metadataJson) entry.metadata_json = metadataJson;

  getDb()
    .prepare(
      `
      INSERT INTO audit_logs
        (id, created_at, actor_type, actor_id, source, action, risk_level, decision,
         approval_id, target_type, target_id, summary, metadata_json)
      VALUES
        (@id, @created_at, @actor_type, @actor_id, @source, @action, @risk_level, @decision,
         @approval_id, @target_type, @target_id, @summary, @metadata_json)
    `,
    )
    .run({
      id: entry.id,
      created_at: entry.created_at,
      actor_type: entry.actor_type,
      actor_id: entry.actor_id ?? null,
      source: entry.source,
      action: entry.action,
      risk_level: entry.risk_level,
      decision: entry.decision,
      approval_id: entry.approval_id ?? null,
      target_type: entry.target_type ?? null,
      target_id: entry.target_id ?? null,
      summary: entry.summary,
      metadata_json: entry.metadata_json ?? null,
    });

  return entry;
}

export function getAuditEvent(id: string): AuditLogEntry | null {
  return (
    (getDb().prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as AuditLogEntry) ?? null
  );
}

export function listAuditEvents(opts?: {
  limit?: number;
  action?: string;
  actorType?: string;
  approvalId?: string;
}): AuditLogEntry[] {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  if (opts?.action) {
    clauses.push('action = @action');
    params.action = opts.action;
  }
  if (opts?.actorType) {
    clauses.push('actor_type = @actorType');
    params.actorType = opts.actorType;
  }
  if (opts?.approvalId) {
    clauses.push('approval_id = @approvalId');
    params.approvalId = opts.approvalId;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
  params.limit = limit;

  return getDb()
    .prepare(
      `
      SELECT * FROM audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT @limit
    `,
    )
    .all(params) as AuditLogEntry[];
}
