export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type SecurityActor = 'user' | 'ai' | 'system' | 'webhook' | 'external';

export type SecurityAction =
  | 'config.save'
  | 'sms.send'
  | 'whatsapp.send'
  | 'calls.initiate'
  | 'calls.hang_up'
  | 'calls.bridge_owner'
  | 'tasks.run'
  | 'tasks.approve'
  | 'tasks.cancel'
  | 'data.delete'
  | 'data.restore'
  | 'data.sync_sensitive'
  | 'pii.reveal'
  | 'backup.create'
  | 'backup.restore'
  | 'backup.query'
  | 'external.open'
  | 'agent.memory_write'
  | 'timemachine.screenshot'
  | 'webhook.ingest'
  | 'system.health'
  | 'unknown';

export type AuditStatus = 'requested' | 'approved' | 'denied' | 'completed' | 'failed';

export interface AuditLog {
  id: string;
  timestamp: string;
  actor: SecurityActor;
  action_type: SecurityAction | string;
  risk_level: RiskLevel;
  source: string;
  status: AuditStatus | string;
  approval_id?: string | null;
  model?: string | null;
  tool?: string | null;
  before_state?: string | null;
  after_state?: string | null;
  metadata?: string | null;
}

export interface AuditLogFilter {
  action_type?: string;
  actor?: SecurityActor;
  risk_level?: RiskLevel;
  status?: string;
  limit?: number;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  title: string;
  description?: string;
  source: string;
  risk_level?: RiskLevel;
  status?: string;
}

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface HealthCheckResult {
  id: string;
  label: string;
  status: HealthStatus;
  detail?: string;
  checked_at: string;
}

export interface SystemHealthReport {
  generated_at: string;
  overall: HealthStatus;
  checks: HealthCheckResult[];
}

export interface GroundingEvidence {
  sourceType: 'conversation' | 'call' | 'message' | 'memory' | 'timemachine' | 'other';
  sourceId: string;
  title?: string;
  timestamp?: string;
  confidence: number;
  excerpt?: string;
}
