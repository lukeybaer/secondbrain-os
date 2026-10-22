'use strict';

const { execFile } = require('child_process');

const AWS_COST_ACCOUNTS = Object.freeze([
  {
    key: 'primary',
    label: 'Primary / SecondBrain',
    account_id: 'ExampleCo',
    role_arn: null,
  },
  {
    key: 'client_app',
    label: 'Client App',
    account_id: '1555000000029',
    role_arn:
      process.env.AMY_AWS_CLIENT_APP_COST_ROLE_ARN ||
      'arn:aws:iam::1555000000029:role/SecondBrainCostExplorerReadRole',
  },
  {
    key: 'venture_app',
    label: 'Venture App',
    account_id: '1555000000061',
    role_arn:
      process.env.AMY_AWS_VENTURE_APP_COST_ROLE_ARN ||
      'arn:aws:iam::1555000000061:role/SecondBrainCostExplorerReadRole',
  },
]);

function executeAws(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.AWS_CLI_COMMAND || 'aws',
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs || 60_000,
        maxBuffer: 5 * 1024 * 1024,
        env: options.env || process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message = String(stderr || stdout || error.message).trim();
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout || '{}'));
        } catch {
          reject(new Error('AWS CLI returned invalid JSON'));
        }
      },
    );
  });
}

function classifyAwsFailure(error) {
  const detail = String(error?.message || error || 'AWS request failed')
    .replace(/AKIA[A-Z0-9]{16}/g, '[redacted-access-key]')
    .slice(0, 400);
  if (/accessdenied|access denied|not authorized|unauthorized/i.test(detail)) {
    return { status: 'access_denied', reason: detail };
  }
  if (/not enabled|dataunavailable|cost explorer.*disabled/i.test(detail)) {
    return { status: 'unavailable', reason: detail };
  }
  if (/expiredtoken|invalidclienttokenid|unrecognizedclient|credentials/i.test(detail)) {
    return { status: 'auth_error', reason: detail };
  }
  return { status: 'error', reason: detail };
}

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

function costWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (end <= start) start.setUTCMonth(start.getUTCMonth() - 1);
  return { start: utcDate(start), end: utcDate(end) };
}

function temporaryCredentialEnv(credentials, baseEnv = process.env) {
  return {
    ...baseEnv,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
  };
}

function normalizeCostResponse(response) {
  const services = {};
  let total = 0;
  for (const period of response?.ResultsByTime || []) {
    for (const group of period.Groups || []) {
      const service = String(group.Keys?.[0] || 'Unknown');
      const amount = Number(group.Metrics?.UnblendedCost?.Amount);
      if (!Number.isFinite(amount)) continue;
      services[service] = (services[service] || 0) + amount;
      total += amount;
    }
  }
  return {
    cost_usd: Math.round(total * 1e6) / 1e6,
    services: Object.fromEntries(
      Object.entries(services)
        .map(([service, amount]) => [service, Math.round(amount * 1e6) / 1e6])
        .sort((a, b) => b[1] - a[1]),
    ),
    estimated: (response?.ResultsByTime || []).some((period) => period.Estimated === true),
  };
}

async function accountEnvironment(account, execute, baseEnv) {
  if (!account.role_arn) return baseEnv;
  const assumed = await execute(
    [
      'sts',
      'assume-role',
      '--role-arn',
      account.role_arn,
      '--role-session-name',
      `amy-cost-${Date.now()}`,
      '--duration-seconds',
      '900',
      '--output',
      'json',
    ],
    { env: baseEnv, timeoutMs: 30_000 },
  );
  if (!assumed?.Credentials?.AccessKeyId) throw new Error('AssumeRole returned no credentials');
  return temporaryCredentialEnv(assumed.Credentials, baseEnv);
}

async function queryAccount(account, { execute, window, baseEnv }) {
  try {
    const env = await accountEnvironment(account, execute, baseEnv);
    const identity = await execute(
      ['sts', 'get-caller-identity', '--output', 'json'],
      { env, timeoutMs: 30_000 },
    );
    if (String(identity?.Account || '') !== account.account_id) {
      return {
        label: account.label,
        account_id: account.account_id,
        status: 'identity_mismatch',
        cost_usd: null,
        reason: `AWS identity resolved account ${identity?.Account || 'unknown'}, expected ${account.account_id}`,
      };
    }
    const response = await execute(
      [
        'ce',
        'get-cost-and-usage',
        '--time-period',
        `Start=${window.start},End=${window.end}`,
        '--granularity',
        'MONTHLY',
        '--metrics',
        'UnblendedCost',
        '--group-by',
        'Type=DIMENSION,Key=SERVICE',
        '--region',
        'us-east-1',
        '--output',
        'json',
      ],
      { env, timeoutMs: 60_000 },
    );
    return {
      label: account.label,
      account_id: account.account_id,
      status: 'ok',
      ...normalizeCostResponse(response),
    };
  } catch (error) {
    return {
      label: account.label,
      account_id: account.account_id,
      ...classifyAwsFailure(error),
      cost_usd: null,
      services: null,
      estimated: null,
    };
  }
}

async function queryAwsCostUsage({
  execute = executeAws,
  now = new Date(),
  env = process.env,
  accounts = AWS_COST_ACCOUNTS,
} = {}) {
  const window = costWindow(now);
  const rows = await Promise.all(
    accounts.map((account) => queryAccount(account, { execute, window, baseEnv: env })),
  );
  const byAccount = Object.fromEntries(rows.map((row, index) => [accounts[index].key, row]));
  const complete = rows.every((row) => row.status === 'ok');
  const verified = rows
    .filter((row) => row.status === 'ok')
    .reduce((total, row) => total + row.cost_usd, 0);
  return {
    ok: complete,
    schema: 'amy.aws-cost-usage.v1',
    generated_at: now.toISOString(),
    window,
    complete,
    total_usd: complete ? Math.round(verified * 1e6) / 1e6 : null,
    verified_accessible_total_usd: Math.round(verified * 1e6) / 1e6,
    accounts: byAccount,
  };
}

module.exports = {
  AWS_COST_ACCOUNTS,
  classifyAwsFailure,
  costWindow,
  executeAws,
  normalizeCostResponse,
  queryAwsCostUsage,
  temporaryCredentialEnv,
};
