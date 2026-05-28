// tool-router-registry.ts
//
// Default tool registry for tool-router.ts. The router scores candidates
// against an intent, but it needs a registry. Every callsite today
// assembles its own; this module ships ONE canonical list so new tools
// become routable from the moment they exist.
//
// Patterns synthesized from:
//   - Letta tool registry (letta-ai/letta-code 2026-04): one stateful
//     registry shared across agents, each tool described by what data it
//     exposes, not how to invoke it.
//   - Agno toolkit auto-discovery (agno-agi/agno docs 2026-04): toolkits
//     publish their tools at startup; the agent picks at call time from
//     the joined registry. SecondBrain's equivalent is the surfaces
//     array on each descriptor.
//   - LangChain ToolRegistry (langchain-ai/langgraph 2026-04 1.0): a
//     pluggable interface that callers can override with their own
//     list. We expose DEFAULT_REGISTRY as a const but `registryFor(surface)`
//     filters to the slice each surface cares about.
//
// Knowledge-shaped descriptions per feedback_knowledge_not_rules_for_amy.md:
// each description names the DATA the tool exposes, not the command to
// run it. Tags add synonym recall so a tier-1 intent like "what calls
// did Luke take" routes to the otter-query tool whose description says
// "transcripts from Otter".
//
// Pure module: no fs, no network. Stable export shape so the briefing
// pipeline and Vapi prompt assembler can both import the same registry.

import {
  ToolDescriptor,
  route,
  RouteOpts,
  RouteResult,
  withCapabilityDefaults,
  SideEffectClass,
  ApprovalGate,
} from './tool-router';

// ── Registry entries ─────────────────────────────────────────────────────────

// Seeded from the locked tools described in MEMORY.md:
//   - reference_voice_stack_landscape.md (otter-query, transcript-fastpath,
//     read_otter_transcripts)
//   - reference_briefing_dashboard.md (briefing parsing and refresh)
//   - reference_gmail_send_pipeline.md (Gmail send and dispatch)
//   - reference_caller_auth_system.md (caller-id pipeline)
//   - reference_briefing_aws_resources.md (Athena, S3 archive)
//
// Each entry's surfaces list is intentionally tight: a tool that ONLY
// belongs on the Vapi surface should never compete with briefing tools
// for routing. When in doubt, list multiple surfaces and let bias do
// the disambiguation.

export const DEFAULT_REGISTRY: ReadonlyArray<ToolDescriptor> = [
  // ── Otter / transcripts ──────────────────────────────────────────────────
  {
    name: 'otter-query',
    description:
      'Otter transcripts from Luke\'s conversations and meetings. Provides searchable text of what was said, by whom, when, and on which date. Use for recall of meeting content, dictated notes, phone-call transcripts, and any voice-captured material.',
    tags: ['otter', 'transcript', 'meeting', 'conversation', 'voice', 'dictation', 'said', 'spoke'],
    surfaces: ['vapi', 'briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query', 'date_from', 'date_to', 'speaker'],
    output_shape: 'list',
    cost_class: 'free',
    source_doc: 'reference_voice_stack_landscape.md',
  },
  {
    name: 'transcript-fastpath',
    description:
      'Cached recent Otter transcripts indexed by date for low-latency lookup. Returns the most recent N transcripts with timestamps. Use when the answer is "what happened today" or "what was the last thing Luke recorded".',
    tags: ['otter', 'today', 'recent', 'transcript', 'last', 'today\'s'],
    surfaces: ['vapi', 'briefing'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['limit'],
    output_shape: 'list',
    cost_class: 'free',
    source_doc: 'reference_voice_stack_landscape.md',
  },
  {
    name: 'read_otter_transcripts',
    description:
      'Vapi-side tool that lists or fetches Otter transcripts by date range or keyword. Returns transcript metadata plus body text. Use during a call when the caller asks "what did Luke say about X".',
    tags: ['otter', 'transcript', 'date-range', 'days', 'date_from', 'date_to'],
    surfaces: ['vapi'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['date_from', 'date_to', 'days', 'query'],
    output_shape: 'list',
    cost_class: 'free',
    source_doc: 'reference_voice_stack_landscape.md',
  },

  // ── Memory / recall ──────────────────────────────────────────────────────
  {
    name: 'memory_search',
    description:
      'BM25 keyword search over Amy\'s local memory files. Returns ranked excerpts with file paths. Use when you need exact-phrase recall of named entities, project codenames, addresses, or prior decisions.',
    tags: ['memory', 'recall', 'search', 'bm25', 'keyword', 'fact', 'prior', 'past'],
    surfaces: ['vapi', 'briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query', 'limit'],
    output_shape: 'list',
    cost_class: 'free',
  },
  {
    name: 'memory_read_block',
    description:
      'Read a named core memory block such as persona, human, or scratchpad. Core blocks are always-loaded, byte-limited working context. Use to inspect the current contents of a structured block.',
    tags: ['memory', 'core', 'block', 'persona', 'human', 'scratchpad', 'context'],
    surfaces: ['vapi', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['block_name'],
    output_shape: 'text',
    cost_class: 'free',
  },
  {
    name: 'graphiti_search',
    description:
      'Semantic search over Amy\'s knowledge graph hosted on EC2. Returns entities and episodes with similarity scores. Use when the query is conceptual rather than literal and the EC2 tunnel is up.',
    tags: ['graphiti', 'semantic', 'knowledge', 'graph', 'entity', 'episode'],
    surfaces: ['vapi', 'briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query', 'top_k'],
    output_shape: 'list',
    cost_class: 'cheap',
  },
  {
    name: 'sb_session_search',
    description:
      'FTS5 search over the local archive of past Claude Code sessions at ~/.secondbrain/sessions.db. Returns top hits with session ids and excerpts. Use when the user asks "did we ever discuss X" across prior conversations.',
    tags: ['session', 'recall', 'prior', 'past', 'history', 'fts5', 'archive'],
    surfaces: ['cli', 'briefing'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query', 'limit'],
    output_shape: 'list',
    cost_class: 'free',
  },

  // ── Contacts ─────────────────────────────────────────────────────────────
  {
    name: 'contacts_lookup',
    description:
      'Reads contact files at secondbrain/memory/contacts/. Returns the markdown file content with personal context, history, and relationship notes. Use when a named person is mentioned and Amy needs the latest known state.',
    tags: ['contact', 'person', 'people', 'who', 'relationship', 'history'],
    surfaces: ['vapi', 'briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['name', 'slug'],
    output_shape: 'text',
    cost_class: 'free',
  },
  {
    name: 'contacts_index',
    description:
      'Master list of all known contacts categorized in secondbrain/memory/contacts/INDEX.md. Returns names by category (family, business, vendors). Use to enumerate contacts or pick the right slug for a contacts_lookup.',
    tags: ['contact', 'people', 'list', 'index', 'directory', 'who'],
    surfaces: ['briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['category'],
    output_shape: 'list',
    cost_class: 'free',
  },

  // ── Email / Gmail ────────────────────────────────────────────────────────
  {
    name: 'gmail_search',
    description:
      'Search Gmail messages by query syntax (from, to, subject, body, label, after, before). Returns message ids and snippets. Use to find specific email threads or check for new mail from a named sender.',
    tags: ['gmail', 'email', 'inbox', 'mail', 'message', 'thread', 'sender', 'from'],
    surfaces: ['cli', 'briefing'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query', 'limit'],
    output_shape: 'list',
    cost_class: 'cheap',
    source_doc: 'reference_gmail_send_pipeline.md',
  },
  {
    name: 'gmail_read_thread',
    description:
      'Fetch the full text of a Gmail thread by id. Returns ordered messages with from, date, and body. Use after gmail_search to read a specific conversation in full.',
    tags: ['gmail', 'thread', 'read', 'body', 'message', 'full'],
    surfaces: ['cli', 'briefing'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['thread_id'],
    output_shape: 'text',
    cost_class: 'cheap',
    source_doc: 'reference_gmail_send_pipeline.md',
  },
  {
    name: 'gmail_send',
    description:
      'Send a Gmail message on Luke\'s behalf. Requires recipient, subject, and body. Body must end with Luke\'s signature. Use only when explicitly approved by Luke; drafts are preferred otherwise.',
    tags: ['gmail', 'send', 'email', 'outbound', 'reply'],
    surfaces: ['cli'],
    version: '1.0.0',
    side_effects: 'write',
    idempotent: false,
    approval: 'review',
    input_keys: ['to', 'subject', 'body'],
    output_shape: 'json',
    cost_class: 'cheap',
    source_doc: 'reference_gmail_send_pipeline.md',
  },

  // ── Briefing ─────────────────────────────────────────────────────────────
  {
    name: 'briefing_today',
    description:
      'Today\'s daily executive briefing dashboard contents. Returns the rendered cards, health probes, news, mortgage rates, and action items as of the most recent refresh. Use when the user asks "what is in the briefing" or "what did Amy surface this morning".',
    tags: ['briefing', 'today', 'dashboard', 'morning', 'daily', 'summary'],
    surfaces: ['briefing', 'cli', 'vapi'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: [],
    output_shape: 'json',
    cost_class: 'free',
    source_doc: 'project_briefing_spec.md',
  },
  {
    name: 'briefing_action_items',
    description:
      'Verified action items extracted from yesterday\'s briefing at data/briefing-action-items.json. Returns the open items with sources. Use when Luke asks "what do I need to do today" or "what is open".',
    tags: ['briefing', 'action', 'todo', 'open', 'tasks', 'items'],
    surfaces: ['briefing', 'cli', 'vapi'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: [],
    output_shape: 'list',
    cost_class: 'free',
    source_doc: 'project_briefing_spec.md',
  },

  // ── Calls / Vapi ─────────────────────────────────────────────────────────
  {
    name: 'caller_auth_status',
    description:
      'Caller-authentication state for the most recent inbound Vapi call. Returns the caller-id verification result and any pinning history. Use to decide whether to share private context with an inbound caller.',
    tags: ['caller', 'auth', 'pin', 'inbound', 'verify', 'identity'],
    surfaces: ['vapi'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['call_id'],
    output_shape: 'json',
    cost_class: 'free',
    source_doc: 'reference_caller_auth_system.md',
  },
  {
    name: 'place_outbound_call',
    description:
      'Place an outbound Vapi call to a phone number with a stated goal. Requires the call script to drive toward the goal. Use only when Luke explicitly approves the call list.',
    tags: ['call', 'outbound', 'phone', 'dial', 'vapi'],
    surfaces: ['cli'],
    version: '1.0.0',
    side_effects: 'destructive',
    idempotent: false,
    approval: 'block',
    input_keys: ['phone_number', 'objective', 'script'],
    output_shape: 'json',
    cost_class: 'paid',
    source_doc: 'scripts/OUTBOUND_CALL_SKILL.md',
  },

  // ── Telegram ─────────────────────────────────────────────────────────────
  {
    name: 'telegram_send',
    description:
      'Send a Telegram message to Luke. Used for daily briefing link, security alerts, and PII / reputation tripwires. Subject to quiet hours (22:00 to 06:00 CT). Body must pass the Telegram surface rule pack.',
    tags: ['telegram', 'notify', 'alert', 'message', 'luke'],
    surfaces: ['cli'],
    version: '1.0.0',
    side_effects: 'write',
    idempotent: false,
    approval: 'none',
    input_keys: ['body', 'category'],
    output_shape: 'json',
    cost_class: 'free',
    source_doc: 'feedback_telegram_policy.md',
  },
  {
    name: 'check_calendar',
    description:
      'Calendar access for connected accounts. Defaults to Luke\'s personal Google Calendar; Outlook work calendars are available only when tenant consent succeeds. Returns upcoming event counts, availability windows, and event details only when requested.',
    tags: ['calendar', 'google', 'gmail', 'outlook', 'microsoft', 'graph', 'work', 'schedule', 'availability', 'meeting'],
    surfaces: ['vapi', 'cli', 'briefing'],
    version: '0.1.0',
    side_effects: 'read',
    input_keys: ['account_label', 'days', 'include_subjects'],
    output_shape: 'json',
    cost_class: 'free',
    source_doc: 'scripts/outlook-calendar-probe.js',
  },
  {
    name: 'create_calendar_event',
    description:
      'Calendar event creation for Luke\'s personal Google Calendar. Produces a side-effect receipt with effect_kind=calendar_event and status=succeeded or failed; a completed-event claim is valid only after a succeeded receipt.',
    tags: ['calendar', 'google', 'gmail', 'schedule', 'appointment', 'meeting', 'event', 'create', 'book'],
    surfaces: ['vapi', 'cli'],
    version: '0.1.0',
    side_effects: 'write',
    idempotent: false,
    approval: 'none',
    input_keys: ['title', 'date', 'start_time', 'end_time', 'duration_minutes', 'timezone', 'description'],
    output_shape: 'json',
    cost_class: 'free',
    source_doc: 'scripts/google-calendar-probe.js',
  },

  // ── Tests / health ───────────────────────────────────────────────────────
  {
    name: 'run_test_suite',
    description:
      'Vitest test results for the SecondBrain repo: pass/fail summary, failure list, and timing. Use before any commit that touches production code.',
    tags: ['test', 'vitest', 'verify', 'check', 'regression'],
    surfaces: ['cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['pattern'],
    output_shape: 'json',
    cost_class: 'cheap',
  },
  {
    name: 'pipeline_heartbeat',
    description:
      'Health probes for Amy\'s scheduled pipelines: Otter ingest, Gmail sync, LinkedIn scan, mortgage rates, news summarizer. Returns each probe\'s last-run timestamp and status. Use to answer "is X running" questions.',
    tags: ['health', 'heartbeat', 'probe', 'pipeline', 'status', 'monitor', 'ingest'],
    surfaces: ['briefing', 'cli'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: [],
    output_shape: 'list',
    cost_class: 'free',
  },

  // ── External / web ──────────────────────────────────────────────────────
  {
    name: 'web_search',
    description:
      'External web search. Returns ranked URLs and snippets. Use only when the answer must come from outside the local repo and memory layer.',
    tags: ['web', 'search', 'google', 'external', 'internet', 'news'],
    surfaces: ['cli', 'briefing', 'vapi'],
    version: '1.0.0',
    side_effects: 'read',
    input_keys: ['query'],
    output_shape: 'list',
    cost_class: 'paid',
  },
];

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Slice of the default registry available on the given surface. Useful when
 * the caller wants to enumerate tools for a surface (e.g. to feed an LLM
 * tool-use registry) without re-implementing the filter.
 */
export function registryFor(surface: string): ReadonlyArray<ToolDescriptor> {
  return DEFAULT_REGISTRY.filter((t) => !t.surfaces || t.surfaces.includes(surface));
}

/**
 * One-shot helper: route a query against the default registry. Sugar for
 * `route(query, DEFAULT_REGISTRY, opts)`. Callers wanting a custom registry
 * should import `route` directly from tool-router.
 */
export function routeDefault(query: string, opts: RouteOpts = {}): RouteResult {
  return route(query, DEFAULT_REGISTRY, opts);
}

/**
 * Look up a single descriptor by name. Returns undefined when missing.
 * Useful for telemetry and logging.
 */
export function descriptorByName(name: string): ToolDescriptor | undefined {
  return DEFAULT_REGISTRY.find((t) => t.name === name);
}

/**
 * Enumerate all tools that carry a given tag. Case-insensitive. Used by
 * the briefing pipeline to build a "tools that mention X" section in the
 * health report.
 */
export function descriptorsByTag(tag: string): ReadonlyArray<ToolDescriptor> {
  const lc = tag.toLowerCase();
  return DEFAULT_REGISTRY.filter((t) => (t.tags ?? []).some((x) => x.toLowerCase() === lc));
}

// ── Capability discovery ───────────────────────────────────────────────────
//
// Composio-style runtime introspection: ask the registry "what tools satisfy
// criterion X". Keeps the routing layer and the discovery layer separate so
// non-routing callers (approval inbox, budget gate, briefing observability)
// can filter without touching the TF-IDF code path.

export interface DiscoveryFilter {
  surface?: string;
  side_effects?: SideEffectClass | ReadonlyArray<SideEffectClass>;
  approval?: ApprovalGate | ReadonlyArray<ApprovalGate>;
  idempotent?: boolean;
  cost_class?: 'free' | 'cheap' | 'paid' | ReadonlyArray<'free' | 'cheap' | 'paid'>;
  output_shape?: 'text' | 'list' | 'json' | 'binary';
  requires_input?: ReadonlyArray<string>;   // tools that accept all listed input keys
  tag_any?: ReadonlyArray<string>;          // tools that carry any of these tags
  include_deprecated?: boolean;             // default false
}

function inSet<T>(value: T, allowed: T | ReadonlyArray<T> | undefined): boolean {
  if (allowed === undefined) return true;
  return Array.isArray(allowed) ? (allowed as ReadonlyArray<T>).includes(value) : value === allowed;
}

/**
 * Return all registry entries matching the filter, with capability defaults
 * resolved so callers can branch on side_effects / approval / idempotent
 * without rechecking for undefined.
 *
 * Composio pattern: a single read API answers "which tools can I safely
 * invoke given my caller context, side-effect budget, and approval state".
 */
export function discover(filter: DiscoveryFilter = {}): ReadonlyArray<ReturnType<typeof withCapabilityDefaults>> {
  const resolved = DEFAULT_REGISTRY.map(withCapabilityDefaults);
  return resolved.filter((t) => {
    if (!filter.include_deprecated && t.deprecated) return false;
    if (filter.surface && !(t.surfaces ?? []).includes(filter.surface)) return false;
    if (!inSet(t.side_effects, filter.side_effects)) return false;
    if (!inSet(t.approval, filter.approval)) return false;
    if (filter.idempotent !== undefined && t.idempotent !== filter.idempotent) return false;
    if (!inSet(t.cost_class, filter.cost_class)) return false;
    if (filter.output_shape && t.output_shape !== filter.output_shape) return false;
    if (filter.requires_input && filter.requires_input.length > 0) {
      const keys = new Set(t.input_keys ?? []);
      for (const need of filter.requires_input) {
        if (!keys.has(need)) return false;
      }
    }
    if (filter.tag_any && filter.tag_any.length > 0) {
      const lcTags = new Set((t.tags ?? []).map((x) => x.toLowerCase()));
      const hit = filter.tag_any.some((tag) => lcTags.has(tag.toLowerCase()));
      if (!hit) return false;
    }
    return true;
  });
}

export interface RegistryStats {
  total: number;
  active: number;             // non-deprecated
  deprecated: number;
  by_surface: Record<string, number>;
  by_side_effects: Record<SideEffectClass, number>;
  by_approval: Record<ApprovalGate, number>;
  by_cost_class: Record<'free' | 'cheap' | 'paid', number>;
  by_version: Record<string, number>;
  // Tools that ship without a source_doc anchor. The briefing surfaces these
  // so we know which entries are flying without provenance.
  unanchored: string[];
}

/**
 * Roll-up of the registry shape for the briefing observability card. Pure
 * function over DEFAULT_REGISTRY; safe to call from any surface.
 */
export function registryStats(): RegistryStats {
  const resolved = DEFAULT_REGISTRY.map(withCapabilityDefaults);
  const stats: RegistryStats = {
    total: resolved.length,
    active: 0,
    deprecated: 0,
    by_surface: {},
    by_side_effects: { read: 0, write: 0, destructive: 0 },
    by_approval: { none: 0, review: 0, block: 0 },
    by_cost_class: { free: 0, cheap: 0, paid: 0 },
    by_version: {},
    unanchored: [],
  };
  for (const t of resolved) {
    if (t.deprecated) stats.deprecated += 1;
    else stats.active += 1;
    for (const s of t.surfaces ?? []) {
      stats.by_surface[s] = (stats.by_surface[s] ?? 0) + 1;
    }
    stats.by_side_effects[t.side_effects] += 1;
    stats.by_approval[t.approval] += 1;
    stats.by_cost_class[t.cost_class] += 1;
    const v = t.version ?? 'unversioned';
    stats.by_version[v] = (stats.by_version[v] ?? 0) + 1;
    if (!t.source_doc) stats.unanchored.push(t.name);
  }
  return stats;
}

/**
 * Resolve a tool reference through deprecation. If the entry is deprecated
 * and declares a `replaced_by`, returns the replacement; otherwise returns
 * the entry unchanged. Returns undefined when the name is unknown.
 */
export function resolveActive(name: string): ToolDescriptor | undefined {
  const seen = new Set<string>();
  let current = descriptorByName(name);
  while (current && current.deprecated && current.replaced_by && !seen.has(current.name)) {
    seen.add(current.name);
    const next = descriptorByName(current.replaced_by);
    if (!next) return current;  // dangling replacement, return the deprecated entry so caller can warn
    current = next;
  }
  return current;
}
