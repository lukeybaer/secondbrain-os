// provider-canary.js (P4, 2026-06-11 ladder plan)
//
// Daily proof that the subscription ladder is alive: one tiny probe per
// subscription rung, results appended to data/agent/amy-provider-health.jsonl,
// classified for the 2:45am diagnostic (probeProviderCanaries). The drill's
// everyday sibling: instead of waiting for an outage to discover a dead rung,
// every morning shows which rungs answered.
//
// Both probes use ExampleCo's existing subscriptions. Paid model API canaries were
// revoked by owner policy on 2026-08-05 because even a one-token check is paid
// token access. Runs once daily through the existing cloud night owner after
// verified desktop cutover; circuit skips remain distinct from actual probes.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// A nonce echo proves the subscription answers; it needs the cheapest model
// under the Claude automation ceiling, never the account default.
const CANARY_CLAUDE_PINS = Object.freeze(['--model', 'claude-haiku-4-5-20251001', '--effort', 'low']);
const {
  isCliFailureOutput,
  buildClaudeCliEnv,
  buildCodexCliEnv,
} = require('./cli-output-guard.js');
const {
  admitBriefingModelLaunch,
  settleBriefingModelLaunch,
} = require('./briefing-night-circuit.js');
const { decideSpawnModel, codexExecPins } = require('./model-router.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const LEDGER = path.join(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'), 'agent', 'amy-provider-health.jsonl');

// Pure classifier. results: { claude: bool, codex: bool }
function classifyProviderHealth(results) {
  const subs = [results.claude && 'claude', results.codex && 'codex'].filter(Boolean);
  if (subs.length === 0) {
    return {
      status: 'red',
      detail: 'NO subscription rung answered; paid model API access is disabled by owner policy',
    };
  }
  const down = ['claude', 'codex'].filter((s) => !results[s]);
  return {
    status: 'green',
    detail:
      subs.join('+') +
      ' subscription rung(s) alive' +
      (down.length ? ' (' + down.join(', ') + ' DOWN, ladder carrying)' : '') +
      ', paid model API access disabled',
  };
}

function probeResult(result, output, nonce) {
  const answered = !result.error && result.status === 0 && output === nonce && !isCliFailureOutput(output);
  const text = `${output}\n${result.stderr || ''}`;
  return { attempted: !['ENOENT', 'EACCES'].includes(result.error?.code), answered,
    exit_code: result.status, outcome: answered ? 'nonce-answered' : /quota|rate.?limit|usage.?limit|weekly.?limit|429/i.test(text) ? 'provider-quota-rejected' : result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.error ? 'launch-error' : 'provider-response-rejected' };
}
function probeClaude(timeoutMs = 60000, nonce = 'pong') {
  // No shell: on Windows shell:true splits multiword argv on spaces. Spawn the
  // CLI via node directly (same pattern as run-scheduled-skill.js).
  try {
    const cliJs = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js',
    );
    const useNode = process.platform === 'win32' && fs.existsSync(cliJs);
    const r = useNode
      ? spawnSync(process.execPath, [cliJs, '-p', ...CANARY_CLAUDE_PINS, `Reply with exactly: ${nonce}`], {
          encoding: 'utf8',
          timeout: timeoutMs,
          env: buildClaudeCliEnv(),
        })
      : spawnSync('claude', ['-p', ...CANARY_CLAUDE_PINS, `Reply with exactly: ${nonce}`], {
          encoding: 'utf8',
          timeout: timeoutMs,
          env: buildClaudeCliEnv(),
        });
    const out = (r.stdout || '').trim();
    return probeResult(r, out, nonce);
  } catch {
    return { attempted: false, answered: false, outcome: 'launch-error' };
  }
}

function buildCodexCanaryArgs(outFile) {
  const decision = decideSpawnModel('provider-canary', 'codex', {
    taskType: 'observe',
    complexity: 'routine',
  });
  if (!decision) throw new Error('provider canary requires live model routing');
  return [
    'exec',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    ...codexExecPins(decision),
    '--output-last-message',
    outFile,
  ];
}

function probeCodex(timeoutMs = 60000, nonce = 'pong') {
  const outFile = path.join(os.tmpdir(), 'canary-codex-' + Date.now() + '.txt');
  try {
    // Prompt rides STDIN, not argv: shell:true on Windows splits multiword
    // argv on spaces (codex saw 'with' as a flag). Flags are space-free.
    const r = spawnSync(
      'codex',
      buildCodexCanaryArgs(outFile),
      {
        input: `Reply with exactly: ${nonce}`,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: buildCodexCliEnv(process.env),
        shell: process.platform === 'win32',
      },
    );
    let out = '';
    try {
      out = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      out = (r.stdout || '').trim();
    }
    return probeResult(r, out, nonce);
  } catch {
    return { attempted: false, answered: false, outcome: 'launch-error' };
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* gone */
    }
  }
}

async function runCanaries(opts = {}) {
  const started = Date.now();
  const dataDir =
    opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
  const ledger = path.join(dataDir, 'agent', 'amy-provider-health.jsonl');
  const circuitGate = opts.admitModelLaunch || admitBriefingModelLaunch;
  const circuitAdmission = circuitGate({
    date: opts.date || process.env.BRIEFING_DATE || '',
    dataDir,
    lane: 'provider-canary',
    priority: 'nonessential',
    estimatedTokens: 50_000,
    nowMs: opts.nowMs || started,
    env: opts.env || process.env,
  });
  if (!circuitAdmission.allowed) {
    const row = {
      ts: new Date(opts.nowMs || started).toISOString(),
      claude: null,
      codex: null,
      status: 'yellow',
      detail: `provider canary skipped by briefing night circuit: ${circuitAdmission.reason}`,
      briefingNightCircuit: circuitAdmission,
      tookMs: Date.now() - started,
    };
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify(row) + '\n');
    return row;
  }
  const nonce = `amy-canary-${require('node:crypto').randomBytes(12).toString('hex')}`;
  const probes = {
    claude: (opts.probeClaude || probeClaude)(60000, nonce),
    codex: (opts.probeCodex || probeCodex)(60000, nonce),
  };
  const attempts = Object.fromEntries(Object.entries(probes).map(([name, value]) => [name,
    typeof value === 'boolean' ? { attempted: true, nonce, answered: value } : { ...value, nonce }]));
  const results = Object.fromEntries(Object.entries(attempts).map(([name, value]) => [name, value.answered === true]));
  if (circuitAdmission.enforced && circuitAdmission.reservationId) {
    try {
      (opts.settleModelLaunch || settleBriefingModelLaunch)({
        date: circuitAdmission.date,
        dataDir,
        reservationId: circuitAdmission.reservationId,
        outcome: 'canaries-finished',
        nowMs: opts.nowMs || Date.now(),
      });
    } catch {
      /* the expiring reservation keeps later admissions conservative */
    }
  }
  const verdict = classifyProviderHealth(results);
  const row = {
    ts: new Date().toISOString(),
    ...results,
    status: verdict.status,
    detail: verdict.detail,
    tookMs: Date.now() - started,
    briefingNightCircuit: circuitAdmission,
    attempts,
  };
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, JSON.stringify(row) + '\n');
  return row;
}

// Latest-canary reader for the diagnostic probe. Stale/missing -> yellow.
function latestCanaryStatus(windowHours = 26, nowMs = Date.now()) {
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const t = Date.parse(row.ts);
      if (!Number.isFinite(t)) continue;
      if (nowMs - t > windowHours * 3600 * 1000) break;
      return { status: row.status, detail: row.detail + ' (canary ' + row.ts + ')' };
    }
  } catch {
    /* missing ledger */
  }
  return { status: 'yellow', detail: 'no provider canary in window (canary task silent?)' };
}

if (require.main === module) {
  runCanaries().then((row) => {
    console.log(JSON.stringify(row, null, 1));
    process.exit(0);
  });
}

module.exports = { classifyProviderHealth, runCanaries, latestCanaryStatus, probeResult, buildCodexCanaryArgs, LEDGER };
