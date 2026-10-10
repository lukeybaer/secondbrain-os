'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { withStagedCookieJar } = require('./yt-dlp-cookie-jar.js');

const MAX_SOURCE_EGRESS_USD = 5;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('VIRAL_SOURCE_PROXY_AUTO_RECHARGE must be true or false');
}

function normalizeSourceAuthMode(value, hasProxyUrl = false) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return hasProxyUrl ? 'residential-proxy' : 'legacy-cookie';
  if (normalized === 'residential-proxy' || normalized === 'legacy-cookie') return normalized;
  throw new Error('VIRAL_SOURCE_AUTH_MODE must be residential-proxy or legacy-cookie');
}

function proxySecretValues(config) {
  if (!config || config.mode !== 'residential-proxy') return [];
  const values = [config.proxyUrl];
  try {
    const parsed = new URL(config.proxyUrl);
    for (const value of [parsed.username, parsed.password]) {
      if (!value) continue;
      values.push(value);
      try {
        values.push(decodeURIComponent(value));
      } catch {
        // Keep the encoded value when a provider supplies unusual credentials.
      }
    }
  } catch {
    // Validation normally prevents this. Redacting the full raw URL still helps.
  }
  return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function redactSensitiveText(value, configOrValues = []) {
  let text = String(value ?? '');
  const values = Array.isArray(configOrValues) ? configOrValues : proxySecretValues(configOrValues);
  for (const secret of [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]');
  }
  return text
    // Only supported proxy protocols need generic credential redaction. An
    // unbounded arbitrary-scheme prefix rescans long non-URL log lines and can
    // turn megabytes of verbose stderr into quadratic work.
    .replace(/((?:https?|socks5h?):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\b(proxy(?:_url)?|username|password)\s*[=:]\s*["']?[^\s;,"']+/gi, '$1=[redacted]');
}

function resolveViralSourceAuth(env = process.env) {
  const rawProxyUrl = String(env.VIRAL_SOURCE_PROXY_URL || '').trim();
  const mode = normalizeSourceAuthMode(env.VIRAL_SOURCE_AUTH_MODE, Boolean(rawProxyUrl));
  if (mode === 'legacy-cookie') {
    return Object.freeze({
      mode,
      provider: 'owner-cookie-jar',
      maxSourceEgressUsd: MAX_SOURCE_EGRESS_USD,
    });
  }

  if (!rawProxyUrl) {
    throw new Error('VIRAL_SOURCE_PROXY_URL is required for residential-proxy mode');
  }
  if (/\s/.test(rawProxyUrl)) {
    throw new Error('VIRAL_SOURCE_PROXY_URL must not contain whitespace');
  }
  let parsed;
  try {
    parsed = new URL(rawProxyUrl);
  } catch {
    throw new Error('VIRAL_SOURCE_PROXY_URL is not a valid proxy URL');
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('VIRAL_SOURCE_PROXY_URL must use http, https, socks5, or socks5h');
  }
  if (!parsed.hostname) throw new Error('VIRAL_SOURCE_PROXY_URL must include a hostname');

  const prepaidUsd = Number(env.VIRAL_SOURCE_PROXY_PREPAID_USD || MAX_SOURCE_EGRESS_USD);
  if (!Number.isFinite(prepaidUsd) || prepaidUsd <= 0) {
    throw new Error('VIRAL_SOURCE_PROXY_PREPAID_USD must be a positive number');
  }
  if (prepaidUsd > MAX_SOURCE_EGRESS_USD) {
    throw new Error(
      `residential source egress refuses a prepaid balance above $${MAX_SOURCE_EGRESS_USD}`,
    );
  }
  const autoRecharge = parseBoolean(env.VIRAL_SOURCE_PROXY_AUTO_RECHARGE, false);
  if (autoRecharge) {
    throw new Error('residential source egress refuses to run while auto-recharge is enabled');
  }

  return Object.freeze({
    mode,
    provider: String(env.VIRAL_SOURCE_PROXY_PROVIDER || 'dataimpulse').trim() || 'dataimpulse',
    proxyUrl: rawProxyUrl,
    prepaidUsd,
    autoRecharge: false,
    maxSourceEgressUsd: MAX_SOURCE_EGRESS_USD,
  });
}

function safeSourceAuthSummary(config) {
  if (config.mode === 'residential-proxy') {
    let gatewayHost = '';
    try {
      gatewayHost = new URL(config.proxyUrl).hostname;
    } catch {
      // The resolver already validates this. Keep receipts secret-free if reused alone.
    }
    return {
      mode: config.mode,
      provider: config.provider,
      gatewayHost,
      prepaidUsd: config.prepaidUsd,
      autoRecharge: false,
      maxSourceEgressUsd: config.maxSourceEgressUsd,
      ownerYouTubeCredentialAttached: false,
    };
  }
  return {
    mode: config.mode,
    provider: config.provider,
    maxSourceEgressUsd: config.maxSourceEgressUsd,
    ownerYouTubeCredentialAttached: true,
  };
}

function waitForPath(filePath, timeoutMs = 5000) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    Atomics.wait(sleeper, 0, 0, 25);
  }
  return fs.existsSync(filePath);
}

function startAuthenticatedProxyRelay(proxyUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-source-relay-'));
  fs.chmodSync(dir, 0o700);
  const readyFile = path.join(dir, 'ready');
  const errorFile = path.join(dir, 'error');
  const credentialFile = path.join(dir, 'upstream');
  const relayScript = path.join(__dirname, 'authenticated-proxy-relay.js');
  const port = 46000 + Math.floor(Math.random() * 15000);
  fs.writeFileSync(credentialFile, proxyUrl, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      relayScript,
      '--listen-port',
      String(port),
      '--ready-file',
      readyFile,
      '--error-file',
      errorFile,
      '--credential-file',
      credentialFile,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => {
    // The synchronous readiness check below owns the actionable error face.
  });
  if (!waitForPath(readyFile)) {
    child.kill('SIGTERM');
    const detail = fs.existsSync(errorFile)
      ? fs.readFileSync(errorFile, 'utf8').trim()
      : 'readiness timeout';
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`authenticated proxy relay failed: ${detail}`);
  }
  const localProxyUrl = fs.readFileSync(readyFile, 'utf8').trim();
  fs.rmSync(credentialFile, { force: true });
  return {
    localProxyUrl,
    stop() {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withPrivateProxyConfig(config, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-source-proxy-'));
  const configPath = path.join(dir, 'yt-dlp.conf');
  let relay;
  let deferred = false;
  const cleanup = () => {
    if (relay) relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // ffmpeg does not consistently honor an authenticated proxy from the
    // inherited environment. Keep the paid credential in a loopback relay and
    // give every downloader the same credential-free localhost endpoint.
    relay = startAuthenticatedProxyRelay(config.proxyUrl);
    fs.writeFileSync(configPath, `--proxy ${relay.localProxyUrl}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Windows ACL semantics differ; EC2 enforces the POSIX mode.
    }
    const result = fn({
      networkArgs: ['--config-locations', configPath],
      externalDownloaderArgs: [
        '--downloader-args',
        `ffmpeg_i:-http_proxy ${relay.localProxyUrl}`,
      ],
      // The environment covers any other child downloader; the explicit
      // ffmpeg input option above is the load-bearing timed-download handoff.
      networkEnv: {
        http_proxy: relay.localProxyUrl,
        https_proxy: relay.localProxyUrl,
        HTTP_PROXY: relay.localProxyUrl,
        HTTPS_PROXY: relay.localProxyUrl,
        ALL_PROXY: relay.localProxyUrl,
        no_proxy: '127.0.0.1,localhost',
        NO_PROXY: '127.0.0.1,localhost',
      },
      redactValues: proxySecretValues(config),
    });
    // An async caller keeps the relay until its child exits.
    if (result && typeof result.then === 'function') {
      deferred = true;
      return Promise.resolve(result).finally(cleanup);
    }
    return result;
  } finally {
    if (!deferred) cleanup();
  }
}

function withYtDlpSourceAuth(config, cookiesMasterPath, fn) {
  if (config.mode === 'residential-proxy') return withPrivateProxyConfig(config, fn);
  return withStagedCookieJar(cookiesMasterPath, (cookiesPath) =>
    fn({
      networkArgs: ['--cookies', cookiesPath],
      externalDownloaderArgs: [],
      networkEnv: {},
      redactValues: [],
    }),
  );
}

module.exports = {
  MAX_SOURCE_EGRESS_USD,
  normalizeSourceAuthMode,
  proxySecretValues,
  redactSensitiveText,
  resolveViralSourceAuth,
  safeSourceAuthSummary,
  startAuthenticatedProxyRelay,
  withYtDlpSourceAuth,
};
