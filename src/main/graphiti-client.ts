// graphiti-client.ts
// TypeScript client for the Graphiti MCP temporal knowledge graph server.
// Source: getzep/graphiti (24k stars) — self-hosted via Docker on EC2.
//
// Graphiti provides:
//   - Temporal knowledge graph (every fact has timestamp + validity window)
//   - Entity deduplication and contradiction resolution
//   - Semantic + temporal search
//
// Server runs at EC2 port 8000 (see docker-compose.graphiti.yml).
// Uses MCP JSON-RPC protocol over HTTP (streamable transport).
// Falls back gracefully to the three-tier memory system if unavailable.

import { getConfig } from './config';

// ��─ Types ──────────��───────────────────────���──────────────────────────────────

export interface GraphitiEpisode {
  name: string; // human-readable label
  episode_body: string; // the fact or event content
  source_description: string; // where this came from (e.g. "call-transcript")
  reference_time?: string; // ISO 8601 when this happened (defaults to now)
  group_id?: string; // namespace for isolation (e.g. "luke-ea")
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

// ── MCP Transport ─────���──────────────────────────────────────────────────────

function graphitiUrl(): string {
  // Graphiti MCP server only accepts localhost connections (Host header validation).
  // Access from Electron requires an SSH tunnel: ssh -fNL 8000:localhost:8000 ec2-user@98.80.164.16
  // The tunnel maps local port 8000 → EC2 localhost:8000 (Graphiti Docker).
  return 'http://127.0.0.1:8000';
}

let _sessionId: string | null = null;
let _requestId = 0;

/** Initialize an MCP session (required before any tool calls). */
async function ensureSession(): Promise<string | null> {
  if (_sessionId) return _sessionId;

  try {
    const res = await fetch(`${graphitiUrl()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'secondbrain', version: '1.0' },
        },
        id: ++_requestId,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const sessionId = res.headers.get('mcp-session-id');
    if (!sessionId) {
      // Try to extract from SSE response body (some servers return inline)
      const text = await res.text();
      const dataMatch = text.match(/data:\s*(\{.*\})/);
      if (dataMatch) {
        _sessionId = 'no-header-session';
        return _sessionId;
      }
      console.warn('[graphiti] Failed to get session ID');
      return null;
    }

    _sessionId = sessionId;

    // MCP protocol requires a notifications/initialized after the handshake
    // before the server will accept tools/call requests. Without this, every
    // subsequent call returns an error. Discovered 2026-04-10 during seeding.
    // Read the body of the initialize response first (may be SSE or JSON,
    // doesn't matter for functionality).
    try {
      await res.text();
    } catch {
      /* already consumed is fine */
    }

    try {
      await fetch(`${graphitiUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': _sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (notifyErr: any) {
      console.warn(`[graphiti] initialized notification failed: ${notifyErr.message}`);
      /* continue — some servers still work without the notification */
    }

    console.log(`[graphiti] MCP session initialized: ${sessionId.slice(0, 8)}...`);
    return _sessionId;
  } catch (err: any) {
    console.warn(`[graphiti] Session init failed: ${err.message}`);
    return null;
  }
}

/** Call an MCP tool via JSON-RPC. */
async function mcpToolCall<T>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
  const sessionId = await ensureSession();
  if (!sessionId) return null;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (_sessionId && _sessionId !== 'no-header-session') {
      headers['Mcp-Session-Id'] = _sessionId;
    }

    const res = await fetch(`${graphitiUrl()}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: ++_requestId,
      }),
      signal: AbortSignal.timeout(30_000), // tool calls can take longer
    });

    const text = await res.text();

    // Parse SSE or direct JSON response
    const dataMatch = text.match(/data:\s*(\{.*\})/);
    const json = dataMatch ? JSON.parse(dataMatch[1]) : JSON.parse(text);

    if (json.error) {
      console.warn(`[graphiti] ${toolName} error: ${json.error.message}`);
      return null;
    }

    // MCP tool results come in result.content[0].text (JSON string)
    const content = json.result?.content;
    if (content?.[0]?.text) {
      return JSON.parse(content[0].text) as T;
    }

    // Direct result format
    if (json.result) {
      return json.result as T;
    }

    return null;
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.warn(`[graphiti] ${toolName} failed: ${err.message}`);
    }
    return null;
  }
}

/** Simple REST request (for /health which is plain HTTP, not MCP). */
async function restRequest<T>(endpoint: string): Promise<T | null> {
  try {
    const res = await fetch(`${graphitiUrl()}${endpoint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─�� Public API ──────���────────────────────────────────���────────────────────────

/**
 * Add a new episode (fact or event) to the knowledge graph.
 * Uses MCP tool: add_memory
 */
export async function addEpisode(episode: GraphitiEpisode): Promise<boolean> {
  const result = await mcpToolCall<{ message: string }>('add_memory', {
    name: episode.name,
    episode_body: episode.episode_body,
    source_description: episode.source_description ?? '',
    source: 'text',
    group_id: episode.group_id ?? 'luke-ea',
  });

  if (result?.message) {
    console.log(`[graphiti] Added: ${episode.name}`);
    return true;
  }
  return false;
}

/**
 * Search the knowledge graph by semantic query.
 * Uses MCP tool: search_memory_facts
 */
export async function searchKnowledge(
  query: string,
  opts?: { groupId?: string; maxResults?: number; centerNodeUuid?: string },
): Promise<GraphitiSearchResult[]> {
  const args: Record<string, unknown> = {
    query,
    group_ids: [opts?.groupId ?? 'luke-ea'],
    max_facts: opts?.maxResults ?? 10,
  };
  if (opts?.centerNodeUuid) {
    args.center_node_uuid = opts.centerNodeUuid;
  }

  const result = await mcpToolCall<{ facts: GraphitiSearchResult[] }>('search_memory_facts', args);
  return result?.facts ?? [];
}

/**
 * Search for nodes (entities) in the graph.
 * Uses MCP tool: search_nodes
 */
export async function searchNodes(
  query: string,
  opts?: { groupId?: string; maxNodes?: number },
): Promise<GraphitiNode[]> {
  const result = await mcpToolCall<{ nodes: GraphitiNode[] }>('search_nodes', {
    query,
    group_ids: [opts?.groupId ?? 'luke-ea'],
    max_nodes: opts?.maxNodes ?? 10,
  });
  return result?.nodes ?? [];
}

/**
 * Get recent episodes from the graph.
 * Uses MCP tool: get_episodes
 */
export async function getRecentEpisodes(
  groupId = 'luke-ea',
  limit = 20,
): Promise<Array<{ uuid: string; name: string; episode_body: string; created_at: string }>> {
  const result = await mcpToolCall<{ episodes: any[] }>('get_episodes', {
    group_ids: [groupId],
    max_episodes: limit,
  });
  return result?.episodes ?? [];
}

/**
 * Get all episodes related to a specific entity (e.g. a contact by name).
 */
export async function getEntityEpisodes(
  entityName: string,
  groupId = 'luke-ea',
): Promise<GraphitiSearchResult[]> {
  return searchKnowledge(entityName, { groupId, maxResults: 20 });
}

/**
 * Ingest a call transcript as a Graphiti episode.
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

  const body = `Outcome: ${opts.outcome}\n\nTranscript:\n${opts.transcript.slice(0, 2000)}`;

  return addEpisode({
    name,
    episode_body: body,
    source_description: `call-transcript:${opts.callId}`,
    reference_time: opts.calledAt,
  });
}

/**
 * Health check — returns true if Graphiti is reachable.
 * Uses the plain /health endpoint (not MCP).
 */
export async function isGraphitiAvailable(): Promise<boolean> {
  const result = await restRequest<{ status: string }>('/health');
  return result?.status === 'healthy' || result?.status === 'ok';
}

/**
 * Build a knowledge context string from Graphiti search results.
 */
export async function buildKnowledgeContext(query: string, maxChars = 1500): Promise<string> {
  const results = await searchKnowledge(query, { maxResults: 8 });
  if (results.length === 0) return '';

  const lines = results
    .filter((r) => !r.invalid_at)
    .map((r) => `- [${r.valid_at?.slice(0, 10) ?? 'unknown'}] ${r.fact}`)
    .join('\n');

  const context = `### Knowledge Graph (Graphiti)\n${lines}`;
  return context.length > maxChars ? context.slice(0, maxChars) + '\n*(truncated)*' : context;
}

/** Reset the MCP session (e.g., after reconnect). */
export function resetGraphitiSession(): void {
  _sessionId = null;
  _requestId = 0;
}
