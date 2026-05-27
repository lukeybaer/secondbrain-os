// tool-router.ts
//
// Semantic tool router for Amy. Given an intent string and a registry of
// available tools (each with a name and a knowledge-shaped description),
// returns a ranked list of candidate tools with scores and rationale.
//
// Inspired by:
//   - agno-agi/agno (formerly Phidata) Toolkit auto-selection: agents are
//     handed a registry and pick at call time by description match. Phidata
//     docs (2026-04) describe this as "describe the data the tool exposes,
//     not the command to run it" which mirrors Luke's locked rule
//     feedback_knowledge_not_rules_for_amy.md.
//   - letta-ai/letta-code: a memory-first agent that scores tools against a
//     query before invocation. Letta uses an embedding model; we use a
//     deterministic TF-IDF style score so the nightly run does not need a
//     network call and tests do not depend on a paid embedding API.
//   - LangGraph "Send" pattern: branching to the highest-scoring node by a
//     pluggable scorer keeps the routing layer simple and swappable.
//
// Why SecondBrain needs this:
//   - Vapi has a small list of tools (otter-query, transcript-fastpath,
//     read_otter_transcripts, etc.) and the Amy assistant routes to one of
//     them by static system-prompt directives. The locked 2026-05-05 standard
//     (probe-amy-foundation.js) confirmed knowledge-shaped descriptions; the
//     piece still missing is the routing layer that PICKS one based on the
//     caller intent.
//   - The briefing pipeline composes many helper scripts and currently hard-
//     codes which one fires for each section. New helper scripts cannot be
//     auto-discovered.
//   - When Amy gains a new skill from scheduled-tasks/, it should be routable
//     by intent without touching every callsite.
//
// Pure scoring, no LLM, no electron, no network. Writer injection mirrors
// tool-trace.ts and tool-cost-ledger.ts so the router can be observed by the
// same telemetry surface that records every tool call.

import * as fs from 'fs';
import * as path from 'path';

// Types

// Side-effect classification (Composio pattern). 'read' tools never mutate
// external state and are always safe to retry; 'write' tools mutate (send,
// post, create, dial, schedule, file write) and need the caller to think
// about idempotency before retrying; 'destructive' tools cannot be undone
// (delete, hard-revoke, permanent message) and require explicit approval.
export type SideEffectClass = 'read' | 'write' | 'destructive';

// Approval requirement. Tier-1 surface for the declarative-approval-inbox
// backlog item (see feature-backlog id declarative-approval-inbox). 'none'
// runs without gating; 'review' queues into the approval inbox for Luke's
// sign-off; 'block' refuses unless the caller passes an explicit override.
export type ApprovalGate = 'none' | 'review' | 'block';

// Capability metadata layered on top of the routing core. All fields are
// optional so the existing registry compiles unchanged; entries that opt
// in get richer discovery / filtering behavior.
//
// Pattern sources:
//   - Composio toolregistry (composiohq/composio docs 2026-04): per-tool
//     capability metadata + versioning + per-user permissions so an agent
//     can introspect what it can do at runtime.
//   - Letta tool registry: tools are first-class records, not strings, so
//     callers can ask "give me tools that satisfy criterion X".
//   - LangGraph capability-aware routing: a tool whose declared side_effect
//     is destructive never gets selected by a low-confidence route without
//     approval flow.
export interface ToolDescriptor {
  // canonical tool name as it appears in the trace ledger
  name: string;
  // knowledge-shaped description: what data this tool exposes, not how to
  // invoke it (Luke rule: feedback_knowledge_not_rules_for_amy.md).
  description: string;
  // optional list of tags / aliases to boost recall on synonymous queries
  tags?: ReadonlyArray<string>;
  // surfaces where this tool is callable: 'vapi' | 'briefing' | 'cli' | etc.
  // Used to filter the registry by caller context.
  surfaces?: ReadonlyArray<string>;
  // optional weight boost (0..1) for tools the operator wants prioritized.
  // Defaults to 0 (no boost). Use sparingly; over-boosting defeats routing.
  bias?: number;

  // ── Capability metadata (added 2026-05-16, run 64) ─────────────────────
  // SemVer-style version for the descriptor's contract. Bump on input or
  // output shape changes. Used by registryStats() to flag stale callers.
  version?: string;
  // True when the tool is kept in the registry for historical routing but
  // should not be selected for new traffic. Discovery filters skip these
  // unless `include_deprecated: true` is passed.
  deprecated?: boolean;
  // Replacement tool name when deprecated. Discovery returns this so the
  // caller can swap automatically.
  replaced_by?: string;
  // Side-effect class. Defaults to 'read' when omitted. Discovery uses
  // this for the safety filter ("give me read-only tools for an unverified
  // inbound caller").
  side_effects?: SideEffectClass;
  // True when calling the tool with identical arguments yields identical
  // results without external state change. Defaults to true for 'read',
  // false otherwise. The retry layer keys off this when deciding whether
  // to replay a failed call.
  idempotent?: boolean;
  // Approval gating for write/destructive tools. Defaults to 'none' for
  // 'read', 'review' for 'write', 'block' for 'destructive' so new tools
  // get a safe default without per-entry boilerplate.
  approval?: ApprovalGate;
  // Names of the input keys this tool consumes. Discovery filter
  // `requires_input(['phone_number'])` returns tools that accept a phone
  // number. Not a full JSON schema; enough metadata for runtime triage.
  input_keys?: ReadonlyArray<string>;
  // High-level shape of the output: 'text' | 'list' | 'json' | 'binary'.
  // Surfaces use this to decide rendering ("can I show this in a card?").
  output_shape?: 'text' | 'list' | 'json' | 'binary';
  // Rough cost class for budget-aware routing: 'free' (local), 'cheap'
  // (cached API), 'paid' (LLM call, web search, voice minute). Defaults
  // to 'free' when omitted.
  cost_class?: 'free' | 'cheap' | 'paid';
  // Memory file or doc anchor that locks this tool's behavior. Used by
  // the briefing's "tools with no provenance" health probe.
  source_doc?: string;
}

// Defaults applied to an entry that omits the capability fields. Centralized
// so registry consumers can derive a fully-populated view without each
// callsite repeating the fallback logic.
export function withCapabilityDefaults(t: ToolDescriptor): Required<Pick<
  ToolDescriptor,
  'side_effects' | 'idempotent' | 'approval' | 'cost_class' | 'deprecated'
>> & ToolDescriptor {
  const side: SideEffectClass = t.side_effects ?? 'read';
  const idempotent = t.idempotent ?? (side === 'read');
  const approval: ApprovalGate =
    t.approval ?? (side === 'destructive' ? 'block' : side === 'write' ? 'review' : 'none');
  const cost_class = t.cost_class ?? 'free';
  const deprecated = t.deprecated ?? false;
  return { ...t, side_effects: side, idempotent, approval, cost_class, deprecated };
}

export interface RouteCandidate {
  tool: ToolDescriptor;
  score: number;          // 0..1+ (raw tf-idf-style score, can exceed 1 with bias)
  matched_terms: string[]; // terms that contributed to the score
}

export interface RouteResult {
  query: string;
  surface?: string;
  candidates: RouteCandidate[]; // ranked best-first
  // top-1 if its score exceeds `confidence_threshold` (default 0.15);
  // null when no tool clears the threshold (caller should fall back to
  // explicit selection rather than gambling).
  selected: RouteCandidate | null;
  confidence_threshold: number;
  // Count of deprecated tools that matched the surface filter but were
  // dropped from scoring because `include_deprecated` was false. Lets the
  // briefing flag "Amy still has N retired tools shadowing live routing".
  excluded_deprecated: number;
}

// Tokenization

const STOPWORDS: ReadonlySet<string> = new Set([
  'a','an','the','of','to','in','for','on','at','by','with','and','or','is',
  'are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','can','may','might','it','its','this','that',
  'these','those','i','you','he','she','we','they','me','him','her','us','them',
  'what','when','where','who','why','how','please','need','want','find','show',
  'tell','give','about','from','into','out','up','down','as','if','then','than',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

// Routing

export interface RouteOpts {
  // Caller surface; when set, only tools whose surfaces include this value
  // are considered.
  surface?: string;
  // Confidence below this returns selected=null. Default 0.15.
  confidence_threshold?: number;
  // Maximum candidates to return. Default 5.
  top_k?: number;
  // When false (default), tools flagged `deprecated` are excluded from
  // scoring entirely so new traffic never routes to a retired tool. Set
  // true only to audit historical routing or inspect a tool slated for
  // removal. Mirrors the `discover()` filter in tool-router-registry.ts so
  // the core route() path and the discovery path agree on deprecation.
  include_deprecated?: boolean;
}

interface ToolIndex {
  tool: ToolDescriptor;
  terms: Map<string, number>;  // term -> count in this tool's description+tags
  total_terms: number;
}

function indexTool(tool: ToolDescriptor): ToolIndex {
  const tokens = tokenize(tool.description);
  for (const tag of tool.tags ?? []) tokens.push(...tokenize(tag));
  const terms = new Map<string, number>();
  for (const tok of tokens) terms.set(tok, (terms.get(tok) ?? 0) + 1);
  return { tool, terms, total_terms: tokens.length };
}

function buildDocumentFrequency(indices: ReadonlyArray<ToolIndex>): Map<string, number> {
  const df = new Map<string, number>();
  for (const idx of indices) {
    for (const term of idx.terms.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

// Score one tool against a query using a small TF-IDF variant:
//   score = sum_t (tf_norm(t, tool) * idf(t)) for t in query_terms
// Plus optional bias added at the end. Deterministic, fast, no embeddings.
function scoreTool(
  queryTerms: string[],
  idx: ToolIndex,
  documentFrequency: Map<string, number>,
  totalDocs: number,
): { score: number; matched: string[] } {
  if (idx.total_terms === 0) return { score: 0, matched: [] };
  let score = 0;
  const matched: string[] = [];
  for (const t of queryTerms) {
    const tf = idx.terms.get(t);
    if (!tf) continue;
    const df = documentFrequency.get(t) ?? 1;
    // smoothed idf so a term in EVERY tool still contributes a tiny bit
    const idf = Math.log(1 + totalDocs / df);
    const tfNorm = tf / idx.total_terms;
    score += tfNorm * idf;
    matched.push(t);
  }
  return { score, matched };
}

export function route(
  query: string,
  registry: ReadonlyArray<ToolDescriptor>,
  opts: RouteOpts = {},
): RouteResult {
  const surface = opts.surface;
  const threshold = opts.confidence_threshold ?? 0.15;
  const topK = Math.max(1, opts.top_k ?? 5);
  const includeDeprecated = opts.include_deprecated ?? false;

  const onSurface = (t: ToolDescriptor): boolean =>
    !surface || !t.surfaces || t.surfaces.includes(surface);

  const filtered = registry.filter(
    (t) => onSurface(t) && (includeDeprecated || !t.deprecated),
  );
  // Count deprecated tools that would otherwise have competed for this
  // route, so observability can surface routing shadowed by retired tools.
  const excludedDeprecated = includeDeprecated
    ? 0
    : registry.filter((t) => t.deprecated === true && onSurface(t)).length;

  const indices = filtered.map(indexTool);
  const df = buildDocumentFrequency(indices);
  const queryTerms = tokenize(query);

  const scored: RouteCandidate[] = indices.map((idx) => {
    const { score, matched } = scoreTool(queryTerms, idx, df, indices.length || 1);
    const bias = idx.tool.bias ?? 0;
    return { tool: idx.tool, score: score + bias, matched_terms: matched };
  });

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, topK);
  const top = candidates[0];
  const selected = top && top.score >= threshold ? top : null;

  return {
    query,
    surface,
    candidates,
    selected,
    confidence_threshold: threshold,
    excluded_deprecated: excludedDeprecated,
  };
}

// Persistence: append every routing decision so the briefing can audit
// "Amy routed N intents today, top-1 confidence median X, fallback rate Y%".
// Format mirrors tool-trace.ts.

export interface RouteRecord {
  timestamp: string;
  query: string;
  surface?: string;
  selected_tool: string | null;
  selected_score: number | null;
  candidates: { name: string; score: number }[];
  confidence_threshold: number;
  excluded_deprecated: number;
}

export type RouteWriter = (record: RouteRecord) => void;

export function makeRouteFileWriter(filePath: string): RouteWriter {
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best effort
    }
  };
}

export function recordRoute(result: RouteResult, writer: RouteWriter): RouteRecord {
  const record: RouteRecord = {
    timestamp: new Date().toISOString(),
    query: result.query,
    surface: result.surface,
    selected_tool: result.selected ? result.selected.tool.name : null,
    selected_score: result.selected ? result.selected.score : null,
    candidates: result.candidates.map((c) => ({ name: c.tool.name, score: c.score })),
    confidence_threshold: result.confidence_threshold,
    excluded_deprecated: result.excluded_deprecated,
  };
  writer(record);
  return record;
}
