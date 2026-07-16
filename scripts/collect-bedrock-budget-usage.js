#!/usr/bin/env node
/**
 * collect-bedrock-budget-usage.js
 *
 * 2026-06-09 ExampleCo approved a $20/mo funded Bedrock fallback lane and asked to
 * "track it in the card with the api tracking of % usage of plan." This reads
 * the amy-llm-fallback-bedrock AWS Budget (actual spend + $20 limit) and writes
 * data/agent/bedrock-budget-usage.json so the briefing token card can show the
 * funded-lane burn next to the Claude Max percent. Free (AWS Budgets API).
 *
 * Mirrors collect-claude-plan-usage.js: authoritative source written to a JSON
 * file the generator reads; if the fetch fails the generator falls back to an
 * honest "not collected" note rather than fabricating a number.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeSidecar, clearSidecar } = require('./lib/collector-degrade.js');
const { ctDateKey, writeProviderReceipt } = require('./lib/token-usage-receipts.js');

// Resolve the AWS account id at runtime (never hardcode it -- the literal is a
// PII denylist token and this file ships in the public-sync allowlist). Env
// override first, else `aws sts get-caller-identity`, same pattern as
// aws-cost-section.js and archive-session-to-s3.sh.
function getAccountId() {
  if (process.env.AWS_ACCOUNT_ID) return process.env.AWS_ACCOUNT_ID;
  const r = spawnSync(
    'aws',
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    { encoding: 'utf8', timeout: 15000 },
  );
  const id = (r.stdout || '').trim();
  if (r.status !== 0 || !/^\d{12}$/.test(id)) {
    throw new Error('could not resolve AWS account id (set AWS_ACCOUNT_ID or configure aws sts)');
  }
  return id;
}
const BUDGET_NAME = process.env.BEDROCK_BUDGET_NAME || 'amy-llm-fallback-bedrock';
const SECONDBRAIN_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(SECONDBRAIN_ROOT, 'data');
const OUT_PATH = path.join(
  DATA_DIR,
  'agent',
  'bedrock-budget-usage.json',
);

function fetchBudget() {
  const accountId = getAccountId();
  const r = spawnSync(
    'aws',
    [
      'budgets',
      'describe-budget',
      '--account-id',
      accountId,
      '--budget-name',
      BUDGET_NAME,
      '--region',
      'us-east-1',
      '--output',
      'json',
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      // aws is aws.cmd on Windows and needs a shell; on Linux it is a real binary.
      shell: process.platform === 'win32',
    },
  );
  if (r.status !== 0) {
    throw new Error(
      (r.stderr || r.error?.message || 'aws budgets describe-budget failed')
        .toString()
        .slice(0, 200),
    );
  }
  const data = JSON.parse(r.stdout);
  const b = data.Budget || {};
  const limit = Number(b.BudgetLimit?.Amount || 0);
  const actual = Number(b.CalculatedSpend?.ActualSpend?.Amount || 0);
  const forecast =
    b.CalculatedSpend?.ForecastedSpend?.Amount != null
      ? Number(b.CalculatedSpend.ForecastedSpend.Amount)
      : null;
  const unit = b.BudgetLimit?.Unit || 'USD';
  const percent = limit > 0 ? Math.round((actual / limit) * 1000) / 10 : null;
  return { budget_name: BUDGET_NAME, limit, actual, forecast, unit, percent };
}

function writeUsageReceipt({ status, payload = null, errorText = '' } = {}) {
  const ownerAction = /accessdenied|not authorized|account id|configure aws|credentials/i.test(errorText);
  return writeProviderReceipt({
    dataDir: DATA_DIR,
    date: process.env.TOKEN_USAGE_RECEIPT_DATE || ctDateKey(),
    provider: 'bedrock',
    observedAt: new Date().toISOString(),
    status,
    source: 'aws budgets describe-budget',
    payload,
    defect:
      status === 'clean'
        ? null
        : {
            code: ownerAction ? 'owner_action_required' : 'probe_failed',
            detail: errorText || 'Bedrock budget usage probe failed.',
          },
  });
}

function main() {
  let payload;
  try {
    payload = fetchBudget();
  } catch (e) {
    console.error(`[collect-bedrock-budget-usage] ${e.message}`);
    // Additive degrade sidecar (never touches the main artifact, readers guard on
    // `limit`): an IAM AccessDenied becomes a loud PROVISIONING state with an owner
    // + remediation the healer is told to skip, not a silently-tolerated gap.
    const { block, sidecar } = writeSidecar(OUT_PATH, {
      errorText: e.message,
      owner: 'ExampleCo',
      remediation: 'run: bash scripts/infra/apply-ec2-iam.sh (ExampleCos budgets:ViewBudget to the EC2 role)',
      source: 'aws budgets describe-budget',
    });
    if (sidecar) {
      console.error(
        `[collect-bedrock-budget-usage] degrade sidecar (${block.degrade_state}${block.healer_excluded ? ', healer-excluded' : ''}) -> ${sidecar}`,
      );
    }
    writeUsageReceipt({ status: 'blocked', errorText: e.message });
    // exit 2 for a structural provisioning fault (loud, human-owned), 1 otherwise.
    process.exit(block && block.degrade_state === 'provisioning' ? 2 : 1);
  }
  // Clear any stale degrade sidecar on a clean read so the fault does not linger.
  clearSidecar(OUT_PATH);
  const out = {
    generated_at: new Date().toISOString(),
    source: 'aws budgets describe-budget',
    ...payload,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  writeUsageReceipt({ status: 'clean', payload: out });
  console.log(`[collect-bedrock-budget-usage] wrote ${OUT_PATH}`);
  console.log(
    `  Bedrock lane: $${payload.actual.toFixed(2)} of $${payload.limit.toFixed(2)} ${payload.unit} (${payload.percent}%)`,
  );
}

if (require.main === module) main();

module.exports = { fetchBudget, writeUsageReceipt };
