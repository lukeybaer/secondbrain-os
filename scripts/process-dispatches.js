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
const { isCliFailureOutput, buildClaudeCliEnv } = require('./lib/cli-output-guard');

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

// Telegram alert path. Used by 2026-05-04 #gap fix: urgent bug
// dispatches must not disappear into a 10-cap backlog silently. Every
// urgent dispatch pings Luke + the dashboard so the receipt is visible
// the moment the dispatch is processed, not the next morning.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[process-dispatches] telegram skipped: no TELEGRAM_BOT_TOKEN in env');
    return;
  }
  try {
    const { execSync } = require('child_process');
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const result = execSync(
      `curl -s -X POST "${url}" -d chat_id=${TELEGRAM_CHAT_ID} -d "text=${encodeURIComponent(message)}" -d parse_mode=HTML`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const parsed = JSON.parse(result);
    if (parsed && parsed.ok) {
      console.log('[process-dispatches] telegram alert sent (msg_id ' + (parsed.result && parsed.result.message_id) + ')');
    } else {
      console.error('[process-dispatches] telegram alert non-ok:', result.slice(0, 200));
    }
  } catch (e) {
    console.error('[process-dispatches] telegram send failed:', e.message);
  }
}

// Detect Amy's own call responses leaking into the dispatch queue from Vapi
// transcripts. These are NOT Luke's feedback. They start with patterns like
// "I'll make sure", "What do you want to discuss", "If you have any other",
// "We have sent you an email", "Give me a moment", etc.
function isAmyResponse(comment) {
  const amyPatterns = [
    /^i'?ll\s+(?:make|ensure|send|prioritize|keep|have|get|check)/,
    /^what\s+do\s+you\s+want\s+to\s+discuss/,
    /^if\s+you\s+(?:have|do\s+not|don'?t)\s+(?:any|see)/,
    /^we\s+have\s+sent\s+you/,
    /^(?:give|let)\s+me\s+(?:a\s+moment|one\s+moment|a\s+sec)/,
    /^(?:the\s+script\s+responsible|without\s+a\s+confirmed)/,
    /^let\s+me\s+refine\s+the\s+focus/,
    /^you\s+(?:had\s+a\s+call|did\s+talk)/,
    /^the\s+call\s+with\b/,
  ];
  return amyPatterns.some((p) => p.test(comment));
}

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

  // Voice directive filter: skip entries where the comment is Amy's own
  // call response, not Luke's feedback. Amy's words start with "I'll",
  // "What do you want to discuss", "If you have any other", etc. These
  // leak into the queue from Vapi call transcripts and are not dispatches.
  if ((entry.source === 'vapi_call' || section === 'voice_directive') && isAmyResponse(c)) {
    return { category: 'skip', priority: 'none', target_area: '', proposed_action: 'filtered: Amy response, not a Luke dispatch', summary: (entry.comment || '').slice(0, 60), classified_by: 'heuristic' };
  }

  // Bug indicators. Imperative "fix" verbs and "broken/wrong/missing"
  // tokens are the strongest signal a current behavior is wrong. Tightened
  // 2026-05-04 #gap after Luke audit found 41 dispatches misrouted to
  // clarify/question by the previous loose set. Tightened again 2026-05-19
  // after second audit found 30 items falling to clarify. Added: "looks
  // bad", "makes no sense", "this can't be right", "why is this empty",
  // "why didn't", "I told you", complaint-about-inaction as bug not clarify.
  const bugPatterns = [
    /\bbug\b/, /\bfix\s+(?:it|this|that|now|today|me)\b/, /\bjust\s+fix\b/,
    /\bfix\s+\w+\s+(?:now|today)\b/, /\bdon'?t\s+wait\b/, /\bwait\s+for\s+a\s+day\b/,
    /shows?\s+zero/, /not\s+(?:working|loading|rendering)/,
    /\bbroken\b/, /\bwrong\b/, /\bmissing\b/, /\billegible\b/,
    /says?\s+news:/, /mislabel/, /can'?t\s+be\s+(?:true|right)/,
    /\bstill\s+(?:too\s+broad|red|broken|wrong|stuck)\b/,
    /should\s+not/, /shouldn'?t/, /won'?t/,
    /^why\s+(?:question\s+mark|is\s+this\s+empty|is\s+this\s+\w+\s+(?:not|empty|missing|broken))/,
    /\bthis\s+is\s+(?:broken|wrong|empty|illegible|a\s+bug)\b/,
    // 2026-05-19: new patterns from audit of 30 misrouted "clarify" items
    /\blooks?\s+bad\b/, /\bmakes?\s+no\s+sense\b/, /\bso\s+much\s+white\s*space\b/,
    /\bwhy\s+(?:is\s+this|didn'?t|would)\b/, /\bi\s+told\s+you\b/,
    /\bwhy\s+do\s+i\s+need\s+to\b/, /\bi\s+don'?t\s+understand\b/,
    /\bfailing\b.*\brule\b/, /\bnot\s+enough\b/,
    // Complaints about inaction that the question filter was stealing
    /\bwhy\s+(?:don'?t|aren'?t|isn'?t|haven'?t|didn'?t)\s+(?:you|we|u)\b/,
    // Data accuracy complaints
    /\bcan'?t\s+be\s+right\b/, /\bsomething'?s?\s+wrong\b/,
  ];
  const isBug = bugPatterns.some((p) => p.test(c));

  // Preference indicators (telling Amy how she should behave going forward)
  const prefPatterns = [
    /^\s*(?:don'?t|never|always|from now on|going forward)\s+(?:tell|reply|respond|use|skip|chunk|narrate|repeat|show|surface|wait)/,
    /\bi prefer\b/, /\bi want you to\b.*\balways\b/,
    /\bnever tell me\b/, /\binstead of\b.*\balways\b/,
  ];
  const isPref = prefPatterns.some((p) => p.test(c));

  // Question indicators. Tightened 2026-05-04: "why don't you do X" is
  // a complaint about inaction, NOT a question, so it falls through to
  // bug/feature. Real questions end in "?" or open with "what do you
  // need / why are / why is / why am" without a "do this" follow-up.
  const isComplaintAboutInaction = /\bwhy\s+(?:don'?t|aren'?t|isn'?t|haven'?t)\s+(?:you|we)\b.*?\b(?:do|implement|fix|add|build)\b/.test(c)
    || /\bwhy\s+wait\b/.test(c);
  const qPatterns = [/\?$/, /\?\s/, /what\s+do\s+you\s+need/i, /why\s+(?:are|is|am)/i];
  const isQuestion = !isComplaintAboutInaction && qPatterns.some((p) => p.test(c));

  // Feature indicators (adds, includes, enhances). Now captures verbs
  // anywhere in the sentence (not just at start) and treats "do this/it",
  // "implement X", "build X" as actionable across the whole comment.
  // 2026-05-19: added "let me [verb]", "check for", "in the future",
  // "I want to [click/scroll/see]", "I want [count]".
  const featPatterns = [
    /^\s*(?:add|include|surface|show|expose|expand|build|make)\b/,
    /\b(?:add|include|surface|expose|expand|build|implement)\s+(?:a|an|the|more|some|that|this|it|me|us)\b/,
    /\bdo\s+(?:this|that|it|the|a)\b/,
    /\bdo\s+\w+\s+(?:today|now|this\s+time)\b/,
    /\bneed\s+(?:more|to\s+see|to\s+have)\b/, /\bwant\s+(?:more|to\s+see|to\s+have)\b/,
    /\bsplit\s+(?:out|them|it)\b/, /\bbreak\s+(?:down|out)\b/,
    /\bi\s+don'?t\s+see\b/, /\bdoesn'?t\s+show\b/,
    // 2026-05-19: UI/UX requests and process preferences
    /\blet\s+me\s+(?:scroll|click|expand|see|view|open|drag|sort|filter)\b/,
    /\bcheck\s+for\s+(?:my|his|her|their|our)\b/,
    /\bin\s+the\s+future\b/, /\bfrom\s+now\s+on\b/,
    /\bi\s+want\s+(?:to\s+(?:click|scroll|see|view)|five|\d+)\b/,
    /\bi\s+approve\b/,
  ];
  const isFeature = featPatterns.some((p) => p.test(c));

  // Order matters. Bug beats feature (fix-it dispatches must route to
  // urgent), feature beats preference, preference beats question, and
  // anything actionable beats clarify.
  let category = 'clarify';
  if (isBug) category = 'bug';
  else if (isFeature) category = 'feature';
  else if (isPref) category = 'preference';
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
  // 2026-05-04 #gap: ping Telegram for urgent dispatches so the receipt is
  // visible the moment the dispatch lands, not the next morning. Closes the
  // "you said tomorrow but never" cycle.
  if (classification.priority === 'urgent') {
    const sectionTag = entry.section ? `[${entry.section}] ` : '';
    sendTelegramAlert(
      `<b>Urgent dispatch queued</b>\n${sectionTag}${(entry.comment || '').slice(0, 240)}\n\n` +
      `Backlog id: <code>${id}</code>\nSource: ${entry.source || 'unknown'}\n` +
      `(Auto-pin from process-dispatches; the next Amy session must drain urgent items at start.)`
    );
  }
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

function fetchSessionArchiveContext(commentText) {
  // Pull top hits from ~/.secondbrain/sessions.db so the spawned Claude
  // session has visibility into prior Claude Code conversations on this
  // topic. Without this, dispatch acts blind to context that may have
  // been built up across earlier sessions.
  const { spawnSync } = require('child_process');
  const { resolvePythonExe } = require('./lib/python-resolver');
  const py = path.join(REPO, 'scripts', 'sb-session-search.py');
  if (!fs.existsSync(py)) return '';
  try {
    const r = spawnSync(resolvePythonExe(), [py, 'search', String(commentText || '').slice(0, 500), '--limit', '3', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (r.status !== 0 || !r.stdout) return '';
    const hits = JSON.parse(r.stdout);
    if (!Array.isArray(hits) || hits.length === 0) return '';
    const lines = ['### Prior session archive (FTS5 hits, possibly relevant)'];
    for (const h of hits) {
      const date = (h.started_at || '').slice(0, 10);
      const sid = (h.session_id || '').slice(0, 8);
      lines.push(`- [${date}] ${h.repo} ${sid} (msgs=${h.message_count})`);
      if (h.topic_guess) lines.push(`  topic : ${String(h.topic_guess).trim().slice(0, 140).replace(/\s+/g, ' ')}`);
      if (h.last_response) lines.push(`  amy   : ${String(h.last_response).trim().slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    lines.push('(For full context: bash scripts/sb-session-search.py show <id>)');
    return lines.join('\n');
  } catch {
    return '';
  }
}

function spawnClaudeAct(entry) {
  const { spawnSync } = require('child_process');
  const archiveContext = fetchSessionArchiveContext(entry.comment);
  const prompt = [
    'You are Amy, Luke Baers autonomous executive assistant. A dispatch just landed.',
    `Source: ${entry.source}, Section: ${entry.section}.`,
    `Item reference: ${entry.itemRef || '(none)'}.`,
    '',
    'Dispatch comment from Luke:',
    entry.comment,
    '',
    archiveContext ? archiveContext + '\n' : '',
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
      // buildClaudeCliEnv injects the Max-plan OAuth token, strips stray
      // API keys, and clears CLAUDECODE.
      env: buildClaudeCliEnv(process.env),
    });
    if (out.error) return { ok: false, error: out.error.message };
    if (out.status !== 0) return { ok: false, error: 'claude exit ' + out.status, stderr: (out.stderr || '').slice(0, 400) };
    // The CLI prints auth/quota failures to stdout and exits 0, so a zero
    // exit is NOT proof the dispatch was acted on. Without this check a
    // not-logged-in CLI made every dispatch log as a successful act.
    if (isCliFailureOutput(out.stdout) || isCliFailureOutput(out.stderr)) {
      return { ok: false, error: 'claude CLI auth/quota failure', stderr: (out.stdout || out.stderr || '').slice(0, 400) };
    }
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
  // Skip Amy's own responses that leaked into the queue from Vapi transcripts.
  const classification = await classifyWithClaude(entry);
  if (classification.category === 'skip') {
    appendLog({ ...entry, processed_at: new Date().toISOString(), action: { type: 'filtered_amy_response' }, classification });
    processed.add(id);
    return { id, action: { type: 'filtered_amy_response' } };
  }
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
  // classification already computed above (before skip filter).
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

module.exports = { runOnce, processOne, readQueue, hashEntry, classifyHeuristic };
