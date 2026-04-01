// Pure JS search over JSON metadata files — no SQLite, no native deps.
// Works in any Electron/Node version.
import { listAllConversations, ConversationMeta } from "./storage";

// Simple weighted keyword search over metadata fields.
// Returns conversations sorted by relevance score (desc).
export function searchConversations(query: string, limit = 50): ConversationMeta[] {
  const all = listAllConversations();
  if (!query.trim()) return all.slice(0, limit);

  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);

  if (terms.length === 0) return all.slice(0, limit);

  const scored = all
    .map(meta => ({ meta, score: scoreConversation(meta, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ meta }) => meta);

  return scored;
}

function scoreConversation(meta: ConversationMeta, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    // Title — highest weight
    if (meta.title.toLowerCase().includes(term)) score += 10;
    // Topics
    if (meta.topics.some(t => t.toLowerCase().includes(term))) score += 6;
    // Keywords
    if (meta.keywords.some(k => k.toLowerCase().includes(term))) score += 5;
    // People & companies
    if (meta.peopleMentioned.some(p => p.toLowerCase().includes(term))) score += 4;
    if (meta.companiesMentioned.some(c => c.toLowerCase().includes(term))) score += 4;
    // Summary
    if (meta.summary.toLowerCase().includes(term)) score += 3;
    // Speakers
    if (meta.speakers.some(s => s.toLowerCase().includes(term))) score += 3;
    // Decisions
    if (meta.decisions.some(d => d.toLowerCase().includes(term))) score += 2;
    // Meeting type / sentiment / role
    if (meta.meetingType.toLowerCase().includes(term)) score += 1;
    if (meta.sentiment.toLowerCase().includes(term)) score += 1;
  }
  return score;
}

// Upsert is a no-op — listAllConversations() reads live from disk
export function upsertConversation(_meta: ConversationMeta): void {
  // metadata is written to disk by saveConversation() in storage.ts
}

export function getAllConversationMeta(): ConversationMeta[] {
  return listAllConversations();
}

export function getConversationById(id: string): ConversationMeta | null {
  return listAllConversations().find(c => c.id === id) ?? null;
}
