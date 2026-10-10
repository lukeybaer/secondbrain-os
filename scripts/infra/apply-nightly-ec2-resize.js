#!/usr/bin/env node
'use strict';

// Installs the approved 7h20m EC2 capacity window without an always-on
// helper. EventBridge Scheduler invokes the AWS-owned AWS-ResizeInstance SSM
// Automation document at 22:15 CT (m7i.xlarge) and 05:35 CT (t3.medium). The
// document is state-safe: it exits when the requested type is already active;
// otherwise it stops, modifies, and restarts the exact registered instance.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRuntimeDataDir } = require('../lib/scheduled-write-ownership.js');
const {
  TIMEZONE: SCHEDULE_TIMEZONE,
  SCALE_UP_CRON,
  SCALE_DOWN_CRON,
  WINDOW_LABEL,
} = require('../lib/nightly-resize-schedule.js');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_REGION = 'us-east-1';
// Sourced from scripts/lib/nightly-resize-schedule.js, the single source of
// truth this schedule shares with the systemd pre-drain timer and the
// resize-health window constants. Moving the schedule means editing that
// module, not these two lines. See scripts/__tests__/nightly-resize-schedule-drift.test.js.
const DEFAULT_TIMEZONE = SCHEDULE_TIMEZONE;
const DEFAULT_SCALE_UP = SCALE_UP_CRON;
const DEFAULT_SCALE_DOWN = SCALE_DOWN_CRON;
const AUTOMATION_ROLE_NAME = 'secondbrain-nightly-resize-automation';
const SCHEDULER_ROLE_NAME = 'secondbrain-nightly-resize-scheduler';
const AUTOMATION_POLICY_NAME = 'secondbrain-nightly-resize-automation';
const SCHEDULER_POLICY_NAME = 'secondbrain-nightly-resize-scheduler';
const DOCUMENT_NAME = 'AWS-ResizeInstance';

function compact(value) {
  return JSON.stringify(value);
}

function registeredInstance() {
  const registry = JSON.parse(
    fs.readFileSync(path.join(REPO, 'config', 'state-ownership.json'), 'utf8'),
  );
  const host = registry.cloud_hosts && registry.cloud_hosts['secondbrain-production'];
  if (!host?.instance_id || !host?.region || !host?.elastic_ip || !host?.allocation_id) {
    throw new Error('state ownership registry lacks the production cloud host identity');
  }
  return {
    instanceId: host.instance_id,
    region: host.region,
    elasticIp: host.elastic_ip,
    allocationId: host.allocation_id,
  };
}

function automationTrustPolicy({ accountId }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ssm.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'aws:SourceAccount': accountId } },
      },
    ],
  };
}

function schedulerTrustPolicy({ accountId, region }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'scheduler.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          // EventBridge Scheduler supplies the schedule-group ARN here. AWS
          // explicitly rejects a schedule ARN or schedule-name prefix.
          StringEquals: {
            'aws:SourceAccount': accountId,
            'aws:SourceArn': `arn:aws:scheduler:${region}:${accountId}:schedule-group/default`,
          },
        },
      },
    ],
  };
}

function automationPolicy({ accountId, region, instanceId }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
        Resource: '*',
      },
      {
        Effect: 'Allow',
        Action: ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:ModifyInstanceAttribute'],
        Resource: `arn:aws:ec2:${region}:${accountId}:instance/${instanceId}`,
      },
    ],
  };
}

function schedulerPolicy({ accountId, region, automationRoleArn }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'ssm:StartAutomationExecution',
        Resource: [
          `arn:aws:ssm:${region}:*:document/${DOCUMENT_NAME}`,
          `arn:aws:ssm:${region}:*:automation-definition/${DOCUMENT_NAME}:*`,
          `arn:aws:ssm:${region}:${accountId}:automation-execution/*`,
        ],
      },
      { Effect: 'Allow', Action: 'iam:PassRole', Resource: automationRoleArn },
    ],
  };
}

function scheduleDefinition({
  name,
  description,
  expression,
  timezone = DEFAULT_TIMEZONE,
  instanceId,
  instanceType,
  schedulerRoleArn,
  automationRoleArn,
}) {
  return {
    name,
    description,
    expression,
    timezone,
    flexibleTimeWindow: { Mode: 'OFF' },
    state: 'ENABLED',
    target: {
      Arn: 'arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution',
      RoleArn: schedulerRoleArn,
      RetryPolicy: { MaximumEventAgeInSeconds: 600, MaximumRetryAttempts: 2 },
      Input: compact({
        DocumentName: DOCUMENT_NAME,
        Parameters: {
          InstanceId: [instanceId],
          InstanceType: [instanceType],
          SleepWait: ['PT5S'],
          AutomationAssumeRole: [automationRoleArn],
        },
      }),
    },
  };
}

function runAws(args, { allowFailure = false } = {}) {
  const result = spawnSync('aws', args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `aws ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr || result.stdout || result.status).trim()}`,
    );
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const ROLE_PROPAGATION_RETRY_DELAYS_MS = [5_000, 5_000, 10_000, 15_000, 20_000];

function isRolePropagationError(output) {
  const message = String(output || '');
  return (
    /(?:cannot\s+be|unable\s+to\s+be)\s+assumed/i.test(message) ||
    /must allow[^.\r\n]{0,80}\bScheduler\b[^.\r\n]{0,80}\bto assume the role\b/i.test(message)
  );
}

function executedDisruptiveResizeSteps(execution) {
  return (execution?.Steps || []).filter(
    (step) =>
      ['stopInstance', 'resizeInstance', 'startInstance'].includes(step.StepName) &&
      !/^(Pending|Skipped)$/i.test(String(step.Status || '')),
  );
}

function validateAutomationDocument(region) {
  const document = JSON.parse(
    runAws([
      'ssm',
      'describe-document',
      '--name',
      DOCUMENT_NAME,
      '--region',
      region,
      '--query',
      'Document.{Status:Status,DocumentType:DocumentType,Owner:Owner,Parameters:Parameters}',
      '--output',
      'json',
    ]).stdout,
  );
  const names = new Set((document.Parameters || []).map((row) => row.Name));
  for (const required of ['InstanceId', 'InstanceType', 'SleepWait', 'AutomationAssumeRole']) {
    if (!names.has(required)) throw new Error(`${DOCUMENT_NAME} lacks parameter ${required}`);
  }
  if (document.Status !== 'Active' || document.DocumentType !== 'Automation') {
    throw new Error(`${DOCUMENT_NAME} is not an active Automation document`);
  }
  if (document.Owner !== 'Amazon') throw new Error(`${DOCUMENT_NAME} is not Amazon-owned`);
  return document;
}

function verifyInstanceBinding({ instanceId, region, elasticIp, allocationId }) {
  const instance = JSON.parse(
    runAws([
      'ec2',
      'describe-instances',
      '--instance-ids',
      instanceId,
      '--region',
      region,
      '--query',
      'Reservations[0].Instances[0].{State:State.Name,Type:InstanceType,PublicIp:PublicIpAddress,LaunchTime:LaunchTime,StateTransitionReason:StateTransitionReason}',
      '--output',
      'json',
    ]).stdout,
  );
  const addresses = JSON.parse(
    runAws([
      'ec2',
      'describe-addresses',
      '--region',
      region,
      '--filters',
      `Name=instance-id,Values=${instanceId}`,
      '--query',
      'Addresses[].{PublicIp:PublicIp,AllocationId:AllocationId,AssociationId:AssociationId}',
      '--output',
      'json',
    ]).stdout,
  );
  const address = addresses.find(
    (row) => row.PublicIp === elasticIp && row.AllocationId === allocationId && row.AssociationId,
  );
  if (!address || instance.PublicIp !== elasticIp) {
    throw new Error(`refusing resize: ${instanceId} lacks its registered Elastic IP ${elasticIp}`);
  }
  if (instance.State !== 'running') {
    throw new Error(
      `refusing resize: ${instanceId} is ${instance.State || 'unknown'}, not running`,
    );
  }
  return { ...instance, ...address };
}

function ensureRole({ name, trust, policyName, policy }) {
  const existing = runAws(['iam', 'get-role', '--role-name', name, '--output', 'json'], {
    allowFailure: true,
  });
  if (existing.ok) {
    runAws([
      'iam',
      'update-assume-role-policy',
      '--role-name',
      name,
      '--policy-document',
      compact(trust),
    ]);
  } else {
    runAws([
      'iam',
      'create-role',
      '--role-name',
      name,
      '--assume-role-policy-document',
      compact(trust),
      '--description',
      'SecondBrain state-safe nightly EC2 capacity resize',
    ]);
  }
  runAws([
    'iam',
    'put-role-policy',
    '--role-name',
    name,
    '--policy-name',
    policyName,
    '--policy-document',
    compact(policy),
  ]);
  return JSON.parse(
    runAws([
      'iam',
      'get-role',
      '--role-name',
      name,
      '--query',
      'Role.{Arn:Arn,RoleId:RoleId}',
      '--output',
      'json',
    ]).stdout,
  );
}

function upsertSchedule(definition, region) {
  const common = [
    '--name',
    definition.name,
    '--group-name',
    'default',
    '--description',
    definition.description,
    '--schedule-expression',
    definition.expression,
    '--schedule-expression-timezone',
    definition.timezone,
    '--flexible-time-window',
    compact(definition.flexibleTimeWindow),
    '--state',
    definition.state,
    '--target',
    compact(definition.target),
    '--region',
    region,
  ];
  const existing = runAws(
    [
      'scheduler',
      'get-schedule',
      '--name',
      definition.name,
      '--group-name',
      'default',
      '--region',
      region,
    ],
    { allowFailure: true },
  );
  let applied;
  for (let attempt = 1; attempt <= ROLE_PROPAGATION_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    applied = runAws(
      ['scheduler', existing.ok ? 'update-schedule' : 'create-schedule', ...common],
      {
        allowFailure: true,
      },
    );
    if (applied.ok) break;
    if (!isRolePropagationError(`${applied.stderr} ${applied.stdout}`)) {
      break;
    }
    sleepMs(ROLE_PROPAGATION_RETRY_DELAYS_MS[attempt - 1]);
  }
  if (!applied?.ok) {
    throw new Error(`scheduler upsert failed: ${applied?.stderr || applied?.stdout || 'unknown'}`);
  }
  return JSON.parse(
    runAws([
      'scheduler',
      'get-schedule',
      '--name',
      definition.name,
      '--group-name',
      'default',
      '--region',
      region,
      '--query',
      '{Arn:Arn,State:State,ScheduleExpression:ScheduleExpression,Timezone:ScheduleExpressionTimezone,Target:Target}',
      '--output',
      'json',
    ]).stdout,
  );
}

function runAcceptanceExecution({ instanceId, instanceType, region, automationRoleArn }) {
  const args = [
    'ssm',
    'start-automation-execution',
    '--document-name',
    DOCUMENT_NAME,
    '--parameters',
    compact({
      InstanceId: [instanceId],
      InstanceType: [instanceType],
      SleepWait: ['PT5S'],
      AutomationAssumeRole: [automationRoleArn],
    }),
    '--region',
    region,
    '--query',
    'AutomationExecutionId',
    '--output',
    'text',
  ];
  let started;
  for (let attempt = 1; attempt <= ROLE_PROPAGATION_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    started = runAws(args, { allowFailure: true });
    if (started.ok) break;
    if (!isRolePropagationError(`${started.stderr} ${started.stdout}`)) {
      break;
    }
    sleepMs(ROLE_PROPAGATION_RETRY_DELAYS_MS[attempt - 1]);
  }
  if (!started?.ok) {
    throw new Error(`acceptance execution could not start: ${started?.stderr || started?.stdout}`);
  }
  const executionId = started.stdout;
  let execution;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    execution = JSON.parse(
      runAws([
        'ssm',
        'get-automation-execution',
        '--automation-execution-id',
        executionId,
        '--region',
        region,
        '--query',
        'AutomationExecution.{Status:AutomationExecutionStatus,CurrentStep:CurrentStepName,FailureMessage:FailureMessage,Steps:StepExecutions[].{StepName:StepName,Action:Action,Status:StepStatus}}',
        '--output',
        'json',
      ]).stdout,
    );
    if (/^(Success|Failed|Cancelled|TimedOut)$/i.test(execution.Status || '')) break;
    sleepMs(3_000);
  }
  if (!/^(Success|Failed|Cancelled|TimedOut)$/i.test(execution?.Status || '')) {
    runAws(
      [
        'ssm',
        'stop-automation-execution',
        '--automation-execution-id',
        executionId,
        '--type',
        'Cancel',
        '--region',
        region,
      ],
      { allowFailure: true },
    );
    throw new Error(
      `${DOCUMENT_NAME} acceptance execution ${executionId} timed out and was cancelled`,
    );
  }
  if (execution?.Status !== 'Success') {
    throw new Error(
      `${DOCUMENT_NAME} acceptance execution ${executionId} ended ${execution?.Status || 'unknown'}: ${execution?.FailureMessage || ''}`,
    );
  }
  const disruptive = executedDisruptiveResizeSteps(execution);
  if (disruptive.length) {
    throw new Error(
      `${DOCUMENT_NAME} acceptance execution ${executionId} used a disruptive path: ${disruptive.map((step) => step.StepName).join(', ')}`,
    );
  }
  return { executionId, ...execution };
}

function verifyInstanceStatus({ instanceId, region }) {
  const status = JSON.parse(
    runAws([
      'ec2',
      'describe-instance-status',
      '--instance-ids',
      instanceId,
      '--include-all-instances',
      '--region',
      region,
      '--query',
      'InstanceStatuses[0].{State:InstanceState.Name,System:SystemStatus.Status,Instance:InstanceStatus.Status}',
      '--output',
      'json',
    ]).stdout,
  );
  if (status?.State !== 'running' || status?.System !== 'ok' || status?.Instance !== 'ok') {
    throw new Error(`instance status proof is non-green: ${JSON.stringify(status)}`);
  }
  return status;
}

function verifyBackendHealth(elasticIp) {
  const result = spawnSync(
    'curl',
    ['-fsS', '--max-time', '20', `http://${elasticIp}:3001/health`],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 25_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `backend health verification failed: ${String(result.stderr || result.status)}`,
    );
  }
  const health = JSON.parse(result.stdout);
  if (health.status !== 'ok')
    throw new Error(`backend health status is ${health.status || 'missing'}`);
  return { status: health.status, service: health.service, version: health.version };
}

function appendReceipt(row) {
  const receiptFile = path.join(
    resolveRuntimeDataDir(),
    'agent',
    'nightly-ec2-resize-receipts.jsonl',
  );
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.appendFileSync(receiptFile, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  return receiptFile;
}

function buildPlan({ accountId, instanceId, region, automationRoleArn, schedulerRoleArn }) {
  return {
    instanceId,
    region,
    window: WINDOW_LABEL,
    scaleUp: scheduleDefinition({
      name: 'secondbrain-nightly-scale-up',
      description: 'Resize SecondBrain to m7i.xlarge for the 7h20m briefing window',
      expression: DEFAULT_SCALE_UP,
      instanceId,
      instanceType: 'm7i.xlarge',
      schedulerRoleArn,
      automationRoleArn,
    }),
    scaleDown: scheduleDefinition({
      name: 'secondbrain-nightly-scale-down',
      description: 'Return SecondBrain to t3.medium after the 7h20m briefing window',
      expression: DEFAULT_SCALE_DOWN,
      instanceId,
      instanceType: 't3.medium',
      schedulerRoleArn,
      automationRoleArn,
    }),
    automationPolicy: automationPolicy({ accountId, instanceId, region }),
    schedulerPolicy: schedulerPolicy({ accountId, region, automationRoleArn }),
  };
}

function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const registered = registeredInstance();
  const region = registered.region || DEFAULT_REGION;
  const instanceId = registered.instanceId;
  const accountId = apply
    ? runAws([
        'sts',
        'get-caller-identity',
        '--query',
        'Account',
        '--output',
        'text',
        '--region',
        region,
      ]).stdout
    : 'ACCOUNT_ID';
  const automationRoleArn = `arn:aws:iam::${accountId}:role/${AUTOMATION_ROLE_NAME}`;
  const schedulerRoleArn = `arn:aws:iam::${accountId}:role/${SCHEDULER_ROLE_NAME}`;
  const plan = buildPlan({ accountId, instanceId, region, automationRoleArn, schedulerRoleArn });
  if (!apply) {
    console.log(JSON.stringify({ mode: 'plan', ...plan }, null, 2));
    return;
  }

  const document = validateAutomationDocument(region);
  const before = verifyInstanceBinding({ ...registered, instanceId, region });

  const automationRole = ensureRole({
    name: AUTOMATION_ROLE_NAME,
    trust: automationTrustPolicy({ accountId }),
    policyName: AUTOMATION_POLICY_NAME,
    policy: plan.automationPolicy,
  });
  const schedulerRole = ensureRole({
    name: SCHEDULER_ROLE_NAME,
    trust: schedulerTrustPolicy({ accountId, region }),
    policyName: SCHEDULER_POLICY_NAME,
    policy: schedulerPolicy({ accountId, region, automationRoleArn: automationRole.Arn }),
  });
  const resolvedPlan = buildPlan({
    accountId,
    instanceId,
    region,
    automationRoleArn: automationRole.Arn,
    schedulerRoleArn: schedulerRole.Arn,
  });
  const disabledScaleUp = { ...resolvedPlan.scaleUp, state: 'DISABLED' };
  const disabledScaleDown = { ...resolvedPlan.scaleDown, state: 'DISABLED' };
  let acceptance;
  let after;
  let instanceStatus;
  let health;
  let scaleUp;
  let scaleDown;
  try {
    upsertSchedule(disabledScaleUp, region);
    upsertSchedule(disabledScaleDown, region);
    acceptance = runAcceptanceExecution({
      instanceId,
      instanceType: before.Type,
      region,
      automationRoleArn: automationRole.Arn,
    });
    after = verifyInstanceBinding({ ...registered, instanceId, region });
    if (after.Type !== before.Type || after.LaunchTime !== before.LaunchTime) {
      throw new Error(
        `acceptance execution was disruptive: type ${before.Type}->${after.Type}, launch ${before.LaunchTime}->${after.LaunchTime}`,
      );
    }
    instanceStatus = verifyInstanceStatus({ instanceId, region });
    health = verifyBackendHealth(registered.elasticIp);
    scaleUp = upsertSchedule(resolvedPlan.scaleUp, region);
    scaleDown = upsertSchedule(resolvedPlan.scaleDown, region);
  } catch (error) {
    const rollback = [];
    for (const definition of [disabledScaleUp, disabledScaleDown]) {
      try {
        const schedule = upsertSchedule(definition, region);
        rollback.push({ name: definition.name, state: schedule.State });
      } catch (rollbackError) {
        rollback.push({
          name: definition.name,
          error: String(rollbackError.message || rollbackError),
        });
      }
    }
    throw new Error(
      `${String(error.message || error)}; schedule rollback=${JSON.stringify(rollback)}`,
    );
  }
  const receiptFile = appendReceipt({
    status: 'green',
    instanceId,
    region,
    window: plan.window,
    elasticIp: registered.elasticIp,
    allocationId: registered.allocationId,
    document,
    automationRole,
    schedulerRole,
    scaleUp,
    scaleDown,
    acceptance,
    instance: after,
    instanceStatus,
    health,
  });
  console.log(
    JSON.stringify(
      {
        mode: 'applied',
        instanceId,
        region,
        window: plan.window,
        automationRole,
        schedulerRole,
        scaleUp,
        scaleDown,
        acceptance,
        instance: after,
        instanceStatus,
        health,
        receiptFile,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    try {
      appendReceipt({ status: 'red', error: String(error.message || error) });
    } catch {
      // stderr remains the fail-closed proof if the runtime receipt is unavailable.
    }
    console.error(`[nightly-ec2-resize] ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SCALE_DOWN,
  DEFAULT_SCALE_UP,
  DEFAULT_TIMEZONE,
  automationPolicy,
  automationTrustPolicy,
  buildPlan,
  executedDisruptiveResizeSteps,
  isRolePropagationError,
  scheduleDefinition,
  schedulerPolicy,
  schedulerTrustPolicy,
  validateAutomationDocument,
  verifyInstanceBinding,
  verifyInstanceStatus,
};
