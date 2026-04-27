#!/usr/bin/env node
/**
 * process-dispatches.js — read dispatch-queue.jsonl, classify each entry via
 * Claude, route to action, write receipt to amy-dispatch-log.jsonl.
 *
 * Dispatch sources (all feed the same queue):
 *  - Dashboard right-click      → POST /briefing/dispatch writes queue entry
 *  - Gmail #Amy email scanner   → scripts/gmail-amy-scan.js writes queue entry
 *  - (future) Vapi call handler → writes queue entry when a call commits action
 *
 * Each queue line:
 *  { ts, source, date, section, itemRef, comment, status: 'queued' }
 *
 * Routing (classified by Claude):
 *  - bug        → add to feature-backlog.json as urgent, emit Telegram alert
 *  - feature    → add to feature-backlog.json normally
 *  - preference → save to memory/feedback_*.md
 *  - question   → reply via Telegram with the answer
 *  - clarify    → reply asking for more context (ambiguous)
 *
 * Idempotency: each processed entry gets a unique id (ts + hash(comment)). The
 * processed set lives in data/agent/dispatch-processed.json. Re-running is
 * safe; already-processed entries are skipped.
 *
 * Run continuously via PM2 or every 2 min via cron:
 *   node scripts/process-dispatches.js --once
 *   node scripts/process-dispatches.js --watch (loops, 60s interval)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const isLinuxEc2 = process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data/agent/dispatch-queue.jsonl');
const QUEUE = process.env.DISPATCH_QUEUE
  || (isLinuxEc2
    ? '/opt/secondbrain/data/agent/dispatch-queue.jsonl'
    : path.join(REPO, 'data', 'agent', 'dispatch-queue.jsonl'));
const PROCESSED = path.join(path.dirname(QUEUE), 'dispatch-processed.json');
const LOG = path.join(path.dirname(QUEUE), 'amy-dispatch-log.jsonl');
const BACKLOG = path.join(REPO, 'data', 'agent', 'feature-backlog.json');
const MEMORY_DIR = path.join(REPO, 'memory');

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function hashEntry(e) {
  const payload = [e.ts, e.source, e.section, e.itemRef, e.comment].join('|');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(PROCESSED, 'utf8')).ids); }
  catch { return new Set(); }
}
function saveProcessed(ids) {
  ensureDir(PROCESSED);
  fs.writeFileSync(PROCESSED, JSON.stringify({ ids: [...ids] }, null, 2));
}

function readQueue() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs.readFileSync(QUEUE, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function appendLog(entry) {
  ensureDir(LOG);
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

function classifyHeuristic(entry) {
  const c = (entry.comment || '').toLowerCase();
  const section = (entry.section || '').toLowerCase();

  // Bug indicators
  const bugPatterns = [
    /\bbug\b/, /shows? zero/, /not (?:working|loading|rendering)/,
    /\bbroken\b/, /says? news:/, /mislabel/, /can'?t be true/,
    /\bstill too broad\b/, /should not/, /shouldn'?t/, /won'?t/,
  ];
  const isBug = bugPatterns.some((p) => p.test(c));

  // Preference indicators (telling Amy how she should behave going forward)
  const prefPatterns = [
    /^\s*(?:don'?t|never|always|from now on|going forward)\b/,
    /\bi prefer\b/, /\bi want you to\b.*\balways\b/,
    /\bnever tell me\b/, /\binstead of\b.*\balways\b/,
  ];
  const isPref = prefPatterns.some((p) => p.test(c));

  // Question indicators
  const qPatterns = [/\?$/, /\?\s/, /what do you need/i, /why (?:are|is|am)/i];
  const isQuestion = qPatterns.some((p) => p.test(c));

  // Feature indicators (adds, includes, enhances)
  const featPatterns = [
    /^\s*(?:add|include|surface|show|expose|expand|build|make)\b/,
    /\bneed (?:more|to see)\b/, /\bwant (?:more|to see)\b/,
    /\bsplit (?:out|them|it)\b/, /\bbreak (?:down|out)\b/,
  ];
  const isFeature = featPatterns.some((p) => p.test(c));

  let category = 'clarify';
  if (isBug) category = 'bug';
  else if (isPref) category = 'preference';
  else if (isFeature) category = 'feature';
  else if (isQuestion) category = 'question';

  // Priority: bugs are urgent if dashboard-visible, else normal
  const priority = (category === 'bug') ? 'urgent' : 'normal';

  // Target area guess from section
  const targetMap = {
    'system health': 'ec2-server.js SYSTEM HEALTH renderer',
    'feature backlog': 'ec2-server.js FEATURE BACKLOG renderer + data/agent/feature-backlog.json',
    'content pipeline': 'ec2-server.js CONTENT PIPELINE renderer + content-review queue',
    'reputation risk': 'scripts for reputation risk scan + ec2-server.js renderer',
    'token usage': 'scripts/suggest-token-reduction.js',
    'linkedin': 'scripts/linkedin-bulk-scan.js + LinkedIn draft generator',
    'world news': 'briefing news feed pipeline + WORLD NEWS renderer',
    'approved': 'ec2-server.js APPROVED section renderer',
    'action items': 'ec2-server.js ACTION ITEMS renderer',
    'ai & tech news': 'briefing news feed + video proposal pipeline',
  };
  let target = '';
  for (const [k, v] of Object.entries(targetMap)) {
    if (section.includes(k)) { target = v; break; }
  }

  // Summary: first 50 chars of the comment, Title Case-ish
  const summary = (entry.comment || '').slice(0, 60).replace(/\s+/g, ' ').trim();

  return {
    category, priority, target_area: target,
    proposed_action: category === 'bug'
      ? `Fix the bug in ${target || entry.section}`
      : category === 'feature'
      ? `Build the enhancement in ${target || entry.section}`
      : category === 'preference'
      ? `Save as a memory rule for future sessions`
      : category === 'question'
      ? `Reply via Telegram with the answer`
      : `Ask Luke for clarification — too ambiguous to route`,
    summary,
    classified_by: 'heuristic',
  };
}

function classifyWithClaude(entry) {
  return Promise.resolve(classifyHeuristic(entry));
}

function addToBacklog(classification, entry) {
  let backlog = { items: [], updatedAt: new Date().toISOString() };
  try { backlog = JSON.parse(fs.readFileSync(BACKLOG, 'utf8')); } catch { /* fresh */ }
  if (!Array.isArray(backlog.items)) backlog.items = [];
  const id = 'dispatch-' + hashEntry(entry);
  if (backlog.items.some((it) => it.id === id)) return { added: false, id, reason: 'already in backlog' };
  backlog.items.push({
    id,
    title: classification.summary || entry.comment.slice(0, 60),
    description: entry.comment,
    section: entry.section,
    priority: classification.priority || 'normal',
    category: classification.category,
    source: entry.source || 'dashboard',
    dispatchedAt: entry.ts,
    targetArea: classification.target_area || '',
    proposedAction: classification.proposed_action || '',
    score: classification.priority === 'urgent' ? 20 : (classification.priority === 'low' ? 5 : 10),
    addedAt: new Date().toISOString(),
    status: 'pending',
  });
  backlog.items.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (backlog.items.length > 15) backlog.items = backlog.items.slice(0, 15);
  backlog.updatedAt = new Date().toISOString();
  ensureDir(BACKLOG);
  fs.writeFileSync(BACKLOG, JSON.stringify(backlog, null, 2));
  return { added: true, id };
}

// 2026-04-26 Luke Otter dispatch -- "architectural change to like dispatch
// things immediately when you receive the dispatch, whether it's through
// email, through otter notes, like this otter note, for example, it should
// trigger the dispatch right away."
//
// When PROCESS_DISPATCHES_ACT=1 is set in the env, the processor spawns
// Claude CLI on the dispatch comment to do the work, commit, and push. When
// the env var is unset (default for now while we tune safety), it falls
// back to the legacy classify-and-park behavior so production traffic does
// not get a sudden code-changing agent.
const ACT_NOW = process.env.PROCESS_DISPATCHES_ACT === '1';
const CLAUDE_CLI = process.env.CLAUDE_CLI || '/usr/bin/claude';
const ACT_LOG = path.join(path.dirname(QUEUE), 'dispatch-act-log.jsonl');
const ACT_TIMEOUT_MS = parseInt(process.env.DISPATCH_ACT_TIMEOUT_MS || '420000', 10);
const ACT_REPO = process.env.DISPATCH_ACT_REPO || REPO;

function spawnClaudeAct(entry) {
  const { spawnSync } = require('child_process');
  const prompt = [
    'You are Amy, Luke Baers autonomous executive assistant. A dispatch just landed.',
    `Source: ${entry.source}, Section: ${entry.section}.`,
    `Item reference: ${entry.itemRef || '(none)'}.`,
    '',
    'Dispatch comment from Luke:',
    entry.comment,
    '',
    'Per secondbrain/memory/feedback_dispatch_means_act_now.md (canonical):',
    '- Default outcome is implement_now, not backlog_add or needs_human_reply.',
    '- If the dispatch is unambiguous, do the code change THIS turn.',
    '- If genuinely ambiguous, send the question via Telegram + draft the most-likely interpretation.',
    '',
    'Constraints: stay inside the secondbrain repo, commit the change with a',
    'message that includes "dispatch:' + entry.ts + '", push to the current',
    'branch. Do not delete files unless explicitly asked. Do not touch .env',
    'or anything in claude-config/.',
    '',
    'When done, print a one-paragraph summary of what shipped and the commit SHA.',
  ].join('\n');
  try {
    const out = spawnSync(CLAUDE_CLI, ['-p', prompt], {
      cwd: ACT_REPO,
      encoding: 'utf8',
      timeout: ACT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: '' },
    });
    if (out.error) return { ok: false, error: out.error.message };
    if (out.status !== 0) return { ok: false, error: 'claude exit ' + out.status, stderr: (out.stderr || '').slice(0, 400) };
    return { ok: true, summary: (out.stdout || '').slice(-2000) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function writeActLog(entry) {
  ensureDir(ACT_LOG);
  fs.appendFileSync(ACT_LOG, JSON.stringify(entry) + '\n');
}

async function processOne(entry, processed) {
  const id = hashEntry(entry);
  if (processed.has(id)) return { id, skipped: true };
  // ACT-NOW path -- spawn Claude CLI to do the work.
  if (ACT_NOW) {
    const r = spawnClaudeAct(entry);
    const action = r.ok
      ? { type: 'implement_now', summary: r.summary }
      : { type: 'implement_failed', error: r.error, stderr: r.stderr };
    writeActLog({ ...entry, acted_at: new Date().toISOString(), result: r });
    appendLog({ ...entry, processed_at: new Date().toISOString(), action });
    processed.add(id);
    return { id, action };
  }
  // Legacy classify-and-park path (kept for fallback / env-var off).
  const classification = await classifyWithClaude(entry);
  if (classification.error) {
    appendLog({ ...entry, processed_at: new Date().toISOString(), action: 'classify_failed', error: classification.error });
    processed.add(id);
    return { id, error: classification.error };
  }
  let action = null;
  if (classification.category === 'bug' || classification.category === 'feature') {
    const result = addToBacklog(classification, entry);
    action = { type: 'backlog_add', ...result, classification };
  } else if (classification.category === 'preference') {
    action = { type: 'memory_suggested', classification, note: 'preference-type dispatches should be reviewed before writing memory' };
  } else if (classification.category === 'question' || classification.category === 'clarify') {
    action = { type: 'needs_human_reply', classification };
  }
  appendLog({ ...entry, processed_at: new Date().toISOString(), classification, action });
  processed.add(id);
  return { id, action, classification };
}

async function runOnce() {
  const queue = readQueue();
  const processed = loadProcessed();
  let handled = 0;
  for (const entry of queue) {
    try {
      const r = await processOne(entry, processed);
      if (!r.skipped) handled++;
    } catch (e) {
      console.error('[process-dispatches] failed:', e.message);
    }
  }
  saveProcessed(processed);
  return { total: queue.length, handled, skipped: queue.length - handled };
}

async function runWatch() {
  console.log('[process-dispatches] watch mode — 60s interval');
  while (true) {
    try {
      const r = await runOnce();
      if (r.handled > 0) console.log(`[process-dispatches] handled ${r.handled}/${r.total}`);
    } catch (e) { console.error('[process-dispatches] loop error:', e.message); }
    await new Promise((r) => setTimeout(r, 60000));
  }
}

if (require.main === module) {
  const mode = process.argv.includes('--watch') ? 'watch' : 'once';
  (mode === 'watch' ? runWatch() : runOnce().then((r) => {
    console.log(JSON.stringify(r, null, 2));
  })).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runOnce, processOne, readQueue, hashEntry };
