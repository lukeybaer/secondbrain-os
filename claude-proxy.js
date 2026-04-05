#!/usr/bin/env node
// claude-proxy.js
// Local proxy server that runs on Luke's PC. Accepts OpenAI-compatible
// /chat/completions requests and routes them through `claude -p` using
// Max plan tokens (zero cost). EC2 connects via SSH reverse tunnel.
//
// Usage:
//   node claude-proxy.js
//   # Listens on port 3456 (configurable via PORT env)
//
// EC2 reaches this via reverse tunnel:
//   ssh -R 3456:localhost:3456 ec2-user@98.80.164.16
//
// Then EC2 server hits http://localhost:3456/chat/completions

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.CLAUDE_PROXY_PORT || 3456;

// Find claude executable
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';

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

// Build a prompt from OpenAI chat messages
function messagesToPrompt(messages, tools) {
  const parts = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(msg.content);
    } else if (msg.role === 'user') {
      parts.push('\n[User]: ' + msg.content);
    } else if (msg.role === 'assistant') {
      let text = msg.content || '';
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          text += '\n[Tool call]: ' + tc.function.name + '(' + tc.function.arguments + ')';
        }
      }
      if (text) parts.push('\n[Assistant]: ' + text);
    } else if (msg.role === 'tool') {
      parts.push('\n[Tool result]: ' + msg.content);
    }
  }

  // Add tool definitions if present
  if (tools && tools.length) {
    const toolSection =
      '\n\n[Available tools - call by responding with ONLY a JSON block like {"tool_call":{"name":"...","arguments":{...}}}]:\n' +
      tools
        .filter((t) => t.type === 'function')
        .map((t) => '- ' + t.function.name + ': ' + (t.function.description || '').slice(0, 300))
        .join('\n');
    // Insert after system prompt
    parts.splice(1, 0, toolSection);
  }

  return parts.join('\n');
}

// Stream claude -p output as OpenAI SSE format
function handleChatCompletions(openaiBody, res) {
  const prompt = messagesToPrompt(openaiBody.messages || [], openaiBody.tools);
  const callId = 'chatcmpl-max-' + Date.now();

  console.log(
    '[proxy] Request: ' +
      (openaiBody.messages || []).length +
      ' messages, ' +
      (openaiBody.tools || []).length +
      ' tools, prompt ' +
      prompt.length +
      ' chars',
  );

  const args = [
    '-p',
    prompt,
    '--bare',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  const proc = spawn(CLAUDE_PATH, args, {
    env: { ...process.env },
    cwd: process.env.HOME || process.env.USERPROFILE,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
  let fullText = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // stream-json text deltas
        if (event.type === 'stream_event' && event.event && event.event.delta) {
          const delta = event.event.delta;
          if (delta.type === 'text_delta' && delta.text) {
            fullText += delta.text;
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

        // result event (final)
        if (event.type === 'result' && event.result) {
          // If we didn't stream any deltas, send the full result
          if (!fullText && event.result) {
            res.write(
              'data: ' +
                JSON.stringify({
                  id: callId,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: event.result }, finish_reason: null }],
                }) +
                '\n\n',
            );
          }
        }
      } catch {
        // Non-JSON output — might be raw text in some modes
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg && !msg.includes('Update available')) {
      console.error('[proxy] stderr:', msg.slice(0, 200));
    }
  });

  proc.on('close', (code) => {
    console.log('[proxy] claude -p exited (' + code + '), streamed ' + fullText.length + ' chars');
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
    console.error('[proxy] spawn error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'claude not available: ' + err.message } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  proc.stdin.end();

  // 90s timeout (generous for voice)
  setTimeout(() => {
    if (!proc.killed) {
      console.log('[proxy] Killing after 90s timeout');
      proc.kill('SIGTERM');
    }
  }, 90000);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Health check
  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', service: 'claude-max-proxy', uptime: process.uptime() }),
    );
    return;
  }

  // OpenAI-compatible chat completions
  if ((url === '/chat/completions' || url === '/v1/chat/completions') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      handleChatCompletions(body, res);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[claude-max-proxy] Listening on 127.0.0.1:' + PORT);
  console.log('[claude-max-proxy] Using: ' + CLAUDE_PATH);
  console.log(
    '[claude-max-proxy] Connect EC2 via: ssh -R ' +
      PORT +
      ':localhost:' +
      PORT +
      ' ec2-user@98.80.164.16',
  );
  console.log('[claude-max-proxy] Max plan tokens — zero API cost');
});
