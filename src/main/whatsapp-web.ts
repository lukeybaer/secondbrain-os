// whatsapp-web.js integration — personal WhatsApp account via Puppeteer/WWebJS.
// All puppeteer/whatsapp-web.js requires are done dynamically so that electron-vite
// doesn't attempt to bundle them (they live in node_modules at runtime).

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fsP from 'fs/promises';
import { createRequire } from 'module';

// Use Node's native require to bypass electron-vite's module resolution
const nativeRequire = createRequire(path.join(app.getAppPath(), 'node_modules', '.package.json'));

// When true, suppress QR popup (e.g. during silent auto-connect on startup).
// Stays true until auth succeeds, auth fails, disconnect, or explicit user connect.
let suppressQRWindow = false;

// ── Types ────────────────────────────────────────────────────────────────────

export type WAStatus =
  | 'disconnected'
  | 'initializing'
  | 'qr'
  | 'authenticated'
  | 'ready'
  | 'auth_failure';

export interface WAChat {
  id: string;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  isGroup: boolean;
}

export interface WAMessage {
  id: string;
  chatId: string;
  from: string;
  fromName?: string;
  to: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  type: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;
let currentStatus: WAStatus = 'disconnected';

type StatusCb = (status: WAStatus, qrDataUrl?: string) => void;
type MessageCb = (msg: WAMessage) => void;

const statusCbs: StatusCb[] = [];
const messageCbs: MessageCb[] = [];
let qrWin: BrowserWindow | null = null;

const DATA_DIR = () => path.join(app.getPath('userData'), 'data', 'whatsapp-web');
const SESSION_PATH = () => path.join(DATA_DIR(), 'session-secondbrain');

// ── Internal helpers ──────────────────────────────────────────────────────────

function emitStatus(status: WAStatus, qrDataUrl?: string): void {
  currentStatus = status;
  statusCbs.forEach((cb) => cb(status, qrDataUrl));
}

function emitMessage(msg: WAMessage): void {
  messageCbs.forEach((cb) => cb(msg));
}

function closeQRWin(): void {
  if (qrWin && !qrWin.isDestroyed()) {
    try {
      qrWin.close();
    } catch {
      /* ignore */
    }
  }
  qrWin = null;
}

async function generateQRDataUrl(qrString: string): Promise<string> {
  try {
    const QRCode = nativeRequire('qrcode') as {
      toDataURL: (s: string, opts?: object) => Promise<string>;
    };
    return await QRCode.toDataURL(qrString, { width: 300, margin: 2 });
  } catch {
    return '';
  }
}

async function showQRWindow(dataUrl: string): Promise<void> {
  closeQRWin();
  if (!dataUrl) return;

  qrWin = new BrowserWindow({
    width: 400,
    height: 480,
    title: 'Connect WhatsApp',
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f0f0f;
      color: #e0e0e0;
      font-family: -apple-system, system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 16px;
      padding: 24px;
      text-align: center;
    }
    h2 { font-size: 17px; font-weight: 600; }
    img { border-radius: 12px; background: #fff; padding: 8px; }
    p { font-size: 12px; color: #666; line-height: 1.6; max-width: 300px; }
    span { color: #4ade80; font-weight: 600; }
  </style>
</head>
<body>
  <h2>Scan to connect WhatsApp</h2>
  <img src="${dataUrl}" width="260" height="260" />
  <p>
    Open WhatsApp on your phone →<br>
    <span>Settings → Linked Devices → Link a Device</span>
  </p>
</body>
</html>`;

  qrWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  qrWin.on('closed', () => {
    qrWin = null;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function onStatusChange(cb: StatusCb): void {
  statusCbs.push(cb);
}

export function onNewMessage(cb: MessageCb): void {
  messageCbs.push(cb);
}

export function getStatus(): WAStatus {
  return currentStatus;
}

/** Allow the QR popup again (called when user explicitly clicks Connect). */
export function allowQRWindow(): void {
  suppressQRWindow = false;
}

export async function initClient(): Promise<{ success: boolean; error?: string }> {
  console.log('[whatsapp-web] initClient called, existing client:', !!client);
  if (client) return { success: true };

  try {
    await fsP.mkdir(DATA_DIR(), { recursive: true });
    await cleanStaleLocks();
    console.log('[whatsapp-web] requiring whatsapp-web.js...');

    const { Client, LocalAuth } = nativeRequire('whatsapp-web.js') as {
      Client: new (opts: object) => any;
      LocalAuth: new (opts: object) => object;
    };
    console.log('[whatsapp-web] require OK, creating Client...');

    emitStatus('initializing');

    // Resolve Puppeteer's bundled Chrome path BEFORE Electron can override it
    const puppeteer = nativeRequire('puppeteer') as { executablePath: () => string };
    const chromePath = puppeteer.executablePath();
    console.log('[whatsapp-web] using Chrome at:', chromePath);

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'secondbrain',
        dataPath: DATA_DIR(),
      }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
        ],
        env: {
          ...process.env,
          // Prevent Electron from interfering with Puppeteer's Chrome process
          ELECTRON_RUN_AS_NODE: undefined,
          ELECTRON_NO_ASAR: undefined,
        },
      },
    });

    client.on('qr', async (qr: string) => {
      const dataUrl = await generateQRDataUrl(qr);
      emitStatus('qr', dataUrl);
      if (!suppressQRWindow) showQRWindow(dataUrl);
    });

    client.on('authenticated', () => {
      emitStatus('authenticated');
      closeQRWin();
    });

    client.on('loading_screen', (percent: number, message: string) => {
      console.log(`[whatsapp-web] loading: ${percent}% — ${message}`);
    });

    client.on('ready', () => {
      console.log('[whatsapp-web] ready event fired');
      emitStatus('ready');
    });

    client.on('auth_failure', () => {
      emitStatus('auth_failure');
      client = null;
    });

    client.on('disconnected', () => {
      emitStatus('disconnected');
      client = null;
    });

    client.on('message', async (msg: any) => {
      try {
        if (!msg.body || msg.type !== 'chat') return;
        const contact = await msg.getContact().catch(() => null);
        const waMsg: WAMessage = {
          id: msg.id._serialized,
          chatId: msg.from,
          from: msg.from,
          fromName: contact?.pushname || contact?.name || undefined,
          to: msg.to,
          body: msg.body,
          timestamp: (msg.timestamp as number) * 1000,
          fromMe: false,
          type: msg.type,
        };
        emitMessage(waMsg);
      } catch {
        /* ignore */
      }
    });

    client.on('message_create', async (msg: any) => {
      // Capture outgoing messages sent from this account
      try {
        if (!msg.fromMe || !msg.body || msg.type !== 'chat') return;
        const waMsg: WAMessage = {
          id: msg.id._serialized,
          chatId: msg.to,
          from: msg.from,
          to: msg.to,
          body: msg.body,
          timestamp: (msg.timestamp as number) * 1000,
          fromMe: true,
          type: msg.type,
        };
        emitMessage(waMsg);
      } catch {
        /* ignore */
      }
    });

    // Fire and forget — initialize() starts Puppeteer asynchronously
    console.log('[whatsapp-web] calling client.initialize()...');
    const initTimeout = setTimeout(() => {
      console.error('[whatsapp-web] initialize timed out after 60s — destroying client');
      if (client) {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
        client = null;
      }
      emitStatus('disconnected');
    }, 60_000);

    client
      .initialize()
      .then(() => {
        clearTimeout(initTimeout);
        console.log('[whatsapp-web] initialize resolved');
      })
      .catch((e: Error) => {
        clearTimeout(initTimeout);
        emitStatus('disconnected');
        client = null;
        console.error('[whatsapp-web] initialize error:', e.message);
      });

    return { success: true };
  } catch (e: any) {
    console.error('[whatsapp-web] initClient outer catch:', e.message, e.stack);
    client = null;
    emitStatus('disconnected');
    return { success: false, error: e.message };
  }
}

export async function getAllChats(): Promise<WAChat[]> {
  console.log('[whatsapp-web] getAllChats called, client:', !!client, 'status:', currentStatus);
  if (!client || currentStatus !== 'ready') {
    console.log('[whatsapp-web] getAllChats bail — client or status not ready');
    return [];
  }
  try {
    const chatsPromise = client.getChats() as Promise<any[]>;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getChats timed out after 15s')), 15_000),
    );
    const chats: any[] = await Promise.race([chatsPromise, timeout]);
    console.log('[whatsapp-web] getChats returned', chats.length, 'chats');
    return chats.slice(0, 60).map((chat: any) => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user || chat.id._serialized,
      lastMessage: chat.lastMessage?.body ?? '',
      lastMessageTime: chat.lastMessage?.timestamp
        ? (chat.lastMessage.timestamp as number) * 1000
        : 0,
      unreadCount: chat.unreadCount ?? 0,
      isGroup: !!chat.isGroup,
    }));
  } catch (e: any) {
    console.error('[whatsapp-web] getAllChats error:', e.message, e.stack);
    return [];
  }
}

export async function getChatHistory(chatId: string, limit = 50): Promise<WAMessage[]> {
  if (!client || currentStatus !== 'ready') return [];
  try {
    const chat = await client.getChatById(chatId);
    const messages: any[] = await chat.fetchMessages({ limit });
    return messages.map((msg: any) => ({
      id: msg.id._serialized,
      chatId,
      from: msg.from,
      to: msg.to,
      body: msg.body ?? '',
      timestamp: (msg.timestamp as number) * 1000,
      fromMe: !!msg.fromMe,
      type: msg.type,
    }));
  } catch {
    return [];
  }
}

export async function sendWhatsAppMessage(
  to: string,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  if (!client || currentStatus !== 'ready') {
    return { success: false, error: 'WhatsApp not connected' };
  }
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    await client.sendMessage(chatId, text);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function searchWhatsAppMessages(query: string): Promise<WAMessage[]> {
  if (!client || currentStatus !== 'ready') return [];
  try {
    const chats: any[] = await client.getChats();
    const results: WAMessage[] = [];
    const q = query.toLowerCase();
    for (const chat of chats.slice(0, 25)) {
      const messages: any[] = await chat.fetchMessages({ limit: 100 });
      for (const msg of messages) {
        if (msg.body && msg.body.toLowerCase().includes(q)) {
          results.push({
            id: msg.id._serialized,
            chatId: chat.id._serialized,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            timestamp: (msg.timestamp as number) * 1000,
            fromMe: !!msg.fromMe,
            type: msg.type,
          });
        }
      }
      if (results.length >= 100) break;
    }
    return results.slice(0, 50);
  } catch {
    return [];
  }
}

export async function disconnectWhatsApp(): Promise<void> {
  closeQRWin();
  if (client) {
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
    emitStatus('disconnected');
    // Clean locks so next startup doesn't hang
    await cleanStaleLocks();
  }
}

/**
 * Clean stale Chrome lock files that prevent Puppeteer from reusing a session.
 * These locks are left behind when the app or Chrome crashes/is force-killed.
 */
async function cleanStaleLocks(): Promise<void> {
  const sessionDir = SESSION_PATH();
  const lockFiles = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const lock of lockFiles) {
    try {
      await fsP.unlink(path.join(sessionDir, lock));
      console.log(`[whatsapp-web] removed stale lock: ${lock}`);
    } catch {
      // File doesn't exist — fine
    }
  }
}

/** Called on app launch — silently connects if a saved session exists. */
export async function autoConnectIfSession(): Promise<void> {
  console.log('[whatsapp-web] autoConnectIfSession — checking', SESSION_PATH());
  try {
    await fsP.access(SESSION_PATH());
    console.log('[whatsapp-web] session exists, cleaning locks + auto-connecting...');
    await cleanStaleLocks();
    suppressQRWindow = true;
    initClient().catch((e) => console.error('[whatsapp-web] auto-connect failed:', e));
  } catch {
    console.log('[whatsapp-web] no saved session, skipping auto-connect');
  }
}
