// graphiti-client.ts
// TypeScript client for the Graphiti MCP temporal knowledge graph server.
// Source: getzep/graphiti (24k stars) — self-hosted via Docker on EC2.
//
// Graphiti provides:
//   - Temporal knowledge graph (every fact has timestamp + validity window)
//   - Entity deduplication and contradiction resolution
//   - Semantic + temporal search
//
// Server runs at EC2 port 3003 (see docker-compose.graphiti.yml).
// Falls back gracefully to the three-tier memory system if unavailable.

import { getConfig } from "./config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphitiEpisode {
  name: string;                 // human-readable label
  episode_body: string;         // the fact or event content
  source_description: string;   // where this came from (e.g. "call-transcript")
  reference_time?: string;      // ISO 8601 when this happened (defaults to now)
  group_id?: string;            // namespace for isolation (e.g. "luke-ea")
}

export interface GraphitiSearchResult {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string;
  invalid_at?: string;
  score: number;
}

export interface GraphitiNode {
  uuid: string;
  name: string;
  summary?: string;
  labels: string[];
  created_at: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

function graphitiUrl(): string {
  const config = getConfig();
  const base = config.ec2BaseUrl?.replace(/:3001$/, "") ?? "";
  return `${base}:3003`;
}

async function graphitiRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<T | null> {
  const url = `${graphitiUrl()}${endpoint}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!res.ok) {
      console.warn(`[graphiti] ${method} ${endpoint} → ${res.status}`);
      return null;
    }

    return await res.json() as T;
  } catch (err: any) {
    // Network error or timeout — Graphiti is unavailable, fall back silently
    if (err.name !== "AbortError") {
      console.warn(`[graphiti] Unavailable (${err.message}) — using local memory fallback`);
    }
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a new episode (fact or event) to the knowledge graph.
 * This is the primary ingestion method — every call transcript, decision,
 * contact interaction, and learned fact goes through here.
 *
 * Maps to Graphiti MCP tool: `mcp__graphiti__add_episode`
 */
export async function addEpisode(episode: GraphitiEpisode): Promise<boolean> {
  const payload = {
    name: episode.name,
    episode_body: episode.episode_body,
    source_description: episode.source_description,
    reference_time: episode.reference_time ?? new Date().toISOString(),
    group_id: episode.group_id ?? "luke-ea",
  };

  const result = await graphitiRequest<{ uuid: string }>("/add_episode", "POST", payload);
  if (result) {
    console.log(`[graphiti] Added episode: ${episode.name} (${result.uuid})`);
    return true;
  }
  return false;
}

/**
 * Search the knowledge graph by semantic query.
 * Returns temporally-weighted results (recent facts score higher).
 *
 * Maps to Graphiti MCP tool: `mcp__graphiti__search`
 */
export async function searchKnowledge(
  query: string,
  opts?: { groupId?: string; maxResults?: number; centerNodeUuid?: string },
): Promise<GraphitiSearchResult[]> {
  const payload = {
    query,
    group_ids: [opts?.groupId ?? "luke-ea"],
    max_facts: opts?.maxResults ?? 10,
    center_node_uuid: opts?.centerNodeUuid,
  };

  const result = await graphitiRequest<{ facts: GraphitiSearchResult[] }>("/search", "POST", payload);
  return result?.facts ?? [];
}

/**
 * Get recent episodes from the graph (for context building).
 */
export async function getRecentEpisodes(
  groupId = "luke-ea",
  limit = 20,
): Promise<Array<{ uuid: string; name: string; episode_body: string; created_at: string }>> {
  const result = await graphitiRequest<{ episodes: any[] }>(
    `/episodes?group_id=${encodeURIComponent(groupId)}&last_n=${limit}`,
  );
  return result?.episodes ?? [];
}

/**
 * Get all episodes related to a specific entity (e.g. a contact by name).
 */
export async function getEntityEpisodes(
  entityName: string,
  groupId = "luke-ea",
): Promise<GraphitiSearchResult[]> {
  return searchKnowledge(entityName, { groupId, maxResults: 20 });
}

/**
 * Ingest a call transcript as a Graphiti episode.
 * Automatically extracts named entities and links facts temporally.
 */
export async function ingestCallTranscript(opts: {
  callId: string;
  callerPhone: string;
  callerName?: string;
  transcript: string;
  outcome: string;
  calledAt: string;
}): Promise<boolean> {
  const name = opts.callerName
    ? `Call with ${opts.callerName} (${opts.callerPhone})`
    : `Call with ${opts.callerPhone}`;

  const body =
    `Outcome: ${opts.outcome}\n\n` +
    `Transcript:\n${opts.transcript.slice(0, 2000)}`;

  return addEpisode({
    name,
    episode_body: body,
    source_description: `call-transcript:${opts.callId}`,
    reference_time: opts.calledAt,
  });
}

/**
 * Health check — returns true if Graphiti is reachable.
 */
export async function isGraphitiAvailable(): Promise<boolean> {
  const result = await graphitiRequest<{ status: string }>("/health");
  return result?.status === "ok";
}

/**
 * Build a knowledge context string from Graphiti search results.
 * Used to enrich system prompts with relevant temporal facts.
 */
export async function buildKnowledgeContext(
  query: string,
  maxChars = 1500,
): Promise<string> {
  const results = await searchKnowledge(query, { maxResults: 8 });
  if (results.length === 0) return "";

  const lines = results
    .filter((r) => !r.invalid_at)
    .map((r) => `- [${r.valid_at.slice(0, 10)}] ${r.fact}`)
    .join("\n");

  const context = `### Knowledge Graph (Graphiti)\n${lines}`;
  return context.length > maxChars ? context.slice(0, maxChars) + "\n*(truncated)*" : context;
}
