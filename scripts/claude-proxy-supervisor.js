#!/usr/bin/env node
// claude-proxy-supervisor.js
//
// Supervises claude-proxy.js: spawns it, logs to a rotating file, and respawns
// on exit with a 5-second backoff. Without this, the proxy dies silently (the
// cmd window closes, the SSH reverse tunnel on EC2 keeps running but reports
// `maxPlanProxy: disconnected`) and every EC2 LLM call falls back to paid
// OpenAI — exactly the 2026-04-11 afternoon regression Luke caught.
//
// Started by start-claude-proxy.vbs in Windows Startup. If killed the watcher
// stops cleanly, but the proxy only stops when the supervisor is killed.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROXY_PATH = path.join(__dirname, '..', 'claude-proxy.js');
const LOG_PATH = path.join(
  process.env.APPDATA || '',
  'secondbrain',
  'data',
  'claude-proxy-supervisor.log',
);
const RESTART_DELAY_MS = 5000;

function ensureLogDir() {
  const dir = path.dirname(LOG_PATH);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(msg) {
  ensureLogDir();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* best effort */
  }
  process.stdout.write(line);
}

function startProxy() {
  log(`spawning ${PROXY_PATH}`);
  const child = spawn(process.execPath, [PROXY_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdout.on('data', (d) => {
    try {
      fs.appendFileSync(LOG_PATH, `[proxy] ${d}`);
    } catch {
      /* ignore */
    }
  });
  child.stderr.on('data', (d) => {
    try {
      fs.appendFileSync(LOG_PATH, `[proxy-err] ${d}`);
    } catch {
      /* ignore */
    }
  });

  child.on('exit', (code, signal) => {
    log(`proxy exited code=${code} signal=${signal || 'none'} — restart in ${RESTART_DELAY_MS}ms`);
    setTimeout(startProxy, RESTART_DELAY_MS);
  });

  child.on('error', (err) => {
    log(`proxy spawn error: ${err.message}`);
  });
}

log('supervisor starting');
startProxy();

// Keep the process alive even if nothing else holds it open
setInterval(() => {
  /* heartbeat */
}, 60000);
