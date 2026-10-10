#!/usr/bin/env node
// scripts/brain-switch.js
//
// Operator control for the one durable default-brain switch
// (scripts/lib/brain-switch.js). Which subscription brain leads every Amy
// lane, Claude or Codex, and what runtime health has done to that choice.
//
//   node scripts/brain-switch.js status [--json]
//   node scripts/brain-switch.js set claude|codex [--by "<who asked>"] [--publish-ec2]
//   node scripts/brain-switch.js clear [--publish-ec2]     # drop demotions, keep preferred
//
// `set` and `clear` change the local host's state file. `--publish-ec2`
// replays the same owner command on the EC2 backend over SSH (through the
// remote checkout's own module and lock), so both hosts agree on the owner's
// preference while each keeps its own runtime health. The source default
// (claude) needs no state file at all; a deploy carries it.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const brainSwitch = require('./lib/brain-switch.js');

const REMOTE_HOST = process.env.BRAIN_SWITCH_HOST || 'ec2-user@ExampleCo';
const SSH_KEY =
  process.env.BRAIN_SWITCH_SSH_KEY ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'sb-key.pem');

function parseArgs(argv) {
  const out = { command: null, brain: null, by: null, json: false, publishEc2: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--publish-ec2') out.publishEc2 = true;
    else if (arg === '--by') out.by = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else if (!out.command) out.command = arg;
    else if (!out.brain) out.brain = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'usage:',
    '  node scripts/brain-switch.js status [--json]',
    '  node scripts/brain-switch.js set claude|codex [--by "<who>"] [--publish-ec2]',
    '  node scripts/brain-switch.js clear [--publish-ec2]',
  ].join('\n');
}

// Mirror ONLY the owner's command to EC2, executed there by the remote
// checkout's own brain-switch module so it takes the remote directory lock
// and keeps EC2's per-host demotions and history (Codex review 2026-09-03).
// Never copies the desktop state file over the remote one.
const REMOTE_ROOT = process.env.BRAIN_SWITCH_REMOTE_ROOT || '/opt/secondbrain';

function remoteCommand(command, brain, by) {
  const safe = (v) => String(v || '').replace(/[^A-Za-z0-9 _.:@/-]/g, '');
  const call =
    command === 'set'
      ? `sw.setPreferredBrain(${JSON.stringify(safe(brain))}, { by: ${JSON.stringify(safe(by))} })`
      : `sw.clearDemotions({ by: ${JSON.stringify(safe(by))} })`;
  const script = `const sw=require('./scripts/lib/brain-switch.js');const r=${call};console.log(JSON.stringify({ result: r, status: sw.statusReport() }));`;
  return `cd ${REMOTE_ROOT} && node -e ${JSON.stringify(script)}`;
}

function publishRemote({ command, brain, by }, run = spawnSync) {
  const res = run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY, REMOTE_HOST, remoteCommand(command, brain, by)],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.error || res.status !== 0) {
    throw new Error(
      `publish to ${REMOTE_HOST} failed: ${(res.error && res.error.message) || res.stderr || res.status}`,
    );
  }
  let remote = null;
  try {
    remote = JSON.parse(String(res.stdout || '').trim().split('\n').pop());
  } catch {
    throw new Error(`publish to ${REMOTE_HOST} returned no status: ${String(res.stdout || '').slice(0, 200)}`);
  }
  return { host: REMOTE_HOST, root: REMOTE_ROOT, command, brain: brain || null, remote };
}

function formatStatus(report) {
  const lines = [
    `preferred: ${report.preferred} (set by ${report.preferredSetBy}${report.preferredSetAt ? ' at ' + report.preferredSetAt : ''})`,
    `leading:   ${report.leading}${report.flipped ? '  <- FLIPPED, ' + report.reason : ''}`,
    `order:     ${report.order.join(' -> ')}`,
    `file:      ${report.file}`,
  ];
  const demoted = Object.entries(report.demoted);
  if (demoted.length) {
    for (const [brain, d] of demoted) {
      lines.push(
        `demoted:   ${brain} (${d.kind}) until ${d.until}${d.sample ? ' :: ' + d.sample.slice(0, 120) : ''}`,
      );
    }
  } else {
    lines.push('demoted:   none');
  }
  if (report.history.length) {
    lines.push('recent:');
    for (const h of report.history) {
      lines.push(
        `  ${h.ts} ${h.event} ${h.brain || ''}${h.kind ? ' ' + h.kind : ''}${h.flipped ? ' FLIP->' + h.leading : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const opts = { by: args.by };
  let result;
  if (!args.command || args.command === 'status') {
    result = brainSwitch.statusReport(opts);
    return args.json ? JSON.stringify(result, null, 2) : formatStatus(result);
  }
  if (args.command === 'set') {
    if (!args.brain) throw new Error('set needs a brain: claude or codex');
    result = brainSwitch.setPreferredBrain(args.brain, { by: args.by || 'operator' });
  } else if (args.command === 'clear') {
    result = brainSwitch.clearDemotions({ by: args.by || 'operator' });
  } else {
    throw new Error(`unknown command ${args.command}`);
  }
  if (args.publishEc2) {
    const publish = deps.publish || publishRemote;
    let receipt;
    try {
      result.published = publish({ command: args.command, brain: args.brain, by: args.by || 'operator' });
      receipt = brainSwitch.recordPublication({
        ok: true,
        host: result.published.host,
        command: args.command,
        brain: args.brain || null,
        remoteLeading: result.published.remote && result.published.remote.status
          ? result.published.remote.status.leading
          : null,
      });
    } catch (err) {
      receipt = brainSwitch.recordPublication({
        ok: false,
        command: args.command,
        brain: args.brain || null,
        error: String(err && err.message).slice(0, 200),
      });
      if (receipt && !receipt.ok) {
        process.stderr.write(`WARNING: publication receipt not written (${receipt.error}): ${receipt.file}\n`);
      }
      throw err;
    }
    // The remote mutation happened; a missing local receipt is a real
    // defect, so say so and exit nonzero instead of pretending it was recorded.
    if (receipt && !receipt.ok) {
      result.receiptError = receipt.error;
      process.stderr.write(`WARNING: publication receipt not written (${receipt.error}): ${receipt.file}\n`);
      process.exitCode = 2;
    }
  }
  const report = brainSwitch.statusReport();
  return args.json
    ? JSON.stringify({ ...result, status: report }, null, 2)
    : formatStatus(report) +
        (result.published
          ? `\npublished ${args.command}${args.brain ? ' ' + args.brain : ''} to ${result.published.host} (remote leading: ${
              result.published.remote && result.published.remote.status
                ? result.published.remote.status.leading
                : 'unknown'
            })`
          : '');
}

if (require.main === module) {
  try {
    process.stdout.write(main() + '\n');
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, publishRemote, remoteCommand, formatStatus };
