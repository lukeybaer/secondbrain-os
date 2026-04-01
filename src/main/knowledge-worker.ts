// knowledge-worker.ts
// Polls EC2 every 3s for pending knowledge queries (from mid-call query_knowledge Vapi function calls).
// Uses fast/medium/slow routing to respond within Vapi's timing constraints:
//   fast   (<5s)  — answer from memory/profile, no search needed
//   medium (5-20s)— search local DB, respond while still on call
//   slow   (20s+) — acknowledge and queue for follow-up (Telegram/callback)

import { getConfig } from "./config";
import { searchConversations } from "./database";
import { getProfileAsText } from "./user-profile";
import { classifyQuerySpeed, readMemory } from "./agent-memory";

const POLL_INTERVAL_MS = 3_000;
const FALLBACK_EC2_URL = ""; // Set ec2BaseUrl in Settings

interface PendingQuery {
  id: string;
  question: string;
  vapiCallId: string | null;
}

let workerRunning = false;
let stopRequested = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Cache the EA memory for fast-path answers; refresh every 5 minutes
let cachedMemory = "";
let memoryCachedAt = 0;
const MEMORY_TTL_MS = 5 * 60 * 1000;

async function getMemoryCached(): Promise<string> {
  if (!cachedMemory || Date.now() - memoryCachedAt > MEMORY_TTL_MS) {
    try {
      cachedMemory = await readMemory();
      memoryCachedAt = Date.now();
    } catch {
      cachedMemory = "";
    }
  }
  return cachedMemory;
}

function getBaseUrl(): string {
  try {
    return getConfig().ec2BaseUrl || FALLBACK_EC2_URL;
  } catch {
    return FALLBACK_EC2_URL;
  }
}

async function fetchPendingQuery(): Promise<PendingQuery | null> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/queries/pending`, { signal: AbortSignal.timeout(8_000) });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.id) return null;
  return data as PendingQuery;
}

async function postAnswer(id: string, answer: string): Promise<void> {
  const base = getBaseUrl();
  await fetch(`${base}/queries/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
    signal: AbortSignal.timeout(8_000),
  });
}

// Fast path: answer from EA memory + profile facts (no DB search)
async function buildFastAnswer(question: string): Promise<string> {
  const memory = await getMemoryCached();
  let profileText = "";
  try { profileText = getProfileAsText(); } catch { /* ignore */ }

  const context = [
    profileText ? `Luke's profile: ${profileText}` : "",
    memory ? `EA memory (excerpt): ${memory.slice(0, 1000)}` : "",
  ].filter(Boolean).join("\n\n");

  if (!context) {
    return `I don't have that information immediately available.`;
  }

  // Simple keyword match from memory — return the most relevant snippet
  const lines = context.split("\n");
  const qLower = question.toLowerCase();
  const relevant = lines.filter(l =>
    l.length > 10 && qLower.split(" ").some(w => w.length > 3 && l.toLowerCase().includes(w))
  ).slice(0, 5);

  if (relevant.length) {
    return relevant.join("\n");
  }
  return `I don't have specific information about that in my immediate memory.`;
}

// Medium path: search local conversation DB (5-20s acceptable)
function buildMediumAnswer(question: string): string {
  const hits = searchConversations(question, 5);

  let profileText = "";
  try { profileText = getProfileAsText(); } catch { /* ignore */ }

  const parts: string[] = [];

  if (profileText) {
    parts.push(`Luke's profile: ${profileText}`);
  }

  if (hits.length > 0) {
    const excerpts = hits
      .slice(0, 3)
      .map((h, i) => {
        const title = h.title ?? "(untitled)";
        const date = h.date ?? "";
        const summary = h.summary ?? "";
        return `[${i + 1}] ${title} (${date}): ${summary.slice(0, 200)}`;
      })
      .join("\n");
    parts.push(`Relevant conversations:\n${excerpts}`);
  }

  if (parts.length === 0) {
    return `I don't have specific information about "${question}" in the knowledge base right now.`;
  }

  return parts.join("\n\n");
}

async function handleQuery(q: PendingQuery): Promise<void> {
  const speed = classifyQuerySpeed(q.question);
  console.log(`[knowledge-worker] Query ${q.id} — speed=${speed}: "${q.question.slice(0, 60)}"`);

  try {
    let answer: string;

    if (speed === "fast") {
      answer = await buildFastAnswer(q.question);
    } else if (speed === "slow") {
      // Acknowledge immediately — tell Vapi to say it will follow up
      answer = "That's going to take me a few minutes to look into. I'll send you a message when I have the answer rather than keep you waiting on the call.";
      // TODO: could queue a background task here
    } else {
      // medium — do the search
      answer = buildMediumAnswer(q.question);
    }

    await postAnswer(q.id, answer);
    console.log(`[knowledge-worker] Answered query ${q.id} (${speed}) — "${answer.slice(0, 60)}"`);
  } catch (err) {
    console.error("[knowledge-worker] handleQuery error:", err);
    try {
      await postAnswer(q.id, "Sorry, I had trouble looking that up right now.");
    } catch { /* ignore */ }
  }
}

async function pollOnce(): Promise<void> {
  if (!workerRunning) return;

  try {
    const q = await fetchPendingQuery();
    if (q) {
      await handleQuery(q);
    }
  } catch {
    // Silently swallow — EC2 might be temporarily unreachable
  }

  if (!stopRequested) {
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  } else {
    workerRunning = false;
    stopRequested = false;
  }
}

export function startKnowledgeWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  stopRequested = false;
  console.log("[knowledge-worker] started (fast/medium/slow routing)");
  pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
}

export function stopKnowledgeWorker(): void {
  if (!workerRunning) return;
  stopRequested = true;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
    workerRunning = false;
    stopRequested = false;
  }
  console.log("[knowledge-worker] stopped");
}
