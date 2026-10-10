'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLAN_SCHEMA = 'gmail_full_backlog_plan.v1';
const RUNNING_STATUS = 'running';
const CONFIRMATION = 'RUN_FULL_GMAIL_BACKLOG_AFTER_CLEANUP';

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

function evaluatePlan(plan, { now = new Date() } = {}) {
  if (!plan || typeof plan !== 'object') {
    return { allowed: false, reason: 'no active full-backlog plan' };
  }
  if (plan.schema !== PLAN_SCHEMA) {
    return { allowed: false, reason: 'full-backlog plan schema is invalid' };
  }
  if (plan.status !== RUNNING_STATUS || plan.execution_enabled !== true) {
    return { allowed: false, reason: 'full-backlog plan is not actively running' };
  }
  if (!plan.cleanup_attestation || plan.cleanup_attestation.completed !== true) {
    return { allowed: false, reason: 'Gmail cleanup is not attested complete' };
  }
  if (!plan.plan_id || plan.approval_token_hash !== approvalHash(plan.plan_id)) {
    return { allowed: false, reason: 'full-backlog plan lacks approval identity' };
  }
  const expiresAt = Date.parse(String(plan.expires_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || nowMs >= expiresAt) {
    return { allowed: false, reason: 'full-backlog approval expired' };
  }
  return { allowed: true, reason: 'explicit post-cleanup full-backlog run is active', plan };
}

function gmailFullBacklogGate({ dataDir, planPath, now } = {}) {
  const resolved = planPath || defaultPlanPath(dataDir);
  const plan = readPlan(resolved);
  return { ...evaluatePlan(plan, { now }), planPath: resolved };
}

module.exports = {
  PLAN_SCHEMA,
  RUNNING_STATUS,
  CONFIRMATION,
  approvalHash,
  defaultPlanPath,
  evaluatePlan,
  gmailFullBacklogGate,
  readPlan,
};
