#!/usr/bin/env node
/**
 * Standalone WhatsApp ingestion — runs outside Electron via pure Node.js.
 * Connects to WhatsApp via whatsapp-web.js, fetches all chats, and feeds
 * each conversation to Graphiti knowledge graph + saves transcripts to disk.
 *
 * Usage: node scripts/whatsapp-ingest-standalone.js
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'secondbrain',
  'data',
  'whatsapp-web',
);
const CONVS_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'secondbrain',
  'data',
  'conversations',
);
const STATE_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'secondbrain',
  'data',
  'whatsapp-ingest',
);
const GRAPHITI_URL = 'http://127.0.0.1:8000';
const RATE_LIMIT_MS = 300;

// ── Graphiti MCP client ─────────────────────────────────────────────────────

let sessionId = null;
let requestId = 0;

function mcpHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

async function parseSSE(res) {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return line ? JSON.parse(line.replace('data: ', '')) : null;
}

async function initGraphiti() {
  try {
    const res = await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'wa-ingest', version: '1.0' },
        },
      }),
    });
    sessionId = res.headers.get('mcp-session-id');
    await parseSSE(res);
    await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return true;
  } catch {
    return false;
  }
}

async function addEpisode(name, body, source) {
  try {
    const res = await fetch(`${GRAPHITI_URL}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: {
          name: 'add_memory',
          arguments: {
            name,
            episode_body: body.slice(0, 3000),
            source_description: source,
            source: 'text',
            group_id: 'luke-ea',
          },
        },
      }),
    });
    return !!(await parseSSE(res))?.result;
  } catch {
    return false;
  }
}

// ── State tracking ──────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8'));
  } catch {
    return { processed: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'state.json'), JSON.stringify(state, null, 2));
}

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== WhatsApp Full History Ingestion (Standalone) ===\n');

  // Init Graphiti
  const graphitiOk = await initGraphiti();
  console.log(`Graphiti: ${graphitiOk ? 'connected' : 'UNAVAILABLE (skipping episodes)'}`);

  // Clean stale locks
  const lockFiles = [
    'lockfile',
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'DevToolsActivePort',
  ];
  const sessionDir = path.join(DATA_DIR, 'session-secondbrain');
  for (const lock of lockFiles) {
    try {
      fs.unlinkSync(path.join(sessionDir, lock));
    } catch {}
  }

  // Create WhatsApp client
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'secondbrain', dataPath: DATA_DIR }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  // Wait for ready
  const readyPromise = new Promise((resolve, reject) => {
    client.on('qr', async (qr) => {
      const url = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      console.log('\n=== SCAN THIS QR CODE ===');
      console.log('QR data URL generated. Open in browser or scan from WhatsApp app.');
      console.log('WhatsApp → Settings → Linked Devices → Link a Device\n');
      // Also try to display in terminal
      try {
        await QRCode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
          if (!err) console.log(str);
        });
      } catch {}
    });
    client.on('authenticated', () => console.log('[wa] Authenticated'));
    client.on('loading_screen', (pct, msg) => console.log(`[wa] Loading: ${pct}% — ${msg}`));
    client.on('ready', () => {
      console.log('[wa] Ready!');
      resolve();
    });
    client.on('auth_failure', (msg) => reject(new Error(`Auth failed: ${msg}`)));
    setTimeout(() => reject(new Error('Timeout waiting for WhatsApp ready (300s)')), 300000);
  });

  console.log('Starting WhatsApp client...');
  await client.initialize();
  await readyPromise;

  // Fetch all chats
  console.log('\nFetching chats...');
  const chats = await client.getChats();
  console.log(`Found ${chats.length} chats\n`);

  const state = loadState();
  let processed = 0,
    skipped = 0,
    graphitiSuccess = 0;
  const errors = [];

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    const chatId = chat.id._serialized;
    const chatName = chat.name || chat.id.user || chatId;

    try {
      // Fetch messages (up to 500)
      const messages = await chat.fetchMessages({ limit: 500 });
      const textMsgs = messages.filter((m) => m.body && m.body.trim() && m.type === 'chat');

      if (textMsgs.length === 0) {
        skipped++;
        continue;
      }

      // Format transcript
      const sorted = textMsgs.sort((a, b) => a.timestamp - b.timestamp);
      const lines = sorted.map((m) => {
        const time = new Date(m.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const sender = m.fromMe ? 'Luke' : chatName;
        return `[${time}] ${sender}: ${m.body.trim()}`;
      });
      const transcript = `WhatsApp: ${chatName}\nMessages: ${textMsgs.length}\n\n${lines.join('\n')}`;
      const hash = md5(transcript);

      // Dedup
      const existing = state.processed[chatId];
      if (existing && existing.hash === hash) {
        skipped++;
        continue;
      }

      // Save transcript to conversations
      const convId = `wa_${chatId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60)}`;
      const convDir = path.join(CONVS_DIR, convId);
      fs.mkdirSync(convDir, { recursive: true });
      fs.writeFileSync(path.join(convDir, 'transcript.txt'), transcript);
      fs.writeFileSync(
        path.join(convDir, 'meta.json'),
        JSON.stringify(
          {
            id: convId,
            otterId: convId,
            title: `WhatsApp: ${chatName}`,
            date: new Date(sorted[0].timestamp * 1000).toISOString().split('T')[0],
            durationMinutes: textMsgs.length,
            speakers: [chatName, 'Luke'],
            myRole: 'participant',
            meetingType: chat.isGroup ? 'group_chat' : 'direct_message',
            summary: `WhatsApp conversation with ${chatName} (${textMsgs.length} messages)`,
            topics: [],
            keywords: [],
            peopleMentioned: [chatName],
            companiesMentioned: [],
            decisions: [],
            sentiment: 'routine',
            transcriptFile: 'transcript.txt',
            taggedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      // Feed to Graphiti
      if (graphitiOk) {
        const episodeBody = `WhatsApp conversation with ${chatName}. ${textMsgs.length} messages.\n\n${lines.slice(0, 30).join('\n')}`;
        const ok = await addEpisode(`WhatsApp: ${chatName}`, episodeBody, `whatsapp:${chatId}`);
        if (ok) graphitiSuccess++;
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
      }

      state.processed[chatId] = {
        hash,
        ingestedAt: new Date().toISOString(),
        chatName,
        messageCount: textMsgs.length,
      };
      saveState(state);
      processed++;

      if ((i + 1) % 10 === 0 || i === 0) {
        console.log(`[${i + 1}/${chats.length}] ${chatName}: ${textMsgs.length} messages`);
      }
    } catch (e) {
      errors.push(`${chatName}: ${e.message}`);
    }
  }

  console.log('\n=== WhatsApp Ingestion Complete ===');
  console.log(`Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);
  console.log(`Graphiti episodes: ${graphitiSuccess}`);
  if (errors.length > 0) {
    console.log('Errors:', errors.slice(0, 5).join('; '));
  }

  // Don't destroy — keep session alive for the Electron app
  console.log('\nKeeping session alive. Press Ctrl+C to exit.');
  // Give Graphiti time to process
  await new Promise((r) => setTimeout(r, 5000));
  await client.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
