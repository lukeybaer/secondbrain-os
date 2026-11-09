'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLAN_SCHEMA = 'gmail_full_backlog_plan.v1';
const RUNNING_STATUS = 'running';
const CONFIRMATION = 'RUN_FULL_GMAIL_BACKLOG_AFTER_CLEANUP';
const ATTACHMENT_SCOPE = 'attachments';
const ATTACHMENT_QUERY_TERM = 'has:attachment';

function defaultPlanPath(dataDir) {
  const root =
    dataDir ||
    process.env.SECONDBRAIN_DATA_DIR ||
    path.resolve(__dirname, '..', '..', 'data');
  return path.join(root, 'life-archive', 'gmail-full-backlog-plan.json');
}

function approvalHash(planId) {
  return crypto.createHash('sha256').update(`${planId}:${CONFIRMATION}`).digest('hex');
}

function readPlan(planPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
}

const ATTACHMENT_QUERY_PREFIX = `${ATTACHMENT_QUERY_TERM} (`;

// True only for the canonical form `has:attachment (<inner>)` where the
// parenthesis opened right after the prefix closes at the final character, so
// no OR, negation or quoting can escape the outer AND. Double-quoted segments
// are skipped while counting depth.
function isCanonicalAttachmentQuery(query) {
  if (typeof query !== 'string' || !query.startsWith(ATTACHMENT_QUERY_PREFIX)) return false;
  if (!query.slice(ATTACHMENT_QUERY_PREFIX.length, -1).trim()) return false;
  let depth = 0;
  let quoted = false;
  for (let index = ATTACHMENT_QUERY_PREFIX.length - 1; index < query.length; index += 1) {
    const char = query[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === '(') {
      depth += 1;
    } else if (!quoted && char === ')') {
      depth -= 1;
      if (depth === 0) return index === query.length - 1;
    }
  }
  return false;
}

// Two plan kinds may run. A full All Mail drain needs the owner's cleanup
// attestation and a null query. An attachment-scoped plan needs the owner's quoted
// owner approval and a canonical has:attachment query, and never claims cleanup.
function scopeProblem(plan, query) {
  if (plan.scope === ATTACHMENT_SCOPE) {
    const approval = plan.owner_approval || {};
    if (!approval.by || !approval.at || !approval.quote) {
      return 'attachment plan lacks owner approval';
    }
    if (!isCanonicalAttachmentQuery(plan.query)) {
      return `attachment plan query must be exactly ${ATTACHMENT_QUERY_TERM} (<inner query>)`;
    }
    if (query !== undefined && query !== plan.query) {
      return 'engine query does not match the attachment plan query';
    }
    return null;
  }
  if (!plan.cleanup_attestation || plan.cleanup_attestation.completed !== true) {
    return 'Gmail cleanup is not attested complete';
  }
  if (plan.query !== null && plan.query !== undefined && plan.query !== '') {
    return 'full-backlog plan must not carry a query';
  }
  return null;
}

function evaluatePlan(plan, { now = new Date(), query } = {}) {
  if (!plan || typeof plan !== 'object') {
    return { allowed: false, reason: 'no active full-backlog plan' };
  }
  if (plan.schema !== PLAN_SCHEMA) {
    return { allowed: false, reason: 'full-backlog plan schema is invalid' };
  }
  if (plan.status !== RUNNING_STATUS || plan.execution_enabled !== true) {
    return { allowed: false, reason: 'full-backlog plan is not actively running' };
  }
  const problem = scopeProblem(plan, query);
  if (problem) {
    return { allowed: false, reason: problem };
  }
  if (!plan.plan_id || plan.approval_token_hash !== approvalHash(plan.plan_id)) {
    return { allowed: false, reason: 'full-backlog plan lacks approval identity' };
  }
  const expiresAt = Date.parse(String(plan.expires_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || nowMs >= expiresAt) {
    return { allowed: false, reason: 'full-backlog approval expired' };
  }
  const reason =
    plan.scope === ATTACHMENT_SCOPE
      ? 'explicit owner-approved attachment backfill run is active'
      : 'explicit post-cleanup full-backlog run is active';
  return { allowed: true, reason, plan };
}

function gmailFullBacklogGate({ dataDir, planPath, now, query } = {}) {
  const resolved = planPath || defaultPlanPath(dataDir);
  const plan = readPlan(resolved);
  return { ...evaluatePlan(plan, { now, query }), planPath: resolved };
}

module.exports = {
  ATTACHMENT_QUERY_TERM,
  ATTACHMENT_SCOPE,
  PLAN_SCHEMA,
  RUNNING_STATUS,
  CONFIRMATION,
  approvalHash,
  defaultPlanPath,
  evaluatePlan,
  gmailFullBacklogGate,
  isCanonicalAttachmentQuery,
  readPlan,
};
