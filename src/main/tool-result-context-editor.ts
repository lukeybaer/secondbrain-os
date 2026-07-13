// tool-result-context-editor.ts
//
// Deterministic context editing for long agent loops -- the pure-TS analogue of
// Anthropic's server-side `clear_tool_uses` strategy
// (https://platform.claude.com/docs/en/build-with-claude/context-editing).
//
// Amy's multi-step loops (briefing self-heal, email scans, call handling) push a
// role:'tool' message per tool call, each carrying the full JSON tool result.
// Over a long run these dominate the window: a Gmail scan or spine sweep can
// leave dozens of large results in context long after they stopped mattering.
// conversation-compressor.ts summarizes reflection ROUNDS and tool-result-cache.ts
// memoizes by args; neither evicts stale tool-result MESSAGES from a live loop.
//
// clearToolResults() does exactly that: once the estimated token footprint crosses
// a trigger, it replaces the OLDEST tool-result message contents with a short
// placeholder breadcrumb, keeping the last N results intact and never touching
// protected tools. Message COUNT is preserved (content is rewritten, not removed)
// so assistant/tool pairing by tool_call_id stays valid -- the model still sees
// that a result existed, just not its bytes.
//
// Pure and deterministic: same input -> same output. No LLM, no I/O.

/** Minimal structural message shape; agent-step-loop's ChatMessage satisfies it. */
export interface EditableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on role:'tool' results; links back to the assistant tool_call id. */
  tool_call_id?: string;
  /** Present on assistant messages that requested tools. */
  tool_calls?: ReadonlyArray<{ id: string; name: string }>;
}

export interface ClearToolResultsOptions {
  /** Estimated total tokens above which editing kicks in. Default 100_000. */
  triggerTokens?: number;
  /** Most-recent tool results to always keep intact. Default 3. */
  keepRecentToolResults?: number;
  /**
   * Do nothing unless clearing would reclaim at least this many estimated
   * tokens -- avoids churning the transcript for a trivial win. Default 1_000.
   */
  clearAtLeastTokens?: number;
  /** Tool names whose results are never cleared (e.g. an approval gate). */
  excludeTools?: ReadonlyArray<string>;
  /** Builds the breadcrumb left in place of a cleared result. */
  placeholder?: (info: { toolName?: string; tokens: number }) => string;
  /** Override the token estimator (tests / calibration). Default chars/4. */
  estimateTokens?: (text: string) => number;
}

export interface ClearToolResultsResult<T extends EditableMessage> {
  /** New array, same length; cleared tool results have placeholder content. */
  messages: T[];
  /** tool_call_ids (or synthetic index keys) of the cleared results. */
  clearedIds: string[];
  /** Estimated tokens reclaimed by the clear. */
  clearedTokens: number;
  /** Estimated total tokens BEFORE editing. */
  totalTokensBefore: number;
  /** True when at least one result was cleared. */
  edited: boolean;
}

const DEFAULTS = {
  triggerTokens: 100_000,
  keepRecentToolResults: 3,
  clearAtLeastTokens: 1_000,
};

/** Rough token estimate: ~4 chars per token. Deterministic, provider-agnostic. */
export function estimateTokensDefault(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

function defaultPlaceholder(info: { toolName?: string; tokens: number }): string {
  const which = info.toolName ? ` from ${info.toolName}` : '';
  return `[tool result cleared to save context${which}: ~${info.tokens} tokens elided]`;
}

/**
 * Map each tool_call_id to the tool name that produced it, by scanning assistant
 * messages' tool_calls. Lets excludeTools protect results by tool identity.
 */
function toolNameById(messages: ReadonlyArray<EditableMessage>): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) map.set(tc.id, tc.name);
    }
  }
  return map;
}

/**
 * Evict oldest tool-result contents once the transcript crosses triggerTokens,
 * keeping the last keepRecentToolResults and any excludeTools protected. Pure:
 * returns a new array; the input is never mutated.
 */
export function clearToolResults<T extends EditableMessage>(
  messages: ReadonlyArray<T>,
  options: ClearToolResultsOptions = {},
): ClearToolResultsResult<T> {
  const triggerTokens = options.triggerTokens ?? DEFAULTS.triggerTokens;
  const keepRecent = Math.max(0, options.keepRecentToolResults ?? DEFAULTS.keepRecentToolResults);
  const clearAtLeast = options.clearAtLeastTokens ?? DEFAULTS.clearAtLeastTokens;
  const exclude = new Set(options.excludeTools ?? []);
  const estimate = options.estimateTokens ?? estimateTokensDefault;
  const placeholder = options.placeholder ?? defaultPlaceholder;

  const totalTokensBefore = messages.reduce((sum, m) => sum + estimate(m.content), 0);
  const nameById = toolNameById(messages);

  const noEdit: ClearToolResultsResult<T> = {
    messages: messages.slice(),
    clearedIds: [],
    clearedTokens: 0,
    totalTokensBefore,
    edited: false,
  };

  if (totalTokensBefore <= triggerTokens) return noEdit;

  // Indices of tool-result messages in chronological order.
  const toolIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolIdx.push(i);
  });

  // Keep the last keepRecent tool results; the rest (oldest-first) are eligible.
  const eligible = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));

  // Decide which eligible results to actually clear, skipping protected tools
  // and anything that looks already-cleared (empty). We clear all eligible in
  // one pass (deterministic); clearAtLeast just vetoes a trivial edit.
  const toClear: number[] = [];
  let reclaimable = 0;
  for (const i of eligible) {
    const id = messages[i].tool_call_id;
    const toolName = id ? nameById.get(id) : undefined;
    if (toolName && exclude.has(toolName)) continue;
    const tokens = estimate(messages[i].content);
    if (tokens <= 0) continue;
    toClear.push(i);
    reclaimable += tokens;
  }

  if (toClear.length === 0 || reclaimable < clearAtLeast) return noEdit;

  const clearSet = new Set(toClear);
  const clearedIds: string[] = [];
  let clearedTokens = 0;

  const out = messages.map((m, i) => {
    if (!clearSet.has(i)) return m;
    const tokens = estimate(m.content);
    clearedTokens += tokens;
    const toolName = m.tool_call_id ? nameById.get(m.tool_call_id) : undefined;
    clearedIds.push(m.tool_call_id ?? `#${i}`);
    return { ...m, content: placeholder({ toolName, tokens }) } as T;
  });

  return {
    messages: out,
    clearedIds,
    clearedTokens,
    totalTokensBefore,
    edited: true,
  };
}

/**
 * In-place variant for the agent loop: rewrites cleared contents on the EXISTING
 * message objects so the loop's array reference (used by step snapshots) is
 * preserved. Returns the same metadata as clearToolResults. Message identity and
 * count are unchanged; only cleared tool-result `content` strings are rewritten.
 */
export function applyContextEdit<T extends EditableMessage>(
  messages: T[],
  options: ClearToolResultsOptions = {},
): Omit<ClearToolResultsResult<T>, 'messages'> {
  const result = clearToolResults(messages, options);
  if (result.edited) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].content !== result.messages[i].content) {
        messages[i].content = result.messages[i].content;
      }
    }
  }
  return {
    clearedIds: result.clearedIds,
    clearedTokens: result.clearedTokens,
    totalTokensBefore: result.totalTokensBefore,
    edited: result.edited,
  };
}
