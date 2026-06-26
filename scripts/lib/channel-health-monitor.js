// Channel health monitor for ec2-server.js.
//
// Runs every CHECK_INTERVAL_MS (5 min by default) inside the secondbrain-backend
// process. Probes each communication channel (telegram, claude max proxy,
// backend port, vapi, gmail, linkedin, pm2). On a green to red transition it alerts
// ExampleCo on Telegram, attempts an in-process auto-fix, reprobes, then alerts
// the outcome. Repeat red states do not re-alert for MIN_ALERT_INTERVAL_MS
// so a stuck channel does not spam.
//
// Daily health-self-heal.js still runs at 3:00 AM CT for the wider sweep
// (backups, video pipeline, news sections, etc.). This module focuses on
// real-time communication channels that need to recover in minutes, not
// hours. State is held in-memory and surfaced at /api/channel-health for
// the dashboard.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_ALERT_INTERVAL_MS = 60 * 60 * 1000;
// Laptop-hosted channels (Claude Max proxy, Gmail scan, LinkedIn crawl) run on
// ExampleCo's laptop, not EC2. EC2 cannot restart them; they recover on their own
// when his machine is on. They flap whenever the laptop sleeps or the network
// blips, so only explicitly approved laptop-hosted channels may send a
// Telegram. Gmail scan freshness belongs in the briefing/System Health
// surface, never in Telegram.
const LAPTOP_REALERT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;

function httpGetJson(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body, json: JSON.parse(body) }); }
        catch { finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body, json: null }); }
      });
    });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
  });
}

// Probe implementations. Each probe returns { status: 'green'|'red', detail,
// meta? }. Probes never throw, they convert failures into status=red so the
// orchestrator stays simple.

async function probeTelegram({ botToken, fetcher = httpGetJson } = {}) {
  if (!botToken) return { status: 'red', detail: 'TELEGRAM_BOT_TOKEN not set' };
  const r = await fetcher('https://api.telegram.org/bot' + botToken + '/getMe');
  if (r.ok && r.json && r.json.ok) {
    return { status: 'green', detail: 'bot @' + (r.json.result.username || '?') + ' reachable' };
  }
  return { status: 'red', detail: 'getMe failed: ' + (r.error || r.body || r.status || 'ExampleCo') };
}

async function probeProxy({ proxyPort = 3456, fetcher = httpGetJson } = {}) {
  const r = await fetcher('http://127.0.0.1:' + proxyPort + '/health');
  if (r.ok && r.json && r.json.status === 'ok') {
    return { status: 'green', detail: 'claude max proxy up, uptime ' + Math.round(r.json.uptime || 0) + 's' };
  }
  return { status: 'red', detail: 'proxy 127.0.0.1:' + proxyPort + ' not responding: ' + (r.error || r.status || 'ExampleCo') };
}

async function probeBackend({ backendPort = 3001, fetcher = httpGetJson } = {}) {
  const r = await fetcher('http://127.0.0.1:' + backendPort + '/health');
  if (r.ok && r.json && r.json.status === 'ok') {
    return { status: 'green', detail: 'backend :' + backendPort + ' /health ok, uptime ' + Math.round(r.json.uptime || 0) + 's' };
  }
  return { status: 'red', detail: 'backend :' + backendPort + ' not responding: ' + (r.error || r.status || 'ExampleCo') };
}

async function probeVapi({
  vapiKey,
  lastWebhookTsProvider = () => null,
  staleSec = 24 * 60 * 60,
  fetcher = httpGetJson,
} = {}) {
  // Two-step probe. First, check that vapi api is reachable (catches network
  // splits + key rotation). Second, check that we have seen ANY recent webhook
  // so we know the inbound side is also functional. The webhook check is
  // soft: zero webhooks in 24h is yellow-then-red because ExampleCo may simply
  // have not called anyone today.
  const apiReach = vapiKey
    ? await fetcher('https://api.vapi.ai/health').catch(() => ({ ok: false }))
    : { ok: false, error: 'VAPI_API_KEY not set' };
  if (!apiReach.ok) {
    return { status: 'red', detail: 'vapi api unreachable: ' + (apiReach.error || apiReach.status || 'ExampleCo') };
  }
  const lastTs = lastWebhookTsProvider();
  if (lastTs == null) {
    return { status: 'green', detail: 'vapi api reachable, no webhook history yet' };
  }
  const ageSec = Math.round((Date.now() - lastTs) / 1000);
  if (ageSec > staleSec) {
    return {
      status: 'red',
      detail: 'vapi api reachable but no webhook in ' + Math.round(ageSec / 3600) + 'h (threshold ' + Math.round(staleSec / 3600) + 'h)',
    };
  }
  return { status: 'green', detail: 'vapi api reachable, last webhook ' + ageSec + 's ago' };
}

// Claude Max OAuth access token health.
//
// The token file at /home/ec2-user/.claude-oauth-token is pushed by the Windows
// SecondBrain-ClaudeTokenRefresh task every hour. EC2's `claude -p` reads it
// per spawn. When the push pipeline stalls (Windows asleep, scheduled task
// fails, scp blocked) the file goes stale and Amy starts answering "I couldn't
// reach my brain" on Telegram -- which is exactly what just happened
// 2026-05-23.
//
// We can't decode the token for expiry (opaque). What we CAN test is freshness
// of the file vs the expected hourly cadence. Codex recommendation 2026-05-23.
//
// Thresholds (laptop-hosted):
//   <= 90 min: green (one hourly cycle + slack)
//   90 min < age <= 6h: yellow (degraded, surface but do not panic)
//   > 6h: red (token will fail soon if not already failing)
async function probeClaudeMaxToken({
  tokenPath = '/home/ec2-user/.claude-oauth-token',
  fsImpl = fs,
  now = () => Date.now(),
} = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(tokenPath);
  } catch {
    return {
      status: 'red',
      detail: 'token file missing at ' + tokenPath + '. Run claude-token-refresh on ExampleCo laptop.',
    };
  }
  const ageMin = Math.round((now() - stat.mtimeMs) / 60000);
  if (ageMin <= 90) {
    return { status: 'green', detail: 'pushed ' + ageMin + ' min ago (within hourly cadence)' };
  }
  if (ageMin <= 360) {
    return {
      status: 'yellow',
      detail: 'pushed ' + ageMin + ' min ago (>90 min, laptop or refresh task may be stalled)',
    };
  }
  return {
    status: 'red',
    detail: 'pushed ' + Math.round(ageMin / 60) + 'h ago. Refresh chain broken; Amy will go dark on Telegram next time the in-memory token expires.',
  };
}

async function probeGmail({
  heartbeatPath = '/opt/secondbrain/data/agent/gmail-scan-heartbeat.jsonl',
  staleMin = 30,
  fsImpl = fs,
  now = () => Date.now(),
  scannerScriptPath = '/opt/secondbrain/scripts/gmail-amy-scan.js',
  helperScriptPath = '/opt/secondbrain/scripts/fetch-recent-gmail.py',
  exec = (cmd) => execSync(cmd, { encoding: 'utf-8', timeout: 5000 }),
} = {}) {
  // Scanner deployment check: gmail-amy-scan.js is meant to run continuously
  // under PM2 and write a heartbeat. On hosts where the scanner has never been
  // deployed (no PM2 process AND no fetch-recent-gmail.py helper), surface as
  // a "skip" rather than firing a red alert every tick. The #inbox / #mail
  // hashtag workflow on ExampleCo's laptop covers Gmail scanning in that case.
  function gmailPm2Running() {
    try {
      const raw = exec('pm2 jlist');
      const list = JSON.parse(raw);
      return list.some((p) => p.name === 'gmail-amy-scan' && p.pm2_env && p.pm2_env.status === 'online');
    } catch { return false; }
  }
  if (!fsImpl.existsSync(heartbeatPath)) {
    const helperExists = fsImpl.existsSync(helperScriptPath);
    const pm2Running = gmailPm2Running();
    if (!helperExists && !pm2Running) {
      return {
        status: 'green',
        detail: 'gmail-amy-scan not deployed on this host; #inbox runs from ExampleCo laptop',
      };
    }
    return { status: 'red', detail: 'gmail heartbeat file missing at ' + heartbeatPath };
  }
  // Read the tail without slurping a large file. Use stat + readSync on the
  // last 4KB. Falls back to readFileSync if the file is small.
  let tailText = '';
  try {
    const stat = fsImpl.statSync(heartbeatPath);
    const tailBytes = Math.min(stat.size, 4096);
    if (stat.size <= 4096) {
      tailText = fsImpl.readFileSync(heartbeatPath, 'utf-8');
    } else {
      const fd = fsImpl.openSync(heartbeatPath, 'r');
      const buf = Buffer.alloc(tailBytes);
      fsImpl.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      fsImpl.closeSync(fd);
      tailText = buf.toString('utf-8');
    }
  } catch (e) {
    return { status: 'red', detail: 'gmail heartbeat read failed: ' + e.message };
  }
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { status: 'red', detail: 'gmail heartbeat empty' };
  let last;
  try { last = JSON.parse(lines[lines.length - 1]); }
  catch (e) { return { status: 'red', detail: 'gmail heartbeat tail malformed: ' + e.message }; }
  const lastTs = last && (last.ts || last.timestamp || last.at);
  if (!lastTs) return { status: 'red', detail: 'gmail heartbeat tail missing ts field' };
  const ageMin = Math.round((now() - new Date(lastTs).getTime()) / 60000);
  if (ageMin > staleMin) {
    // If the scanner deployment is structurally missing on this host, a stale
    // heartbeat is not a runtime failure -- it's just left over from a manual
    // poke. Treat as skip so we don't reignite the Telegram alert loop after
    // the file ages out. Real stale (scanner deployed but stopped) still red.
    const helperExists = fsImpl.existsSync(helperScriptPath);
    const pm2Running = gmailPm2Running();
    if (!helperExists && !pm2Running) {
      return {
        status: 'green',
        detail: 'gmail-amy-scan not deployed on this host; #inbox runs from ExampleCo laptop (heartbeat ' + ageMin + 'm old, ignored)',
      };
    }
    return { status: 'red', detail: 'gmail-amy-scan heartbeat ' + ageMin + 'm old (threshold ' + staleMin + 'm)' };
  }
  return { status: 'green', detail: 'gmail-amy-scan heartbeat ' + ageMin + 'm old' };
}

async function probeLinkedin({
  lastCrawlTsProvider = () => null,
  staleHours = 36,
  now = () => Date.now(),
} = {}) {
  // LinkedIn intel is produced by the nightly midnight crawl in the Electron
  // app on ExampleCo's laptop and relayed to EC2 via /sync. EC2 never crawls; it
  // only holds whatever the laptop last pushed (LinkedInIntelStore.lastCrawlAt).
  // The crawl runs nightly, so a healthy timestamp is under staleHours old;
  // older means the laptop has been off or the crawl failed for a night+.
  const lastTs = lastCrawlTsProvider();
  if (lastTs == null) {
    return { status: 'green', detail: 'linkedin crawl: no intel synced yet' };
  }
  const ts = typeof lastTs === 'number' ? lastTs : new Date(lastTs).getTime();
  if (!Number.isFinite(ts)) {
    return { status: 'red', detail: 'linkedin crawl: lastCrawlAt unparseable (' + lastTs + ')' };
  }
  const ageH = Math.round((now() - ts) / 3600000);
  if (ageH > staleHours) {
    return { status: 'red', detail: 'linkedin crawl ' + ageH + 'h old (threshold ' + staleHours + 'h)' };
  }
  return { status: 'green', detail: 'linkedin crawl ' + ageH + 'h old' };
}

// Crash-loop detector. PM2's restart_time is a LIFETIME counter, so a freshly
// deployed process can show "55 restarts" without actually being in a loop.
// A real crash loop is restart_time GROWING fast: more than restartDeltaThreshold
// new restarts within crashWindowMs. The probe is stateful, callers create one
// instance and reuse it across ticks. baselineProvider returns the previously
// observed { restarts, observedAt } so callers (and tests) can inject baselines
// without managing closure state externally.
function createPm2Probe({
  pm2Process = 'secondbrain-backend',
  restartDeltaThreshold = 5,
  crashWindowMs = 10 * 60 * 1000,
  exec = (cmd) => execSync(cmd, { encoding: 'utf-8', timeout: 5000 }),
  initialBaseline = null,
} = {}) {
  let baseline = initialBaseline;
  function probe({ uptimeMs, restarts, now = () => Date.now() } = {}) {
    let resolvedUptime = uptimeMs;
    let resolvedRestarts = restarts;
    if (resolvedUptime == null || resolvedRestarts == null) {
      try {
        const raw = exec('pm2 jlist');
        const list = JSON.parse(raw);
        const found = list.find((p) => p.name === pm2Process);
        if (!found) return { status: 'red', detail: 'pm2 process ' + pm2Process + ' not found' };
        resolvedRestarts = found.pm2_env && found.pm2_env.restart_time != null
          ? found.pm2_env.restart_time
          : resolvedRestarts;
        resolvedUptime = found.pm2_env && found.pm2_env.pm_uptime != null
          ? now() - found.pm2_env.pm_uptime
          : resolvedUptime;
      } catch (e) {
        return { status: 'red', detail: 'pm2 jlist failed: ' + (e.message || 'ExampleCo').slice(0, 80) };
      }
    }
    if (resolvedRestarts == null || resolvedUptime == null) {
      return { status: 'red', detail: 'pm2 stats unavailable' };
    }
    const uptimeMin = Math.round(resolvedUptime / 60000);
    if (!baseline) {
      // First observation. Establish baseline and report green (we have no
      // history yet to call this a loop). Subsequent ticks compare against
      // this baseline.
      baseline = { restarts: resolvedRestarts, observedAt: now() };
      return {
        status: 'green',
        detail: 'pm2 ' + pm2Process + ' baseline set: ' + resolvedRestarts + ' lifetime restarts, uptime ' + uptimeMin + 'm',
        meta: { restarts: resolvedRestarts, uptimeMs: resolvedUptime, baseline: true },
      };
    }
    const delta = resolvedRestarts - baseline.restarts;
    const elapsedMs = now() - baseline.observedAt;
    const inCrashWindow = elapsedMs <= crashWindowMs;
    if (inCrashWindow && delta > restartDeltaThreshold) {
      return {
        status: 'red',
        detail: 'pm2 crash loop: ' + delta + ' new restarts in last ' + Math.round(elapsedMs / 60000) + 'm (total ' + resolvedRestarts + ', uptime ' + uptimeMin + 'm)',
        meta: { restarts: resolvedRestarts, delta, uptimeMs: resolvedUptime },
      };
    }
    // Slide the baseline forward once the crash window closes so the next
    // burst is measured from a fresh starting point. Without this, slowly
    // accumulating lifetime restarts could eventually trip the threshold.
    if (!inCrashWindow) {
      baseline = { restarts: resolvedRestarts, observedAt: now() };
    }
    return {
      status: 'green',
      detail: 'pm2 ' + pm2Process + ' uptime ' + uptimeMin + 'm, ' + resolvedRestarts + ' lifetime restarts (+' + delta + ' since baseline)',
      meta: { restarts: resolvedRestarts, delta, uptimeMs: resolvedUptime },
    };
  }
  return { probe, getBaseline: () => baseline };
}

// Stateless adapter that creates a single-shot probe on every call. Kept for
// tests and ad-hoc usage. Production code should use createPm2Probe to track
// restart deltas across ticks.
function probePm2(opts = {}) {
  const { probe } = createPm2Probe(opts);
  return probe(opts);
}

// Heal implementations. Each heal returns { attempted, action, detail }.
// success is determined by the orchestrator via reprobe, so heal only reports
// whether the action ran.

function healTelegram() {
  return {
    attempted: false,
    action: 'manual',
    detail: 'TELEGRAM_BOT_TOKEN is owner-managed; no safe in-process fix. Surface to ExampleCo.',
  };
}

function healProxy() {
  return {
    attempted: false,
    action: 'manual',
    detail: 'Claude Max proxy runs on ExampleCo laptop via start-claude-proxy.vbs. EC2 cannot restart it. Surface to ExampleCo.',
  };
}

function healBackend({ exec = (cmd) => execSync(cmd, { encoding: 'utf-8', timeout: 10000 }) } = {}) {
  // We are running INSIDE secondbrain-backend. Restarting it would kill our
  // own monitor. The most useful action is to ask pm2 to reset counters so
  // any future crash loop is detected cleanly, and to surface to ExampleCo that
  // the local /health endpoint failed (which should be impossible while we
  // are alive, but if it happens it usually means port collision).
  try {
    const out = exec('pm2 reset secondbrain-backend');
    return { attempted: true, action: 'pm2-reset', detail: 'pm2 reset run; if backend still red, manual fix needed. out=' + out.trim().slice(0, 120) };
  } catch (e) {
    return { attempted: true, action: 'pm2-reset', detail: 'pm2 reset failed: ' + e.message };
  }
}

function healVapi() {
  // Vapi is external. The only thing we can do from here is force a refresh
  // of the cached assistant config. The orchestrator hands us a refresher
  // callback if available.
  return { attempted: false, action: 'manual', detail: 'Vapi api outage is upstream; alert ExampleCo and wait.' };
}

function healGmail({ exec = (cmd) => execSync(cmd, { encoding: 'utf-8', timeout: 15000 }) } = {}) {
  // The gmail-amy-scan watcher should be running under pm2. If the heartbeat
  // is stale we ask pm2 to restart its process. If it is not a pm2 process
  // (Windows task scheduler), surface to ExampleCo.
  try {
    const out = exec('pm2 restart gmail-amy-scan || true');
    return { attempted: true, action: 'pm2-restart-gmail', detail: 'pm2 restart gmail-amy-scan attempted: ' + out.trim().slice(0, 120) };
  } catch (e) {
    return { attempted: true, action: 'pm2-restart-gmail', detail: 'pm2 restart gmail-amy-scan failed: ' + e.message };
  }
}

function healLinkedin() {
  // The LinkedIn crawl runs in the Electron app on ExampleCo's laptop, not EC2.
  // EC2 cannot trigger it. As a laptop-hosted channel the orchestrator never
  // calls this heal anyway; it exists only for def-shape consistency.
  return {
    attempted: false,
    action: 'manual',
    detail: 'LinkedIn crawl runs nightly in the Electron app on ExampleCo laptop. EC2 cannot trigger it. Surface to ExampleCo.',
  };
}

function healPm2({ exec = (cmd) => execSync(cmd, { encoding: 'utf-8', timeout: 5000 }) } = {}) {
  // Reset restart counter so the next probe sees a clean slate. PM2 already
  // auto-restarts crashed processes, so the heal here is the counter reset
  // plus a ExampleCo alert so he can investigate the underlying cause.
  try {
    const out = exec('pm2 reset all');
    return { attempted: true, action: 'pm2-reset-all', detail: 'pm2 reset all run: ' + out.trim().slice(0, 120) };
  } catch (e) {
    return { attempted: true, action: 'pm2-reset-all', detail: 'pm2 reset all failed: ' + e.message };
  }
}

// Orchestrator.

function createMonitor({
  sendMessage,
  logEvent = () => {},
  now = () => Date.now(),
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
  minAlertIntervalMs = DEFAULT_MIN_ALERT_INTERVAL_MS,
  probeDefs,
  telegramBotToken,
  proxyPort = 3456,
  backendPort = 3001,
  vapiKey,
  lastVapiWebhookTsProvider = () => null,
  gmailHeartbeatPath = '/opt/secondbrain/data/agent/gmail-scan-heartbeat.jsonl',
  lastLinkedinCrawlTsProvider = () => null,
  pm2Process = 'secondbrain-backend',
  exec,
  fetcher = httpGetJson,
  fsImpl = fs,
} = {}) {
  if (typeof sendMessage !== 'function') {
    throw new Error('channel-health-monitor: sendMessage function is required');
  }

  const pm2Probe = createPm2Probe({ pm2Process, exec });
  const defaultDefs = [
    {
      name: 'telegram',
      friendly: 'Telegram',
      probe: () => probeTelegram({ botToken: telegramBotToken, fetcher }),
      heal: () => healTelegram(),
    },
    {
      name: 'proxy',
      friendly: 'Claude Max proxy',
      laptopHosted: true,
      probe: () => probeProxy({ proxyPort, fetcher }),
      heal: () => healProxy(),
    },
    {
      name: 'backend',
      friendly: 'Backend (port ' + backendPort + ')',
      probe: () => probeBackend({ backendPort, fetcher }),
      heal: () => healBackend({ exec }),
    },
    {
      name: 'vapi',
      friendly: 'Vapi',
      probe: () => probeVapi({ vapiKey, lastWebhookTsProvider: lastVapiWebhookTsProvider, fetcher }),
      heal: () => healVapi(),
    },
    {
      name: 'gmail',
      friendly: 'Gmail scan',
      laptopHosted: true,
      telegramAllowed: false,
      probe: () => probeGmail({ heartbeatPath: gmailHeartbeatPath, fsImpl, now }),
      heal: () => healGmail({ exec }),
    },
    {
      name: 'linkedin',
      friendly: 'LinkedIn crawl',
      laptopHosted: true,
      probe: () => probeLinkedin({ lastCrawlTsProvider: lastLinkedinCrawlTsProvider, now }),
      heal: () => healLinkedin(),
    },
    {
      name: 'pm2',
      friendly: 'PM2 crash loop',
      probe: () => pm2Probe.probe({ now }),
      heal: () => healPm2({ exec }),
    },
    {
      // Catches the 2026-05-23 outage where ExampleCo's laptop was awake, the proxy
      // was reachable but the OAuth token push had stalled, so Amy went dark on
      // Telegram for ~2 hours before ExampleCo noticed. With this probe the briefing
      // and channel monitor see token-push staleness as a first-class signal.
      name: 'claude-max-token',
      friendly: 'Claude Max token push',
      laptopHosted: true,
      probe: () => probeClaudeMaxToken({ fsImpl, now }),
    },
  ];
  const defs = probeDefs || defaultDefs;

  const state = {
    startedAt: now(),
    lastTickAt: null,
    intervalMs,
    channels: {},
  };
  for (const d of defs) {
    state.channels[d.name] = {
      friendly: d.friendly,
      status: 'ExampleCo',
      detail: '',
      lastChangedAt: null,
      lastOkAt: null,
      lastRedAt: null,
      lastAlertedAt: null,
      lastHealAttemptAt: null,
      lastHealAction: null,
      lastHealDetail: null,
      consecutiveRed: 0,
      // Laptop-hosted only: true between sending an offline note and the
      // matching recovery note, so a suppressed flap does not emit a stray
      // "back online" message.
      laptopAlertOpen: false,
    };
  }

  function recordAlertSent(name) {
    state.channels[name].lastAlertedAt = now();
  }

  function shouldAlert(name) {
    const ch = state.channels[name];
    if (!ch.lastAlertedAt) return true;
    return now() - ch.lastAlertedAt > minAlertIntervalMs;
  }

  // Laptop-hosted re-alert gate: one note, then silent for 4h regardless of
  // flapping. The window is anchored on the last offline note we actually
  // sent, so a service that recovers and stays up past 4h gets a fresh note
  // if it goes down again, while a service flapping every few minutes only
  // produces one note per 4h.
  function shouldAlertLaptop(name) {
    const ch = state.channels[name];
    if (!ch.lastAlertedAt) return true;
    return now() - ch.lastAlertedAt >= LAPTOP_REALERT_INTERVAL_MS;
  }

  async function checkOne(def) {
    const ch = state.channels[def.name];
    const before = ch.status;
    let result;
    try {
      result = await def.probe();
    } catch (e) {
      result = { status: 'red', detail: 'probe threw: ' + (e.message || 'ExampleCo') };
    }
    ch.status = result.status;
    ch.detail = result.detail || '';
    ch.meta = result.meta || null;
    if (before !== result.status) {
      ch.lastChangedAt = now();
    }
    if (result.status === 'green') {
      ch.lastOkAt = now();
      ch.consecutiveRed = 0;
    } else {
      ch.lastRedAt = now();
      ch.consecutiveRed += 1;
    }
    logEvent({ ts: new Date(now()).toISOString(), channel: def.name, status: result.status, detail: result.detail });
    return { def, before, after: result };
  }

  async function tick() {
    state.lastTickAt = now();
    const recoveredAfterHeal = new Set();
    const transitions = [];
    for (const def of defs) {
      const t = await checkOne(def);
      transitions.push(t);
    }
    for (const t of transitions) {
      if (t.after.status !== 'red') continue;
      const ch = state.channels[t.def.name];

      // Laptop-hosted channels run on ExampleCo's laptop; EC2 cannot fix them.
      // Send ONE quiet offline note (no "attempting auto-fix", no heal, no
      // "manual fix needed"), then stay silent for 4h before re-alerting.
      if (t.def.laptopHosted) {
        if (!shouldAlertLaptop(t.def.name)) continue;
        if (t.def.telegramAllowed === false) {
          recordAlertSent(t.def.name);
          ch.laptopAlertOpen = false;
          logEvent({
            ts: new Date(now()).toISOString(),
            channel: t.def.name,
            event: 'telegram-suppressed-by-policy',
            detail: ch.detail,
          });
          continue;
        }
        await sendMessage(
          'ℹ️ ' + ch.friendly + ' is offline. It runs on your laptop and will recover when your machine is on.',
          { kind: 'health-alert-laptop-offline', extras: { channel: t.def.name } },
        );
        recordAlertSent(t.def.name);
        ch.laptopAlertOpen = true;
        logEvent({ ts: new Date(now()).toISOString(), channel: t.def.name, event: 'alert-laptop-offline', detail: ch.detail });
        continue;
      }

      const isNew = t.before !== 'red';
      if (!isNew && !shouldAlert(t.def.name)) continue;

      const downMsg = '⚠️ ' + ch.friendly + ' is down. ' + ch.detail + '\n\nAttempting auto-fix...';
      await sendMessage(downMsg, { kind: 'health-alert-down', extras: { channel: t.def.name } });
      recordAlertSent(t.def.name);
      logEvent({ ts: new Date(now()).toISOString(), channel: t.def.name, event: 'alert-down', detail: ch.detail });

      let healResult;
      try { healResult = t.def.heal(); }
      catch (e) { healResult = { attempted: false, action: 'error', detail: 'heal threw: ' + e.message }; }
      ch.lastHealAttemptAt = now();
      ch.lastHealAction = healResult.action;
      ch.lastHealDetail = healResult.detail;
      logEvent({ ts: new Date(now()).toISOString(), channel: t.def.name, event: 'heal-attempted', action: healResult.action, detail: healResult.detail });

      if (!healResult.attempted) {
        await sendMessage(
          '❌ Auto-fix for ' + ch.friendly + ' not possible from EC2. ' + healResult.detail + '\n\nManual fix needed.',
          { kind: 'health-alert-manual-needed', extras: { channel: t.def.name, heal_action: healResult.action } },
        );
        continue;
      }

      let after2;
      try { after2 = await t.def.probe(); }
      catch (e) { after2 = { status: 'red', detail: 'reprobe threw: ' + e.message }; }
      ch.status = after2.status;
      ch.detail = after2.detail;
      if (after2.status === 'green') {
        ch.lastOkAt = now();
        ch.consecutiveRed = 0;
        ch.lastChangedAt = now();
        recoveredAfterHeal.add(t.def.name);
        await sendMessage(
          '✅ ' + ch.friendly + ' is back online after auto-fix (' + healResult.action + '). ' + after2.detail,
          { kind: 'health-alert-recovered', extras: { channel: t.def.name, heal_action: healResult.action } },
        );
      } else {
        await sendMessage(
          '❌ Auto-fix for ' + ch.friendly + ' did not recover the channel. Action: ' + healResult.action + '. State: ' + after2.detail + '. Manual fix needed.',
          { kind: 'health-alert-heal-failed', extras: { channel: t.def.name, heal_action: healResult.action } },
        );
      }
    }
    for (const t of transitions) {
      if (t.before === 'red' && t.after.status === 'green') {
        if (recoveredAfterHeal.has(t.def.name)) continue;
        const ch = state.channels[t.def.name];

        // Laptop-hosted: brief recovery note, and only if we actually sent an
        // offline note for this episode. A flap we suppressed inside the 4h
        // window produces no recovery message (no spam from a quiet flap).
        if (t.def.laptopHosted) {
          if (ch.laptopAlertOpen) {
            await sendMessage(
              '✅ ' + ch.friendly + ' back online.',
              { kind: 'health-alert-laptop-recovered', extras: { channel: t.def.name } },
            );
            ch.laptopAlertOpen = false;
            logEvent({ ts: new Date(now()).toISOString(), channel: t.def.name, event: 'alert-laptop-recovered', detail: t.after.detail });
          }
          continue;
        }

        await sendMessage(
          '✅ ' + ch.friendly + ' recovered on its own. ' + t.after.detail,
          { kind: 'health-alert-self-recovered', extras: { channel: t.def.name } },
        );
        recordAlertSent(t.def.name);
      }
    }
    return transitions;
  }

  function getSnapshot() {
    const channels = {};
    for (const [k, v] of Object.entries(state.channels)) {
      channels[k] = { ...v };
    }
    const overall = Object.values(channels).every((c) => c.status === 'green')
      ? 'green'
      : Object.values(channels).some((c) => c.status === 'red')
        ? 'red'
        : 'ExampleCo';
    return {
      overall,
      startedAt: new Date(state.startedAt).toISOString(),
      lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
      intervalMs: state.intervalMs,
      channels,
    };
  }

  let timerHandle = null;
  function start() {
    if (timerHandle) return;
    tick().catch((e) => logEvent({ ts: new Date(now()).toISOString(), event: 'tick-error', detail: e.message }));
    timerHandle = setInterval(() => {
      tick().catch((e) => logEvent({ ts: new Date(now()).toISOString(), event: 'tick-error', detail: e.message }));
    }, intervalMs);
    if (timerHandle && timerHandle.unref) timerHandle.unref();
  }
  function stop() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  return { start, stop, tick, checkOne, getSnapshot, defs, state };
}

module.exports = {
  createMonitor,
  probeTelegram,
  probeProxy,
  probeBackend,
  probeVapi,
  probeGmail,
  probeClaudeMaxToken,
  probeLinkedin,
  probePm2,
  createPm2Probe,
  healTelegram,
  healProxy,
  healBackend,
  healVapi,
  healGmail,
  healLinkedin,
  healPm2,
  httpGetJson,
};
