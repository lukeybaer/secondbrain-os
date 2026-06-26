// provider-canary.js (P4, 2026-06-11 ladder plan)
//
// Daily proof that the LLM fallback ladder is alive: one tiny probe per
// provider rung, results appended to data/agent/amy-provider-health.jsonl,
// classified for the 2:45am diagnostic (probeProviderCanaries). The drill's
// everyday sibling: instead of waiting for an outage to discover a dead rung,
// every morning shows which rungs answered.
//
// Cheap by construction: claude probe is `claude -p ping` (subscription),
// codex probe is a tiny `codex exec` (subscription), the OpenAI key probe is a
// 1-token completion (fractions of a cent). Runs once daily via Task Scheduler.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { isCliFailureOutput, buildClaudeCliEnv } = require('./cli-output-guard.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const LEDGER = path.join(REPO, 'data', 'agent', 'amy-provider-health.jsonl');

// Pure classifier. results: { claude: bool, codex: bool, openaiKey: bool }
function classifyProviderHealth(results) {
  const subs = [results.claude && 'claude', results.codex && 'codex'].filter(Boolean);
  const floors = [results.openaiKey && 'openai-key'].filter(Boolean);
  if (subs.length === 0 && floors.length === 0) {
    return { status: 'red', detail: 'NO provider rung answered: Amy has no brain anywhere' };
  }
  if (subs.length === 0) {
    return {
      status: 'yellow',
      detail:
        'only the paid floor answered (' +
        floors.join(', ') +
        ') -- both subscriptions down, cost exposure until one recovers',
    };
  }
  const down = ['claude', 'codex'].filter((s) => !results[s]);
  return {
    status: 'green',
    detail:
      subs.join('+') +
      ' subscription rung(s) alive' +
      (down.length ? ' (' + down.join(', ') + ' DOWN, ladder carrying)' : '') +
      (results.openaiKey ? ', floor key valid' : ', floor key NOT validated'),
  };
}

function probeClaude(timeoutMs = 60000) {
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
      ? spawnSync(process.execPath, [cliJs, '-p', 'Reply with exactly: pong'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          env: buildClaudeCliEnv(),
        })
      : spawnSync('claude', ['-p', 'Reply with exactly: pong'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          env: buildClaudeCliEnv(),
        });
    const out = (r.stdout || '').trim();
    return !r.error && r.status === 0 && !!out && !isCliFailureOutput(out);
  } catch {
    return false;
  }
}

function probeCodex(timeoutMs = 60000) {
  const outFile = path.join(os.tmpdir(), 'canary-codex-' + Date.now() + '.txt');
  try {
    // Prompt rides STDIN, not argv: shell:true on Windows splits multiword
    // argv on spaces (codex saw 'with' as a flag). Flags are space-free.
    const r = spawnSync(
      'codex',
      ['exec', '--skip-git-repo-check', '-s', 'read-only', '--output-last-message', outFile],
      {
        input: 'Reply with exactly: pong',
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, CLAUDECODE: '' },
        shell: process.platform === 'win32',
      },
    );
    let out = '';
    try {
      out = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      out = (r.stdout || '').trim();
    }
    return !r.error && r.status === 0 && !!out && !isCliFailureOutput(out);
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* gone */
    }
  }
}

function probeOpenAiKey(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const key = process.env.OPENAI_API_KEY || '';
    if (!key || key.length < 20) return resolve(false);
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'pong' }],
      max_tokens: 1,
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function runCanaries() {
  const started = Date.now();
  const results = {
    claude: probeClaude(),
    codex: probeCodex(),
    openaiKey: await probeOpenAiKey(),
  };
  const verdict = classifyProviderHealth(results);
  const row = {
    ts: new Date().toISOString(),
    ...results,
    status: verdict.status,
    detail: verdict.detail,
    tookMs: Date.now() - started,
  };
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n');
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

module.exports = { classifyProviderHealth, runCanaries, latestCanaryStatus, LEDGER };
