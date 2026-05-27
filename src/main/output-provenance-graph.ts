// output-provenance-graph.ts
//
// Per-output provenance DAG. Every artifact Amy surfaces -- briefing tile,
// gmail draft, telegram dispatch, call script, dashboard card -- has a
// graph of inputs that produced it: tool calls, memory reads, evidence
// links, upstream sibling outputs. When Luke asks "why did Amy say X?"
// or "what did the call script depend on?" or "which memory file fed
// last night's briefing news section?" the answer is a graph slice from
// this module, not a forensic grep across logs.
//
// Why this is not the same as anything already present:
//
//   - agent-decision-log.ts is a flat append-only stream of decisions. It
//     answers "what did Amy do?" in linear time order, not "what did this
//     particular output depend on?".
//   - tool-trace.ts records per-call telemetry (which tool, how long,
//     payload size). It is keyed by call_id, not by output.
//   - claim-verifier.ts returns a per-claim citation map ONCE for a
//     finished artifact. It does not retain the citation map across the
//     artifact's lifecycle; nothing links the cite back to the tool call
//     that produced the evidence.
//   - context-block-snapshots.ts captures core-memory snapshots. It
//     does not link a particular snapshot to the artifact that used it.
//
// The gap this closes: a join of all of those streams into a per-output
// directed graph, queryable by output_id, with the edges weighted by
// how much each input contributed to the output. That gives Amy two
// concrete capabilities Luke has asked for:
//
//   1) "Why does the briefing news section keep regressing?" -> walk
//      lineage of the section's last 7 outputs, identify which input
//      sources show up in red outputs but not green ones.
//   2) "If I delete or change memory file user_companies.md, which
//      surfaces are affected?" -> reverse lookup from input_ref to
//      output set.
//
// Pattern sources (2026 OSS + research):
//   - W&B Weave 0.50+ trace lineage (wandb/weave 2026-03) -- typed
//     parent/child trace edges across tool calls, with payload provenance
//     attached to each node.
//   - LangSmith run-tree provenance (langchain-ai/langsmith 0.3 2026-02)
//     -- per-run tree where each output node carries the set of inputs
//     it consumed, exposed via runs/{id}/lineage.
//   - Anthropic Skills SDK "trajectory.predecessors" metadata (Skills
//     SDK 2026-03) -- each skill emits a successors array so the host
//     can reconstruct the DAG without parsing logs.
//   - arxiv 2503.04562 "Agent Provenance Graphs for Auditing" (2025-03)
//     -- formalizes outputs, evidence, and tool calls as a typed DAG and
//     defines the "why" and "what-if" query primitives implemented here.
//   - OpenAI Agents SDK RunNode.tree (openai/agents-python 2026-04) --
//     per-run forest where every produced item has a parents[] pointer.
//   - DataHub / OpenLineage (LF AI 2024) -- the long-running canonical
//     reference for output-to-input lineage outside the agent world.
//
// Design:
//   - Pure module. The graph is in-memory; persistence is injected via
//     ProvenanceStore. Tests use InMemoryProvenanceStore.
//   - Nodes are typed (output | tool_call | memory_read | evidence |
//     belief | sibling_output). The output_id is the primary key.
//   - Edges carry a weight in [0,1] so a "primarily relied on" input can
//     be distinguished from a "consulted but discarded" input.
//   - BFS walks return a depth-bounded subgraph, never an unbounded
//     graph traversal, so a single forensic query cannot blow up memory.

import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProvenanceNodeKind =
  | 'output'
  | 'tool_call'
  | 'memory_read'
  | 'evidence'
  | 'belief'
  | 'sibling_output';

export interface ProvenanceNode {
  id: string;                  // stable id (sha256 of kind + ref + label)
  kind: ProvenanceNodeKind;
  surface?: string;            // 'briefing', 'gmail', 'call', etc.
  label: string;               // short human label
  ref?: string;                // path, url, message-id, ledger line, etc.
  ts: string;                  // ISO when the node was first recorded
  meta?: Record<string, unknown>;
}

export interface ProvenanceEdge {
  from: string;                // upstream node id
  to: string;                  // downstream node id (typically an output)
  weight: number;              // 0..1, contribution share
  ts: string;                  // ISO when the edge was recorded
  note?: string;
}

export interface ProvenanceStore {
  addNode: (n: ProvenanceNode) => void | Promise<void>;
  addEdge: (e: ProvenanceEdge) => void | Promise<void>;
  getNode: (id: string) => ProvenanceNode | undefined | Promise<ProvenanceNode | undefined>;
  /** Edges where `to` matches the given id. */
  inboundEdges: (id: string) => ProvenanceEdge[] | Promise<ProvenanceEdge[]>;
  /** Edges where `from` matches the given id. */
  outboundEdges: (id: string) => ProvenanceEdge[] | Promise<ProvenanceEdge[]>;
  listOutputs: (filter?: { surface?: string }) =>
    ProvenanceNode[] | Promise<ProvenanceNode[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashId(kind: ProvenanceNodeKind, label: string, ref?: string): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}|${label}|${ref ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

function clamp01(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface OpenOutputOpts {
  surface: string;
  label: string;
  ref?: string;
  meta?: Record<string, unknown>;
  now?: () => Date;
}

/**
 * Opens (or returns existing) an output node. Idempotent on (kind, label, ref).
 */
export function openOutput(
  store: ProvenanceStore,
  opts: OpenOutputOpts
): ProvenanceNode {
  const id = hashId('output', opts.label, opts.ref);
  const node: ProvenanceNode = {
    id,
    kind: 'output',
    surface: opts.surface,
    label: opts.label,
    ref: opts.ref,
    ts: nowIso(opts.now),
    meta: opts.meta,
  };
  // Sync stores accept void; async stores will be awaited by callers
  // that want strict ordering. The result is consistent for both.
  void store.addNode(node);
  return node;
}

export interface RecordInputOpts {
  output_id: string;
  kind: Exclude<ProvenanceNodeKind, 'output'>;
  label: string;
  ref?: string;
  /** Contribution share in 0..1. 1.0 = primary driver, 0.1 = consulted. */
  weight?: number;
  note?: string;
  meta?: Record<string, unknown>;
  now?: () => Date;
}

/**
 * Records a single input edge to the given output. Idempotent on
 * (input kind, label, ref). Returns the input node id so callers can
 * chain a follow-up call (recordInput(...) on the input itself to record
 * grand-parent provenance).
 */
export function recordInput(
  store: ProvenanceStore,
  opts: RecordInputOpts
): string {
  const inputId = hashId(opts.kind, opts.label, opts.ref);
  const node: ProvenanceNode = {
    id: inputId,
    kind: opts.kind,
    label: opts.label,
    ref: opts.ref,
    ts: nowIso(opts.now),
    meta: opts.meta,
  };
  void store.addNode(node);
  const edge: ProvenanceEdge = {
    from: inputId,
    to: opts.output_id,
    weight: clamp01(opts.weight ?? 1.0),
    ts: nowIso(opts.now),
    note: opts.note,
  };
  void store.addEdge(edge);
  return inputId;
}

/**
 * Records a sibling-output dependency: this output reused another output
 * (e.g. a briefing tile pulled from the news section's render). Edges
 * are explicit so a later regression can be traced through the chain.
 */
export function recordSibling(
  store: ProvenanceStore,
  to_output_id: string,
  from_output_id: string,
  weight = 1.0,
  note?: string,
  now?: () => Date
): void {
  const edge: ProvenanceEdge = {
    from: from_output_id,
    to: to_output_id,
    weight: clamp01(weight),
    ts: nowIso(now),
    note,
  };
  void store.addEdge(edge);
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface LineageSlice {
  root: ProvenanceNode;
  nodes: ProvenanceNode[];      // bfs-discovered upstream nodes
  edges: ProvenanceEdge[];      // edges within the slice
  truncated: boolean;           // true if BFS hit max_nodes
}

/**
 * BFS upstream from an output, bounded by depth and node count. Returns
 * a subgraph slice safe to render in a forensic UI.
 *
 * The defaults (depth 4, max 200 nodes) reflect a typical SecondBrain
 * graph where a briefing tile has ~3 tool calls + ~6 memory reads +
 * ~2 sibling outputs each with their own depth-2 ancestry.
 */
export async function lineage(
  store: ProvenanceStore,
  output_id: string,
  opts: { depth?: number; max_nodes?: number } = {}
): Promise<LineageSlice> {
  const depth = opts.depth ?? 4;
  const maxNodes = opts.max_nodes ?? 200;
  const root = await store.getNode(output_id);
  if (!root) {
    throw new Error(`output node not found: ${output_id}`);
  }
  const seen = new Set<string>([root.id]);
  const nodes: ProvenanceNode[] = [];
  const edges: ProvenanceEdge[] = [];
  let frontier: string[] = [root.id];
  let truncated = false;
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const inbound = await store.inboundEdges(cur);
      for (const e of inbound) {
        edges.push(e);
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const n = await store.getNode(e.from);
        if (n) {
          nodes.push(n);
          if (nodes.length >= maxNodes) {
            truncated = true;
            return { root, nodes, edges, truncated };
          }
          next.push(e.from);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return { root, nodes, edges, truncated };
}

/**
 * Returns the distinct upstream sources mentioning the search string in
 * label, ref, or any string meta field. Used to answer "did this output
 * touch user_companies.md?" without rendering the full lineage.
 */
export async function whyContains(
  store: ProvenanceStore,
  output_id: string,
  query: string,
  opts: { depth?: number } = {}
): Promise<ProvenanceNode[]> {
  const slice = await lineage(store, output_id, {
    depth: opts.depth ?? 4,
    max_nodes: 500,
  });
  const q = query.toLowerCase();
  const matches = slice.nodes.filter((n) => {
    if (n.label.toLowerCase().includes(q)) return true;
    if (n.ref && n.ref.toLowerCase().includes(q)) return true;
    if (n.meta) {
      for (const v of Object.values(n.meta)) {
        if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
  return matches;
}

/**
 * Reverse impact analysis. Given an input node id (a memory file, a
 * tool, an evidence link), returns the set of output nodes that depend
 * on it within `depth` hops. Answers "if I change user_companies.md,
 * which surfaces are affected?".
 */
export async function impactedOutputs(
  store: ProvenanceStore,
  input_id: string,
  opts: { depth?: number; max_outputs?: number } = {}
): Promise<ProvenanceNode[]> {
  const depth = opts.depth ?? 4;
  const maxOutputs = opts.max_outputs ?? 100;
  const seen = new Set<string>([input_id]);
  const outputs: ProvenanceNode[] = [];
  let frontier: string[] = [input_id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const outbound = await store.outboundEdges(cur);
      for (const e of outbound) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const n = await store.getNode(e.to);
        if (!n) continue;
        if (n.kind === 'output') {
          outputs.push(n);
          if (outputs.length >= maxOutputs) return outputs;
        }
        next.push(e.to);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return outputs;
}

/**
 * Returns the per-source dependency summary for an output, ranked by
 * total edge weight. Useful for a tile drilldown ("this output mostly
 * relied on memory_read:user_companies (0.7) and tool_call:gmail (0.3)").
 */
export async function dependencySummary(
  store: ProvenanceStore,
  output_id: string,
  opts: { depth?: number } = {}
): Promise<Array<{ node: ProvenanceNode; weight: number }>> {
  const slice = await lineage(store, output_id, {
    depth: opts.depth ?? 4,
    max_nodes: 500,
  });
  const weightById = new Map<string, number>();
  for (const e of slice.edges) {
    weightById.set(e.from, (weightById.get(e.from) ?? 0) + e.weight);
  }
  const out: Array<{ node: ProvenanceNode; weight: number }> = [];
  for (const n of slice.nodes) {
    const w = weightById.get(n.id);
    if (w !== undefined) out.push({ node: n, weight: w });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

// ── In-memory store (default for tests + tier-1 callers) ─────────────────────

export class InMemoryProvenanceStore implements ProvenanceStore {
  private _nodes = new Map<string, ProvenanceNode>();
  private _inbound = new Map<string, ProvenanceEdge[]>();
  private _outbound = new Map<string, ProvenanceEdge[]>();
  addNode(n: ProvenanceNode): void {
    // Preserve the earliest-seen version; later additions are merged
    // into meta so timestamps stay stable.
    const existing = this._nodes.get(n.id);
    if (existing) {
      const meta = { ...(existing.meta ?? {}), ...(n.meta ?? {}) };
      this._nodes.set(n.id, { ...existing, meta });
      return;
    }
    this._nodes.set(n.id, JSON.parse(JSON.stringify(n)));
  }
  addEdge(e: ProvenanceEdge): void {
    const inbound = this._inbound.get(e.to) ?? [];
    // Idempotent on (from, to): if an edge already exists, keep the
    // max weight and the earliest ts so adding the same edge twice is
    // safe.
    const dup = inbound.find((x) => x.from === e.from);
    if (dup) {
      dup.weight = Math.max(dup.weight, e.weight);
      if (e.note) dup.note = e.note;
      return;
    }
    inbound.push({ ...e });
    this._inbound.set(e.to, inbound);
    const outbound = this._outbound.get(e.from) ?? [];
    outbound.push({ ...e });
    this._outbound.set(e.from, outbound);
  }
  getNode(id: string): ProvenanceNode | undefined {
    const n = this._nodes.get(id);
    return n ? JSON.parse(JSON.stringify(n)) : undefined;
  }
  inboundEdges(id: string): ProvenanceEdge[] {
    return (this._inbound.get(id) ?? []).map((e) => ({ ...e }));
  }
  outboundEdges(id: string): ProvenanceEdge[] {
    return (this._outbound.get(id) ?? []).map((e) => ({ ...e }));
  }
  listOutputs(filter?: { surface?: string }): ProvenanceNode[] {
    const out: ProvenanceNode[] = [];
    for (const n of this._nodes.values()) {
      if (n.kind !== 'output') continue;
      if (filter?.surface && n.surface !== filter.surface) continue;
      out.push(JSON.parse(JSON.stringify(n)));
    }
    return out;
  }
  clear(): void {
    this._nodes.clear();
    this._inbound.clear();
    this._outbound.clear();
  }
  size(): { nodes: number; edges: number } {
    let edges = 0;
    for (const arr of this._inbound.values()) edges += arr.length;
    return { nodes: this._nodes.size, edges };
  }
}
