import { randomUUID } from 'crypto';
import type { AuditDecision, AuditRiskLevel } from './audit-log';

export type PolicyActorType = 'renderer' | 'user' | 'ai' | 'tool' | 'external' | 'system';

export type PolicyAction =
  | 'send_sms'
  | 'send_whatsapp'
  | 'send_telegram'
  | 'send_email'
  | 'initiate_call'
  | 'bridge_call'
  | 'hang_up_call'
  | 'delete_data'
  | 'sensitive_sync'
  | 'reveal_pii'
  | 'run_task'
  | 'vapi_function_call'
  | 'query_knowledge'
  | 'read_data'
  | 'approval_request'
  | 'approval_resolution'
  | 'reputation_risk';

export interface ApprovalPolicyContext {
  actor: PolicyActorType;
  actorId?: string | undefined;
  source: string;
  action: PolicyAction | string;
  summary: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  dataCategory?: string | undefined;
  riskLevel?: AuditRiskLevel | undefined;
  text?: string | undefined;
  containsPii?: boolean | undefined;
  approved?: boolean | undefined;
  approvalId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ApprovalPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  riskLevel: AuditRiskLevel;
  reason: string;
}

export interface ApprovalResult {
  allowed: boolean;
  approvalId?: string;
  decision: ApprovalPolicyDecision;
  error?: string;
}

type ApprovalRequestType =
  | 'share_pii'
  | 'transfer_call'
  | 'commit_to_action'
  | 'reputation_risk'
  | 'content_approval';

type ApprovalWaiter = (result: { approved: boolean; data?: string }) => void;

const approvalWaiters = new Map<string, ApprovalWaiter>();

const APPROVAL_REQUIRED_ACTIONS = new Set<string>([
  'send_sms',
  'send_whatsapp',
  'send_telegram',
  'send_email',
  'initiate_call',
  'bridge_call',
  'hang_up_call',
  'delete_data',
  'sensitive_sync',
  'reveal_pii',
  'run_task',
]);

const HIGH_RISK_ACTIONS = new Set<string>([
  ...APPROVAL_REQUIRED_ACTIONS,
  'approval_request',
  'approval_resolution',
  'reputation_risk',
]);

const SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:\d[ -]*?){13,16}\b/, // payment-card-ish
  /\b(?:account|routing|ssn|social security|passport|drivers license|driver's license)\b/i,
  /\b(?:dob|date of birth|birthdate)\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way)\b/i,
];

function isHumanApprovedActor(actor: PolicyActorType): boolean {
  return actor === 'renderer' || actor === 'user';
}

export function containsSensitiveText(text: string | undefined): boolean {
  if (!text) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function metadataContainsSensitiveData(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  try {
    return containsSensitiveText(JSON.stringify(metadata));
  } catch {
    return false;
  }
}

export function actionRequiresApproval(action: string): boolean {
  return APPROVAL_REQUIRED_ACTIONS.has(action);
}

export function evaluateApprovalPolicy(ctx: ApprovalPolicyContext): ApprovalPolicyDecision {
  const action = String(ctx.action);
  const sensitive =
    ctx.containsPii === true ||
    containsSensitiveText(ctx.text) ||
    metadataContainsSensitiveData(ctx.metadata);
  const highRiskAction = HIGH_RISK_ACTIONS.has(action) || sensitive;
  const riskLevel =
    ctx.riskLevel ??
    (action === 'delete_data' || action === 'reveal_pii'
      ? 'critical'
      : highRiskAction
        ? 'high'
        : 'low');

  const needsApproval =
    ctx.actor !== 'system' &&
    !isHumanApprovedActor(ctx.actor) &&
    (actionRequiresApproval(action) || sensitive);

  if (isHumanApprovedActor(ctx.actor)) {
    return {
      allowed: true,
      requiresApproval: false,
      riskLevel,
      reason: 'renderer/user action is treated as already approved',
    };
  }

  if (ctx.approved === true) {
    return {
      allowed: true,
      requiresApproval: false,
      riskLevel,
      reason: ctx.approvalId ? `approved by owner (${ctx.approvalId})` : 'approved by owner',
    };
  }

  if (needsApproval) {
    return {
      allowed: false,
      requiresApproval: true,
      riskLevel,
      reason: `${ctx.actor} ${action} requires owner approval`,
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    riskLevel,
    reason: 'action allowed by policy',
  };
}

function auditPolicyDecision(
  ctx: ApprovalPolicyContext,
  decision: ApprovalPolicyDecision,
  auditDecision?: AuditDecision | string,
  approvalId?: string,
): void {
  try {
    const { recordAuditEvent } = require('./audit-log') as typeof import('./audit-log');
    recordAuditEvent({
      actorType: ctx.actor,
      ...(ctx.actorId ? { actorId: ctx.actorId } : {}),
      source: ctx.source,
      action: String(ctx.action),
      riskLevel: decision.riskLevel,
      decision:
        auditDecision ??
        (decision.allowed
          ? 'allowed'
          : decision.requiresApproval
            ? 'approval_required'
            : 'blocked'),
      approvalId: approvalId ?? ctx.approvalId,
      ...(ctx.targetType ? { targetType: ctx.targetType } : {}),
      ...(ctx.targetId ? { targetId: ctx.targetId } : {}),
      summary: ctx.summary,
      metadata: {
        ...(ctx.metadata ?? {}),
        policy_reason: decision.reason,
        requires_approval: decision.requiresApproval,
      },
    });
  } catch (err) {
    console.warn(
      '[approval-policy] audit failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function auditAndAuthorize(ctx: ApprovalPolicyContext): ApprovalResult {
  const decision = evaluateApprovalPolicy(ctx);
  auditPolicyDecision(ctx, decision);
  return {
    allowed: decision.allowed,
    approvalId: ctx.approvalId,
    decision,
    ...(decision.allowed ? {} : { error: decision.reason }),
  };
}

function requestTypeForAction(action: string, sensitive: boolean): ApprovalRequestType {
  if (sensitive || action === 'reveal_pii') return 'share_pii';
  if (action === 'bridge_call') return 'transfer_call';
  if (action.startsWith('send_')) return 'content_approval';
  if (action === 'reputation_risk') return 'reputation_risk';
  return 'commit_to_action';
}

function approvalMessageFor(action: string): string {
  if (action === 'reveal_pii') return 'Owner approval is required before sharing sensitive information.';
  if (action.startsWith('send_')) return 'Owner approval is required before sending this message.';
  if (action.includes('call')) return 'Owner approval is required before placing or changing a call.';
  if (action === 'run_task') return 'Owner approval is required before running this task.';
  return 'Owner approval is required before continuing.';
}

function normalizeApprovalMetadata(ctx: ApprovalPolicyContext): string {
  try {
    return JSON.stringify({
      ...(ctx.metadata ?? {}),
      data_category: ctx.dataCategory,
      contains_pii: ctx.containsPii === true || containsSensitiveText(ctx.text),
    });
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export function resolvePolicyApproval(
  approvalId: string,
  result: { approved: boolean; data?: string },
): boolean {
  const waiter = approvalWaiters.get(approvalId);
  if (!waiter) return false;
  waiter(result);
  return true;
}

export async function ensureActionApproved(
  ctx: ApprovalPolicyContext,
  timeoutMs = 55_000,
): Promise<ApprovalResult> {
  const initialDecision = evaluateApprovalPolicy(ctx);

  if (initialDecision.allowed) {
    auditPolicyDecision(ctx, initialDecision, 'allowed');
    return { allowed: true, approvalId: ctx.approvalId, decision: initialDecision };
  }

  auditPolicyDecision(ctx, initialDecision, 'approval_required');

  if (!initialDecision.requiresApproval) {
    return { allowed: false, decision: initialDecision, error: initialDecision.reason };
  }

  const config = (require('../config') as typeof import('../config')).getConfig();
  if (!config.telegramBotToken || !config.telegramChatId) {
    auditPolicyDecision(ctx, initialDecision, 'denied');
    return {
      allowed: false,
      decision: initialDecision,
      error: `${approvalMessageFor(String(ctx.action))} Telegram approval is not configured.`,
    };
  }

  const now = new Date();
  const approvalId = ctx.approvalId ?? `appr_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + timeoutMs).toISOString();
  const sensitive = ctx.containsPii === true || containsSensitiveText(ctx.text);
  const requestType = requestTypeForAction(String(ctx.action), sensitive);

  const { createApproval, resolveApproval } = require('../database-sqlite') as typeof import('../database-sqlite');
  const { sendApprovalRequest } = require('../telegram') as typeof import('../telegram');

  try {
    const approvalRecord: Parameters<typeof createApproval>[0] = {
      id: approvalId,
      request_type: requestType,
      description: ctx.summary,
      created_at: now.toISOString(),
      actor_type: ctx.actor,
      source: ctx.source,
      action: String(ctx.action),
      risk_level: initialDecision.riskLevel,
      policy_reason: initialDecision.reason,
      metadata_json: normalizeApprovalMetadata(ctx),
      expires_at: expiresAt,
    };
    if (ctx.targetType === 'call' && ctx.targetId) approvalRecord.call_id = ctx.targetId;
    if (ctx.dataCategory) approvalRecord.data_category = ctx.dataCategory;
    if (ctx.actorId) approvalRecord.actor_id = ctx.actorId;
    if (ctx.targetType) approvalRecord.target_type = ctx.targetType;
    if (ctx.targetId) approvalRecord.target_id = ctx.targetId;
    createApproval(approvalRecord);
  } catch {
    // Existing row is fine; keep waiting on the same approval id.
  }

  const result = await new Promise<{ approved: boolean; data?: string; timedOut?: boolean }>(
    (resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: { approved: boolean; data?: string; timedOut?: boolean }): void => {
        clearTimeout(timer);
        approvalWaiters.delete(approvalId);
        resolve(value);
      };

      approvalWaiters.set(approvalId, (value) => finish(value));

      timer = setTimeout(() => {
        try {
          resolveApproval(approvalId, 'timed_out');
        } catch {
          /* best effort */
        }
        finish({ approved: false, timedOut: true });
      }, timeoutMs);

      const telegramApproval: import('../telegram').PendingApproval = {
        id: approvalId,
        request_type: requestType,
        description: ctx.summary,
        created_at: now.toISOString(),
        status: 'pending',
        resolve: (value) => finish(value),
      };
      if (ctx.targetType === 'call' && ctx.targetId) telegramApproval.call_id = ctx.targetId;
      if (ctx.dataCategory) telegramApproval.data_category = ctx.dataCategory;

      sendApprovalRequest(config.telegramChatId, telegramApproval).catch(() =>
        finish({ approved: false, data: 'sendApprovalRequest failed' }),
      );
    },
  );

  if (result.timedOut) {
    auditPolicyDecision(ctx, initialDecision, 'timed_out', approvalId);
    return {
      allowed: false,
      approvalId,
      decision: initialDecision,
      error: `${approvalMessageFor(String(ctx.action))} Approval timed out.`,
    };
  }

  try {
    resolveApproval(approvalId, result.approved ? 'approved' : 'denied', result.data);
  } catch {
    /* best effort */
  }

  if (!result.approved) {
    auditPolicyDecision(ctx, initialDecision, 'denied', approvalId);
    return {
      allowed: false,
      approvalId,
      decision: initialDecision,
      error: `${approvalMessageFor(String(ctx.action))} The owner denied the request.`,
    };
  }

  const approvedDecision: ApprovalPolicyDecision = {
    allowed: true,
    requiresApproval: false,
    riskLevel: initialDecision.riskLevel,
    reason: `approved by owner (${approvalId})`,
  };
  auditPolicyDecision({ ...ctx, approved: true, approvalId }, approvedDecision, 'approved', approvalId);
  return { allowed: true, approvalId, decision: approvedDecision };
}
