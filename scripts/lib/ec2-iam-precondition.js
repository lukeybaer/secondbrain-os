'use strict';

// scripts/lib/ec2-iam-precondition.js
//
// The machine-checkable capability precondition for the Bedrock funded-lane
// budget collector (report breakpoint 7, Perspective A: "Every external
// collector must declare a machine-checkable capability precondition"). Answers
// ONE question without fabricating: can this instance role READ the funded-lane
// budget?
//
//   { ok: true,  state: 'ok' }                      budgets:ViewBudget works.
//   { ok: false, state: 'provisioning', ... }       AccessDenied: the ExampleCo is
//        missing. Fails loud with the exact remediation
//        (scripts/infra/apply-ec2-iam.sh) and owner. NEVER handed to the healer.
//   { ok: false, state: 'transient', ... }          some other aws error; retry.
//
// Pure aws probe with an injectable spawn so tests never touch real AWS.

const { spawnSync } = require('child_process');

const REMEDIATION =
  'run: bash scripts/infra/apply-ec2-iam.sh (ExampleCos budgets:ViewBudget on the funded-lane budget to the EC2 role)';

function checkBudgetReadable(opts = {}) {
  const spawn = opts.spawn || spawnSync;
  const budgetName =
    opts.budgetName || process.env.BEDROCK_BUDGET_NAME || 'amy-llm-fallback-bedrock';
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';

  let acct = opts.accountId || process.env.AWS_ACCOUNT_ID;
  if (!acct) {
    const r = spawn(
      'aws',
      ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
      { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' },
    );
    acct = (r && r.stdout ? r.stdout : '').trim();
  }
  if (!/^\d{12}$/.test(String(acct || ''))) {
    return {
      ok: false,
      state: 'provisioning',
      kind: 'missing-config',
      reason: 'could not resolve a 12-digit AWS account id',
      owner: 'ExampleCo',
      remediation: REMEDIATION,
    };
  }

  const r = spawn(
    'aws',
    [
      'budgets',
      'describe-budget',
      '--account-id',
      String(acct),
      '--budget-name',
      budgetName,
      '--region',
      region,
      '--output',
      'json',
    ],
    { encoding: 'utf8', timeout: 20000, shell: process.platform === 'win32' },
  );
  if (r && r.status === 0) return { ok: true, state: 'ok', budgetName };

  const err = String((r && (r.stderr || (r.error && r.error.message))) || 'aws budgets describe-budget failed').slice(0, 240);
  const denied = /AccessDenied|not authorized to perform/i.test(err);
  return {
    ok: false,
    state: denied ? 'provisioning' : 'transient',
    kind: denied ? 'iam-access-denied' : 'aws-error',
    reason: err,
    owner: denied ? 'ExampleCo' : null,
    remediation: denied ? REMEDIATION : null,
  };
}

if (require.main === module) {
  const res = checkBudgetReadable();
  console.log(JSON.stringify(res, null, 2));
  // exit 0 = ok, 2 = provisioning (loud, human-owned), 1 = transient.
  process.exit(res.ok ? 0 : res.state === 'provisioning' ? 2 : 1);
}

module.exports = { checkBudgetReadable, REMEDIATION };
