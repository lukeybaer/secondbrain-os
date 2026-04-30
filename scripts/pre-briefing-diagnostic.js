#!/usr/bin/env node
// pre-briefing-diagnostic.js
//
// Runs at 2:45 AM CT, BEFORE health-self-heal.js (3:00 AM).
// Produces a structured diagnostic JSON that health-self-heal reads via
// --from-diagnostic to focus its heal efforts.
//
// Output: data/agent/pre-briefing-diagnostic-YYYY-MM-DD.json
//
// This script is read-only -- it never modifies state, only probes.

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const OUTPUT_DIR = path.join(REPO, 'data', 'agent');

const {
  probeBackups,
  probeS3Parity,
  probeEc2,
  probeLlm,
  probeSchedDispatch,
  probeNightlyEnhancements,
  probeVideoPipeline,
  probeVideoFeedbackLoop,
  probeStaleUploads,
  probeApiAudit,
} = require('./health-self-heal');

function main() {
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  console.log(`[${ts}] pre-briefing diagnostic`);

  const checks = {};

  // Run all probes
  const probes = [
    ['backups', probeBackups],
    ['s3Parity', probeS3Parity],
    ['ec2', probeEc2],
    ['llm', probeLlm],
    ['schedDispatch', probeSchedDispatch],
    ['nightlyEnhancements', probeNightlyEnhancements],
    ['videoPipeline', probeVideoPipeline],
    ['videoFeedbackLoop', probeVideoFeedbackLoop],
    ['staleUploads', probeStaleUploads],
    ['apiAudit', probeApiAudit],
  ];

  for (const [name, probeFn] of probes) {
    try {
      checks[name] = probeFn();
    } catch (e) {
      checks[name] = { status: 'red', detail: `probe threw: ${e.message.slice(0, 80)}` };
    }
    console.log(`  ${name}: ${checks[name].status} -- ${checks[name].detail}`);
  }

  // Classify and build heal plan
  const healPlan = [];
  const summary = { red: 0, yellow: 0, green: 0 };

  for (const [name, result] of Object.entries(checks)) {
    summary[result.status] = (summary[result.status] || 0) + 1;

    if (result.status === 'red' || result.status === 'yellow') {
      const canAutoHeal = canHeal(name, result);
      const strategy = getHealStrategy(name, result);
      const estMinutes = estimateHealTime(name);

      checks[name].canAutoHeal = canAutoHeal;
      checks[name].healStrategy = strategy;

      if (canAutoHeal) {
        healPlan.push({ probe: name, action: strategy, estMinutes });
      }
    }
  }

  // Sort heal plan by estimated time (quick fixes first)
  healPlan.sort((a, b) => a.estMinutes - b.estMinutes);

  const diagnostic = {
    generated_at: ts,
    date: today,
    checks,
    summary,
    healPlan,
  };

  // Write output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `pre-briefing-diagnostic-${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(diagnostic, null, 2) + '\n');

  console.log(`\nsummary: ${summary.red} red, ${summary.yellow} yellow, ${summary.green} green`);
  console.log(`heal plan: ${healPlan.length} item(s)`);
  for (const h of healPlan) {
    console.log(`  ${h.probe}: ${h.action} (~${h.estMinutes}min)`);
  }
  console.log(`\nwritten to ${outPath}`);

  // Stale-RED escalation: any probe RED for 3+ consecutive days gets a
  // separate, louder Gmail escalation beyond the daily briefing line.
  // See feedback_canautoheal_false_is_not_a_heal.md for why.
  try {
    const { computeStaleRedProbes, hasExistingEscalation, logEscalation, draftGmailEscalation } =
      require('./stale-red-escalation.js');
    const REPO = path.resolve(__dirname, '..');
    const ESC_LOG = path.join(OUTPUT_DIR, 'escalations.jsonl');
    const result = computeStaleRedProbes(OUTPUT_DIR);
    if (!result.error && result.stale && result.stale.length > 0) {
      console.log(`\nstale-red escalation: ${result.stale.length} probe(s) RED 3+ days`);
      for (const s of result.stale) {
        if (hasExistingEscalation(ESC_LOG, s.probe)) {
          console.log(`  [skip] ${s.probe} -- already escalated in last 24h`);
          continue;
        }
        const drafted = draftGmailEscalation(s, { dryRun: false, repo: REPO });
        logEscalation(ESC_LOG, { ts: new Date().toISOString(), ...s, drafted });
        console.log(`  [escalate] ${s.probe} ${s.streakDays}d red -- drafted=${JSON.stringify(drafted)}`);
      }
    }
  } catch (e) {
    console.error('stale-red escalation failed:', (e && e.message) || e);
  }
}

function canHeal(probeName, result) {
  // These probes have automated healers
  const healable = {
    backups: true,        // re-run backup-cli
    s3Parity: true,       // sync orphaned
    // ec2: false,        // requires SSH/PM2, handled remotely
    // llm: false,        // requires local proxy restart
    // schedDispatch: false, // requires Claude Code app restart
    // nightlyEnhancements: partially (can trigger catch-up run)
    // videoPipeline: false, // informational
    // videoFeedbackLoop: false, // cannot auto-regen
    staleUploads: true, // 2026-04-20: now auto-heals by SCP + POST to /youtube/queue
    // apiAudit: false,    // informational
  };
  return healable[probeName] === true;
}

function getHealStrategy(probeName, result) {
  const strategies = {
    backups: 're-run backup-cli.ts',
    s3Parity: 'run --sync-orphaned to upload missing snapshots',
    ec2: 'check PM2 process on EC2 (manual)',
    llm: 'restart start-claude-proxy.vbs (manual)',
    schedDispatch: 'restart Claude Code app (manual)',
    nightlyEnhancements: 'trigger catch-up nightly run',
    videoPipeline: 'investigate video build pipeline',
    videoFeedbackLoop: 'send alert -- videos need manual regen review',
    staleUploads: 'SCP local file + POST to /youtube/queue on EC2',
    apiAudit: 'review flagged files for paid API usage',
  };
  return strategies[probeName] || 'unknown';
}

function estimateHealTime(probeName) {
  const estimates = {
    backups: 5,
    s3Parity: 30,
    ec2: 0,           // manual
    llm: 0,           // manual
    schedDispatch: 0, // manual
    nightlyEnhancements: 15,
    videoPipeline: 0,
    videoFeedbackLoop: 0,
    staleUploads: 10, // SCP + HTTP POST per stale item
    apiAudit: 0,
  };
  return estimates[probeName] || 0;
}

if (require.main === module) {
  main();
}

module.exports = { main };
