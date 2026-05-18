import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

export interface ConversationMeta {
  id: string;
  otterId: string;
  title: string;
  date: string;
  durationMinutes: number;
  speakers: string[];
  myRole: string;
  meetingType: string;
  summary: string;
  topics: string[];
  keywords: string[];
  peopleMentioned: string[];
  companiesMentioned: string[];
  decisions: string[];
  sentiment: string;
  transcriptFile: string;
  taggedAt: string;
}

function getConvsDir(): string {
  return path.join(getConfig().dataDir, 'conversations');
}

function getSermonsDir(): string {
  return path.join(getConfig().dataDir, 'sermons');
}

export function ensureDataDirs(): void {
  const dirs = [getConfig().dataDir, getConvsDir(), getWhatsAppDir(), getSmsDir(), getSermonsDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function saveConversation(meta: ConversationMeta, transcript: string): void {
  ensureDataDirs();
  const convDir = path.join(getConvsDir(), meta.id);
  if (!fs.existsSync(convDir)) {
    fs.mkdirSync(convDir, { recursive: true });
  }
  fs.writeFileSync(path.join(convDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(path.join(convDir, 'transcript.txt'), transcript, 'utf-8');
}

export function loadConversation(
  id: string,
): { meta: ConversationMeta; transcript: string } | null {
  const convDir = path.join(getConvsDir(), id);
  const metaFile = path.join(convDir, 'meta.json');
  const transcriptFile = path.join(convDir, 'transcript.txt');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as ConversationMeta;
    const transcript = fs.existsSync(transcriptFile)
      ? fs.readFileSync(transcriptFile, 'utf-8')
      : '';
    return { meta, transcript };
  } catch {
    return null;
  }
}

export function listAllConversations(): ConversationMeta[] {
  ensureDataDirs();
  const convsDir = getConvsDir();
  const results: ConversationMeta[] = [];
  try {
    const dirs = fs.readdirSync(convsDir);
    for (const dir of dirs) {
      const metaFile = path.join(convsDir, dir, 'meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as ConversationMeta;
          results.push(meta);
        } catch {
          // skip malformed
        }
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export function conversationExists(otterId: string): boolean {
  const all = listAllConversations();
  return all.some((c) => c.otterId === otterId);
}

// ── Otter list cache ──────────────────────────────────────────────────────────

export interface OtterListItem {
  otterId: string;
  title: string;
  date: string;
  durationMinutes: number;
  status: string;
}

function getOtterCacheFile(): string {
  return path.join(getConfig().dataDir, 'otter-list-cache.json');
}

export function saveOtterListCache(items: OtterListItem[]): void {
  ensureDataDirs();
  fs.writeFileSync(getOtterCacheFile(), JSON.stringify(items, null, 2), 'utf-8');
}

export function loadOtterListCache(): OtterListItem[] {
  try {
    const file = getOtterCacheFile();
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function updateOtterListCacheStatus(otterId: string, status: string): void {
  const items = loadOtterListCache();
  const idx = items.findIndex((i) => i.otterId === otterId);
  if (idx >= 0) {
    items[idx].status = status;
    saveOtterListCache(items);
  }
}

// ── WhatsApp messages (Cloud API webhook / send) ─────────────────────────────

export interface WhatsAppMessage {
  id: string;
  messageId: string;
  source: 'inbound' | 'outbound';
  from: string;
  to: string;
  body: string;
  timestamp: string;
  contactName?: string;
  phoneNumberId?: string;
  createdAt: string;
}

function getWhatsAppDir(): string {
  return path.join(getConfig().dataDir, 'whatsapp');
}

function sanitizeMessageId(messageId: string): string {
  return messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export function saveWhatsAppMessage(msg: WhatsAppMessage): void {
  ensureDataDirs();
  const dir = getWhatsAppDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeMessageId(msg.messageId)}.json`);
  fs.writeFileSync(file, JSON.stringify(msg, null, 2), 'utf-8');
}

export function listWhatsAppMessages(limit = 500): WhatsAppMessage[] {
  ensureDataDirs();
  const dir = getWhatsAppDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const messages: WhatsAppMessage[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      messages.push(JSON.parse(raw) as WhatsAppMessage);
    } catch {
      // skip malformed
    }
  }
  return messages
    .sort((a, b) => (b.createdAt || b.timestamp).localeCompare(a.createdAt || a.timestamp))
    .slice(0, limit);
}

// ── SMS messages (Twilio) ───────────────────────────────────────────────────

export interface SmsMessage {
  id: string;
  messageId: string;
  source: 'inbound' | 'outbound';
  from: string;
  to: string;
  body: string;
  timestamp: string;
  contactName?: string;
  mediaUrls?: string[]; // local file paths for downloaded MMS attachments
  mediaTypes?: string[]; // MIME types per attachment
  createdAt: string;
}

function getSmsDir(): string {
  return path.join(getConfig().dataDir, 'sms');
}

export function saveSmsMessage(msg: SmsMessage): void {
  ensureDataDirs();
  const dir = getSmsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeMessageId(msg.messageId)}.json`);
  fs.writeFileSync(file, JSON.stringify(msg, null, 2), 'utf-8');
}

export function listSmsMessages(limit = 500): SmsMessage[] {
  ensureDataDirs();
  const dir = getSmsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const messages: SmsMessage[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      messages.push(JSON.parse(raw) as SmsMessage);
    } catch {
      // skip malformed
    }
  }
  return messages
    .sort((a, b) => (b.createdAt || b.timestamp).localeCompare(a.createdAt || a.timestamp))
    .slice(0, limit);
}

export function searchSmsMessages(query: string, limit = 100): SmsMessage[] {
  const all = listSmsMessages(9999);
  const q = query.toLowerCase();
  return all
    .filter(
      (m) =>
        m.body.toLowerCase().includes(q) ||
        m.from.includes(q) ||
        m.to.includes(q) ||
        (m.contactName && m.contactName.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}
