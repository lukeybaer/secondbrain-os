const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const LUKE_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_BASE = 'https://api.telegram.org/bot' + BOT_TOKEN;
const VAPI_API_KEY = process.env.VAPI_API_KEY || '';
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';
const LUKE_PHONE = process.env.LUKE_PRIVATE_SIM || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '';

// ── Synced Data Cache ────────────────────────────────────────────────────────
// Populated by the Electron app via POST /sync. Used by tool handlers to
// answer project/todo queries during live calls without polling back to Electron.
let syncedData = {
  projects: [],
  todos: [],
  recentCalls: [],
  amyVersion: 2,
  timestamp: null,
};

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
      return {
        type: 'continue',
        sessionId: session ? session.id : null,
        sessionTopic: session ? session.topic : null,
      };
    }
  }

  // Quick knowledge query (short, question-like, no code task verbs)
  const isShort = trimmed.length < 120;
  const hasQueryPattern = QUERY_PATTERNS.some((p) => p.test(trimmed));
  const hasTaskVerbs =
    /\b(fix|build|add|create|write|implement|refactor|deploy|update|change|remove|delete|install|configure|set up|migrate|test)\b/i.test(
      trimmed,
    );
  if (isShort && hasQueryPattern && !hasTaskVerbs) {
    return { type: 'query' };
  }

  return { type: 'new_task' };
}

// ── Graphiti Ingest (fire-and-forget) ─────────────────────────────────────────
// Feeds data into Graphiti knowledge graph via MCP protocol.
// EC2 talks to Graphiti on localhost (same machine, no SSH tunnel needed).

let graphitiSessionId = null;
let graphitiReqId = 0;

function ingestToGraphiti(name, body, source) {
  if (!body || body.length < 10) return;
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'add_memory',
      arguments: {
        name,
        episode_body: body.slice(0, 3000),
        source,
        source_description: source,
        group_id: 'luke-ea',
      },
    },
    id: ++graphitiReqId,
  });

  const doRequest = () => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (graphitiSessionId) headers['Mcp-Session-Id'] = graphitiSessionId;

    const req = http.request(
      { hostname: '127.0.0.1', port: 8000, path: '/mcp', method: 'POST', headers },
      (res) => {
        if (res.headers['mcp-session-id']) graphitiSessionId = res.headers['mcp-session-id'];
        res.resume(); // drain response
      },
    );
    req.on('error', () => {}); // swallow — non-critical
    req.setTimeout(15000, () => req.destroy());
    req.write(payload);
    req.end();
  };

  // Ensure session exists
  if (!graphitiSessionId) {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ec2', version: '1.0' },
      },
      id: ++graphitiReqId,
    });
    const initReq = http.request(
      {
        hostname: '127.0.0.1',
        port: 8000,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(initBody),
        },
      },
      (res) => {
        if (res.headers['mcp-session-id']) graphitiSessionId = res.headers['mcp-session-id'];
        res.resume();
        // Now send the actual request
        setTimeout(doRequest, 100);
      },
    );
    initReq.on('error', () => {});
    initReq.setTimeout(10000, () => initReq.destroy());
    initReq.write(initBody);
    initReq.end();
  } else {
    doRequest();
  }
}

// ── Command Queue ─────────────────────────────────────────────────────────────
// status: 'pending' | 'in_progress' | 'done' | 'failed'

const commandQueue = new Map();

function addCommand({ type, prompt, replyTo, replyId, routing }) {
  const id = generateId('cmd');
  const command = {
    id,
    type, // 'claude' | 'search'
    prompt,
    replyTo, // 'telegram' | 'vapi'
    replyId: replyId || null,
    routing: routing || { type: 'new_task' }, // dispatch routing metadata
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

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function transcribeWithWhisper(audioBuffer, filePath) {
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const boundary = '----WBoundary' + Date.now().toString(36);
  const filename = (filePath || 'audio.ogg').split('/').pop();
  const mime = filename.endsWith('.mp3')
    ? 'audio/mpeg'
    : filename.endsWith('.mp4')
      ? 'audio/mp4'
      : filename.endsWith('.wav')
        ? 'audio/wav'
        : 'audio/ogg';

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    audioBuffer,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`,
    ),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + openaiKey,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw).text || '');
          } catch (e) {
            reject(new Error('Whisper parse error: ' + raw.slice(0, 200)));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      TG_BASE + '/' + method,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sendMessage(text, { raw = false } = {}) {
  // raw=true sends without HTML parse mode (for untrusted content like Claude output)
  const opts = { chat_id: LUKE_CHAT_ID, text };
  if (!raw) opts.parse_mode = 'HTML';
  return tgPost('sendMessage', opts);
}

function sendApprovalRequest(approvalId, description, requestType) {
  const text =
    'Quick check — ' +
    description +
    '\n\nReply YES ' +
    approvalId +
    ' to approve, NO ' +
    approvalId +
    ' to skip.';
  return sendMessage(text);
}

// ── Status summary ─────────────────────────────────────────────────────────────

function buildStatusSummary() {
  const activeSessions = [...sessionRegistry.values()].filter((s) => s.status === 'active');
  const pendingCmds = [...commandQueue.values()].filter(
    (c) => c.status === 'pending' || c.status === 'in_progress',
  );

  const lines = [];

  if (activeSessions.length) {
    lines.push('Working on (' + activeSessions.length + '):');
    for (const s of activeSessions) {
      const age = Math.round((Date.now() - new Date(s.lastActivity).getTime()) / 60000);
      lines.push('  ' + s.topic + ' — ' + age + 'm ago');
    }
  } else {
    lines.push('Nothing active right now.');
  }

  if (pendingCmds.length) {
    lines.push('');
    lines.push('Queue (' + pendingCmds.length + '):');
    for (const c of pendingCmds) {
      const label = c.status === 'in_progress' ? '▶' : '·';
      lines.push('  ' + label + ' ' + c.prompt.slice(0, 70) + (c.prompt.length > 70 ? '…' : ''));
    }
  } else {
    lines.push('Queue is clear.');
  }

  return lines.join('\n');
}

// ── Vapi outbound call ────────────────────────────────────────────────────────

async function initiateVapiOutbound(to, message) {
  if (!VAPI_API_KEY) {
    console.log('[vapi outbound] No VAPI_API_KEY — falling back to Telegram');
    return sendMessage('Vapi not configured — message: ' + message);
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
    const req = https.request(
      'https://api.vapi.ai/call/phone',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + VAPI_API_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Bridge-In: dial the owner's private SIM and connect him to the caller ─────────
// Makes an outbound Vapi call to the owner with a bridge assistant that has a
// transferCall tool pre-wired to the original caller's number.

async function bridgeOwner(callerName, topic, callerPhone, liveCallId) {
  if (!VAPI_API_KEY) {
    console.log('[bridge] No VAPI_API_KEY — sending Telegram notification instead');
    return sendMessage(
      callerName + ' called about "' + topic + '" — couldn\'t dial you (Vapi not configured).',
    );
  }

  const bridgePrompt =
    'You are bridging a live call for the owner. A caller named ' +
    callerName +
    ' is on hold about: "' +
    topic +
    '". Tell the owner who is holding and ask: "Want me to connect you?" If the owner says Yes, use the transferCall tool to connect. If the owner says No, end this call — the other line will be told the owner is unavailable.';

  const body = JSON.stringify({
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: { number: LUKE_PHONE },
    assistant: {
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: bridgePrompt }],
        tools: callerPhone
          ? [
              {
                type: 'transferCall',
                destinations: [
                  { type: 'number', number: callerPhone, message: 'Connecting you now.' },
                ],
              },
            ]
          : [],
      },
      voice: { provider: '11labs', voiceId: 'paula' },
      firstMessage:
        'Hey the owner — you have got ' +
        callerName +
        ' holding about "' +
        topic +
        '". Want me to connect you?',
      endCallPhrases: ['no', 'no thanks', 'not now', 'goodbye'],
    },
    metadata: { bridge_caller: callerName, live_call_id: liveCallId || 'unknown' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.vapi.ai/call/phone',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + VAPI_API_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Direct Tool Execution ────────────────────────────────────────────────────
// Handles Vapi tool calls synchronously using the synced data cache.
// No more polling — answers come back in the same HTTP response.

function handleCheckProjectStatus(params) {
  const projects = syncedData.projects || [];
  const filter = (params.project_name || '').toLowerCase();

  const matched = filter ? projects.filter((p) => p.name.toLowerCase().includes(filter)) : projects;

  if (!matched.length) {
    return filter
      ? 'No projects matching "' + params.project_name + '" found.'
      : 'No active projects right now.';
  }

  return matched
    .map((p) => {
      const tasks = p.tasks || [];
      const todo = tasks.filter((t) => t.status === 'todo').length;
      const inProgress = tasks.filter((t) => t.status === 'in-progress').length;
      const done = tasks.filter((t) => t.status === 'done').length;
      const needsFollowUp = tasks.filter((t) => t.status === 'needs-follow-up').length;

      let summary = p.name + ' (' + p.status + '): ';
      const parts = [];
      if (todo) parts.push(todo + ' to do');
      if (inProgress) parts.push(inProgress + ' in progress');
      if (done) parts.push(done + ' done');
      if (needsFollowUp) parts.push(needsFollowUp + ' need follow-up');
      summary += parts.join(', ') || 'no tasks';

      if (needsFollowUp) {
        const followUps = tasks.filter((t) => t.status === 'needs-follow-up');
        summary += '. Needs follow-up: ' + followUps.map((t) => t.title).join(', ');
      }
      return summary;
    })
    .join('\n');
}

function handleCheckTodos(params) {
  let todos = syncedData.todos || [];

  if (params.assignee) {
    todos = todos.filter((t) => (t.assignee || '').toLowerCase() === params.assignee.toLowerCase());
  }
  if (params.priority) {
    todos = todos.filter((t) => t.priority === params.priority);
  }
  // Only show non-completed
  todos = todos.filter((t) => t.status !== 'done');

  if (!todos.length) {
    return params.assignee
      ? 'No pending todos for ' + params.assignee + '.'
      : 'Todo list is clear!';
  }

  return todos
    .map((t) => {
      const parts = [t.title || t.content || '(untitled)'];
      if (t.priority && t.priority !== 'medium') parts.push('[' + t.priority + ']');
      if (t.assignee) parts.push('→ ' + t.assignee);
      if (t.dueDate) parts.push('due ' + t.dueDate);
      return '- ' + parts.join(' ');
    })
    .join('\n');
}

function handleManageTask(params) {
  // Task management requires write access — queue it for the Electron app
  const action = params.action || 'unknown';
  const title = params.title || params.notes || 'Untitled';

  // We can't write directly to Electron's JSON files from EC2, so we queue
  // a command that the Electron app's command worker will pick up and execute.
  addCommand({
    type: 'claude',
    prompt:
      'Amy requested task management: ' +
      action +
      ' — "' +
      title +
      '"' +
      (params.project_name ? ' in project "' + params.project_name + '"' : '') +
      (params.status ? ' status: ' + params.status : '') +
      (params.priority ? ' priority: ' + params.priority : '') +
      (params.assignee ? ' assignee: ' + params.assignee : '') +
      (params.notes ? ' notes: ' + params.notes : ''),
    replyTo: 'telegram',
    routing: { type: 'new_task' },
  });

  return (
    "Got it — I've queued that " + action + ' for "' + title + '". It\'ll be done in a moment.'
  );
}

function handleSendMessage(params) {
  if (params.channel === 'telegram' && params.message) {
    sendMessage('From Amy: ' + params.message);
    return 'Message sent via Telegram.';
  }
  return 'Message channel "' + (params.channel || 'unknown') + '" is not supported yet.';
}

// ── Claude LLM Proxy (Max Plan — zero cost) ────────────────────────────────
// OpenAI-compatible /chat/completions endpoint that uses `claude -p` (Claude Code CLI).
// Burns Max plan tokens (included in subscription) instead of API credits.
// Vapi sends OpenAI format → we extract prompt → spawn `claude -p` → stream back OpenAI SSE.

function buildClaudePrompt(openaiBody) {
  const messages = openaiBody.messages || [];
  const parts = [];

  // Extract system prompt
  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push('[SYSTEM]\n' + msg.content);
    }
  }

  // Extract tool definitions so Claude knows what tools are available
  const tools = (openaiBody.tools || []).filter((t) => t.type === 'function');
  if (tools.length) {
    parts.push(
      '\n[AVAILABLE TOOLS]\nYou have these tools. To call a tool, respond ONLY with a JSON block:\n```json\n{"tool_call": {"name": "tool_name", "arguments": {...}}}\n```\n',
    );
    for (const t of tools) {
      parts.push('- ' + t.function.name + ': ' + (t.function.description || '').slice(0, 200));
    }
  }

  // Build conversation
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      parts.push('\n[USER]\n' + msg.content);
    } else if (msg.role === 'assistant') {
      let text = msg.content || '';
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          text +=
            '\n```json\n{"tool_call": {"name": "' +
            tc.function.name +
            '", "arguments": ' +
            tc.function.arguments +
            '}}\n```';
        }
      }
      if (text) parts.push('\n[ASSISTANT]\n' + text);
    } else if (msg.role === 'tool') {
      parts.push('\n[TOOL RESULT for ' + (msg.tool_call_id || 'unknown') + ']\n' + msg.content);
    }
  }

  parts.push(
    '\n[ASSISTANT]\nRespond naturally. If you need to call a tool, respond ONLY with the JSON block — nothing else.',
  );

  return parts.join('\n');
}

function streamClaudeCLI(openaiBody, res) {
  const prompt = buildClaudePrompt(openaiBody);
  const callId = 'chatcmpl-' + Date.now();

  console.log('[claude-max] Spawning claude -p (' + prompt.length + ' chars prompt)');

  const proc = spawn(
    'claude',
    [
      '-p',
      prompt,
      '--bare',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ],
    {
      env: { ...process.env, HOME: process.env.HOME || '/home/ec2-user' },
      cwd: '/opt/secondbrain',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial role delta
  res.write(
    'data: ' +
      JSON.stringify({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      '\n\n',
  );

  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // Handle stream-json events from claude -p
        if (event.type === 'stream_event' && event.event && event.event.delta) {
          const delta = event.event.delta;
          if (delta.type === 'text_delta' && delta.text) {
            res.write(
              'data: ' +
                JSON.stringify({
                  id: callId,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                }) +
                '\n\n',
            );
          }
        }

        // Handle assistant message with tool use
        if (event.type === 'assistant' && event.message) {
          // Already streamed via deltas above
        }

        // Handle result (final message)
        if (event.type === 'result') {
          // Result means we're done
        }
      } catch {
        // Non-JSON line — could be a plain text token
        // In some modes claude outputs raw text
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error('[claude-max] stderr:', chunk.toString().slice(0, 200));
  });

  proc.on('close', (code) => {
    console.log('[claude-max] Process exited with code', code);
    // Send finish
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        '\n\n',
    );
    res.write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
  });

  proc.on('error', (err) => {
    console.error('[claude-max] spawn error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Claude Code not available: ' + err.message } }));
    } else if (!res.writableEnded) {
      res.write(
        'data: ' +
          JSON.stringify({
            id: callId,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { content: ' [Error: Claude Code unavailable]' },
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  // Close stdin immediately — we pass prompt via -p flag
  proc.stdin.end();

  // Safety timeout: kill after 60s (Vapi times out at ~60s for function calls)
  setTimeout(() => {
    if (!proc.killed) {
      console.log('[claude-max] Killing process after 60s timeout');
      proc.kill('SIGTERM');
    }
  }, 60000);
}

// Fallback: if ANTHROPIC_API_KEY is set, use direct API (faster but costs money)
function streamClaudeAPI(openaiBody, res) {
  // Translate OpenAI → Anthropic format
  const messages = openaiBody.messages || [];
  let systemPrompt = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
    } else if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input:
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments,
          });
        }
      }
      if (content.length) anthropicMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      const last = anthropicMessages[anthropicMessages.length - 1];
      const toolResult = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content || '',
      };
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
    } else {
      anthropicMessages.push({ role: msg.role, content: msg.content || '' });
    }
  }

  const tools = (openaiBody.tools || [])
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

  const anthropicBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt || undefined,
    messages: anthropicMessages,
    tools: tools.length ? tools : undefined,
    stream: true,
  };
  const bodyStr = JSON.stringify(anthropicBody);
  const callId = 'chatcmpl-' + Date.now();
  let currentToolCallIndex = -1;
  let currentToolCallId = '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const proxyReq = https.request(
    {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    },
    (proxyRes) => {
      let buffer = '';
      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]' || !data) continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_start') {
              if (event.content_block.type === 'text') {
                res.write(
                  'data: ' +
                    JSON.stringify({
                      id: callId,
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: { role: 'assistant', content: '' },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    '\n\n',
                );
              } else if (event.content_block.type === 'tool_use') {
                currentToolCallIndex++;
                currentToolCallId = event.content_block.id;
                res.write(
                  'data: ' +
                    JSON.stringify({
                      id: callId,
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: currentToolCallIndex,
                                id: currentToolCallId,
                                type: 'function',
                                function: { name: event.content_block.name, arguments: '' },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    '\n\n',
                );
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                res.write(
                  'data: ' +
                    JSON.stringify({
                      id: callId,
                      object: 'chat.completion.chunk',
                      choices: [
                        { index: 0, delta: { content: event.delta.text }, finish_reason: null },
                      ],
                    }) +
                    '\n\n',
                );
              } else if (event.delta.type === 'input_json_delta') {
                res.write(
                  'data: ' +
                    JSON.stringify({
                      id: callId,
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: currentToolCallIndex,
                                function: { arguments: event.delta.partial_json },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    '\n\n',
                );
              }
            } else if (event.type === 'message_delta') {
              const fr = event.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
              res.write(
                'data: ' +
                  JSON.stringify({
                    id: callId,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: fr }],
                  }) +
                  '\n\n',
              );
              res.write('data: [DONE]\n\n');
            }
          } catch {}
        }
      });
      proxyRes.on('end', () => {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });
      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
  proxyReq.write(bodyStr);
  proxyReq.end();
}

// ── Local Proxy (Max Plan via SSH tunnel) ───────────────────────────────────
// Luke's PC runs claude-proxy.js on port 3456. EC2 reaches it via SSH reverse
// tunnel: ssh -R 3456:localhost:3456 ec2-user@98.80.164.16
// Priority: local proxy (free) → Anthropic API (if key set) → OpenAI (fallback)

const LOCAL_PROXY_PORT = 3456;

function checkLocalProxy() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + LOCAL_PROXY_PORT + '/health', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function streamViaLocalProxy(openaiBody, res) {
  const bodyStr = JSON.stringify(openaiBody);
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: LOCAL_PROXY_PORT,
      path: '/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    },
    (proxyRes) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    console.error('[claude-llm] Local proxy pipe error:', err.message, '— falling back to OpenAI');
    streamViaOpenAI(openaiBody, res);
  });
  proxyReq.write(bodyStr);
  proxyReq.end();
}

function streamViaOpenAI(openaiBody, res) {
  const oaiBody = JSON.stringify({
    model: 'gpt-4o',
    messages: openaiBody.messages || [],
    stream: true,
  });
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }
  const oaiReq = https.request(
    {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || ''),
        'Content-Length': Buffer.byteLength(oaiBody),
      },
    },
    (oaiRes) => {
      oaiRes.on('data', (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      });
      oaiRes.on('end', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );
  oaiReq.on('error', (err) => {
    console.error('[claude-llm] OpenAI fallback error:', err.message);
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
  oaiReq.write(oaiBody);
  oaiReq.end();
}

async function streamClaudeLLM(openaiBody, res) {
  // 1. Try local Max plan proxy (free, via SSH tunnel from Luke's PC)
  const proxyUp = await checkLocalProxy();
  if (proxyUp) {
    console.log('[claude-llm] Using Max plan proxy (local tunnel)');
    streamViaLocalProxy(openaiBody, res);
    return;
  }
  // 2. Try Anthropic API if key is set
  if (ANTHROPIC_API_KEY) {
    console.log('[claude-llm] Local proxy down — using Anthropic API');
    streamClaudeAPI(openaiBody, res);
    return;
  }
  // 3. Fall back to OpenAI (current working setup)
  console.log('[claude-llm] Local proxy down, no API key — falling back to OpenAI');
  streamViaOpenAI(openaiBody, res);
}

// ── Proactive Updates ────────────────────────────────────────────────────────
// Amy can notify Luke of important events, but ONLY through Telegram (not calls)
// unless the caller explicitly asked for a callback.
// This is the capability — it's opt-in and conservative by default.

const proactiveCallbacks = new Map(); // callId → { callbackRequested, channel, topic }

function registerCallbackRequest(callId, topic) {
  proactiveCallbacks.set(callId, {
    callbackRequested: true,
    channel: 'call', // Caller explicitly asked for a callback
    topic,
    registeredAt: new Date().toISOString(),
  });
  console.log('[proactive] Callback registered for call', callId, ':', topic);
}

async function sendProactiveUpdate(message, channel) {
  if (channel === 'call') {
    // Only call if explicitly requested
    return initiateVapiOutbound(LUKE_PHONE, message);
  }
  // Telegram is daily-briefing-only — log proactive updates to console
  console.log('[proactive] Update (not sent to Telegram):', message);
}

// Deliver a proactive update for a completed task
async function deliverProactiveTaskUpdate(taskTopic, result, callbackCallId) {
  const callback = callbackCallId ? proactiveCallbacks.get(callbackCallId) : null;

  if (callback && callback.callbackRequested) {
    // Caller explicitly asked for a callback — call them
    await sendProactiveUpdate(
      'Hey Luke, Amy here with an update. ' + taskTopic + ': ' + result,
      'call',
    );
    proactiveCallbacks.delete(callbackCallId);
  } else {
    // Telegram is daily-briefing-only — log task updates to console
    console.log('[proactive] Task update (not sent to Telegram):', taskTopic, result);
  }
}

// ── Action Handoff Protocol ─────────────────────────────────────────────────
// When Amy delegates a task to Claude Code, she creates a structured handoff
// record. Claude Code picks it up, executes, and Amy delivers the result.

const actionHandoffs = new Map();

function createHandoff({ taskDescription, successCriteria, priority, callbackCallId, source }) {
  const id = generateId('handoff');
  const handoff = {
    id,
    taskDescription,
    successCriteria: successCriteria || 'Task completed successfully',
    priority: priority || 'normal',
    callbackCallId: callbackCallId || null,
    source: source || 'telegram', // Where the request came from
    status: 'pending', // pending → in_progress → completed → delivered
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  };
  actionHandoffs.set(id, handoff);

  // Also create a command for Claude Code to pick up
  const cmd = addCommand({
    type: 'claude',
    prompt: taskDescription,
    replyTo: source === 'vapi' ? 'vapi' : 'telegram',
    routing: { type: 'new_task' },
  });

  handoff.commandId = cmd.id;
  console.log('[handoff] Created', id, '→ cmd', cmd.id, ':', taskDescription.slice(0, 60));
  return handoff;
}

function completeHandoff(handoffId, result, success) {
  const h = actionHandoffs.get(handoffId);
  if (!h) return null;
  h.status = success ? 'completed' : 'failed';
  h.result = result;
  h.completedAt = new Date().toISOString();

  // Proactively deliver the result
  deliverProactiveTaskUpdate(h.taskDescription.slice(0, 60), result, h.callbackCallId).catch(
    (err) => console.error('[handoff] delivery error:', err.message),
  );

  return h;
}

// ── Command delivery ──────────────────────────────────────────────────────────

async function deliverCommandResult(cmd) {
  if (cmd.replyTo === 'telegram') {
    const result = (cmd.result || '').trim();
    const icon = cmd.success ? '✓' : '✗';
    // Lead with the result — skip meta noise like routing type and prompt preview
    const text =
      icon +
      ' ' +
      (result || (cmd.success ? 'Done.' : 'Something went wrong — no output returned.'));
    // Send as raw text — Claude output often contains <, >, & which break HTML parse mode
    const reply = await sendMessage(text.slice(0, 1000) + (text.length > 1000 ? '…' : ''), {
      raw: true,
    });
    if (!reply.ok) {
      console.error('[cmd] Telegram delivery failed:', reply.description);
    }
  } else if (cmd.replyTo === 'vapi') {
    await initiateVapiOutbound(
      LUKE_PHONE,
      (cmd.success ? '' : 'Problem: ') + (cmd.result || 'done'),
    );
  }
}

// ── Long-polling loop ─────────────────────────────────────────────────────────

let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const result = await tgPost('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ['message'],
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

        // ── Voice note / audio transcription ───────────────────────────────
        if (msg.voice || msg.audio) {
          const fileObj = msg.voice || msg.audio;
          console.log('[tg] voice note received, file_id:', fileObj.file_id);
          try {
            const fileInfo = await tgPost('getFile', { file_id: fileObj.file_id });
            if (!fileInfo.ok) throw new Error('getFile failed: ' + JSON.stringify(fileInfo));
            const filePath = fileInfo.result.file_path;
            const fileUrl = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + filePath;
            const audioBuffer = await downloadBuffer(fileUrl);
            const transcript = await transcribeWithWhisper(audioBuffer, filePath);
            if (!transcript.trim()) {
              await sendMessage("Got your voice note but couldn't make out the audio. Try again?");
              continue;
            }
            console.log('[tg] voice transcript:', transcript);
            msg.text = transcript;
            await sendMessage('🎤 ' + transcript);
          } catch (err) {
            console.error('[tg] voice transcription error:', err.message);
            await sendMessage('Had trouble transcribing that voice note. Please try typing it.');
            continue;
          }
        }

        const rawText = (msg.text || '').trim();
        if (!rawText) continue;
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
            sendMessage('Got it — on it.');
          } else {
            sendMessage('Nothing pending to approve.');
          }
        } else if (noMatch || bareNo) {
          const id = noMatch ? noMatch[1].toLowerCase() : [...pendingApprovals.keys()].at(-1);
          const approval = id ? pendingApprovals.get(id) : null;
          if (approval) {
            approval.resolve({ approved: false });
            pendingApprovals.delete(id);
            sendMessage('Skipped.');
          }
        } else {
          // ── Intelligent command dispatch ────────────────────────────────────

          const lowerRaw = rawText.toLowerCase();

          // /help
          if (lowerRaw === '/help') {
            await sendMessage(
              'Amy v2.0 here. Send me anything naturally:\n\n' +
                'I can:\n' +
                "• Answer any question (I'm powered by Claude)\n" +
                '• Check project status & todos\n' +
                '• Queue coding tasks for Claude Code\n' +
                '• Search your conversation history\n' +
                '• Make & receive calls on your behalf\n' +
                '• Send messages via Telegram\n' +
                '• Manage tasks & projects\n\n' +
                'Commands:\n' +
                'run: <task> — new coding task\n' +
                'search: <query> — search knowledge\n' +
                '"continue" — resume last session\n' +
                '/brief — send morning briefing now\n' +
                '/status — show queue + sessions\n' +
                '/sessions — all sessions\n' +
                '/version — Amy version info\n\n' +
                'Approvals: YES <id> / NO <id>',
            );
            continue;
          }

          // /version — show Amy version info
          if (lowerRaw === '/version') {
            const ver = syncedData.amyVersion || 'unknown';
            const age = syncedData.timestamp
              ? Math.round((Date.now() - new Date(syncedData.timestamp).getTime()) / 1000) + 's ago'
              : 'never synced';
            const claude = ANTHROPIC_API_KEY ? 'ready' : 'not configured';
            await sendMessage(
              'Amy v' +
                ver +
                '\n' +
                'Data sync: ' +
                age +
                '\n' +
                'Projects: ' +
                (syncedData.projects || []).length +
                '\n' +
                'Todos: ' +
                (syncedData.todos || []).length +
                '\n' +
                'Claude LLM: ' +
                claude +
                '\n' +
                'Direct tools: check_project_status, check_todos, manage_task, send_message',
            );
            continue;
          }

          // /brief — trigger morning briefing manually
          if (lowerRaw === '/brief' || lowerRaw === '/briefing') {
            schedulerFlags.delete(schedulerFlag('briefing'));
            sendDailyBriefing().catch((e) =>
              console.error('[briefing] manual trigger error:', e.message),
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
              await sendMessage('No sessions yet.');
            } else {
              const lines = all.map((s) => {
                const age = Math.round((Date.now() - new Date(s.lastActivity).getTime()) / 60000);
                return '[' + s.status + '] ' + s.topic + ' — ' + age + 'm ago';
              });
              await sendMessage('Sessions (' + all.length + '):\n' + lines.join('\n'));
            }
            continue;
          }

          // Explicit prefixes: run: / claude: / /run / /claude
          const claudeMatch =
            lowerRaw.match(/^(?:run|claude):\s*(.+)/s) ||
            lowerRaw.match(/^\/(?:run|claude)\s+(.+)/s);

          if (claudeMatch) {
            const prompt =
              rawText.slice(rawText.indexOf(claudeMatch[1])).trim() || claudeMatch[1].trim();
            const routing = classifyIntent(prompt);
            addCommand({ type: 'claude', prompt, replyTo: 'telegram', routing });
            const ack = routing.type === 'continue' ? 'Picking up where we left off.' : 'On it.';
            await sendMessage(ack);
            continue;
          }

          // search: / /search
          const searchMatch =
            lowerRaw.match(/^search:\s*(.+)/s) || lowerRaw.match(/^\/search\s+(.+)/s);

          if (searchMatch) {
            const prompt =
              rawText.slice(rawText.indexOf(searchMatch[1])).trim() || searchMatch[1].trim();
            addCommand({ type: 'search', prompt, replyTo: 'telegram', routing: { type: 'query' } });
            await sendMessage('Looking that up…');
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
            addCommand({
              type: 'search',
              prompt: rawText,
              replyTo: 'telegram',
              routing: { type: 'query' },
            });
            await sendMessage('Looking that up…');
            continue;
          }

          if (intent.type === 'continue') {
            addCommand({
              type: 'claude',
              prompt: rawText,
              replyTo: 'telegram',
              routing: intent,
            });
            const ack = intent.sessionTopic
              ? 'Picking back up on: ' + intent.sessionTopic
              : 'Resuming where we left off.';
            await sendMessage(ack);
            continue;
          }

          // Default: new_task
          addCommand({
            type: 'claude',
            prompt: rawText,
            replyTo: 'telegram',
            routing: { type: 'new_task' },
          });
          await sendMessage('On it.');
        }

        // Post-process: feed Graphiti with every Telegram message (fire-and-forget)
        ingestToGraphiti('Telegram: Luke', rawText, 'telegram-message');
      }
    }
  } catch (e) {
    console.error('[tg poll error]', e.message);
  }

  setTimeout(pollTelegram, 2000);
}

// ── YouTube Upload Engine ────────────────────────────────────────────────────
// Handles OAuth2 token refresh, resumable upload, thumbnail upload.
// Videos are pushed via POST /youtube/queue then uploaded at scheduled slots.

const YOUTUBE_DATA_DIR = '/opt/secondbrain/data/youtube';
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';

const YOUTUBE_TOKENS = {
  AILifeHacks: {
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN_AILIFEHACKS || '',
    access_token: null,
    expires_at: 0,
  },
  BedtimeStories: {
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN_BEDTIMESTORIES || '',
    access_token: null,
    expires_at: 0,
  },
};

// In-memory upload queue — videos pushed via API, uploaded at scheduled slots
const youtubeUploadQueue = [];

function ensureYoutubeDir() {
  try {
    fs.mkdirSync(YOUTUBE_DATA_DIR, { recursive: true });
  } catch {}
}

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshYoutubeToken(channel) {
  const token = YOUTUBE_TOKENS[channel];
  if (!token) throw new Error('Unknown channel: ' + channel);

  // Return cached token if still valid
  if (token.access_token && Date.now() / 1000 < token.expires_at - 60) {
    return token.access_token;
  }

  console.log('[youtube] Refreshing token for ' + channel);
  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const body = params.toString();

  const res = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body,
  );

  const data = JSON.parse(res.body.toString());
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));

  token.access_token = data.access_token;
  token.expires_at = Date.now() / 1000 + (data.expires_in || 3600);
  console.log(
    '[youtube] Token refreshed for ' + channel + ' (expires in ' + data.expires_in + 's)',
  );
  return token.access_token;
}

async function uploadVideoToYouTube(videoPath, thumbnailPath, metadata, channel) {
  const accessToken = await refreshYoutubeToken(channel);
  const fileSize = fs.statSync(videoPath).size;

  const categoryId = channel === 'BedtimeStories' ? '24' : '28'; // Entertainment vs Science & Technology
  const madeForKids = channel === 'BedtimeStories';

  const uploadMeta = JSON.stringify({
    snippet: {
      title: metadata.title || 'Untitled',
      description: metadata.description || '',
      tags: metadata.tags || [],
      categoryId,
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: 'public',
      madeForKids,
      selfDeclaredMadeForKids: madeForKids,
    },
  });

  // Step 1: Initiate resumable upload
  console.log(
    '[youtube] Initiating upload: ' +
      metadata.title +
      ' (' +
      Math.round(fileSize / 1024 / 1024) +
      'MB)',
  );
  const initRes = await httpsRequest(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': fileSize,
        'Content-Length': Buffer.byteLength(uploadMeta),
      },
    },
    uploadMeta,
  );

  const uploadUrl = initRes.headers.location;
  if (!uploadUrl) throw new Error('No upload URL in response: ' + initRes.status);

  // Step 2: Upload video file
  console.log('[youtube] Uploading video data...');
  const videoData = fs.readFileSync(videoPath);
  const uploadRes = await httpsRequest(
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': fileSize,
      },
      timeout: 300000,
    },
    videoData,
  );

  const result = JSON.parse(uploadRes.body.toString());
  if (!result.id) throw new Error('Upload failed: ' + JSON.stringify(result));

  const videoId = result.id;
  console.log('[youtube] Video uploaded: ' + videoId);

  // Step 3: Upload thumbnail (if available)
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    // Wait a bit for YouTube to process
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const thumbData = fs.readFileSync(thumbnailPath);
      const thumbRes = await httpsRequest(
        'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoId,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'image/jpeg',
            'Content-Length': thumbData.length,
          },
        },
        thumbData,
      );
      console.log(
        '[youtube] Thumbnail uploaded for ' + videoId + ' (status: ' + thumbRes.status + ')',
      );
    } catch (e) {
      console.warn('[youtube] Thumbnail upload failed:', e.message);
    }
  }

  const shortUrl = 'https://youtube.com/shorts/' + videoId;
  console.log('[youtube] Video uploaded:', metadata.title, shortUrl);
  return { videoId, url: shortUrl };
}

async function processUploadSlot() {
  if (youtubeUploadQueue.length === 0) return;

  const slotName = 'upload-slot-' + nowInCT().hour;
  if (hasFired(slotName)) return;

  const item = youtubeUploadQueue[0];
  console.log('[youtube] Processing upload slot: ' + item.id);

  try {
    const result = await uploadVideoToYouTube(
      item.videoPath,
      item.thumbnailPath,
      { title: item.title, description: item.description || '', tags: item.tags || [] },
      item.channel,
    );
    item.status = 'posted';
    item.youtube_url = result.url;
    item.videoId = result.videoId;
    item.posted_at = new Date().toISOString();
    youtubeUploadQueue.shift(); // Remove from queue
    markFired(slotName);

    // Clean up uploaded files
    try {
      fs.unlinkSync(item.videoPath);
    } catch {}
    try {
      if (item.thumbnailPath) fs.unlinkSync(item.thumbnailPath);
    } catch {}

    console.log('[youtube] Upload complete: ' + result.url);
  } catch (e) {
    console.error('[youtube] Upload failed for ' + item.id + ':', e.message);
    console.error('[youtube] Upload failed for "' + item.title + '":', e.message);
  }
}

// ── Scheduler — Daily Briefing + Video Pipeline ─────────────────────────────
// Runs in-process via setInterval. Fires jobs at designated CT times.
// Idempotency: in-memory flags reset at midnight CT.

const schedulerFlags = new Map(); // "briefing-2026-04-04" → true

function nowInCT() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  let hour = 0,
    minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  if (hour === 24) hour = 0;
  return { hour, minute };
}

function todayKeyCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
}

function friendlyDateCT() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

function inWindow(time, targetHour, targetMinute, windowMinutes) {
  windowMinutes = windowMinutes || 2;
  const nowTotal = time.hour * 60 + time.minute;
  const targetTotal = targetHour * 60 + targetMinute;
  return nowTotal >= targetTotal && nowTotal < targetTotal + windowMinutes;
}

function schedulerFlag(name) {
  return name + '-' + todayKeyCT();
}

function hasFired(name) {
  return schedulerFlags.has(schedulerFlag(name));
}

function markFired(name) {
  schedulerFlags.set(schedulerFlag(name), true);
}

// ── News fetching ────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'SecondBrain/1.0' } }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      })
      .on('error', reject);
  });
}

function parseRssHeadlines(xml, max) {
  max = max || 5;
  const re = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gis;
  const headlines = [];
  let match,
    count = 0;
  while ((match = re.exec(xml)) !== null) {
    const title = match[1]
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#[0-9]+;/g, '');
    if (count > 0 && title.length > 15 && headlines.length < max) {
      headlines.push(title);
    }
    count++;
  }
  return headlines;
}

async function fetchNewsHeadlines() {
  const seen = new Set();
  const headlines = [];

  // NewsAPI if configured (best source)
  if (NEWS_API_KEY) {
    try {
      const url =
        'https://newsapi.org/v2/top-headlines?country=us&pageSize=15&apiKey=' + NEWS_API_KEY;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw);
      if (data.articles) {
        for (const a of data.articles) {
          if (a.title && headlines.length < 10) {
            const key = a.title.toLowerCase().slice(0, 40);
            if (!seen.has(key)) {
              seen.add(key);
              headlines.push(a.title);
            }
          }
        }
        if (headlines.length >= 10) return headlines;
      }
    } catch (e) {
      console.warn('[briefing] NewsAPI failed:', e.message);
    }
  }

  // RSS fallbacks to fill remaining slots
  const feeds = [
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    'https://feeds.npr.org/1001/rss.xml',
    'https://rsshub.app/apnews/topics/apf-topnews',
  ];
  for (const feed of feeds) {
    try {
      const xml = await fetchUrl(feed);
      for (const h of parseRssHeadlines(xml, 8)) {
        const key = h.toLowerCase().slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key);
          headlines.push(h);
        }
      }
    } catch {
      /* skip */
    }
    if (headlines.length >= 10) break;
  }
  return headlines.slice(0, 10);
}

async function fetchAITechNews() {
  const feeds = [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://techcrunch.com/feed/',
    'https://www.theverge.com/rss/index.xml',
    'https://arstechnica.com/feed/',
    'https://hnrss.org/frontpage',
  ];
  const seen = new Set();
  const headlines = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchUrl(feed);
      for (const h of parseRssHeadlines(xml, 8)) {
        const key = h.toLowerCase().slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key);
          headlines.push(h);
        }
      }
    } catch {
      /* skip */
    }
    if (headlines.length >= 10) break;
  }
  return headlines.slice(0, 10);
}

async function summarizeWithGroq(headlines, prompt) {
  if (!GROQ_API_KEY || headlines.length === 0) {
    return headlines.map((h) => '• ' + h).join('\n');
  }
  try {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: prompt + '\n\n' + headlines.map((h, i) => i + 1 + '. ' + h).join('\n'),
        },
      ],
    });
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + GROQ_API_KEY,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              resolve(
                (data.choices &&
                  data.choices[0] &&
                  data.choices[0].message &&
                  data.choices[0].message.content) ||
                  '',
              );
            } catch {
              resolve('');
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    if (result) return result.trim();
  } catch (e) {
    console.warn('[briefing] Groq summarization failed:', e.message);
  }
  return headlines.map((h) => '• ' + h).join('\n');
}

// ── Morning Briefing ─────────────────────────────────────────────────────────

async function sendDailyBriefing() {
  if (hasFired('briefing')) {
    console.log('[briefing] Already sent today — skipping');
    return;
  }
  if (!BOT_TOKEN || !LUKE_CHAT_ID) {
    console.warn('[briefing] Telegram not configured — skipping');
    return;
  }

  console.log('[briefing] Building morning briefing...');

  const [worldNews, aiNews] = await Promise.all([fetchNewsHeadlines(), fetchAITechNews()]);

  const worldSummary = await summarizeWithGroq(
    worldNews,
    'Summarize each headline in one concise sentence with specific facts (names, numbers, dates). Return as a numbered list, one per line. Be factual, no filler.',
  );
  const aiSummary = await summarizeWithGroq(
    aiNews,
    'Summarize each headline in one concise sentence with specific facts. Focus on what matters for someone building AI products. Return as a numbered list, one per line.',
  );

  // Build briefing sections
  const lines = [];
  lines.push('Good morning Luke — ' + friendlyDateCT());
  lines.push('');

  if (aiSummary) {
    lines.push('AI & TECH:');
    lines.push(aiSummary);
    lines.push('');
  }

  if (worldSummary) {
    lines.push('WORLD NEWS:');
    lines.push(worldSummary);
    lines.push('');
  }

  // Synced data from Electron (projects, todos, calls)
  if (syncedData.timestamp) {
    const age = Math.round((Date.now() - new Date(syncedData.timestamp).getTime()) / 60000);
    if (age < 1440) {
      // Less than 24h old
      if (syncedData.todos && syncedData.todos.length > 0) {
        const open = syncedData.todos.filter((t) => !t.completed);
        if (open.length > 0) {
          lines.push('OPEN TASKS (' + open.length + '):');
          for (const t of open.slice(0, 5)) {
            lines.push('  • ' + (t.title || t.text || JSON.stringify(t)).slice(0, 80));
          }
          if (open.length > 5) lines.push('  ... and ' + (open.length - 5) + ' more');
          lines.push('');
        }
      }
      if (syncedData.projects && syncedData.projects.length > 0) {
        const active = syncedData.projects.filter((p) => p.status === 'active');
        if (active.length > 0) {
          lines.push('ACTIVE PROJECTS (' + active.length + '):');
          for (const p of active.slice(0, 3)) {
            lines.push('  • ' + (p.name || p.title || 'Unnamed'));
          }
          lines.push('');
        }
      }
    }
  }

  lines.push("What's the focus today?");

  const text = lines.join('\n');

  try {
    await sendMessage(text);
    markFired('briefing');
    console.log('[briefing] Morning briefing sent successfully');
  } catch (e) {
    console.error('[briefing] Failed to send:', e.message);
  }
}

// ── Scheduler Tick ───────────────────────────────────────────────────────────

async function schedulerTick() {
  const time = nowInCT();

  // 5:29–5:31 AM CT — morning briefing
  if (inWindow(time, 5, 29)) {
    sendDailyBriefing().catch((e) => console.error('[scheduler] briefing error:', e.message));
  }

  // YouTube upload slots: 9am, 1pm, 5pm CT
  if (inWindow(time, 9, 0) || inWindow(time, 13, 0) || inWindow(time, 17, 0)) {
    processUploadSlot().catch((e) => console.error('[scheduler] upload error:', e.message));
  }

  // Clean up old flags at midnight
  if (inWindow(time, 0, 0, 3)) {
    const today = todayKeyCT();
    for (const key of schedulerFlags.keys()) {
      if (!key.endsWith(today)) {
        schedulerFlags.delete(key);
      }
    }
  }
}

function startScheduler() {
  console.log('[scheduler] Started — checking every 60s');
  console.log('[scheduler] Morning briefing: 5:30 AM CT (10 AI + 10 world news)');
  console.log('[scheduler] YouTube uploads: 9am / 1pm / 5pm CT');
  ensureYoutubeDir();
  schedulerTick(); // Run immediately on start
  setInterval(schedulerTick, 60000);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
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
    const proxyUp = await checkLocalProxy();
    const llmSource = proxyUp
      ? 'claude-max-plan (FREE)'
      : ANTHROPIC_API_KEY
        ? 'anthropic-api (PAID)'
        : 'openai-gpt4o (PAID)';
    jsonOk(res, {
      status: 'ok',
      service: 'secondbrain-backend',
      version: '2.0.0',
      uptime: process.uptime(),
      llm: {
        source: llmSource,
        maxPlanProxy: proxyUp ? 'connected' : 'disconnected',
        cost: proxyUp ? 'zero (Max plan)' : 'per-token',
      },
      amyVersion: syncedData.amyVersion || 2,
      dataSyncAge: syncedData.timestamp
        ? Math.round((Date.now() - new Date(syncedData.timestamp).getTime()) / 1000) + 's'
        : 'never',
      pending_approvals: pendingApprovals.size,
      last_update_id: lastUpdateId,
      sessions: {
        total: sessionRegistry.size,
        active: [...sessionRegistry.values()].filter((s) => s.status === 'active').length,
      },
      commands: {
        total: commandQueue.size,
        pending: [...commandQueue.values()].filter((c) => c.status === 'pending').length,
        in_progress: [...commandQueue.values()].filter((c) => c.status === 'in_progress').length,
      },
      queries: {
        total: queryQueue.size,
        pending: [...queryQueue.values()].filter((q) => q.status === 'pending').length,
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
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
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
    if (!s) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    jsonOk(res, s);
    return;
  }

  // PATCH /sessions/:id — update session (status, topic, metadata)
  if (urlPath.match(/^\/sessions\/[^/]+$/) && req.method === 'PATCH') {
    const id = urlPath.split('/')[2];
    const s = sessionRegistry.get(id);
    if (!s) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readBody(req);
      if (body.topic !== undefined) s.topic = body.topic;
      if (body.status !== undefined) s.status = body.status;
      if (body.metadata !== undefined) Object.assign(s.metadata, body.metadata);
      s.lastActivity = new Date().toISOString();
      console.log('[session] Updated', id, '—', s.status, s.topic.slice(0, 40));
      jsonOk(res, s);
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  // DELETE /sessions/:id — mark session complete
  if (urlPath.match(/^\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    const id = urlPath.split('/')[2];
    const s = sessionRegistry.get(id);
    if (!s) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    s.status = 'complete';
    s.lastActivity = new Date().toISOString();
    console.log('[session] Closed', id);
    jsonOk(res, { ok: true });
    return;
  }

  // ── Vapi webhook ───────────────────────────────────────────────────────────

  if (urlPath === '/vapi/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        // Vapi sends events either as { type, functionCall, call } or wrapped as { message: { type, functionCall, call } }
        const msg = event.message && event.message.type ? event.message : event;
        const evType = msg.type;
        const fnCall = msg.functionCall;
        const callObj = msg.call;
        console.log('[vapi]', evType, callObj && callObj.id);

        if (evType === 'function-call' && fnCall && fnCall.name === 'request_approval') {
          const params = fnCall.parameters || {};
          const id = 'apr_' + Date.now();

          await sendApprovalRequest(
            id,
            params.description || 'Unknown request',
            params.request_type || 'unknown',
          );

          const result = await new Promise((resolve) => {
            pendingApprovals.set(id, { resolve, description: params.description });
            setTimeout(() => {
              if (pendingApprovals.has(id)) {
                pendingApprovals.delete(id);
                resolve({ approved: false, timed_out: true });
              }
            }, 55000);
          });

          jsonOk(res, { result: result.approved ? 'approved' : 'denied' });
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'bridge_in_luke') {
          const params = fnCall.parameters || {};
          const callerName = params.caller_name || 'someone';
          const topic = params.topic || 'unspecified topic';
          const callerPhone = (callObj && callObj.customer && callObj.customer.number) || '';
          const liveCallId = callObj && callObj.id;

          console.log('[bridge] Bridging ' + callerName + ' to the owner re: ' + topic);
          // Bridge-in is an active call event — Luke gets the call itself, no separate Telegram ping

          if (!LUKE_PHONE) {
            console.log(
              '[bridge] LUKE_PHONE not set — cannot dial. Set LUKE_PRIVATE_SIM env var on EC2.',
            );
            jsonOk(res, {
              result:
                'I was not able to reach the owner right now — his direct line is not configured. I will let him know you called.',
            });
            return;
          }

          bridgeOwner(callerName, topic, callerPhone, liveCallId)
            .then((r) => console.log('[bridge] Dial initiated:', r && r.id))
            .catch((e) => console.error('[bridge] Dial error:', e.message));

          // Respond immediately so Vapi does not time out the function call
          jsonOk(res, {
            result: 'Calling the owner now — ' + callerName + ', please hold while I connect you.',
          });
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'query_knowledge') {
          const params = fnCall.parameters || {};
          const question = params.question || params.query || 'unknown question';
          const vapiCallId = callObj && callObj.id;

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
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          }

          if (answer !== null) {
            jsonOk(res, { result: answer });
          } else {
            jsonOk(res, {
              result: "I couldn't find that in time, let me check and get back to you.",
            });
          }

          // ── New v2+ tool handlers (direct execution, no polling) ─────────
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'check_project_status') {
          const result = handleCheckProjectStatus(fnCall.parameters || {});
          console.log('[vapi] check_project_status:', result.slice(0, 80));
          jsonOk(res, { result });
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'check_todos') {
          const result = handleCheckTodos(fnCall.parameters || {});
          console.log('[vapi] check_todos:', result.slice(0, 80));
          jsonOk(res, { result });
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'manage_task') {
          const result = handleManageTask(fnCall.parameters || {});
          console.log('[vapi] manage_task:', result.slice(0, 80));
          jsonOk(res, { result });
        } else if (evType === 'function-call' && fnCall && fnCall.name === 'send_message') {
          const result = handleSendMessage(fnCall.parameters || {});
          console.log('[vapi] send_message:', result.slice(0, 80));
          jsonOk(res, { result });
        } else {
          jsonOk(res, { received: true });
        }
      } catch (e) {
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
      if (!message) {
        res.writeHead(400);
        res.end('message required');
        return;
      }
      const result = await initiateVapiOutbound(to, message);
      jsonOk(res, { ok: true, result });
    } catch (e) {
      console.error('[vapi outbound error]', e.message);
      res.writeHead(500);
      res.end(e.message);
    }
    return;
  }

  // ── Command Queue endpoints ────────────────────────────────────────────────

  // POST /commands — add a command (optionally with routing override)
  if (urlPath === '/commands' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.type || !body.prompt) {
        res.writeHead(400);
        res.end('type and prompt required');
        return;
      }
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
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
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
    if (!cmd) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    jsonOk(res, cmd);
    return;
  }

  // POST /commands/:id/claim
  if (urlPath.match(/^\/commands\/[^/]+\/claim$/) && req.method === 'POST') {
    const id = urlPath.split('/')[2];
    const cmd = commandQueue.get(id);
    if (!cmd) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (cmd.status !== 'pending') {
      res.writeHead(409);
      res.end('not pending');
      return;
    }
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
    if (!cmd) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readBody(req);
      cmd.status = body.success ? 'done' : 'failed';
      cmd.success = !!body.success;
      cmd.result = body.result || '';
      cmd.updatedAt = new Date().toISOString();
      console.log('[cmd] Completed', id, cmd.status);
      await deliverCommandResult(cmd);
      jsonOk(res, { ok: true });
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  // ── Query Queue endpoints ──────────────────────────────────────────────────

  if (urlPath === '/queries' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.question) {
        res.writeHead(400);
        res.end('question required');
        return;
      }
      const id = addQuery({ question: body.question, vapiCallId: body.vapiCallId });
      jsonOk(res, { id }, 201);
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
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
    if (!q) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readBody(req);
      const answer = body.answer || '';
      q.status = 'done';
      queryAnswers.set(id, answer);
      console.log('[query] Answered', id, '—', answer.slice(0, 60));
      jsonOk(res, { ok: true, answer });
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  // ── Data Sync (Electron → EC2) ──────────────────────────────────────────────

  if (urlPath === '/sync' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      syncedData = {
        projects: body.projects || [],
        todos: body.todos || [],
        recentCalls: body.recentCalls || [],
        amyVersion: body.amyVersion || 2,
        timestamp: body.timestamp || new Date().toISOString(),
      };
      console.log(
        '[sync] Updated: ' +
          syncedData.projects.length +
          ' projects, ' +
          syncedData.todos.length +
          ' todos, ' +
          syncedData.recentCalls.length +
          ' calls' +
          ', Amy v' +
          syncedData.amyVersion,
      );
      jsonOk(res, { ok: true, received: syncedData.timestamp });
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  if (urlPath === '/sync' && req.method === 'GET') {
    jsonOk(res, {
      ...syncedData,
      stale: !syncedData.timestamp || Date.now() - new Date(syncedData.timestamp).getTime() > 60000,
    });
    return;
  }

  // ── Memory Sync (Electron pushes canonical memory to EC2) ─────────────────
  // POST body: { memories: [{ name, type, body }] } — bulk push from Electron.
  // GET: returns current cached memory for prompt building.
  if (urlPath === '/sync-memory' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.memories && Array.isArray(payload.memories)) {
          syncedData.memories = payload.memories;
          syncedData.memorySyncedAt = new Date().toISOString();
          jsonOk(res, {
            ok: true,
            count: payload.memories.length,
            syncedAt: syncedData.memorySyncedAt,
          });
          console.log('[sync-memory] Received ' + payload.memories.length + ' memory entries');
        } else {
          jsonOk(res, { ok: false, error: 'Expected { memories: [...] }' });
        }
      } catch (err) {
        jsonOk(res, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (urlPath === '/sync-memory' && req.method === 'GET') {
    const memories = syncedData.memories || [];
    jsonOk(res, {
      ok: true,
      count: memories.length,
      syncedAt: syncedData.memorySyncedAt || null,
      stale:
        !syncedData.memorySyncedAt ||
        Date.now() - new Date(syncedData.memorySyncedAt).getTime() > 3600000,
    });
    return;
  }

  // ── Claude LLM Proxy (OpenAI-compatible) ──────────────────────────────────
  // Vapi sends requests here when custom-llm provider is configured.
  // Translates OpenAI format → Anthropic Claude → streams back OpenAI SSE format.

  if (
    (urlPath === '/llm/chat/completions' ||
      urlPath === '/v1/chat/completions' ||
      urlPath === '/chat/completions') &&
    req.method === 'POST'
  ) {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const openaiBody = JSON.parse(body);
        console.log(
          '[claude-llm] Request: model=' +
            (openaiBody.model || 'default') +
            ', messages=' +
            (openaiBody.messages || []).length +
            ', tools=' +
            (openaiBody.tools || []).length,
        );
        streamClaudeLLM(openaiBody, res);
      } catch (e) {
        console.error('[claude-llm] parse error:', e.message);
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
    return;
  }

  // ── Action Handoff endpoints ────────────────────────────────────────────────

  if (urlPath === '/handoffs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const handoff = createHandoff({
        taskDescription: body.taskDescription || body.task || '',
        successCriteria: body.successCriteria,
        priority: body.priority,
        callbackCallId: body.callbackCallId,
        source: body.source || 'api',
      });
      jsonOk(res, handoff, 201);
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  if (urlPath === '/handoffs' && req.method === 'GET') {
    jsonOk(res, [...actionHandoffs.values()]);
    return;
  }

  if (urlPath.match(/^\/handoffs\/[^/]+\/complete$/) && req.method === 'POST') {
    const id = urlPath.split('/')[2];
    try {
      const body = await readBody(req);
      const h = completeHandoff(id, body.result || '', body.success !== false);
      if (!h) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      jsonOk(res, h);
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  // ── Proactive callback registration ───────────────────────────────────────

  if (urlPath === '/proactive/register-callback' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      registerCallbackRequest(body.callId || 'manual', body.topic || 'Task update');
      jsonOk(res, { ok: true });
    } catch (e) {
      res.writeHead(400);
      res.end('bad json');
    }
    return;
  }

  // ── Amy Version Info ──────────────────────────────────────────────────────────

  if (urlPath === '/amy/version' && req.method === 'GET') {
    jsonOk(res, {
      activeVersion: syncedData.amyVersion,
      dataAge: syncedData.timestamp
        ? Math.round((Date.now() - new Date(syncedData.timestamp).getTime()) / 1000) + 's'
        : 'never synced',
      projects: syncedData.projects.length,
      todos: syncedData.todos.length,
    });
    return;
  }

  // ── Briefing endpoints ─────────────────────────────────────────────────────

  if (urlPath === '/briefing/trigger' && req.method === 'POST') {
    schedulerFlags.delete(schedulerFlag('briefing'));
    sendDailyBriefing().catch((e) => console.error('[briefing] manual trigger error:', e.message));
    jsonOk(res, { ok: true, message: 'Briefing triggered' });
    return;
  }

  if (urlPath === '/scheduler/status' && req.method === 'GET') {
    const time = nowInCT();
    jsonOk(res, {
      currentTimeCT: time.hour + ':' + String(time.minute).padStart(2, '0'),
      todayKey: todayKeyCT(),
      firedToday: [...schedulerFlags.keys()],
      nextBriefing: hasFired('briefing') ? 'already sent' : '5:30 AM CT (10 AI + 10 world)',
      uploadQueue: youtubeUploadQueue.length,
      uploadSlots: '9am / 1pm / 5pm CT',
    });
    return;
  }

  // ── YouTube endpoints ──────────────────────────────────────────────────────

  // POST /youtube/queue — push a video to the upload queue (multipart: video + thumbnail + metadata)
  if (urlPath === '/youtube/queue' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // Expect JSON with base64-encoded video + thumbnail, or file paths on EC2
      if (!body.id || !body.title || !body.channel) {
        res.writeHead(400);
        res.end('id, title, channel required');
        return;
      }
      ensureYoutubeDir();
      let videoPath = body.videoPath; // If file already on EC2
      let thumbnailPath = body.thumbnailPath;

      // If base64 video data provided, write to disk
      if (body.videoBase64) {
        videoPath = path.join(YOUTUBE_DATA_DIR, body.id + '.mp4');
        fs.writeFileSync(videoPath, Buffer.from(body.videoBase64, 'base64'));
      }
      if (body.thumbnailBase64) {
        thumbnailPath = path.join(YOUTUBE_DATA_DIR, body.id + '_thumb.jpg');
        fs.writeFileSync(thumbnailPath, Buffer.from(body.thumbnailBase64, 'base64'));
      }

      if (!videoPath) {
        res.writeHead(400);
        res.end('videoPath or videoBase64 required');
        return;
      }

      youtubeUploadQueue.push({
        id: body.id,
        title: body.title,
        description: body.description || '',
        tags: body.tags || [],
        channel: body.channel,
        videoPath,
        thumbnailPath,
        queued_at: new Date().toISOString(),
        status: 'queued',
      });
      console.log('[youtube] Queued: ' + body.title + ' (' + body.channel + ')');
      jsonOk(res, { ok: true, position: youtubeUploadQueue.length, id: body.id }, 201);
    } catch (e) {
      res.writeHead(400);
      res.end('bad json: ' + e.message);
    }
    return;
  }

  // GET /youtube/queue — view upload queue
  if (urlPath === '/youtube/queue' && req.method === 'GET') {
    jsonOk(res, {
      queue: youtubeUploadQueue.map((q) => ({
        id: q.id,
        title: q.title,
        channel: q.channel,
        status: q.status,
        queued_at: q.queued_at,
      })),
      nextSlots: ['9:00 AM CT', '1:00 PM CT', '5:00 PM CT'],
    });
    return;
  }

  // POST /youtube/upload-now — force upload the next queued video immediately
  if (urlPath === '/youtube/upload-now' && req.method === 'POST') {
    if (youtubeUploadQueue.length === 0) {
      jsonOk(res, { ok: false, message: 'Queue is empty' });
      return;
    }
    processUploadSlot().catch((e) => console.error('[youtube] manual upload error:', e.message));
    jsonOk(res, { ok: true, uploading: youtubeUploadQueue[0].title });
    return;
  }

  // ── Test endpoint ──────────────────────────────────────────────────────────

  if (urlPath === '/test/telegram' && req.method === 'POST') {
    const result = await sendMessage('Amy backend is live and connected to Telegram!');
    jsonOk(res, result);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3001, async () => {
  console.log('[SecondBrain] SecondBrain backend v2.0.0 on :3001');
  console.log('[SecondBrain] Telegram polling for chat ' + LUKE_CHAT_ID);
  console.log('[SecondBrain] Dispatch routing: new_task | continue | query | status');
  const llmMode =
    process.env.CLAUDE_LLM_MODE === 'max'
      ? 'Max plan (claude -p)'
      : ANTHROPIC_API_KEY
        ? 'API key (direct)'
        : 'Max plan (claude -p)';
  console.log('[SecondBrain] Claude LLM proxy: ' + llmMode);
  console.log(
    '[SecondBrain] Direct tool execution: check_project_status, check_todos, manage_task, send_message',
  );
  pollTelegram();
  startScheduler();
  // Telegram is daily-briefing-only — log startup to console instead
  const time = nowInCT();
  console.log(
    '[SecondBrain] Amy v2.1 online — ' +
      time.hour +
      ':' +
      String(time.minute).padStart(2, '0') +
      ' CT',
  );
});
