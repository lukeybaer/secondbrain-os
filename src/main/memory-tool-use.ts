// memory-tool-use.ts
//
// Letta-inspired self-editing memory via Anthropic tool_use API.
//
// Problem: memory-index.ts, core-memory-blocks.ts, and memory-bm25.ts all
// expose imperative APIs but Amy must be coded to call them at specific moments
// (post-call, end-of-task). Letta's insight is that the agent DECIDES to edit
// its own memory as tool_use blocks during a live Claude API call — same
// mechanism as any other tool. This unlocks real-time memory management:
// Amy can search, read, and rewrite her working context mid-reasoning.
//
// Pattern: Letta v0.16.7 "stateful agents" — core_memory_replace,
// core_memory_append, archival_memory_search, archival_memory_insert.
// SecondBrain adapts these to the three-tier memory architecture.
//
// Usage (Claude API call with self-editing memory):
//   import { MEMORY_TOOLS, executeMemoryTool } from './memory-tool-use';
//   const response = await anthropic.messages.create({
//     model: 'claude-sonnet-4-6',
//     tools: [...MEMORY_TOOLS, ...otherTools],
//     messages,
//   });
//   for (const block of response.content) {
//     if (block.type === 'tool_use' && block.name.startsWith('memory_')) {
//       const result = await executeMemoryTool(block.name, block.input, memoryPaths);
//       // append tool_result back into messages and continue
//     }
//   }

import { readBlock, writeBlock, listBlocks, DEFAULT_BLOCK_LIMIT } from './core-memory-blocks';
import { upsertMemory, buildMemoryContext } from './memory-index';
import { searchMemory, refreshIndex } from './memory-bm25';
import { memoryReplace, MemoryEditError } from './memory-block-editor';

// ── Tool definitions (Anthropic format) ──────────────────────────────────────

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ExampleCo>;
    required: string[];
  };
}

export const MEMORY_TOOLS: AnthropicToolDefinition[] = [
  {
    name: 'memory_search',
    description:
      "Search Amy's local memory files using BM25 keyword search. Returns the top-N most relevant excerpts. Use when you need to recall specific facts, contact details, project context, or prior decisions.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword query. Named entities, project names, and specific phrases work best.',
        },
        top_k: {
          type: 'number',
          description: 'Max number of results to return (default: 5, max: 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read_block',
    description:
      'Read a named core memory block (persona, human, scratchpad, or any custom block). Core blocks are always-loaded, byte-limited, and edited atomically. Use to get the current contents of a structured block.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Block name (e.g. "persona", "human", "scratchpad").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'memory_write_block',
    description:
      'Overwrite a named core memory block with new content. The block has a hard byte limit (default 2000). This persists immediately to disk and survives session restarts. Use to update working context about the owner, your own identity, or scratchpad notes.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Block name (e.g. "persona", "human", "scratchpad").',
        },
        content: {
          type: 'string',
          description: 'New content for the block. Must be under the byte limit.',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'memory_replace_block',
    description:
      'Edit ONE fact inside a core memory block without rewriting the whole block. old_string must match the existing text verbatim and uniquely; the edit is refused (no change made) if it matches zero times or more than once. Prefer this over memory_write_block whenever you are changing part of a block, so unrelated facts cannot be accidentally dropped.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The block to edit (e.g. "human", "persona").',
        },
        old_string: {
          type: 'string',
          description:
            'The exact existing text to replace. Must appear verbatim and exactly once. Add surrounding context if a short string is ambiguous.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text.',
        },
      },
      required: ['name', 'old_string', 'new_string'],
    },
  },
  {
    name: 'memory_insert',
    description:
      'Upsert a Tier 2 memory entry (topic-scoped markdown file). Use to record a new fact, decision, or preference that should persist beyond this session. The entry is indexed for future BM25 + semantic search.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Short slug for the memory topic (e.g. "dentist-project", "spouse-visa-timeline").',
        },
        content: {
          type: 'string',
          description:
            'The memory content to persist. Write in first person as Amy, concise and factual.',
        },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'memory_list_blocks',
    description:
      'List all core memory blocks with their name, byte count, limit, and last-updated timestamp. Use to discover what structured context is available before reading.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'memory_get_context',
    description:
      "Retrieve the full Tier 2 memory context (all weighted entries above a threshold), formatted as a markdown string. This is the same context injected into Amy's system prompt. Use when you need a broad overview of what Amy remembers.",
    input_schema: {
      type: 'object',
      properties: {
        min_weight: {
          type: 'number',
          description: 'Only include entries with weight >= this value (default: 0.3).',
        },
        max_chars: {
          type: 'number',
          description: 'Truncate context to this many characters (default: 8000).',
        },
      },
      required: [],
    },
  },
];

// ── Paths config ──────────────────────────────────────────────────────────────

export interface MemoryPaths {
  blocksDir: string; // e.g. secondbrain/memory/core-blocks/
  memoryDir: string; // e.g. secondbrain/memory/ (Tier 2 md files)
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export interface MemoryToolResult {
  success: boolean;
  output: string; // human-readable result for tool_result content
  data?: ExampleCo; // structured data (optional)
}

export async function executeMemoryTool(
  name: string,
  input: Record<string, ExampleCo>,
  paths: MemoryPaths,
): Promise<MemoryToolResult> {
  try {
    switch (name) {
      case 'memory_search': {
        const query = String(input.query ?? '');
        const topK = Math.min(Number(input.top_k ?? 5), 20);
        if (!query) return { success: false, output: 'query is required' };

        const results = searchMemory(paths.memoryDir, query, topK);

        if (results.length === 0) {
          return { success: true, output: `No memory results for: "${query}"` };
        }

        const lines = results.map(
          (r, i) =>
            `${i + 1}. [${r.relPath}:${r.lineNumber}] score=${r.score.toFixed(3)}\n   ${r.excerpt}`,
        );
        return {
          success: true,
          output: `Found ${results.length} results for "${query}":\n\n${lines.join('\n\n')}`,
          data: results,
        };
      }

      case 'memory_read_block': {
        const blockName = String(input.name ?? '');
        if (!blockName) return { success: false, output: 'name is required' };

        const block = readBlock(paths.blocksDir, blockName);
        if (!block) {
          return {
            success: false,
            output: `Block "${blockName}" not found. Use memory_list_blocks to see available blocks.`,
          };
        }
        return {
          success: true,
          output: `Block "${blockName}" (${block.content.length}/${block.limit} bytes, updated ${block.updated_at}):\n\n${block.content}`,
          data: block,
        };
      }

      case 'memory_write_block': {
        const blockName = String(input.name ?? '');
        const content = String(input.content ?? '');
        if (!blockName) return { success: false, output: 'name is required' };
        if (!content) return { success: false, output: 'content is required' };

        const existing = readBlock(paths.blocksDir, blockName);
        const limit = existing?.limit ?? DEFAULT_BLOCK_LIMIT;

        if (content.length > limit) {
          return {
            success: false,
            output: `Content too long: ${content.length} chars exceeds block limit of ${limit}. Trim the content.`,
          };
        }

        writeBlock(paths.blocksDir, blockName, content, limit);
        return {
          success: true,
          output: `Block "${blockName}" updated (${content.length}/${limit} bytes).`,
        };
      }

      case 'memory_replace_block': {
        const blockName = String(input.name ?? '');
        const oldString = String(input.old_string ?? '');
        const newString = String(input.new_string ?? '');
        if (!blockName) return { success: false, output: 'name is required' };
        if (!oldString) return { success: false, output: 'old_string is required' };

        const block = readBlock(paths.blocksDir, blockName);
        if (!block) {
          return {
            success: false,
            output: `Block "${blockName}" not found. Use memory_list_blocks to see available blocks.`,
          };
        }

        try {
          const edit = memoryReplace(block.content, oldString, newString, block.limit);
          writeBlock(paths.blocksDir, blockName, edit.content, block.limit);
          return {
            success: true,
            output: `Block "${blockName}" edited at line ${edit.matchedLine} (${edit.content.length}/${block.limit} bytes). Rest of the block left untouched.`,
          };
        } catch (e) {
          if (e instanceof MemoryEditError) {
            return { success: false, output: `Edit refused (${e.code}): ${e.message}` };
          }
          throw e;
        }
      }

      case 'memory_insert': {
        const topic = String(input.topic ?? '');
        const content = String(input.content ?? '');
        if (!topic) return { success: false, output: 'topic is required' };
        if (!content) return { success: false, output: 'content is required' };

        upsertMemory(topic, content);
        // invalidate BM25 singleton so next search picks up the new entry
        refreshIndex(paths.memoryDir);

        return {
          success: true,
          output: `Memory upserted for topic "${topic}".`,
        };
      }

      case 'memory_list_blocks': {
        const names = listBlocks(paths.blocksDir);
        if (names.length === 0) {
          return {
            success: true,
            output: 'No core blocks found. Use memory_write_block to create one.',
          };
        }

        const rows = names.map((n) => {
          const block = readBlock(paths.blocksDir, n);
          if (!block) return `  ${n}: (unreadable)`;
          return `  ${n}: ${block.content.length}/${block.limit} bytes, updated ${block.updated_at}`;
        });

        return {
          success: true,
          output: `Core memory blocks (${names.length}):\n${rows.join('\n')}`,
          data: names,
        };
      }

      case 'memory_get_context': {
        const minWeight = Number(input.min_weight ?? 0.3);
        const maxChars = Number(input.max_chars ?? 8000);
        const ctx = buildMemoryContext({ maxChars, minWeight });
        return {
          success: true,
          output: ctx || '(no memory entries above threshold)',
        };
      }

      default:
        return { success: false, output: `PRIVATE_NAME memory tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Memory tool error: ${msg}` };
  }
}

// ── Helper: format tool_result message for Claude API ────────────────────────

export function buildToolResultMessage(
  toolUseId: string,
  result: MemoryToolResult,
): {
  role: 'user';
  content: [{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }];
} {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result.output,
        ...(result.success ? {} : { is_error: true }),
      },
    ],
  };
}

// ── Helper: check if a tool block is a memory tool ───────────────────────────

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOLS.some((t) => t.name === name);
}
