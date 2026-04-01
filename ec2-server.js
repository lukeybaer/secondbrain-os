const http = require('http');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const LUKE_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_BASE = 'https://api.telegram.org/bot' + BOT_TOKEN;
const VAPI_API_KEY = process.env.VAPI_API_KEY || '';
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';
const LUKE_PHONE = process.env.LUKE_PRIVATE_SIM || '';

const pendingApprovals = new Map();

// ── Session Registry ──────────────────────────────────────────────────────────
// Tracks active Claude Code sessions so we can route "continue" commands back
// to the right session rather than spawning a new one every time.
//
// Session shape:
//   id          string   unique session ID
//   topic       string   short description of what's being worked on
//   status      string   'active' | 'paused' | 'complete'
//   createdAt   string   ISO
//   lastActivity string  ISO
//   metadata    object   arbitrary extra fields (epicNumber, etc.)

const sessionRegistry = new Map();

function generateId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function addSession({ id, topic, metadata }) {
  const sessionId = id || generateId('sess');
  const session = {
    id: sessionId,
    topic: topic || 'Unknown task',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    metadata: metadata || {},
  };
  sessionRegistry.set(sessionId, session);
  console.log('[session] Registered', sessionId, '—', topic);
  return session;
}

function touchSession(id) {
  const s = sessionRegistry.get(id);
  if (s) s.lastActivity = new Date().toISOString();
}

function getMostRecentActiveSession() {
  let best = null;
  for (const s of sessionRegistry.values()) {
    if (s.status === 'active') {
      if (!best || s.lastActivity > best.lastActivity) best = s;
    }
  }
  return best;
}

// ── Intent Classification ─────────────────────────────────────────────────────
// Classifies a free-text message into one of four routing intents:
//   new_task   → spawn a new claude -p session
//   continue   → route to existing session via --continue
//   query      → answer via local search, no full session needed
//   status     → summarise current sessions and queue, respond directly

const CONTINUE_PATTERNS = [
  /\bcontinue\b/i,
  /\bresume\b/i,
  /\bkeep going\b/i,
  /\bcarry on\b/i,
  /\bgo on\b/i,
  /\bkeep working\b/i,
  /\bstill on\b/i,
  /\bnext epic\b/i,
  /\bpick.{0,8}up\b/i,
  /\bwhere (we|you) left off\b/i,
];

const STATUS_PATTERNS = [
  /^\/status$/i,
  /\bwhat.{0,15}(status|progress|happening|working on)\b/i,
  /\bhow.{0,10}(going|doing|progress)\b/i,
  /\bany updates?\b/i,
  /\bwhat.{0,6}(done|finished|completed)\b/i,
  /\bgive.{0,10}update\b/i,
  /^status\??$/i,
];

const QUERY_PATTERNS = [
  /^did (i|we|you)\b/i,
  /^(do|does|have|has|had) (i|we|you)\b/i,
  /^what did (i|we|you)\b/i,
  /^when did (i|we|you)\b/i,
  /^who is\b/i,
  /^tell me about\b/i,
  /^find (a |the )?\b/i,
  /^search (for )?\b/i,
  /^look up\b/i,
  /^(is there|are there)\b/i,
];

function classifyIntent(text) {
  const trimmed = text.trim();

  // Explicit status request
  for (const p of STATUS_PATTERNS) {
    if (p.test(trimmed)) return { type: 'status' };
  }

  // Continue existing session
  for (const p of CONTINUE_PATTERNS) {
    if (p.test(trimmed)) {
      const session = getMostRecentActiveSession();
      return { type: 'continue', sessionId: session ? session.id : null, sessionTopic: session ? session.topic : null };
    }
  }

  // Quick knowledge query (short, question-like, no code task verbs)
  const isShort = trimmed.length < 120;
  const hasQueryPattern = QUERY_PATTERNS.some(p => p.test(trimmed));
  const hasTaskVerbs = /\b(fix|build|add|create|write|implement|refactor|deploy|update|change|remove|delete|install|configure|set up|migrate|test)\b/i.test(trimmed);
  if (isShort && hasQueryPattern && !hasTaskVerbs) {
    return { type: 'query' };
  }

  return { type: 'new_task' };
}

// ── Command Queue ─────────────────────────────────────────────────────────────
// status: 'pending' | 'in_progress' | 'done' | 'failed'

const commandQueue = new Map();

function addCommand({ type, prompt, replyTo, replyId, routing }) {
  const id = generateId('cmd');
  const command = {
    id,
    type,            // 'claude' | 'search'
    prompt,
    replyTo,         // 'telegram' | 'vapi'
    replyId: replyId || null,
    routing: routing || { type: 'new_task' },  // dispatch routing metadata
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    success: null,
  };
  commandQueue.set(id, command);
  console.log('[cmd] Added command', id, type, '/', (routing || {}).type, '—', prompt.slice(0, 60));
  return command;
}

function getOldestPending() {
  for (const cmd of commandQueue.values()) {
    if (cmd.status === 'pending') return cmd;
  }
  return null;
}

// ── Knowledge Query Queue ─────────────────────────────────────────────────────

const queryQueue = new Map();
const queryAnswers = new Map();

function addQuery({ question, vapiCallId }) {
  const id = generateId('qry');
  queryQueue.set(id, {
    id,
    question,
    vapiCallId: vapiCallId || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  console.log('[query] Added query', id, '—', question.slice(0, 60));
  return id;
}

function getOldestPendingQuery() {
  for (const q of queryQueue.values()) {
    if (q.status === 'pending') return q;
  }
  return null;
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(TG_BASE + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(text) {
  return tgPost('sendMessage', { chat_id: LUKE_CHAT_ID, text, parse_mode: 'HTML' });
}

function sendApprovalRequest(approvalId, description, requestType) {
  const text = '<b>APPROVAL REQUIRED</b>\n\n<b>Type:</b> ' + requestType + '\n<b>Request:</b> ' + description + '\n\nReply: YES ' + approvalId + ' or NO ' + approvalId;
  return sendMessage(text);
}

// ── Status summary ─────────────────────────────────────────────────────────────

function buildStatusSummary() {
  const activeSessions = [...sessionRegistry.values()].filter(s => s.status === 'active');
  const pendingCmds = [...commandQueue.values()].filter(c => c.status === 'pending' || c.status === 'in_progress');

  const lines = [];

  if (activeSessions.length) {
    lines.push('<b>Active sessions (' + activeSessions.length + '):</b>');
    for (const s of activeSessions) {
      const age = Math.round((Date.now() - new Date(s.lastActivity).getTime()) / 60000);
      lines.push('• <code>' + s.id.slice(0, 20) + '</code> — ' + s.topic + ' (' + age + 'm ago)');
    }
  } else {
    lines.push('<b>No active sessions.</b>');
  }

  if (pendingCmds.length) {
    lines.push('');
    lines.push('<b>Queue (' + pendingCmds.length + ' pending):</b>');
    for (const c of pendingCmds) {
      lines.push('• [' + c.status.toUpperCase() + '] ' + (c.routing && c.routing.type ? c.routing.type : c.type) + ': ' + c.prompt.slice(0, 60) + (c.prompt.length > 60 ? '…' : ''));
    }
  } else {
    lines.push('\n<b>Queue is empty.</b>');
  }

  return lines.join('\n');
}

// ── Vapi outbound call ────────────────────────────────────────────────────────

async function initiateVapiOutbound(to, message) {
  if (!VAPI_API_KEY) {
    console.log('[vapi outbound] No VAPI_API_KEY — falling back to Telegram');
    return sendMessage('<b>Vapi callback (no key configured):</b>\n' + message);
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      phoneNumberId: to || LUKE_PHONE,
      assistantId: process.env.VAPI_ASSISTANT_ID || undefined,
      customer: { number: to || LUKE_PHONE },
      assistantOverrides: {
        firstMessage: message,
      },
    });
    const req = https.request('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + VAPI_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Bridge-In: dial the owner's private SIM and connect him to the caller ─────────
// Makes an outbound Vapi call to the owner with a bridge assistant that has a
// transferCall tool pre-wired to the original caller's number.

async function bridgethe owner(callerName, topic, callerPhone, liveCallId) {
  if (!VAPI_API_KEY) {
    console.log('[bridge] No VAPI_API_KEY — sending Telegram notification instead');
    return sendMessage('<b>Bridge-In Request</b>\n<b>From:</b> ' + callerName + '\n<b>About:</b> ' + topic + '\n<b>Caller phone:</b> ' + (callerPhone || 'unknown') + '\n\nNote: VAPI_API_KEY not set — could not auto-dial.');
  }

  const bridgePrompt = 'You are bridging a live call for the owner. A caller named ' + callerName + ' is on hold about: "' + topic + '". Tell the owner who is holding and ask: "Want me to connect you?" If the owner says Yes, use the transferCall tool to connect. If the owner says No, end this call — the other line will be told the owner is unavailable.';

  const body = JSON.stringify({
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: { number: LUKE_PHONE },
    assistant: {
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: bridgePrompt }],
        tools: callerPhone ? [
          {
            type: 'transferCall',
            destinations: [{ type: 'number', number: callerPhone, message: 'Connecting you now.' }],
          },
        ] : [],
      },
      voice: { provider: '11labs', voiceId: 'paula' },
      firstMessage: 'Hey the owner — you have got ' + callerName + ' holding about "' + topic + '". Want me to connect you?',
      endCallPhrases: ['no', 'no thanks', 'not now', 'goodbye'],
    },
    metadata: { bridge_caller: callerName, live_call_id: liveCallId || 'unknown' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + VAPI_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Command delivery ──────────────────────────────────────────────────────────

async function deliverCommandResult(cmd) {
  const label = cmd.success ? '✅ Done' : '❌ Failed';
  const preview = (cmd.prompt || '').slice(0, 50);
  const routingTag = cmd.routing && cmd.routing.type ? ' [' + cmd.routing.type + ']' : '';

  if (cmd.replyTo === 'telegram') {
    const text = '<b>' + label + routingTag + '</b> — <i>' + preview + (cmd.prompt.length > 50 ? '…' : '') + '</i>\n\n' + (cmd.result || '(no result)');
    await sendMessage(text);
  } else if (cmd.replyTo === 'vapi') {
    await initiateVapiOutbound(LUKE_PHONE, (cmd.success ? 'Task complete: ' : 'Task failed: ') + (cmd.result || 'no result'));
  }
}

// ── Long-polling loop ─────────────────────────────────────────────────────────

let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const result = await tgPost('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ['message']
    });

    if (result.ok && result.result && result.result.length) {
      for (const update of result.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;

        if (String(msg.chat.id) !== String(LUKE_CHAT_ID)) {
          console.log('[tg] Ignored message from unknown chat:', msg.chat.id);
          continue;
        }

        const rawText = (msg.text || '').trim();
        const text = rawText.toUpperCase();
        console.log('[tg] the owner:', rawText);

        const yesMatch = text.match(/^YES\s+(\S+)/);
        const noMatch = text.match(/^NO\s+(\S+)/);
        const bareYes = text === 'YES';
        const bareNo = text === 'NO';

        if (yesMatch || bareYes) {
          const id = yesMatch ? yesMatch[1].toLowerCase() : [...pendingApprovals.keys()].at(-1);
          const approval = id ? pendingApprovals.get(id) : null;
          if (approval) {
            approval.resolve({ approved: true });
            pendingApprovals.delete(id);
            sendMessage('Approved. Taking action now.');
          } else {
            sendMessage('No pending approval found for: ' + (id || 'latest'));
          }
        } else if (noMatch || bareNo) {
          const id = noMatch ? noMatch[1].toLowerCase() : [...pendingApprovals.keys()].at(-1);
          const approval = id ? pendingApprovals.get(id) : null;
          if (approval) {
            approval.resolve({ approved: false });
            pendingApprovals.delete(id);
            sendMessage('Declined. Will let them know.');
          }
        } else {
          // ── Intelligent command dispatch ────────────────────────────────────

          const lowerRaw = rawText.toLowerCase();

          // /help
          if (lowerRaw === '/help') {
            await sendMessage(
              '<b>Dispatch Commands:</b>\n\n' +
              '<b>Explicit:</b>\n' +
              '<code>run: &lt;task&gt;</code> — new Claude Code task\n' +
              '<code>claude: &lt;task&gt;</code> — same as run:\n' +
              '<code>search: &lt;query&gt;</code> — search conversations\n\n' +
              '<b>Natural language (auto-routed):</b>\n' +
              '"continue working on…" → resumes active session\n' +
              '"what\'s the status?" → shows sessions + queue\n' +
              '"did I talk about X?" → searches knowledge base\n' +
              'anything else → queues as new task\n\n' +
              '<code>/status</code> — show sessions & queue\n' +
              '<code>/sessions</code> — list all registered sessions\n' +
              '<code>/help</code> — this message\n\n' +
              'Approval replies: <code>YES &lt;id&gt;</code> / <code>NO &lt;id&gt;</code>'
            );
            continue;
          }

          // /status — show sessions + queue
          if (lowerRaw === '/status') {
            await sendMessage(buildStatusSummary());
            continue;
          }

          // /sessions — list session registry
          if (lowerRaw === '/sessions') {
            const all = [...sessionRegistry.values()];
            if (!all.length) {
              await sendMessage('No sessions registered yet.');
            } else {
              const lines = all.map(s =>
                '<b>[' + s.status.toUpperCase() + ']</b> <code>' + s.id + '</code>\n' +
                'Topic: ' + s.topic + '\n' +
                'Last activity: ' + s.lastActivity
              );
              await sendMessage('<b>Sessions (' + all.length + '):</b>\n\n' + lines.join('\n\n'));
            }
            continue;
          }

          // Explicit prefixes: run: / claude: / /run / /claude
          const claudeMatch =
            lowerRaw.match(/^(?:run|claude):\s*(.+)/s) ||
            lowerRaw.match(/^\/(?:run|claude)\s+(.+)/s);

          if (claudeMatch) {
            const prompt = rawText.slice(rawText.indexOf(claudeMatch[1])).trim() ||
                           claudeMatch[1].trim();
            const routing = classifyIntent(prompt);
            const cmd = addCommand({ type: 'claude', prompt, replyTo: 'telegram', routing });
            const routeLabel = routing.type === 'continue' ? ' (continuing session)' : '';
            await sendMessage(
              'Queuing Claude Code task' + routeLabel + ': <i>' +
              prompt.slice(0, 80) + (prompt.length > 80 ? '…' : '') +
              '</i>\n\nID: <code>' + cmd.id + '</code>\nI\'ll message you when it\'s done.'
            );
            continue;
          }

          // search: / /search
          const searchMatch =
            lowerRaw.match(/^search:\s*(.+)/s) ||
            lowerRaw.match(/^\/search\s+(.+)/s);

          if (searchMatch) {
            const prompt = rawText.slice(rawText.indexOf(searchMatch[1])).trim() ||
                           searchMatch[1].trim();
            const cmd = addCommand({ type: 'search', prompt, replyTo: 'telegram', routing: { type: 'query' } });
            await sendMessage('Searching… <code>' + cmd.id + '</code>');
            continue;
          }

          // ── Natural language dispatch (no prefix) ────────────────────────────
          // Classify intent and route accordingly.

          const intent = classifyIntent(rawText);
          console.log('[dispatch] Intent:', intent.type, '—', rawText.slice(0, 60));

          if (intent.type === 'status') {
            await sendMessage(buildStatusSummary());
            continue;
          }

          if (intent.type === 'query') {
            // Route as a search command — knowledge worker will answer it
            const cmd = addCommand({ type: 'search', prompt: rawText, replyTo: 'telegram', routing: { type: 'query' } });
            await sendMessage('Looking that up… <code>' + cmd.id + '</code>');
            continue;
          }

          if (intent.type === 'continue') {
            const sessionInfo = intent.sessionTopic
              ? '\nContinuing: <i>' + intent.sessionTopic + '</i>'
              : '';
            const cmd = addCommand({
              type: 'claude',
              prompt: rawText,
              replyTo: 'telegram',
              routing: intent,
            });
            await sendMessage(
              'Routing to active session.' + sessionInfo +
              '\n\nID: <code>' + cmd.id + '</code>\nI\'ll message you when it\'s done.'
            );
            continue;
          }

          // Default: new_task
          const cmd = addCommand({
            type: 'claude',
            prompt: rawText,
            replyTo: 'telegram',
            routing: { type: 'new_task' },
          });
          await sendMessage(
            'Got it — queuing as new task: <i>' +
            rawText.slice(0, 80) + (rawText.length > 80 ? '…' : '') +
            '</i>\n\nID: <code>' + cmd.id + '</code>\nI\'ll message you when it\'s done.'
          );
        }
      }
    }
  } catch(e) {
    console.error('[tg poll error]', e.message);
  }

  setTimeout(pollTelegram, 2000);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); }
    });
  });
}

function jsonOk(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── Health ─────────────────────────────────────────────────────────────────

  if (urlPath === '/health' && req.method === 'GET') {
    jsonOk(res, {
      status: 'ok', service: 'secondbrain-backend', version: '1.4.0',
      uptime: process.uptime(), pending_approvals: pendingApprovals.size,
      last_update_id: lastUpdateId,
      sessions: {
        total: sessionRegistry.size,
        active: [...sessionRegistry.values()].filter(s => s.status === 'active').length,
      },
      commands: {
        total: commandQueue.size,
        pending: [...commandQueue.values()].filter(c => c.status === 'pending').length,
        in_progress: [...commandQueue.values()].filter(c => c.status === 'in_progress').length,
      },
      queries: {
        total: queryQueue.size,
        pending: [...queryQueue.values()].filter(q => q.status === 'pending').length,
      },
    });
    return;
  }

  // ── Session registry endpoints ─────────────────────────────────────────────

  // POST /sessions — register a new session
  if (urlPath === '/sessions' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const session = addSession({ id: body.id, topic: body.topic, metadata: body.metadata });
      jsonOk(res, session, 201);
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // GET /sessions — list all sessions
  if (urlPath === '/sessions' && req.method === 'GET') {
    jsonOk(res, [...sessionRegistry.values()]);
    return;
  }

  // GET /sessions/active — most recent active session
  if (urlPath === '/sessions/active' && req.method === 'GET') {
    jsonOk(res, getMostRecentActiveSession() || null);
    return;
  }

  // GET /sessions/:id
  if (urlPath.match(/^\/sessions\/[^/]+$/) && req.method === 'GET') {
    const id = urlPath.split('/')[2];
    const s = sessionRegistry.get(id);
    if (!s) { res.writeHead(404); res.end('not found'); return; }
    jsonOk(res, s);
    return;
  }

  // PATCH /sessions/:id — update session (status, topic, metadata)
  if (urlPath.match(/^\/sessions\/[^/]+$/) && req.method === 'PATCH') {
    const id = urlPath.split('/')[2];
    const s = sessionRegistry.get(id);
    if (!s) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readBody(req);
      if (body.topic !== undefined) s.topic = body.topic;
      if (body.status !== undefined) s.status = body.status;
      if (body.metadata !== undefined) Object.assign(s.metadata, body.metadata);
      s.lastActivity = new Date().toISOString();
      console.log('[session] Updated', id, '—', s.status, s.topic.slice(0, 40));
      jsonOk(res, s);
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // DELETE /sessions/:id — mark session complete
  if (urlPath.match(/^\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    const id = urlPath.split('/')[2];
    const s = sessionRegistry.get(id);
    if (!s) { res.writeHead(404); res.end('not found'); return; }
    s.status = 'complete';
    s.lastActivity = new Date().toISOString();
    console.log('[session] Closed', id);
    jsonOk(res, { ok: true });
    return;
  }

  // ── Vapi webhook ───────────────────────────────────────────────────────────

  if (urlPath === '/vapi/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        console.log('[vapi]', event.type, event.call && event.call.id);

        if (event.type === 'function-call' && event.functionCall && event.functionCall.name === 'request_approval') {
          const params = event.functionCall.parameters || {};
          const id = 'apr_' + Date.now();

          await sendApprovalRequest(id, params.description || 'Unknown request', params.request_type || 'unknown');

          const result = await new Promise(resolve => {
            pendingApprovals.set(id, { resolve, description: params.description });
            setTimeout(() => {
              if (pendingApprovals.has(id)) {
                pendingApprovals.delete(id);
                resolve({ approved: false, timed_out: true });
              }
            }, 55000);
          });

          jsonOk(res, { result: result.approved ? 'approved' : 'denied' });

        } else if (event.type === 'function-call' && event.functionCall && event.functionCall.name === 'bridge_in_luke') {
          const params = event.functionCall.parameters || {};
          const callerName = params.caller_name || 'someone';
          const topic = params.topic || 'unspecified topic';
          const callerPhone = (event.call && event.call.customer && event.call.customer.number) || '';
          const liveCallId = event.call && event.call.id;

          console.log('[bridge] Bridging ' + callerName + ' to the owner re: ' + topic);
          await sendMessage('<b>Bridge-In initiated</b>\n<b>Caller:</b> ' + callerName + '\n<b>Topic:</b> ' + topic);

          if (!LUKE_PHONE) {
            console.log('[bridge] LUKE_PHONE not set — cannot dial');
            jsonOk(res, { result: 'I was not able to reach the owner right now — his direct line is not configured. I will let him know you called.' });
            return;
          }

          bridgethe owner(callerName, topic, callerPhone, liveCallId)
            .then(r => console.log('[bridge] Dial initiated:', r && r.id))
            .catch(e => console.error('[bridge] Dial error:', e.message));

          // Respond immediately so Vapi does not time out the function call
          jsonOk(res, { result: 'Calling the owner now — ' + callerName + ', please hold while I connect you.' });

        } else if (event.type === 'function-call' && event.functionCall && event.functionCall.name === 'query_knowledge') {
          const params = event.functionCall.parameters || {};
          const question = params.question || params.query || 'unknown question';
          const vapiCallId = event.call && event.call.id;

          const queryId = addQuery({ question, vapiCallId });

          const TIMEOUT_MS = 25000;
          const POLL_INTERVAL = 1000;
          const deadline = Date.now() + TIMEOUT_MS;
          let answer = null;

          while (Date.now() < deadline) {
            if (queryAnswers.has(queryId)) {
              answer = queryAnswers.get(queryId);
              queryAnswers.delete(queryId);
              break;
            }
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
          }

          if (answer !== null) {
            jsonOk(res, { result: answer });
          } else {
            jsonOk(res, { result: "I couldn't find that in time, let me check and get back to you." });
          }

        } else {
          jsonOk(res, { received: true });
        }
      } catch(e) {
        console.error('[vapi webhook error]', e.message);
        res.writeHead(400);
        res.end('bad json');
      }
    });
    return;
  }

  // ── Vapi outbound ──────────────────────────────────────────────────────────

  if (urlPath === '/vapi/outbound' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const to = body.to || LUKE_PHONE;
      const message = body.message || '';
      if (!message) { res.writeHead(400); res.end('message required'); return; }
      const result = await initiateVapiOutbound(to, message);
      jsonOk(res, { ok: true, result });
    } catch(e) {
      console.error('[vapi outbound error]', e.message);
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // ── Command Queue endpoints ────────────────────────────────────────────────

  // POST /commands — add a command (optionally with routing override)
  if (urlPath === '/commands' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.type || !body.prompt) { res.writeHead(400); res.end('type and prompt required'); return; }
      // If caller provided explicit routing, use it; otherwise classify
      const routing = body.routing || classifyIntent(body.prompt);
      const cmd = addCommand({
        type: body.type,
        prompt: body.prompt,
        replyTo: body.replyTo || 'telegram',
        replyId: body.replyId,
        routing,
      });
      jsonOk(res, { id: cmd.id, routing: cmd.routing }, 201);
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // GET /commands/pending — fetch oldest pending command
  if (urlPath === '/commands/pending' && req.method === 'GET') {
    const cmd = getOldestPending();
    jsonOk(res, cmd || null);
    return;
  }

  // GET /commands/:id
  if (urlPath.match(/^\/commands\/[^/]+$/) && req.method === 'GET') {
    const id = urlPath.split('/')[2];
    const cmd = commandQueue.get(id);
    if (!cmd) { res.writeHead(404); res.end('not found'); return; }
    jsonOk(res, cmd);
    return;
  }

  // POST /commands/:id/claim
  if (urlPath.match(/^\/commands\/[^/]+\/claim$/) && req.method === 'POST') {
    const id = urlPath.split('/')[2];
    const cmd = commandQueue.get(id);
    if (!cmd) { res.writeHead(404); res.end('not found'); return; }
    if (cmd.status !== 'pending') { res.writeHead(409); res.end('not pending'); return; }
    cmd.status = 'in_progress';
    cmd.updatedAt = new Date().toISOString();
    console.log('[cmd] Claimed', id);
    jsonOk(res, { ok: true });
    return;
  }

  // POST /commands/:id/complete
  if (urlPath.match(/^\/commands\/[^/]+\/complete$/) && req.method === 'POST') {
    const id = urlPath.split('/')[2];
    const cmd = commandQueue.get(id);
    if (!cmd) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readBody(req);
      cmd.status = body.success ? 'done' : 'failed';
      cmd.success = !!body.success;
      cmd.result = body.result || '';
      cmd.updatedAt = new Date().toISOString();
      console.log('[cmd] Completed', id, cmd.status);
      await deliverCommandResult(cmd);
      jsonOk(res, { ok: true });
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // ── Query Queue endpoints ──────────────────────────────────────────────────

  if (urlPath === '/queries' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.question) { res.writeHead(400); res.end('question required'); return; }
      const id = addQuery({ question: body.question, vapiCallId: body.vapiCallId });
      jsonOk(res, { id }, 201);
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  if (urlPath === '/queries/pending' && req.method === 'GET') {
    const q = getOldestPendingQuery();
    jsonOk(res, q || null);
    return;
  }

  if (urlPath.match(/^\/queries\/[^/]+\/complete$/) && req.method === 'POST') {
    const id = urlPath.split('/')[2];
    const q = queryQueue.get(id);
    if (!q) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readBody(req);
      const answer = body.answer || '';
      q.status = 'done';
      queryAnswers.set(id, answer);
      console.log('[query] Answered', id, '—', answer.slice(0, 60));
      jsonOk(res, { ok: true, answer });
    } catch(e) {
      res.writeHead(400); res.end('bad json');
    }
    return;
  }

  // ── Test endpoint ──────────────────────────────────────────────────────────

  if (urlPath === '/test/telegram' && req.method === 'POST') {
    const result = await sendMessage('the owneryBot backend is live and connected to Telegram!');
    jsonOk(res, result);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3001, async () => {
  console.log('[SecondBrain] the owneryBot backend v1.4.0 on :3001');
  console.log('[SecondBrain] Telegram polling for chat ' + LUKE_CHAT_ID);
  console.log('[SecondBrain] Dispatch routing: new_task | continue | query | status');
  pollTelegram();
  try {
    await sendMessage('the owneryBot v1.4.0 online. Dispatch routing active.\n\nSay anything naturally — I\'ll route it. Send /help for options.');
    console.log('[SecondBrain] Startup notification sent');
  } catch(e) {
    console.error('[SecondBrain] Startup notification failed:', e.message);
  }
});
