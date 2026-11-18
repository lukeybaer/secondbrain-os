#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const { normalizeIso, repoRoot } = require('./lib/graphiti-event-log');
const { providerOrder } = require('./lib/graphiti-source-policy');

function loadDotEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function commandProbe(name, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(name, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 8000,
    windowsHide: true,
    shell: process.platform === 'win32',
    env: { ...process.env, ...(opts.env || {}) },
  });
  const ms = Date.now() - started;
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  if (r.error) {
    return { status: 'red', latency_ms: ms, detail: r.error.message };
  }
  if (r.status !== 0) {
    return { status: 'red', latency_ms: ms, detail: text.slice(0, 300) || `exit ${r.status}` };
  }
  if (/not\s+(authenticated|logged in)|login required/i.test(text)) {
    return { status: 'red', latency_ms: ms, detail: 'installed but not authenticated' };
  }
  return { status: 'green', latency_ms: ms, detail: text.split(/\r?\n/)[0].slice(0, 180) || 'ok' };
}

function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, json: JSON.parse(body || '{}') });
        } catch {
          resolve({ ok: false, statusCode: res.statusCode, json: null, body });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

async function runProviderHealth(opts = {}) {
  const root = opts.root || repoRoot();
  loadDotEnv(root);
  const startedAt = normalizeIso(new Date());
  const codex = commandProbe(process.env.CODEX_CMD || 'codex', ['--version']);
  const proxyStarted = Date.now();
  const proxyRaw = await httpGetJson(`http://127.0.0.1:${process.env.CLAUDE_PROXY_PORT || 3456}/health`);
  const proxy = proxyRaw.ok
    ? { status: 'green', latency_ms: Date.now() - proxyStarted, detail: 'Claude Max proxy up' }
    : { status: 'red', latency_ms: Date.now() - proxyStarted, detail: proxyRaw.error || `HTTP ${proxyRaw.statusCode || '?'}` };
  const claude = commandProbe(process.env.CLAUDE_CMD || 'claude', ['--version']);
  const providers = {
    codex,
    'claude-proxy': proxy,
    'claude-cli': claude,
  };
  const active = providerOrder().find((p) => providers[p] && providers[p].status === 'green') || null;
  const status = active === 'codex' ? 'green' : active ? 'yellow' : 'red';
  const summary = {
    schema: 'graphiti.provider_health.v1',
    ts: startedAt,
    status,
    active_provider: active,
    required_order: providerOrder(),
    providers,
    detail: active
      ? `active provider ${active}; order ${providerOrder().join(' -> ')}`
      : 'no subscription provider answered; paid model API access is disabled by owner policy',
  };
  const out = path.join(root, 'data', 'agent', 'graphiti-provider-health.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(summary) + '\n');
  fs.writeFileSync(path.join(root, 'data', 'agent', 'graphiti-provider-health-latest.json'), JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  runProviderHealth()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.status === 'red' ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    });
}

module.exports = { runProviderHealth };
