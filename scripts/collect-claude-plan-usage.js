#!/usr/bin/env node
/**
 * collect-claude-plan-usage.js
 *
 * 2026-05-25 ExampleCo flagged: my token-usage card was reporting "Claude Max
 * 46% burned this week" while the actual Anthropic settings page at
 * claude.ai/settings/usage showed 24%. The 46% was derived from a
 * guess-budget envelope (data/agent/subscription-limits.json:
 * weekly_input_like_tokens=5B) divided into summed token-usage-*.json
 * file totals. That math is meaningless because Anthropic does not bill
 * Max usage by input-like tokens; the plan caps are message-shape limits
 * that Anthropic publishes back via /api/oauth/usage.
 *
 * This collector hits the authoritative endpoint with the same OAuth
 * access token the Claude Code CLI uses (~/.claude/.credentials.json,
 * field claudeAiOauth.accessToken, refreshed hourly by
 * scripts/claude-token-refresh.js). Writes
 * data/agent/claude-plan-usage.json with the raw payload plus a flat
 * summary the briefing renderer can read.
 *
 * Endpoint contract (from claude.ai web UI traffic + the @anthropic-ai/
 * claude-code/cli.js token refresh flow):
 *   GET https://claude.ai/api/oauth/usage
 *   Authorization: Bearer <accessToken>
 *   Response: {
 *     five_hour: { utilization: 10.0, resets_at: "..." },
 *     seven_day: { utilization: 24.0, resets_at: "..." },
 *     seven_day_sonnet: { utilization: 4.0, resets_at: "..." },
 *     seven_day_opus: { ... }  | null,
 *     extra_usage: { is_enabled: true, monthly_limit: 13000, used_credits: 0.0, currency: "USD" }
 *   }
 *
 * The `utilization` numbers ARE the percent Anthropic uses to enforce
 * the plan. No more derived ratios.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const OUT_PATH = path.join(
  process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'),
  'agent',
  'claude-plan-usage.json',
);

function readAccessToken() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`credentials not found at ${CREDENTIALS_PATH}; run claude /login`);
  }
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const token = creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
  if (!token) throw new Error('claudeAiOauth.accessToken missing from credentials');
  return token;
}

function fetchUsage(token, { host = 'claude.ai', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: host,
      path: '/api/oauth/usage',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'secondbrain-claude-plan-usage/1.0',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 240)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`bad JSON from /api/oauth/usage: ${e.message}; body: ${body.slice(0, 240)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`/api/oauth/usage timed out after ${timeoutMs}ms`)); });
    req.end();
  });
}

function flatten(raw) {
  const num = (v) => (typeof v === 'number' ? v : null);
  const pct = (block) => block && typeof block.utilization === 'number' ? block.utilization : null;
  return {
    five_hour_percent: pct(raw.five_hour),
    five_hour_resets_at: (raw.five_hour && raw.five_hour.resets_at) || null,
    weekly_all_models_percent: pct(raw.seven_day),
    weekly_all_models_resets_at: (raw.seven_day && raw.seven_day.resets_at) || null,
    weekly_sonnet_percent: pct(raw.seven_day_sonnet),
    weekly_sonnet_resets_at: (raw.seven_day_sonnet && raw.seven_day_sonnet.resets_at) || null,
    weekly_opus_percent: pct(raw.seven_day_opus),
    weekly_opus_resets_at: (raw.seven_day_opus && raw.seven_day_opus.resets_at) || null,
    extra_usage_enabled: raw.extra_usage ? !!raw.extra_usage.is_enabled : false,
    extra_usage_monthly_limit: num(raw.extra_usage && raw.extra_usage.monthly_limit),
    extra_usage_used_credits: num(raw.extra_usage && raw.extra_usage.used_credits),
    extra_usage_currency: (raw.extra_usage && raw.extra_usage.currency) || null,
  };
}

// claude.ai sits behind Cloudflare, which intermittently serves a bot-challenge
// "Just a moment..." HTML page (HTTP 403) even to a valid OAuth request. It is
// transient: an immediate retry almost always succeeds (observed 5/6 on a
// 6-call burst, 2026-06-01). A single un-retried 403 was leaving the on-disk
// file stale for a full day, which the briefing then rendered as the current
// percent. Retry a handful of times before giving up so one flaky challenge
// never strands the data.
async function fetchUsageWithRetry(token, { attempts = 4, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchUsage(token);
    } catch (e) {
      lastErr = e;
      const challenged = /HTTP 403|Just a moment|timed out/i.test(e.message || '');
      if (!challenged || i === attempts - 1) throw e;
      console.error(`[collect-claude-plan-usage] attempt ${i + 1}/${attempts} failed (${e.message.slice(0, 80)}); retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function main() {
  let token;
  try { token = readAccessToken(); }
  catch (e) {
    console.error(`[collect-claude-plan-usage] ${e.message}`);
    process.exit(2);
  }
  let raw;
  try { raw = await fetchUsageWithRetry(token); }
  catch (e) {
    console.error(`[collect-claude-plan-usage] ${e.message}`);
    process.exit(1);
  }
  const flat = flatten(raw);
  const out = {
    plan: 'Claude Max (20x)', // not in the payload; matches the settings page label
    generated_at: new Date().toISOString(),
    source: 'https://claude.ai/api/oauth/usage',
    ...flat,
    raw,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[collect-claude-plan-usage] wrote ${OUT_PATH}`);
  console.log(`  weekly all models: ${flat.weekly_all_models_percent}% (resets ${flat.weekly_all_models_resets_at})`);
  console.log(`  weekly Sonnet:     ${flat.weekly_sonnet_percent}% (resets ${flat.weekly_sonnet_resets_at})`);
  console.log(`  five hour:         ${flat.five_hour_percent}% (resets ${flat.five_hour_resets_at})`);
  if (flat.extra_usage_enabled) {
    console.log(`  extra usage:       ${flat.extra_usage_used_credits} of ${flat.extra_usage_monthly_limit} ${flat.extra_usage_currency} (pay-as-you-go enabled)`);
  }
}

if (require.main === module) main();

module.exports = { fetchUsage, fetchUsageWithRetry, flatten };
