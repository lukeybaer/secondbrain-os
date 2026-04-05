import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  id: string;
  startedAt: string;
  messages: ChatMessage[];
  contextSummary?: string;
}

function getChatsDir(): string {
  return path.join(getConfig().dataDir, 'chats');
}

function ensureChatsDir(): void {
  const dir = getChatsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function saveSession(session: ChatSession): void {
  ensureChatsDir();
  fs.writeFileSync(
    path.join(getChatsDir(), `${session.id}.json`),
    JSON.stringify(session, null, 2),
    'utf-8',
  );
}

export function loadSession(id: string): ChatSession | null {
  const file = path.join(getChatsDir(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadLatestSession(): ChatSession | null {
  ensureChatsDir();
  try {
    const dir = getChatsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({
        id: f.replace('.json', ''),
        mtime: fs.statSync(path.join(dir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? loadSession(files[0].id) : null;
  } catch {
    return null;
  }
}

export function createSession(contextSummary?: string): ChatSession {
  const session: ChatSession = {
    id: `chat_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    startedAt: new Date().toISOString(),
    messages: [],
    contextSummary,
  };
  saveSession(session);
  return session;
}

export async function summarizeSession(session: ChatSession): Promise<string> {
  if (session.messages.length < 2) return '';
  const openai = new OpenAI({ apiKey: getConfig().openaiApiKey });
  const transcript = session.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'SecondBrain'}: ${m.content}`)
    .join('\n\n');

  const res = await openai.chat.completions.create({
    model: getConfig().openaiModel,
    messages: [
      {
        role: 'user',
        content: `Summarize this conversation in 3-5 sentences. Capture what was asked, key insights found, and any conclusions:\n\n${transcript.slice(0, 8000)}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 400,
  });
  return res.choices[0].message.content?.trim() || '';
}

// Save chat session as a tagged conversation on disk (best-effort, no throw).
// First call does full AI tagging. Subsequent calls just refresh the transcript.
export async function saveSessionAsConversation(session: ChatSession): Promise<void> {
  if (session.messages.length < 2) return;

  try {
    const { saveConversation, conversationExists, listAllConversations } =
      await import('./storage');
    const { upsertConversation } = await import('./database');
    const { tagConversation } = await import('./tagger');

    const transcript = session.messages
      .map((m) => `${m.role === 'user' ? 'You' : 'SecondBrain'}: ${m.content}`)
      .join('\n\n');

    // If already tagged, just refresh the transcript — no new OpenAI call
    if (conversationExists(session.id)) {
      const all = listAllConversations();
      const existing = all.find((c) => c.otterId === session.id);
      if (existing) {
        saveConversation(existing, transcript);
      }
      return;
    }

    // First time: full AI tagging
    const date = new Date(session.startedAt).toISOString().split('T')[0];
    const durationMinutes = Math.max(
      1,
      Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000),
    );
    const firstQuestion =
      session.messages.find((m) => m.role === 'user')?.content || 'Chat Session';
    const title = firstQuestion.slice(0, 80) + (firstQuestion.length > 80 ? '…' : '');

    const meta = await tagConversation(session.id, title, date, durationMinutes, transcript);
    meta.meetingType = 'OpenBrainChat';
    meta.speakers = ['You', 'SecondBrain'];

    saveConversation(meta, transcript);
    upsertConversation(meta);

    // Post-save: feed Graphiti + working memory
    try {
      const { onDataIngested, chatSessionEvent } = await import('./ingest-hooks');
      onDataIngested(
        chatSessionEvent({
          sessionId: session.id,
          summary: meta.summary || meta.title || 'chat session',
          transcript,
        }),
      );
    } catch {
      /* non-critical */
    }
  } catch {
    // best-effort
  }
}
