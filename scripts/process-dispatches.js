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
 *  - bug        → add to feature-backlog.json as urgent, log a notification receipt
 *  - feature    → add to feature-backlog.json normally
 *  - preference → save to memory/feedback_*.md
 *  - question   → write the answer to the dispatch log/dashboard surface
 *  - clarify    → write the clarification ask to the dispatch log/dashboard surface
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
const isLinuxEc2 =
  process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data/agent/dispatch-queue.jsonl');
const QUEUE =
  process.env.DISPATCH_QUEUE ||
  (isLinuxEc2
    ? '/opt/secondbrain/data/agent/dispatch-queue.jsonl'
    : path.join(REPO, 'data', 'agent', 'dispatch-queue.jsonl'));
const PROCESSED = path.join(path.dirname(QUEUE), 'dispatch-processed.json');
const LOG = path.join(path.dirname(QUEUE), 'amy-dispatch-log.jsonl');
const BACKLOG = path.join(REPO, 'data', 'agent', 'feature-backlog.json');
const MEMORY_DIR = path.join(REPO, 'memory');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Telegram alert path. Used by 2026-05-04 #gap fix: urgent bug
// dispatches must not disappear into a 10-cap backlog silently. Every
// urgent dispatch pings ExampleCo + the dashboard so the receipt is visible
// the moment the dispatch is processed, not the next morning.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// 2026-06-09: routed through the central notify chokepoint so the universal
// upstream-error scrub (HTTP 4xx / not_found_error model leaks) applies. Urgent
// dispatch pings are not Telegram-reactive, so kind='spine-result' is logged and
// suppressed by policy unless a future caller explicitly proves Telegram origin.
function sendTelegramAlert(message) {
  try {
    const { notifyWithFallback } = require('./lib/notify-with-fallback');
    notifyWithFallback({
      text: String(message),
      source: 'process-dispatches',
      kind: 'spine-result',
      priority: 'urgent',
    });
  } catch (e) {
    console.error('[process-dispatches] telegram notify failed:', e.message);
  }
}

// Detect Amy's own call responses leaking into the dispatch queue from Vapi
// transcripts. These are NOT ExampleCo's feedback. They start with patterns like
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
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED, 'utf8')).ids);
  } catch {
    return new Set();
  }
}
function saveProcessed(ids) {
  ensureDir(PROCESSED);
  fs.writeFileSync(PROCESSED, JSON.stringify({ ids: [...ids] }, null, 2));
}

function readQueue() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs
    .readFileSync(QUEUE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendLog(entry) {
  ensureDir(LOG);
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

const AMY_DISPATCH_SIGNAL = /(?:^|[^\w])#amy\b|hashtag\s+amy\b/i;
const EXPLICIT_DISPATCH_SOURCES = new Set([
  'dashboard',
  'briefing_dashboard_right_click',
  'briefing-surface',
  'mobile_briefing_long_press',
  'mobile-briefing-page',
  'telegram',
  'telegram_command',
  'voice',
  'call',
]);

function hasAmyDispatchSignal(entry) {
  return AMY_DISPATCH_SIGNAL.test(
    [entry.comment, entry.text, entry.prompt, entry.title, entry.subject, entry.section]
      .filter(Boolean)
      .join('\n'),
  );
}

function isExplicitDispatchEntry(entry) {
  if (entry && (entry.explicitAmyTrigger === true || entry.explicitRequest === true)) return true;
  const source = String((entry && entry.source) || '').toLowerCase();
  if (source === 'gmail' || source === 'gmail_amy_email' || source === 'otter') {
    return hasAmyDispatchSignal(entry || {});
  }
  if (EXPLICIT_DISPATCH_SOURCES.has(source)) return true;
  return hasAmyDispatchSignal(entry || {});
}

function classifyHeuristic(entry) {
  const c = (entry.comment || '').toLowerCase();
  const section = (entry.section || '').toLowerCase();

  // Voice directive filter: skip entries where the comment is Amy's own
  // call response, not ExampleCo's feedback. Amy's words start with "I'll",
  // "What do you want to discuss", "If you have any other", etc. These
  // leak into the queue from Vapi call transcripts and are not dispatches.
  if ((entry.source === 'vapi_call' || section === 'voice_directive') && isAmyResponse(c)) {
    return {
      category: 'skip',
      priority: 'none',
      target_area: '',
      proposed_action: 'filtered: Amy response, not a ExampleCo dispatch',
      summary: (entry.comment || '').slice(0, 60),
      classified_by: 'heuristic',
    };
  }

  // Bug indicators. Imperative "fix" verbs and "broken/wrong/missing"
  // tokens are the strongest signal a current behavior is wrong. Tightened
  // 2026-05-04 #gap after ExampleCo audit found 41 dispatches misrouted to
  // clarify/question by the previous loose set. Tightened again 2026-05-19
  // after second audit found 30 items falling to clarify. Added: "looks
  // bad", "makes no sense", "this can't be right", "why is this empty",
  // "why didn't", "I told you", complaint-about-inaction as bug not clarify.
  const bugPatterns = [
    /\bbug\b/,
    /\bfix\s+(?:it|this|that|now|today|me)\b/,
    /\bjust\s+fix\b/,
    /\bfix\s+\w+\s+(?:now|today)\b/,
    /\bdon'?t\s+wait\b/,
    /\bwait\s+for\s+a\s+day\b/,
    /shows?\s+zero/,
    /not\s+(?:working|loading|rendering)/,
    /\bbroken\b/,
    /\bwrong\b/,
    /\bmissing\b/,
    /\billegible\b/,
    /says?\s+news:/,
    /mislabel/,
    /can'?t\s+be\s+(?:true|right)/,
    /\bstill\s+(?:too\s+broad|red|broken|wrong|stuck)\b/,
    /should\s+not/,
    /shouldn'?t/,
    /won'?t/,
    /^why\s+(?:question\s+mark|is\s+this\s+empty|is\s+this\s+\w+\s+(?:not|empty|missing|broken))/,
    /\bthis\s+is\s+(?:broken|wrong|empty|illegible|a\s+bug)\b/,
    // 2026-05-19: new patterns from audit of 30 misrouted "clarify" items
    /\blooks?\s+bad\b/,
    /\bmakes?\s+no\s+sense\b/,
    /\bso\s+much\s+white\s*space\b/,
    /\bwhy\s+(?:is\s+this|didn'?t|would)\b/,
    /\bi\s+told\s+you\b/,
    /\bwhy\s+do\s+i\s+need\s+to\b/,
    /\bi\s+don'?t\s+understand\b/,
    /\bfailing\b.*\brule\b/,
    /\bnot\s+enough\b/,
    // Complaints about inaction that the question filter was stealing
    /\bwhy\s+(?:don'?t|aren'?t|isn'?t|haven'?t|didn'?t)\s+(?:you|we|u)\b/,
    // Data accuracy complaints
    /\bcan'?t\s+be\s+right\b/,
    /\bsomething'?s?\s+wrong\b/,
  ];
  const isBug = bugPatterns.some((p) => p.test(c));

  // Preference indicators (telling Amy how she should behave going forward)
  const prefPatterns = [
    /^\s*(?:don'?t|never|always|from now on|going forward)\s+(?:tell|reply|respond|use|skip|chunk|narrate|repeat|show|surface|wait)/,
    /\bi prefer\b/,
    /\bi want you to\b.*\balways\b/,
    /\bnever tell me\b/,
    /\binstead of\b.*\balways\b/,
  ];
  const isPref = prefPatterns.some((p) => p.test(c));

  // Question indicators. Tightened 2026-05-04: "why don't you do X" is
  // a complaint about inaction, NOT a question, so it falls through to
  // bug/feature. Real questions end in "?" or open with "what do you
  // need / why are / why is / why am" without a "do this" follow-up.
  const isComplaintAboutInaction =
    /\bwhy\s+(?:don'?t|aren'?t|isn'?t|haven'?t)\s+(?:you|we)\b.*?\b(?:do|implement|fix|add|build)\b/.test(
      c,
    ) || /\bwhy\s+wait\b/.test(c);
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
    /\bneed\s+(?:more|to\s+see|to\s+have)\b/,
    /\bwant\s+(?:more|to\s+see|to\s+have)\b/,
    /\bsplit\s+(?:out|them|it)\b/,
    /\bbreak\s+(?:down|out)\b/,
    /\bi\s+don'?t\s+see\b/,
    /\bdoesn'?t\s+show\b/,
    // 2026-05-19: UI/UX requests and process preferences
    /\blet\s+me\s+(?:scroll|click|expand|see|view|open|drag|sort|filter)\b/,
    /\bcheck\s+for\s+(?:my|his|her|their|our)\b/,
    /\bin\s+the\s+future\b/,
    /\bfrom\s+now\s+on\b/,
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
  const priority = category === 'bug' ? 'urgent' : 'normal';

  // Target area guess from section
  const targetMap = {
    'system health': 'ec2-server.js SYSTEM HEALTH renderer',
    'feature backlog': 'ec2-server.js FEATURE BACKLOG renderer + data/agent/feature-backlog.json',
    'content pipeline': 'ec2-server.js CONTENT PIPELINE renderer + content-review queue',
    'reputation risk': 'scripts for reputation risk scan + ec2-server.js renderer',
    'token usage': 'scripts/suggest-token-reduction.js',
    linkedin: 'scripts/linkedin-bulk-scan.js + LinkedIn draft generator',
    'world news': 'briefing news feed pipeline + WORLD NEWS renderer',
    approved: 'ec2-server.js APPROVED section renderer',
    'action items': 'ec2-server.js ACTION ITEMS renderer',
    'ai & tech news': 'briefing news feed + video proposal pipeline',
  };
  let target = '';
  for (const [k, v] of Object.entries(targetMap)) {
    if (section.includes(k)) {
      target = v;
      break;
    }
  }

  // Summary: first 50 chars of the comment, Title Case-ish
  const summary = (entry.comment || '').slice(0, 60).replace(/\s+/g, ' ').trim();

  return {
    category,
    priority,
    target_area: target,
    proposed_action:
      category === 'bug'
        ? `Fix the bug in ${target || entry.section}`
        : category === 'feature'
          ? `Build the enhancement in ${target || entry.section}`
          : category === 'preference'
            ? `Save as a memory rule for future sessions`
            : category === 'question'
              ? `Write the answer to the dispatch log/dashboard surface`
              : `Ask ExampleCo for clarification — too ambiguous to route`,
    summary,
    classified_by: 'heuristic',
  };
}

function classifyWithClaude(entry) {
  return Promise.resolve(classifyHeuristic(entry));
}

function addToBacklog(classification, entry) {
  let backlog = { items: [], updatedAt: new Date().toISOString() };
  try {
    backlog = JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  } catch {
    /* fresh */
  }
  if (!Array.isArray(backlog.items)) backlog.items = [];
  const id = 'dispatch-' + hashEntry(entry);
  if (backlog.items.some((it) => it.id === id))
    return { added: false, id, reason: 'already in backlog' };
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
    score: classification.priority === 'urgent' ? 20 : classification.priority === 'low' ? 5 : 10,
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
        `Backlog id: <code>${id}</code>\nSource: ${entry.source || 'ExampleCo'}\n` +
        `(Auto-pin from process-dispatches; the next Amy session must drain urgent items at start.)`,
    );
  }
  return { added: true, id };
}

// 2026-04-26 ExampleCo Otter dispatch -- "architectural change to like dispatch
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
// 2026-06-14: pin a live model on every `claude -p` spawn below. When the CLI
// is invoked with no --model AND its OAuth token is stale/mid-refresh, it
// resolves to its retired built-in default (claude-3-5-sonnet-20241022) and the
// Anthropic API 404s. codexRescue already backstops that, but pinning a current
// model removes the trigger entirely so the rescue rarely fires.
const CLI_MODEL = process.env.DISPATCH_CLI_MODEL || 'claude-sonnet-4-6';
const ACT_LOG = path.join(path.dirname(QUEUE), 'dispatch-act-log.jsonl');
const ACT_TIMEOUT_MS = parseInt(process.env.DISPATCH_ACT_TIMEOUT_MS || '420000', 10);
const ACT_REPO = process.env.DISPATCH_ACT_REPO || REPO;
const { ensureCodexWorktree } = require('./lib/codex-worktree.js');

// Resolve how to launch Claude Code cross-platform. On Windows `claude` is a
// .cmd shim that spawnSync cannot exec directly (ENOENT), so prefer invoking
// `node <cli.js>` (the documented local pattern) and fall back to the CLAUDE_CLI
// binary only if cli.js is not found. 2026-06-01: the PC executor failed with
// "spawnSync claude ENOENT" until this resolver landed.
const os = require('os');
function resolveClaudeCli(
  candidates = [
    process.env.CLAUDE_CLI_JS,
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js',
    ),
  ].filter(Boolean),
  existsFn = fs.existsSync,
  execPath = process.execPath,
  fallback = CLAUDE_CLI,
) {
  for (const c of candidates) {
    try {
      if (existsFn(c)) return { exec: execPath, baseArgs: [c] };
    } catch {
      /* keep trying */
    }
  }
  return { exec: fallback, baseArgs: [] };
}

function fetchSessionArchiveContext(commentText) {
  // Pull top hits from ~/.secondbrain/sessions.db so the spawned Claude
  // session has visibility into prior Claude Code conversations on this
  // topic. Without this, dispatch acts blind to context that may have
  // been built up across earlier sessions.
  //
  // This is OPTIONAL context: every failure path (missing optional module,
  // missing script, search error) must return '' and never throw, or it would
  // crash the autonomous executor before Claude even runs. 2026-06-01: the EC2
  // deploy dir lacked scripts/lib/python-resolver, and the bare require threw
  // and killed the dispatch loop.
  let spawnSync, resolvePythonExe;
  try {
    ({ spawnSync } = require('child_process'));
    ({ resolvePythonExe } = require('./lib/python-resolver'));
  } catch {
    return '';
  }
  const py = path.join(REPO, 'scripts', 'sb-session-search.py');
  if (!fs.existsSync(py)) return '';
  try {
    const r = spawnSync(
      resolvePythonExe(),
      [py, 'search', String(commentText || '').slice(0, 500), '--limit', '3', '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
    if (r.status !== 0 || !r.stdout) return '';
    const hits = JSON.parse(r.stdout);
    if (!Array.isArray(hits) || hits.length === 0) return '';
    const lines = ['### Prior session archive (FTS5 hits, possibly relevant)'];
    for (const h of hits) {
      const date = (h.started_at || '').slice(0, 10);
      const sid = (h.session_id || '').slice(0, 8);
      lines.push(`- [${date}] ${h.repo} ${sid} (msgs=${h.message_count})`);
      if (h.topic_guess)
        lines.push(`  topic : ${String(h.topic_guess).trim().slice(0, 140).replace(/\s+/g, ' ')}`);
      if (h.last_response)
        lines.push(
          `  amy   : ${String(h.last_response).trim().slice(0, 160).replace(/\s+/g, ' ')}`,
        );
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
  let actRepo;
  try {
    const ref = [entry.source, entry.section, entry.itemRef, entry.ts, entry.comment]
      .filter(Boolean)
      .join(' ');
    actRepo = ensureCodexWorktree({
      repoRoot: ACT_REPO,
      purpose: `dispatch-${ref}`,
      branchPrefix: 'codex/dispatch',
    }).cwd;
  } catch (e) {
    return { ok: false, error: 'dispatch isolation failed: ' + e.message, retryable: true };
  }
  const prompt = [
    'You are Amy, ExampleCo ExampleCos autonomous executive assistant. A dispatch just landed.',
    'Branch cleanliness: you are running in an isolated worktree for this dispatch.',
    `Do not edit the shared checkout at ${REPO}.`,
    `Source: ${entry.source}, Section: ${entry.section}.`,
    `Item reference: ${entry.itemRef || '(none)'}.`,
    '',
    'Dispatch comment from ExampleCo:',
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
    'When done, print a one-ExampleCoraph summary of what shipped and the commit SHA.',
  ].join('\n');
  // CODEX RESCUE RUNG (2026-06-11 ladder plan P1/P2): when the Claude rung
  // fails on an auth/quota sentinel, the OpenAI-subscription codex CLI acts on
  // the dispatch instead (workspace-write sandbox: edits stay inside the repo).
  // Provider-outage failures are RETRYABLE: processOne must not consume the
  // dispatch id for them, so the watch loop retries next cycle.
  function codexRescue() {
    const os = require('os');
    const outFile = path.join(os.tmpdir(), 'dispatch-codex-' + Date.now() + '.txt');
    try {
      const out = spawnSync(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '-s',
          'workspace-write',
          '--output-last-message',
          outFile,
          prompt,
        ],
        {
          cwd: actRepo,
          encoding: 'utf8',
          timeout: ACT_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDECODE: '' },
        },
      );
      let text = '';
      try {
        text = require('fs').readFileSync(outFile, 'utf8').trim();
      } catch {
        text = (out.stdout || '').trim();
      }
      if (out.error)
        return { ok: false, error: 'codex spawn: ' + out.error.message, retryable: true };
      if (out.status !== 0 || !text || isCliFailureOutput(text)) {
        return {
          ok: false,
          error: 'codex rung failed (exit ' + out.status + ')',
          stderr: (text || out.stderr || '').slice(0, 400),
          retryable: true,
        };
      }
      return { ok: true, summary: '[via codex] ' + text.slice(-2000) };
    } finally {
      try {
        require('fs').unlinkSync(outFile);
      } catch (_e) {}
    }
  }
  try {
    const { exec, baseArgs } = resolveClaudeCli();
    const out = spawnSync(exec, [...baseArgs, '--model', CLI_MODEL, '--dangerously-skip-permissions', '-p', prompt], {
      cwd: actRepo,
      encoding: 'utf8',
      timeout: ACT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      // buildClaudeCliEnv injects the Max-plan OAuth token, strips stray
      // API keys, and clears CLAUDECODE.
      env: buildClaudeCliEnv(process.env),
    });
    if (out.error) return codexRescue();
    if (out.status !== 0) return codexRescue();
    // The CLI prints auth/quota failures to stdout and exits 0, so a zero
    // exit is NOT proof the dispatch was acted on. Without this check a
    // not-logged-in CLI made every dispatch log as a successful act.
    if (isCliFailureOutput(out.stdout) || isCliFailureOutput(out.stderr)) {
      return codexRescue();
    }
    return { ok: true, summary: (out.stdout || '').slice(-2000) };
  } catch (e) {
    return { ok: false, error: e.message, retryable: true };
  }
}

function writeActLog(entry) {
  ensureDir(ACT_LOG);
  fs.appendFileSync(ACT_LOG, JSON.stringify(entry) + '\n');
}

async function processOne(entry, processed) {
  const id = hashEntry(entry);
  if (processed.has(id)) return { id, skipped: true };
  if (!isExplicitDispatchEntry(entry)) {
    const action = { type: 'archived_no_explicit_request' };
    appendLog({
      ...entry,
      processed_at: new Date().toISOString(),
      action,
      note: 'queue row recorded but not acted on because it had no explicit #Amy/hashtag Amy request or approved command source',
    });
    processed.add(id);
    return { id, action };
  }
  // Skip Amy's own responses that leaked into the queue from Vapi transcripts.
  const classification = await classifyWithClaude(entry);
  if (classification.category === 'skip') {
    appendLog({
      ...entry,
      processed_at: new Date().toISOString(),
      action: { type: 'filtered_amy_response' },
      classification,
    });
    processed.add(id);
    return { id, action: { type: 'filtered_amy_response' } };
  }
  // ACT-NOW path -- spawn Claude CLI to do the work (codex rescue inside).
  if (ACT_NOW) {
    if (!['bug', 'feature', 'preference'].includes(classification.category)) {
      const action = { type: 'needs_human_reply', classification };
      appendLog({ ...entry, processed_at: new Date().toISOString(), classification, action });
      processed.add(id);
      return { id, action, classification };
    }
    const r = spawnClaudeAct(entry);
    if (!r.ok && r.retryable) {
      // PROVIDER OUTAGE (both ladder rungs down): defer, do NOT consume the
      // id. The watch loop retries next cycle once a provider recovers.
      // (2026-06-11 ladder plan: a Claude outage used to permanently eat
      // every dispatch that arrived during it.)
      const action = { type: 'implement_deferred_provider_outage', error: r.error };
      writeActLog({ ...entry, acted_at: new Date().toISOString(), result: r });
      appendLog({ ...entry, processed_at: new Date().toISOString(), action, deferred: true });
      return { id, action, deferred: true };
    }
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
    appendLog({
      ...entry,
      processed_at: new Date().toISOString(),
      action: 'classify_failed',
      error: classification.error,
    });
    processed.add(id);
    return { id, error: classification.error };
  }
  let action = null;
  if (classification.category === 'bug' || classification.category === 'feature') {
    const result = addToBacklog(classification, entry);
    action = { type: 'backlog_add', ...result, classification };
  } else if (classification.category === 'preference') {
    action = {
      type: 'memory_suggested',
      classification,
      note: 'preference-type dispatches should be reviewed before writing memory',
    };
  } else if (classification.category === 'question' || classification.category === 'clarify') {
    action = { type: 'needs_human_reply', classification };
  }
  appendLog({ ...entry, processed_at: new Date().toISOString(), classification, action });
  processed.add(id);
  return { id, action, classification };
}

// ── Stale command drainer ───────────────────────────────────────────────────
// The Vapi/Telegram command queue (ec2-server.js commandQueue, exposed via
// /commands/*) is only consumed by the Electron desktop-app worker. When the
// app is closed (e.g. a 1:41am phone call) commands sit pending forever and the
// work never triggers. This always-on processor adopts any command left pending
// past the grace window: it atomically forwards it (pending->forwarded, so the
// PC worker cannot also run it), drops it into THIS dispatch queue for the
// normal classify/backlog flow, and pings Telegram so ExampleCo knows it landed.
// 2026-06-01 fix. Pure logic + tests: scripts/lib/command-queue-forward.js.
const COMMAND_API_BASE = process.env.COMMAND_API_BASE || 'http://localhost:3001';
const COMMAND_GRACE_MIN = parseInt(process.env.COMMAND_GRACE_MIN || '5', 10);

function httpJson(method, url, body = null, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {};
      const req = lib.request(url, { method, timeout: timeoutMs, headers }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => resolve({ status: 0, body: null }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve({ status: 0, body: null });
      });
      if (payload) req.write(payload);
      req.end();
    } catch {
      resolve({ status: 0, body: null });
    }
  });
}

// ── Autonomous dev: branch -> claude edits -> commit -> push -> PR URL ────────
// The executor never touches master directly. For each command it starts from a
// clean checkout of the latest origin/master on a fresh branch, lets Claude make
// the change WITHOUT committing, then the wrapper commits exactly what changed
// and pushes the branch. A misheard command can only ever produce a branch/PR,
// never corrupt prod. Runs in DISPATCH_ACT_REPO when that is already isolated;
// if it points at the shared checkout, executeForwardedCommand creates a private
// worktree first so wrapper git operations and agent edits never touch master.
function gitInRepo(args, timeoutMs = 60000, repo = ACT_REPO) {
  const { spawnSync } = require('child_process');
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function autoBranchName(cmd) {
  const slug =
    String(cmd.id || 'cmd')
      .replace(/[^a-z0-9]/gi, '')
      .slice(-14) || 'cmd';
  return `auto/dispatch-${slug}`;
}

// Pure: derive a GitHub compare/PR URL from a remote URL (SSH or HTTPS form).
function compareUrlFromRemote(remoteUrl, branch) {
  const m = String(remoteUrl || '').match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) return '';
  return `https://github.com/${m[1]}/${m[2]}/compare/master...${branch}?expand=1`;
}

function repoCompareUrl(branch, repo = ACT_REPO) {
  const r = gitInRepo(['remote', 'get-url', 'origin'], 10000, repo);
  return compareUrlFromRemote((r.stdout || '').trim(), branch);
}

// Start each command from a clean branch off the freshest origin/master. Returns
// false if the repo could not be brought to a known-clean state (so we never run
// the agent on top of stale or dirty state).
function prepareCleanBranch(branch, repo = ACT_REPO) {
  const fetch = gitInRepo(['fetch', 'origin', 'master'], 90000, repo);
  if (fetch.status !== 0) {
    console.error('[autodev] fetch failed:', (fetch.stderr || '').slice(0, 200));
    return false;
  }
  const co = gitInRepo(['checkout', '-B', branch, 'origin/master'], 30000, repo);
  if (co.status !== 0) {
    console.error('[autodev] checkout failed:', (co.stderr || '').slice(0, 200));
    return false;
  }
  // Hard-clean any stray state so post-run `git status` reflects only Claude's edits.
  gitInRepo(['reset', '--hard', 'origin/master'], 30000, repo);
  gitInRepo(['clean', '-fd'], 30000, repo);
  return true;
}

// Run Claude to make the change but NOT commit/push. The wrapper owns git so we
// capture exactly the intended diff (no `git add -A` over a dirty tree).
function runClaudeForChange(entry, opts = {}, repo = ACT_REPO) {
  const archiveContext = fetchSessionArchiveContext(entry.comment);
  const prompt = [
    'You are Amy, ExampleCo ExampleCos autonomous executive assistant. A dispatched request landed and you are running headless to implement it.',
    `Source: ${entry.source}. Reference: ${entry.itemRef || '(none)'}.`,
    '',
    'Request from ExampleCo:',
    entry.comment,
    '',
    archiveContext ? archiveContext + '\n' : '',
    'Implement it fully in THIS repository (the current working directory). If it is a code change, write or update a regression test too.',
    'CRITICAL git rules: do NOT run git commit, git push, git checkout, or git reset. Just edit/create files in the working tree. A wrapper handles all git.',
    'Constraints: stay inside this repo, do not touch .env or anything under claude-config/, do not delete files unless explicitly asked.',
    'When done, print a one-ExampleCoraph summary of exactly what you changed and why.',
  ].join('\n');
  try {
    const { spawnSync } = require('child_process');
    const { exec, baseArgs } = resolveClaudeCli();
    // --dangerously-skip-permissions: this is a headless autonomous run, there is
    // no human to approve tool use. It is bounded to a throwaway branch in a
    // dedicated checkout, so the blast radius is a PR, never master.
    // Managed-wait (2026-06-02): the run budget is the command's wait-policy
    // deadline (default ~60m), not the old fixed 12-min hard kill. "Wait X then
    // close" maps to opts.deadlineMs; absent that, the legacy ACT_TIMEOUT_MS.
    const out = spawnSync(
      exec,
      [...baseArgs, '--model', CLI_MODEL, '--dangerously-skip-permissions', '-p', prompt],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: opts.deadlineMs || ACT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeCliEnv(process.env),
      },
    );
    if (out.error) return { ok: false, error: out.error.message };
    if (out.status !== 0)
      return {
        ok: false,
        error: 'claude exit ' + out.status,
        stderr: (out.stderr || '').slice(0, 400),
      };
    // A real auth/quota failure does NO work: claude cannot run, so the sentinel
    // is only decisive when paired with an empty diff. Return it as a FLAG, not a
    // hard failure, so executeForwardedCommand can still ship a run that produced
    // real file changes even when the agent's own output legitimately contains a
    // 4xx / not_found / quota string (e.g. a dispatch whose task is ABOUT 404
    // errors). 2026-06-02: this false-positive silently discarded a completed
    // dispatch ("stop spamming me with 404s" edited cli-output-guard.js and was
    // thrown away as an "auth failure" because its summary mentioned 404).
    const authSentinel = isCliFailureOutput(out.stdout) || isCliFailureOutput(out.stderr);
    return { ok: true, summary: (out.stdout || '').slice(-2000), authSentinel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// One Amy applies, she does not park a PR for herself to merge. When
// DISPATCH_AUTOLAND is on and we are the EC2 drainer (the only host that has both
// a git checkout AND the live deploy), land the agent's diff straight to master
// and deploy it. EC2 has no test runner, so the gate is Codex's reviewed minimum:
// node --check on every changed .js plus a post-deploy /health probe with
// automatic rollback. Any gate failure (bad syntax, master moved, push rejected,
// unhealthy after deploy) degrades to a pushed branch + PR link and NEVER leaves
// a broken master live. Codex-reviewed 2026-06-02 (one-Amy apply+deploy).
const AUTOLAND = process.env.DISPATCH_AUTOLAND === '1';
const LIVE_ROOT = process.env.LIVE_DEPLOY_ROOT || '/opt/secondbrain';
const HEALTH_URL = (process.env.COMMAND_API_BASE || 'http://localhost:3001') + '/health';
const NEW_LIVE_FILES = new Set([
  'scripts/callback-watchdog.js',
  'scripts/lib/voice-cloud-runtime.js',
  'scripts/lib/vapi-tool-contract.js',
  'scripts/lib/voice-tool-policy.js',
  'scripts/lib/spine-ingress.js',
]);

function changedFilesInRepo(repo = ACT_REPO) {
  const r = gitInRepo(['status', '--porcelain'], 20000, repo);
  return String(r.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      let p = l.slice(3).trim();
      // Rename/copy rows are "XY orig -> new"; the new path is what is on disk.
      const arrow = p.indexOf(' -> ');
      if (arrow !== -1) p = p.slice(arrow + 4).trim();
      // git quotes paths with special chars (core.quotePath); strip the wrapper.
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p;
    })
    .filter(Boolean);
}

function syntaxCheck(files, repo = ACT_REPO) {
  const { spawnSync } = require('child_process');
  for (const f of files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    const r = spawnSync('node', ['--check', path.join(repo, f)], {
      encoding: 'utf8',
      timeout: 20000,
    });
    if (r.status !== 0) return { ok: false, file: f, err: (r.stderr || '').slice(0, 300) };
  }
  return { ok: true };
}

async function backendHealthy(retries = 3, gapMs = 10000) {
  for (let i = 0; i < retries; i++) {
    const r = await httpJson('GET', HEALTH_URL, null, 8000);
    if (r.status === 200 && r.body && r.body.status === 'ok') return true;
    if (i < retries - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}

// ── Widened live deploy (Codex-reviewed 2026-06-02 follow-up) ─────────────────
// The first autoland only deployed ec2-server.js -> server.js, so a fix that
// touched a scripts/lib/*.js that server.js require()s landed to master but ran
// stale live until someone copied it by hand. Now the deploy step covers EVERY
// changed file that exists under /opt/secondbrain (map work-checkout path -> live
// path), restarts the affected PM2 process(es), and runs the same /health probe
// with auto-rollback for the FULL set. See memory/project_one_amy_apply_and_deploy.md.

// Map a repo-relative changed file to the absolute live path(s) it deploys to.
// ec2-server.js is special: PM2 runs /opt/secondbrain/server.js, so the work
// checkout's ec2-server.js must overwrite BOTH server.js and ec2-server.js (the
// 2026-04-22 trap in reference_ec2_server_deploy_path.md). Everything else maps
// 1:1 to LIVE_ROOT/<path>.
function deployTargetsFor(file) {
  if (file === 'ec2-server.js') {
    return [path.posix.join(LIVE_ROOT, 'server.js'), path.posix.join(LIVE_ROOT, 'ec2-server.js')];
  }
  return [path.posix.join(LIVE_ROOT, file)];
}

// Which long-running PM2 process(es) need a restart to pick up a changed file.
// ec2-server.js/server.js -> secondbrain-backend. process-dispatches.js ->
// dispatch-processor. callback-watchdog has its own always-on process. Shared
// libs and anything else are require()d by either backend or dispatcher, so
// restart both to be safe unless a narrower voice-runtime mapping is known.
function processesFor(file) {
  if (file === 'ec2-server.js') return ['secondbrain-backend'];
  if (file === 'scripts/process-dispatches.js') return ['dispatch-processor'];
  if (file === 'scripts/callback-watchdog.js') return ['callback-watchdog'];
  if (file === 'scripts/lib/voice-cloud-runtime.js') return ['secondbrain-backend', 'callback-watchdog'];
  return ['secondbrain-backend', 'dispatch-processor'];
}

// Containment guard: a deploy target must resolve to a path under LIVE_ROOT.
// A misheard/hostile dispatch can only ever surface paths via git status on the
// work checkout (git never tracks files outside the worktree), but normalize +
// prefix-check anyway so a "../../etc/x" style path can never escape the root.
function isUnderRoot(p) {
  const root = LIVE_ROOT.endsWith('/') ? LIVE_ROOT : LIVE_ROOT + '/';
  const norm = path.posix.normalize(p);
  return norm === LIVE_ROOT || norm.startsWith(root);
}

// Pure planner (testable without touching the filesystem). Returns the set of
// copies to make and the union of processes to restart. A target is included only
// if it is under LIVE_ROOT AND already exists there: a changed file that is not
// part of the live deploy (a test, a memory doc, or anything outside the root)
// lands to master but is never copied live.
function planDeploy(files, existsFn = fs.existsSync) {
  const copies = [];
  const procs = new Set();
  for (const f of files) {
    const targets = deployTargetsFor(f)
      .filter((t) => isUnderRoot(t) && (existsFn(t) || NEW_LIVE_FILES.has(f)))
      .map((t) => ({ live: t, newFile: !existsFn(t) }));
    if (targets.length === 0) continue;
    for (const target of targets) copies.push({ src: f, live: target.live, newFile: target.newFile });
    for (const p of processesFor(f)) procs.add(p);
  }
  return { copies, procs: [...procs] };
}

function restoreFiles(backups) {
  const { spawnSync } = require('child_process');
  let allOk = true;
  for (const { live, backup, newFile } of backups) {
    const r = newFile
      ? spawnSync('rm', ['-f', live], { encoding: 'utf8', timeout: 20000 })
      : spawnSync('cp', [backup, live], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) {
      allOk = false;
      // Fail loud: a silent failed restore leaves live state corrupt. The backup
      // is preserved on disk so a human can finish the restore by hand.
      console.error(
        `[autoland] ROLLBACK RESTORE FAILED for ${live}: ${(r.stderr || '').slice(0, 200)} (backup kept at ${backup})`,
      );
    }
  }
  return allOk;
}

function restartProcesses(procs) {
  const { spawnSync } = require('child_process');
  for (const p of procs) {
    let r;
    if (p === 'callback-watchdog') {
      const described = spawnSync('pm2', ['describe', p], { encoding: 'utf8', timeout: 15000 });
      r =
        described.status === 0
          ? spawnSync('pm2', ['restart', p, '--update-env'], { encoding: 'utf8', timeout: 30000 })
          : spawnSync(
              'pm2',
              [
                'start',
                path.posix.join(LIVE_ROOT, 'scripts/callback-watchdog.js'),
                '--name',
                p,
                '--cwd',
                LIVE_ROOT,
                '--update-env',
              ],
              { encoding: 'utf8', timeout: 30000 },
            );
    } else {
      r = spawnSync('pm2', ['restart', p, '--update-env'], { encoding: 'utf8', timeout: 30000 });
    }
    if (r.status !== 0) {
      return { ok: false, error: `pm2 restart/start failed for ${p}: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
    }
  }
  const save = spawnSync('pm2', ['save'], { encoding: 'utf8', timeout: 30000 });
  if (save.status !== 0) {
    return { ok: false, error: `pm2 save failed: ${(save.stderr || save.stdout || '').slice(0, 200)}` };
  }
  return { ok: true };
}

// Local on EC2: back up every live target, copy the work-checkout file over it,
// then restart the affected process(es). Mirrors the only real deploy path
// (health-self-heal.js) but local cp instead of scp since we are already on EC2.
// On any copy/backup failure, restore whatever was already overwritten and bail.
function deployFilesLocal(plan, repo = ACT_REPO) {
  const { spawnSync } = require('child_process');
  const stamp = String(Math.floor(Date.now() / 1000));
  const backups = [];
  for (const { src, live, newFile } of plan.copies) {
    const backup = `${live}.bak-${stamp}`;
    if (!newFile) {
      const b = spawnSync('cp', [live, backup], { encoding: 'utf8', timeout: 20000 });
      if (b.status !== 0) {
        restoreFiles(backups);
        return {
          ok: false,
          error: `backup failed for ${live}: ` + (b.stderr || '').slice(0, 200),
          backups,
        };
      }
    }
    backups.push({ live, backup: newFile ? null : backup, newFile });
    const r = spawnSync('cp', [path.join(repo, src), live], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) {
      restoreFiles(backups);
      return {
        ok: false,
        error: `copy failed for ${src} -> ${live}: ` + (r.stderr || '').slice(0, 200),
        backups,
      };
    }
  }
  const restarted = restartProcesses(plan.procs);
  if (!restarted.ok) {
    restoreFiles(backups);
    return { ok: false, error: restarted.error, backups };
  }
  return { ok: true, backups, procs: plan.procs };
}

function rollbackDeploy(backups, procs, badSha, repo = ACT_REPO) {
  restoreFiles(backups);
  restartProcesses(procs);
  if (badSha) {
    gitInRepo(['revert', '--no-edit', badSha], 30000, repo);
    gitInRepo(['push', 'origin', 'HEAD:master'], 120000, repo);
  }
}

// Optional real-test gate. EC2 normally has no vitest, so autoland is syntax +
// healthcheck only. If the work checkout has the dev deps installed
// (node_modules/.bin/vitest present, i.e. `npm ci` was run in /opt/secondbrain-work),
// run the suite before landing so a behavior regression degrades to a branch
// instead of shipping live. A no-op (ok:true, ran:false) when deps are absent.
function behaviorTestGate(repo = ACT_REPO) {
  const vitestBin = path.join(
    repo,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
  );
  if (!fs.existsSync(vitestBin)) return { ok: true, ran: false };
  const { spawnSync } = require('child_process');
  const r = spawnSync(vitestBin, ['run', '--silent'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: parseInt(process.env.AUTOLAND_TEST_TIMEOUT_MS || '600000', 10),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0)
    return { ok: false, ran: true, err: (r.stdout || r.stderr || '').slice(-600) };
  return { ok: true, ran: true };
}

// Land the agent's diff to master and deploy it, with rollback. Returns the same
// result shape executeForwardedCommand uses. On any gate failure it pushes the
// work branch and returns a PR link instead of landing, so master never breaks.
async function landAndDeploy(cmd, entry, branch, r, repo = ACT_REPO) {
  const compareUrl = repoCompareUrl(branch, repo);
  const files = changedFilesInRepo(repo);
  const msg = `auto: ${(entry.comment || 'dispatched change').slice(0, 64)} (dispatch:${cmd.id})`;
  gitInRepo(['add', '-A'], 30000, repo);
  const commit = gitInRepo(['commit', '-m', msg], 30000, repo);
  if (commit.status !== 0)
    return {
      ok: false,
      error: 'commit failed',
      stderr: (commit.stderr || '').slice(0, 300),
      summary: r.summary,
    };

  const syn = syntaxCheck(files, repo);
  if (!syn.ok) {
    gitInRepo(['push', '-u', 'origin', branch, '--force-with-lease'], 120000, repo);
    return {
      ok: false,
      error: `syntax check failed on ${syn.file}; pushed branch for review`,
      compareUrl,
      summary: r.summary,
    };
  }
  // Real unit tests when deps are installed; otherwise a no-op (EC2 default).
  const tests = behaviorTestGate(repo);
  if (!tests.ok) {
    gitInRepo(['push', '-u', 'origin', branch, '--force-with-lease'], 120000, repo);
    return {
      ok: false,
      error: `tests failed; pushed branch for review: ${(tests.err || '').slice(0, 200)}`,
      compareUrl,
      summary: r.summary,
    };
  }
  // Only land if origin/master has not moved since we branched (no concurrent clobber).
  gitInRepo(['fetch', 'origin', 'master'], 60000, repo);
  const mergeBase = String(
    gitInRepo(['merge-base', 'HEAD', 'origin/master'], 20000, repo).stdout || '',
  ).trim();
  const remoteMaster = String(
    gitInRepo(['rev-parse', 'origin/master'], 20000, repo).stdout || '',
  ).trim();
  if (!mergeBase || mergeBase !== remoteMaster) {
    gitInRepo(['push', '-u', 'origin', branch, '--force-with-lease'], 120000, repo);
    return {
      ok: false,
      error: 'origin/master moved (concurrent change); pushed branch instead of landing',
      compareUrl,
      summary: r.summary,
    };
  }
  const land = gitInRepo(['push', 'origin', 'HEAD:master', '--force-with-lease'], 120000, repo);
  if (land.status !== 0) {
    gitInRepo(['push', '-u', 'origin', branch, '--force-with-lease'], 120000, repo);
    return {
      ok: false,
      error: 'master push rejected (branch protection?); pushed branch instead',
      stderr: (land.stderr || '').slice(0, 300),
      compareUrl,
      summary: r.summary,
    };
  }
  const sha = String(gitInRepo(['rev-parse', 'HEAD'], 20000, repo).stdout || '')
    .trim()
    .slice(0, 10);

  // Deploy EVERY changed file that exists under LIVE_ROOT, not just ec2-server.js.
  const plan = planDeploy(files);
  if (plan.copies.length === 0) {
    return {
      ok: true,
      sha,
      deployed: false,
      summary: r.summary,
      note: 'no changed files map to the live deploy tree, so master was updated with no live redeploy needed',
    };
  }
  const dep = deployFilesLocal(plan, repo);
  if (!dep.ok) {
    // Best effort restore + revert so a half-applied deploy never stays live.
    rollbackDeploy(dep.backups || [], plan.procs, sha, repo);
    return {
      ok: false,
      error: 'landed to master but deploy failed (rolled back): ' + dep.error,
      sha,
      summary: r.summary,
    };
  }
  if (!(await backendHealthy())) {
    rollbackDeploy(dep.backups, dep.procs, sha, repo);
    return {
      ok: false,
      error: `deployed but /health failed; rolled back ${dep.backups.length} file(s) and reverted master`,
      sha,
      summary: r.summary,
    };
  }
  return {
    ok: true,
    sha,
    deployed: true,
    deployedFiles: dep.backups.map((b) => b.live),
    restarted: dep.procs,
    summary: r.summary,
  };
}

// "Execute, not park": a multi-channel command that no live consumer claimed gets
// the dev DONE here as a pushed branch + PR link, not a backlog entry or a
// notification. Returns a result object; closes the command via /complete.
const { classifyTaskKind } = require('./lib/dispatch-delivery');

// Read-only research executor: answer a question from the archive (memory,
// contacts, data). No git, no branch, no autoland. The answer IS the result and
// is delivered on the command's channel (spoken on a callback, or Telegram).
// 2026-06-03: research asks ("search memory for a contact history") were failing
// because they ran through the code/autoland path which cannot research.
function runResearch(entry, opts = {}) {
  const prompt = [
    'You are Amy, ExampleCo ExampleCos executive assistant, answering a question he asked by phone. You will read your answer back to him, so write it to be spoken.',
    '',
    'His question:',
    entry.comment,
    '',
    'Research it using THIS repository: memory/ (especially memory/contacts/*.md), data/ archives, and any context you can read. Do NOT edit, create, commit, or push any files. This is read-only.',
    'Answer in plain spoken English, 4 to 8 sentences, no markdown, no bullet characters, no URLs, no file paths. If the record is thin, say what you do know and what is missing. Print ONLY the spoken answer, nothing else.',
  ].join('\n');
  try {
    const { spawnSync } = require('child_process');
    const { exec, baseArgs } = resolveClaudeCli();
    const out = spawnSync(
      exec,
      [...baseArgs, '--model', CLI_MODEL, '--dangerously-skip-permissions', '-p', prompt],
      {
        cwd: ACT_REPO,
        encoding: 'utf8',
        timeout: opts.deadlineMs || ACT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeCliEnv(process.env),
      },
    );
    if (out.error) return { ok: false, error: out.error.message };
    if (out.status !== 0)
      return {
        ok: false,
        error: 'claude exit ' + out.status,
        stderr: (out.stderr || '').slice(0, 400),
      };
    if (isCliFailureOutput(out.stdout) || isCliFailureOutput(out.stderr)) {
      return { ok: false, error: 'claude CLI auth/quota failure' };
    }
    const answer = String(out.stdout || '').trim();
    if (!answer) return { ok: false, error: 'research produced no answer' };
    return { ok: true, answer };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function executeForwardedCommand(cmd) {
  const entry = {
    ts: cmd.createdAt || new Date().toISOString(),
    source: cmd.replyTo === 'telegram' ? 'telegram_command' : 'vapi_command',
    section: 'orphaned voice/telegram command',
    itemRef: cmd.id,
    comment: cmd.prompt || '',
  };

  // Research asks are answered read-only and delivered on the command's channel,
  // NOT pushed through the code/autoland path (which cannot research and fails).
  if (classifyTaskKind(entry.comment) === 'research') {
    await httpJson('POST', `${COMMAND_API_BASE}/commands/${cmd.id}/status`, {
      status: 'running',
      note: 'researching',
    });
    const rr = runResearch(entry, { deadlineMs: cmd.deadlineMs });
    const rResult = rr.ok
      ? { ok: true, research: true, oneLiner: rr.answer.slice(0, 1200) }
      : { ok: false, error: rr.error || 'research failed' };
    writeActLog({
      ...entry,
      command_id: cmd.id,
      kind: 'research',
      acted_at: new Date().toISOString(),
      result: rResult,
    });
    await completeWithRetry(
      cmd.id,
      !!rResult.ok,
      (rResult.ok ? rResult.oneLiner : 'research failed: ' + (rResult.error || 'ExampleCo')).slice(
        0,
        1500,
      ),
      { oneLiner: rResult.ok ? rResult.oneLiner : '' },
    );
    return rResult;
  }

  const branch = autoBranchName(cmd);
  let result;
  let workRepo = ACT_REPO;
  try {
    workRepo = ensureCodexWorktree({
      repoRoot: ACT_REPO,
      purpose: `forwarded-command-${cmd.id || entry.comment || 'command'}`,
      branchPrefix: 'codex/forwarded-command',
      linkNodeModules: false,
    }).cwd;
  } catch (e) {
    result = { ok: false, error: 'command isolation failed: ' + e.message };
  }
  if (!result && !prepareCleanBranch(branch, workRepo)) {
    result = { ok: false, error: 'could not prepare a clean branch from origin/master' };
  } else if (!result) {
    // Mark running + a note so check_spine shows liveness mid-call (Step 4).
    await httpJson('POST', `${COMMAND_API_BASE}/commands/${cmd.id}/status`, {
      status: 'running',
      note: (entry.comment || 'working').slice(0, 80),
    });
    const r = runClaudeForChange(entry, { deadlineMs: cmd.deadlineMs }, workRepo);
    if (!r.ok) {
      result = { ok: false, error: r.error, stderr: r.stderr };
    } else {
      // Capture exactly what Claude changed. Empty diff means the agent did not
      // edit THIS checkout (e.g. it resolved a different root) or had nothing to
      // do; either way do not push an empty branch.
      const status = gitInRepo(['status', '--porcelain'], 20000, workRepo);
      if (!String(status.stdout || '').trim()) {
        // No diff. NOW the auth/quota sentinel is decisive (Change 1): a run that
        // produced nothing AND tripped the sentinel is a genuine CLI failure;
        // otherwise the agent simply had nothing to do.
        result = r.authSentinel
          ? { ok: false, error: 'claude CLI auth/quota failure', summary: r.summary }
          : {
              ok: false,
              error: 'no file changes produced in the work checkout',
              summary: r.summary,
            };
      } else if (AUTOLAND && isLinuxEc2) {
        // One Amy applies: land to master + deploy, healthcheck rollback on failure.
        result = await landAndDeploy(cmd, entry, branch, r, workRepo);
      } else {
        // Park a branch + PR (non-EC2 host, or autoland disabled).
        gitInRepo(['add', '-A'], 30000, workRepo);
        const msg = `auto: ${(entry.comment || 'dispatched change').slice(0, 64)} (dispatch:${cmd.id})`;
        const commit = gitInRepo(['commit', '-m', msg], 30000, workRepo);
        const push = gitInRepo(
          ['push', '-u', 'origin', branch, '--force-with-lease'],
          120000,
          workRepo,
        );
        if (commit.status !== 0 || push.status !== 0) {
          result = {
            ok: false,
            error: 'commit/push failed',
            stderr: ((commit.stderr || '') + (push.stderr || '')).slice(0, 400),
            summary: r.summary,
          };
        } else {
          const compareUrl = repoCompareUrl(branch, workRepo);
          result = { ok: true, branch, compareUrl, summary: r.summary };
        }
      }
    }
  }
  writeActLog({ ...entry, command_id: cmd.id, acted_at: new Date().toISOString(), result });
  const resultText = !result.ok
    ? `execution failed: ${result.error || 'ExampleCo'}`
    : result.deployed
      ? `Fixed and live on master (${result.sha}).\n\n${(result.summary || '').slice(0, 1100)}`
      : result.sha
        ? `Applied to master (${result.sha}). ${result.note || ''}\n\n${(result.summary || '').slice(0, 1000)}`
        : `Done on branch ${result.branch}. Open a PR: ${result.compareUrl}\n\n${(result.summary || '').slice(0, 1100)}`;
  // Completion receipt MUST land, or the command shows forwarded forever with no
  // confirmation even though the dev shipped (observed 2026-06-01: the single
  // POST silently failed after the long blocking Claude run). Retry, and log the
  // real status of each attempt instead of swallowing it.
  // Structured one-liner for channel-correct delivery (voice speaks this; it is
  // speech-safe on the server). PR link rides separately for the Telegram path.
  const oneLiner = !result.ok
    ? 'That dev task ran into a problem.'
    : result.deployed
      ? 'Done, it is live.'
      : result.sha
        ? 'Done, applied to master.'
        : 'Done, the change is ready.';
  await completeWithRetry(cmd.id, !!result.ok, resultText.slice(0, 1500), {
    oneLiner,
    prUrl: result.compareUrl || '',
    branch: result.branch || '',
  });
  return result;
}

async function completeWithRetry(cmdId, success, resultText, extra = {}, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    const r = await httpJson(
      'POST',
      `${COMMAND_API_BASE}/commands/${cmdId}/complete`,
      { success, result: resultText, ...extra },
      15000,
    );
    if (r.status === 200) {
      if (i > 1) console.log(`[process-dispatches] completion landed for ${cmdId} on attempt ${i}`);
      return true;
    }
    console.warn(
      `[process-dispatches] completion attempt ${i}/${attempts} for ${cmdId} got status ${r.status}`,
    );
    await new Promise((res) => setTimeout(res, 1000 * i));
  }
  console.error(
    `[process-dispatches] FAILED to record completion for ${cmdId} after ${attempts} attempts`,
  );
  return false;
}

// Only a host with a real git working tree may execute (and commit/push) a
// forwarded command. On EC2 /opt/secondbrain is an scp-deployed copy with no
// .git, so executing there would edit the live deploy with no version control.
// This gate makes the SAME code safe on every host: a non-git host leaves
// commands pending (does not even forward them) so the git-capable executor
// (ExampleCo's PC dev tree) picks them up. 2026-06-01.
function actRepoIsGitCapable() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['-C', ACT_REPO, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  } catch {
    return false;
  }
}

let _loggedNoGit = false;
async function drainStaleCommands() {
  if (!actRepoIsGitCapable()) {
    if (!_loggedNoGit) {
      console.log(
        `[process-dispatches] ACT_REPO (${ACT_REPO}) is not a git work tree; leaving commands for a git-capable executor`,
      );
      _loggedNoGit = true;
    }
    return 0;
  }
  const listed = await httpJson(
    'GET',
    `${COMMAND_API_BASE}/commands/stale?minutes=${COMMAND_GRACE_MIN}`,
  );
  if (listed.status !== 200 || !Array.isArray(listed.body) || listed.body.length === 0) return 0;
  let executed = 0;
  for (const cmd of listed.body) {
    if (!cmd || !cmd.id) continue;
    // Atomic ownership: only one consumer can win pending->forwarded, so the PC
    // worker and this drainer can never both run the same command.
    const fwd = await httpJson('POST', `${COMMAND_API_BASE}/commands/${cmd.id}/forward`);
    if (fwd.status !== 200) continue; // 409 = already claimed/forwarded elsewhere
    const ageMin = Math.round((Date.now() - Date.parse(cmd.createdAt)) / 60000);
    console.log(
      `[process-dispatches] executing orphaned command ${cmd.id} (age ${ageMin}m): ${(cmd.prompt || '').slice(0, 80)}`,
    );
    const r = await executeForwardedCommand(cmd);
    console.log(
      `[process-dispatches] command ${cmd.id} -> ${r.ok ? 'done' : 'failed: ' + (r.error || '')}`,
    );
    if (r.ok) executed++;
  }
  return executed;
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
      // Execute orphaned Vapi/Telegram commands that no live consumer claimed.
      const exec = await drainStaleCommands();
      if (exec > 0) console.log(`[process-dispatches] executed ${exec} orphaned command(s)`);
      const r = await runOnce();
      if (r.handled > 0) console.log(`[process-dispatches] handled ${r.handled}/${r.total}`);
    } catch (e) {
      console.error('[process-dispatches] loop error:', e.message);
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
}

if (require.main === module) {
  const mode = process.argv.includes('--watch') ? 'watch' : 'once';
  (mode === 'watch'
    ? runWatch()
    : runOnce().then((r) => {
        console.log(JSON.stringify(r, null, 2));
      })
  ).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  runOnce,
  processOne,
  readQueue,
  hashEntry,
  hasAmyDispatchSignal,
  isExplicitDispatchEntry,
  classifyHeuristic,
  drainStaleCommands,
  executeForwardedCommand,
  actRepoIsGitCapable,
  resolveClaudeCli,
  autoBranchName,
  compareUrlFromRemote,
  planDeploy,
  deployTargetsFor,
  processesFor,
};
