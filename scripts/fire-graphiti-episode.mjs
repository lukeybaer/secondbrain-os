#!/usr/bin/env node
// fire-graphiti-episode.mjs <memory-file.md>
//
// Standalone Graphiti addEpisode firer for the #learn workflow. Reads the
// given memory file, opens an MCP session against the local Graphiti
// server at http://127.0.0.1:8000, calls add_memory with the file body,
// prints GRAPHITI_OK <name> on success or GRAPHITI_UNREACHABLE <reason>
// on failure. Exit code: 0 either way (failure is reported, not fatal,
// because the next seed-graphiti.ts run will pick the file up).
//
// This is the missing mechanical handle for step 6 of the #learn
// workflow (memory/feedback_scheduled_tasks_must_be_silent.md context).

import { readFileSync } from 'node:fs';
import path from 'node:path';

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://127.0.0.1:8000';
const file = process.argv[2];
if (!file) {
  console.error('usage: fire-graphiti-episode.mjs <memory-file.md>');
  process.exit(2);
}

const body = readFileSync(file, 'utf8');
const name = path.basename(file, '.md');

let sessionId = null;
let requestId = 0;

function headers() {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

async function parseSSE(res) {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) return null;
  try { return JSON.parse(line.slice(6)); } catch { return null; }
}

try {
  const init = await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fire-graphiti-episode', version: '1.0' },
      },
    }),
  });
  sessionId = init.headers.get('mcp-session-id');
  await parseSSE(init);
  await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const res = await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'tools/call',
      params: {
        name: 'add_memory',
        arguments: {
          name,
          episode_body: body.slice(0, 3000),
          source_description: '#learn manual fire from ' + path.basename(file),
          source: 'text',
          group_id: 'owner-ea',
        },
      },
    }),
  });
  const data = await parseSSE(res);
  if (data?.result) {
    console.log('GRAPHITI_OK ' + name);
    process.exit(0);
  }
  console.log('GRAPHITI_UNREACHABLE no-result-from-add_memory');
} catch (e) {
  console.log('GRAPHITI_UNREACHABLE ' + (e?.message || String(e)));
}
