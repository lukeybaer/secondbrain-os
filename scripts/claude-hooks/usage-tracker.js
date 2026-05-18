#!/usr/bin/env node
/**
 * Claude Code Usage Tracker
 *
 * Reads the active session's JSONL file and computes:
 * - Per-reply token counts and estimated cost
 * - Cumulative session totals
 * - Rolling 5-hour window estimate for Max plan limit tracking
 *
 * Usage modes:
 *   node usage-tracker.js --session <sessionId>   # specific session
 *   node usage-tracker.js --latest                 # most recent session in cwd project
 *   node usage-tracker.js --hook                   # called from UserPromptSubmit hook, reads env
 *   node usage-tracker.js --all-5h                 # all sessions in rolling 5h window
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Pricing per million tokens (API pricing, used for cost estimation even on Max plan)
const PRICING = {
  'claude-opus-4-6': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-opus-4-5': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-haiku-3-5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreate: 1.0 },
};

// Max plan approximate token budgets per 5-hour rolling window
const MAX_PLAN_LIMITS = {
  '5x': { tokens: 88000, price: '$100/mo' },
  '20x': { tokens: 220000, price: '$200/mo' },
};

function getProjectDir() {
  // Claude Code stores sessions in ~/.claude/projects/{encoded-cwd}/
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  const encoded = cwd.replace(/[:\\\/]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function findSessionFiles(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      file: path.join(projectDir, f),
      sessionId: f.replace('.jsonl', ''),
      mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      size: fs.statSync(path.join(projectDir, f)).size,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

function parseSession(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const messages = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.message?.usage && d.message?.role === 'assistant') {
        const u = d.message.usage;
        const model = d.message.model || 'unknown';
        const pricing = PRICING[model] || PRICING['claude-sonnet-4-6']; // fallback

        const inputTokens = u.input_tokens || 0;
        const outputTokens = u.output_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheCreate = u.cache_creation_input_tokens || 0;
        const totalInput = inputTokens + cacheRead + cacheCreate;

        // Cost calc (per million tokens)
        const cost =
          (inputTokens / 1_000_000) * pricing.input +
          (outputTokens / 1_000_000) * pricing.output +
          (cacheRead / 1_000_000) * pricing.cacheRead +
          (cacheCreate / 1_000_000) * pricing.cacheCreate;

        messages.push({
          timestamp: d.timestamp || null,
          model,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreate,
          totalInput,
          totalTokens: totalInput + outputTokens,
          cost,
          webSearches: u.server_tool_use?.web_search_requests || 0,
          webFetches: u.server_tool_use?.web_fetch_requests || 0,
          speed: u.speed || 'standard',
        });
      }
    } catch (e) {
      /* skip malformed lines */
    }
  }

  return messages;
}

function summarize(messages) {
  const totals = {
    replies: messages.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalTokens: 0,
    cost: 0,
    webSearches: 0,
    webFetches: 0,
    byModel: {},
  };

  for (const m of messages) {
    totals.inputTokens += m.inputTokens;
    totals.outputTokens += m.outputTokens;
    totals.cacheRead += m.cacheRead;
    totals.cacheCreate += m.cacheCreate;
    totals.totalTokens += m.totalTokens;
    totals.cost += m.cost;
    totals.webSearches += m.webSearches;
    totals.webFetches += m.webFetches;

    if (!totals.byModel[m.model]) {
      totals.byModel[m.model] = { replies: 0, tokens: 0, cost: 0 };
    }
    totals.byModel[m.model].replies++;
    totals.byModel[m.model].tokens += m.totalTokens;
    totals.byModel[m.model].cost += m.cost;
  }

  return totals;
}

function getAllProjectDirs() {
  // Max plan limit is shared across ALL repos, web, desktop, mobile, Code
  // Scan every project dir under ~/.claude/projects/ for complete 5h picture
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return [];
  return fs
    .readdirSync(projectsRoot)
    .filter((d) => {
      try {
        return fs.statSync(path.join(projectsRoot, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => path.join(projectsRoot, d));
}

const ROLLING_CACHE_FILE = path.join(os.tmpdir(), 'amy-usage-cache.json');
const ROLLING_CACHE_TTL_MS = 30_000; // 30 seconds

function rolling5hTokens() {
  // Cache the expensive filesystem scan to avoid 5+ second status line renders.
  // Cache lives in a temp file with a 30-second TTL.
  try {
    const raw = fs.readFileSync(ROLLING_CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts < ROLLING_CACHE_TTL_MS) {
      return { outputTokens: cached.outputTokens, totalTokens: cached.totalTokens };
    }
  } catch (_) { /* cache miss or corrupt — recompute */ }

  // Sum output tokens across ALL sessions in ALL repos in the last 5 hours
  // Max plan limits are shared across every surface
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  let totalOutput = 0;
  let totalAll = 0;

  for (const projDir of getAllProjectDirs()) {
    const files = findSessionFiles(projDir);
    for (const f of files) {
      // Skip files not modified in the last 5h
      if (f.mtime < cutoff) continue;

      const messages = parseSession(f.file);
      for (const m of messages) {
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : f.mtime;
        if (ts >= cutoff) {
          totalOutput += m.outputTokens;
          totalAll += m.totalTokens;
        }
      }
    }
  }

  const result = { outputTokens: totalOutput, totalTokens: totalAll };
  try {
    fs.writeFileSync(ROLLING_CACHE_FILE, JSON.stringify({ ts: Date.now(), ...result }));
  } catch (_) { /* non-fatal */ }
  return result;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatCost(c) {
  if (c < 0.01) return '<$0.01';
  return '$' + c.toFixed(2);
}

// --- Output modes ---

function hookOutput(projectDir, planTier = '5x') {
  // Compact output for injection into prompts via hook
  const files = findSessionFiles(projectDir);
  if (files.length === 0) return JSON.stringify({ systemMessage: '' });

  const currentSession = parseSession(files[0].file);
  const sessionTotals = summarize(currentSession);
  const last = currentSession[currentSession.length - 1];
  const rolling = rolling5hTokens();
  const limit = MAX_PLAN_LIMITS[planTier] || MAX_PLAN_LIMITS['5x'];
  const pct = Math.min(100, Math.round((rolling.outputTokens / limit.tokens) * 100));

  const lines = [
    `[Usage] Session: ${formatTokens(sessionTotals.totalTokens)} tokens (${sessionTotals.replies} replies, ~${formatCost(sessionTotals.cost)} API-equiv)`,
    `[Usage] 5h rolling window: ~${formatTokens(rolling.outputTokens)} output tokens (~${pct}% of ${planTier} Max limit)`,
  ];

  if (last) {
    lines.push(
      `[Usage] Last reply: ${formatTokens(last.totalTokens)} tokens (${formatTokens(last.outputTokens)} out, ${last.model})`,
    );
  }

  return JSON.stringify({ systemMessage: lines.join('\n') });
}

function prettyOutput(projectDir, planTier = '5x') {
  const files = findSessionFiles(projectDir);
  if (files.length === 0) {
    console.log('No session files found.');
    return;
  }

  const currentSession = parseSession(files[0].file);
  const sessionTotals = summarize(currentSession);
  const rolling = rolling5hTokens();
  const limit = MAX_PLAN_LIMITS[planTier] || MAX_PLAN_LIMITS['5x'];
  const pct = Math.min(100, Math.round((rolling.outputTokens / limit.tokens) * 100));

  console.log('\n=== Claude Code Usage Report ===\n');
  console.log(`Current session: ${files[0].sessionId}`);
  console.log(`  Replies: ${sessionTotals.replies}`);
  console.log(
    `  Input tokens:  ${formatTokens(sessionTotals.inputTokens)} (fresh) + ${formatTokens(sessionTotals.cacheRead)} (cache read) + ${formatTokens(sessionTotals.cacheCreate)} (cache write)`,
  );
  console.log(`  Output tokens: ${formatTokens(sessionTotals.outputTokens)}`);
  console.log(`  Total tokens:  ${formatTokens(sessionTotals.totalTokens)}`);
  console.log(`  API-equiv cost: ${formatCost(sessionTotals.cost)}`);

  if (Object.keys(sessionTotals.byModel).length > 1) {
    console.log(`  By model:`);
    for (const [model, data] of Object.entries(sessionTotals.byModel)) {
      console.log(
        `    ${model}: ${data.replies} replies, ${formatTokens(data.tokens)} tokens, ${formatCost(data.cost)}`,
      );
    }
  }

  console.log(`\n5-hour rolling window (Max plan tracker):`);
  console.log(
    `  Output tokens: ${formatTokens(rolling.outputTokens)} / ~${formatTokens(limit.tokens)} (${pct}%)`,
  );
  console.log(
    `  ${'#'.repeat(Math.round(pct / 2))}${'_'.repeat(50 - Math.round(pct / 2))} ${pct}%`,
  );

  if (pct >= 80) {
    console.log(`  WARNING: Approaching Max plan limit. Consider shorter replies or waiting.`);
  }

  if (sessionTotals.webSearches > 0 || sessionTotals.webFetches > 0) {
    console.log(
      `\nWeb usage: ${sessionTotals.webSearches} searches, ${sessionTotals.webFetches} fetches`,
    );
  }

  console.log('');
}

function statusLineOutput(projectDir, planTier = '5x') {
  // Single line for status bar
  const files = findSessionFiles(projectDir);
  if (files.length === 0) {
    process.stdout.write('No sessions');
    return;
  }

  const currentSession = parseSession(files[0].file);
  const sessionTotals = summarize(currentSession);
  const rolling = rolling5hTokens();
  const limit = MAX_PLAN_LIMITS[planTier] || MAX_PLAN_LIMITS['5x'];
  const pct = Math.min(100, Math.round((rolling.outputTokens / limit.tokens) * 100));

  process.stdout.write(
    `${formatTokens(sessionTotals.totalTokens)} session | ${formatTokens(rolling.outputTokens)}/${formatTokens(limit.tokens)} 5h (${pct}%) | ~${formatCost(sessionTotals.cost)}`,
  );
}

// --- Main ---
const args = process.argv.slice(2);
const mode = args[0] || '--hook';
const planTier = args.includes('--20x') ? '20x' : '5x';

// Determine project dir
let projectDir;
if (args.includes('--project-dir') && args[args.indexOf('--project-dir') + 1]) {
  projectDir = args[args.indexOf('--project-dir') + 1];
} else {
  projectDir = getProjectDir();
}

switch (mode) {
  case '--hook':
    process.stdout.write(hookOutput(projectDir, planTier));
    break;
  case '--pretty':
    prettyOutput(projectDir, planTier);
    break;
  case '--status':
    statusLineOutput(projectDir, planTier);
    break;
  case '--latest':
    prettyOutput(projectDir, planTier);
    break;
  default:
    prettyOutput(projectDir, planTier);
}
