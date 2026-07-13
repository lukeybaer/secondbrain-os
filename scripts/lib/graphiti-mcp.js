const http = require('http');
const { ensureGraphitiTunnel } = require('./graphiti-tunnel');

const DEFAULT_URL = process.env.GRAPHITI_URL || 'http://127.0.0.1:8000';
const DEFAULT_GROUP = process.env.GRAPHITI_GROUP_ID || 'owner-ea';

let sessionId = null;
let requestId = 0;

function requestJson(url, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: payload ? 'POST' : 'GET',
        headers: payload
          ? {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'Content-Length': Buffer.byteLength(payload),
              ...headers,
            }
          : { Accept: 'application/json', ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d.toString()));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, raw }));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function parseMcpResponse(raw) {
  const candidates = String(raw || '')
    .split(/\r?\n/)
    .map((line) => (line.startsWith('data:') ? line.slice(5).trim() : line.trim()))
    .filter((line) => line && line !== '[DONE]');
  const errors = [];
  for (const c of candidates.length ? candidates : [raw]) {
    try {
      const outer = JSON.parse(c);
      if (outer.error) throw new Error(outer.error.message || JSON.stringify(outer.error));
      const text = outer.result && outer.result.content && outer.result.content[0] && outer.result.content[0].text;
      if (text) {
        if (/^\s*error\b/i.test(text)) throw new Error(text.slice(0, 300));
        try {
          return JSON.parse(text);
        } catch {
          return { message: text };
        }
      }
      if (outer.result) return outer.result;
      return outer;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors[0] || 'unparseable MCP response');
}

async function ensureSession(baseUrl = DEFAULT_URL) {
  const tunnel = await ensureGraphitiTunnel({ baseUrl });
  if (!tunnel.reachable) {
    throw new Error(tunnel.reason || 'Graphiti is unreachable');
  }
  if (sessionId) return sessionId;
  const init = await requestJson(
    `${baseUrl}/mcp`,
    {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'secondbrain-graphiti-drain', version: '1.0' },
      },
      id: ++requestId,
    },
    {},
    10000,
  );
  sessionId = init.headers['mcp-session-id'] || null;
  if (!sessionId) throw new Error('Graphiti MCP did not return Mcp-Session-Id');
  try {
    await requestJson(
      `${baseUrl}/mcp`,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { 'Mcp-Session-Id': sessionId },
      5000,
    );
  } catch {
    // Some MCP servers accept tool calls without the notification.
  }
  return sessionId;
}

async function toolCall(toolName, args, opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_URL;
  try {
    const sid = await ensureSession(baseUrl);
    const res = await requestJson(
      `${baseUrl}/mcp`,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: ++requestId,
      },
      { 'Mcp-Session-Id': sid },
      opts.timeoutMs || 45000,
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Graphiti MCP HTTP ${res.statusCode}: ${String(res.raw).slice(0, 300)}`);
    }
    return parseMcpResponse(res.raw);
  } catch (error) {
    resetSession();
    throw error;
  }
}

async function addEpisode(event, opts = {}) {
  const args = {
    name: event.name,
    episode_body: event.body || event.episode_body,
    source: 'text',
    source_description: event.source_description || `${event.source}:${event.source_id || 'ExampleCo'}`,
    group_id: event.group_id || opts.groupId || DEFAULT_GROUP,
  };
  if (event.reference_time) args.reference_time = event.reference_time;
  return toolCall('add_memory', args, opts);
}

async function searchFacts(query, opts = {}) {
  const out = await toolCall(
    'search_memory_facts',
    {
      query,
      group_ids: [opts.groupId || DEFAULT_GROUP],
      max_facts: opts.maxFacts || opts.limit || 10,
    },
    opts,
  );
  return out && out.facts ? out.facts : [];
}

async function health(baseUrl = DEFAULT_URL) {
  const tunnel = await ensureGraphitiTunnel({ baseUrl });
  if (!tunnel.reachable) {
    return { status: 'error', reason: tunnel.reason || 'Graphiti is unreachable' };
  }
  const res = await requestJson(`${baseUrl}/health`, null, {}, 5000);
  try {
    return JSON.parse(res.raw || '{}');
  } catch {
    return { status: res.statusCode === 200 ? 'ok' : 'error', raw: res.raw };
  }
}

function resetSession() {
  sessionId = null;
}

module.exports = {
  addEpisode,
  health,
  parseMcpResponse,
  resetSession,
  searchFacts,
  toolCall,
};
