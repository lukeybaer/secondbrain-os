#!/usr/bin/env node
// vapi-mcp/server.js
//
// Local MCP server exposing the 4 Vapi-specific tools Amy needs when
// running as claude-via-proxy on a voice call:
//
//   bridge_in_owner        - transfer caller to the owner's phone
//   request_approval       - ask the owner for permission via Telegram
//   flag_reputation_risk   - log a reputation risk for the owner
//   send_message           - send a Telegram message on the owner's behalf
//
// Claude -p launches with --mcp-config pointing at this server. When
// Claude decides to call one of these tools, it emits native tool_use
// events in stream-json output. The claude-proxy translates those to
// OpenAI tool_calls for Vapi.

const readline = require('readline');
const https = require('https');

const EC2_BASE_URL = process.env.EC2_BASE_URL || 'https://unay54a6jh.execute-api.us-east-1.amazonaws.com/prod';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function logErr(msg) {
  process.stderr.write('[vapi-mcp] ' + msg + '\n');
}

const TOOLS = [
  {
    name: 'bridge_in_owner',
    description: 'Transfer the current caller to the owner via warm transfer. Use when a caller asks for the owner, or the conversation needs escalation.',
    inputSchema: {
      type: 'object',
      properties: {
        caller_name: { type: 'string', description: 'Name of the person calling.' },
        topic: { type: 'string', description: 'One-sentence reason they want the owner.' },
      },
      required: ['caller_name', 'topic'],
    },
  },
  {
    name: 'request_approval',
    description: 'Request the owner explicit approval before doing something consequential: sharing PII, transferring a call, committing to an action. Owner is asked via Telegram. ALWAYS use before sharing address, phone, email, financial details.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What you are about to do, in plain English.' },
        request_type: { type: 'string', enum: ['share_pii', 'transfer_call', 'commit_to_action', 'reputation_risk'] },
        data_category: { type: 'string', description: 'Type of data (home_address, phone_number, email, financial, etc)' },
      },
      required: ['description', 'request_type'],
    },
  },
  {
    name: 'flag_reputation_risk',
    description: 'Flag a statement that could be embarrassing, defamatory, legally risky, or misrepresents the owner. Flag and continue the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['false_statement', 'legal_threat', 'defamation', 'misrepresentation', 'illegal_activity', 'other'] },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        description: { type: 'string', description: 'What was said and why it is a risk.' },
        excerpt: { type: 'string', description: 'Exact quote that triggered the flag.' },
      },
      required: ['category', 'severity', 'description'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message via Telegram on the owner behalf. Use when the owner says text them, let them know, send a message.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['telegram'] },
        message: { type: 'string', description: 'The message body.' },
      },
      required: ['channel', 'message'],
    },
  },
];

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(EC2_BASE_URL + path);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function callTool(name, args) {
  try {
    switch (name) {
      case 'bridge_in_owner': {
        const r = await postJson('/vapi/bridge-in', args);
        return { content: [{ type: 'text', text: r.status < 300 ? 'Bridge request sent. Dialing the owner now.' : 'Bridge request failed: ' + JSON.stringify(r.body) }] };
      }
      case 'request_approval': {
        const r = await postJson('/approvals/request', args);
        const approved = r.body && r.body.approved;
        return { content: [{ type: 'text', text: approved ? 'Approved by owner.' : 'Denied or timed out.' }] };
      }
      case 'flag_reputation_risk': {
        const r = await postJson('/reputation/flag', args);
        return { content: [{ type: 'text', text: r.status < 300 ? 'Flagged for review.' : 'Flag failed: ' + JSON.stringify(r.body) }] };
      }
      case 'send_message': {
        const r = await postJson('/telegram/send', { text: args.message });
        return { content: [{ type: 'text', text: r.status < 300 ? 'Message sent.' : 'Send failed: ' + JSON.stringify(r.body) }] };
      }
      default:
        return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vapi-mcp', version: '1.0.0' },
      }});
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result });
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // no response for notifications
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) {
    logErr('dispatch error: ' + e.message);
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
});

logErr('vapi-mcp ready on stdio');
