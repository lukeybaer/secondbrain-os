#!/usr/bin/env node
'use strict';

const {
  assertCanonicalOutboundCallsAllowed,
  authorizeMachineSelfTestCorrectionEverywhere,
  authorizeOutboundTestEverywhere,
  consumeOutboundTestAuthorizationEverywhere,
  machineSelfTestCorrectionAuthorizationMetadata,
  pauseOutboundCallsEverywhere,
  settleInternalVoiceSelfTestEverywhere,
  readOutboundCallControl,
  resumeOutboundCallsAfterTestApprovalEverywhere,
  resumeOutboundCallsEverywhere,
} = require('./lib/outbound-call-control.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const command = args._[0] || 'status';
  if (command === 'reconcile-internal-test') {
    const callIds = typeof args.callIds === 'string' ? args.callIds.split(',').map(id => id.trim()) : undefined;
    const result = await (deps.settleInternalVoiceSelfTestEverywhere || settleInternalVoiceSelfTestEverywhere)({ invocationKey: args.invocationKey || '',
      callIds, reconcile: !callIds, dialerStopped: args.dialerStopped === true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!['passed', 'failed', 'not-dialed'].includes(result.outcome?.status)) process.exitCode = 2;
    return result;
  }
  if (command === 'authorize-test') {
    const result = await authorizeOutboundTestEverywhere({
      phoneNumber: args.phoneNumber || '',
      invocationKey: args.invocationKey || '',
      ownerAuthorized: true,
      ownerRequestText: args.ownerRequestText || '',
      ttlMs: args.ttlMs,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'authorize-machine-self-test-correction') {
    const result = await authorizeMachineSelfTestCorrectionEverywhere({
      invocationKey: args.invocationKey || '',
      sourceCallId: args.sourceCallId || '',
      pairedCallId: args.pairedCallId || '',
      correlationId: args.correlationId || '',
      ownerAuthorized: true,
      machineInternalAuthorization: machineSelfTestCorrectionAuthorizationMetadata(),
      ttlMs: args.ttlMs,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'consume-test') {
    const result = await consumeOutboundTestAuthorizationEverywhere({
      phoneNumber: args.phoneNumber || '',
      invocationKey: args.invocationKey || '',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'resume-after-test') {
    const result = await resumeOutboundCallsAfterTestApprovalEverywhere({
      ownerAuthorized: true,
      ownerApprovalText: args.ownerApprovalText || '',
      reason: args.reason || 'Owner approved the completed principal dialing test.',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'pause') {
    const result = await (deps.pauseOutboundCallsEverywhere || pauseOutboundCallsEverywhere)({
      reason: args.reason || 'Owner explicitly paused outbound calls.',
      source: args.source || 'owner-message',
      scope: args.scope,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
    return result;
  }
  if (command === 'resume') {
    const result = await resumeOutboundCallsEverywhere({
      reason: args.reason || 'Owner explicitly resumed outbound calls.',
      ownerAuthorized: true,
      ownerRequestText: args.ownerRequestText || '',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const local = readOutboundCallControl();
  try {
    const canonical = await assertCanonicalOutboundCallsAllowed();
    const result = { ok: true, local, canonical };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    const result = { ok: false, local, error: String(error.message || error) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 2;
    return result;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
