// agent-memory.ts
// Generic persistent memory system for AI agents in SecondBrain.
//
// Each agent has its own memory file (Markdown) that persists across all
// interactions — calls, Telegram, in-app. The agent reads it before acting
// and updates it after every interaction.
//
// Usage:
//   import { getAgentMemory } from "./agent-memory";
//   const ea = getAgentMemory("ea");
//   const systemPrompt = await ea.buildSystemPrompt(basePrompt);
//   await ea.runPostCallReflection({ callId, ... });
//
// To add a new agent:
//   Register a seed in AGENT_SEEDS below (or pass a custom path/seed to
//   AgentMemory constructor directly).

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildMemoryContext,
  upsertMemory,
  appendToArchive,
  appendWorkingMemory,
  initMemoryIndex,
  readWorkingMemory,
} from './memory-index';
import { buildKnowledgeContext, ingestCallTranscript } from './graphiti-client';
import { readCanonicalMemory } from './memory-sync';

// ── Agent registry ────────────────────────────────────────────────────────────

const registry = new Map<string, AgentMemory>();

/** Get (or create) the memory instance for a named agent. */
export function getAgentMemory(agentId: string): AgentMemory {
  if (!registry.has(agentId)) {
    const seed = AGENT_SEEDS[agentId];
    if (!seed)
      throw new Error(
        `Unknown agent: "${agentId}". Register a seed in AGENT_SEEDS or create AgentMemory directly.`,
      );
    registry.set(agentId, new AgentMemory(agentId, seed.fileName, seed.initialContent));
  }
  return registry.get(agentId)!;
}

// ── Agent seed definitions ────────────────────────────────────────────────────
// Each built-in agent gets its own file name and rich initial memory content.
// These are written once on first run and then the agent evolves them over time.

const AGENT_SEEDS: Record<string, { fileName: string; initialContent: string }> = {
  ea: {
    fileName: 'EA_MEMORY.md',
    initialContent: `# EA Agent Memory — Executive Assistant
*Last updated: ${new Date().toISOString()}*
*Agent: EA (Executive Assistant)*

---

## Identity & Role
I am an autonomous executive assistant. Not a chatbot — an agent. I take calls, research, make decisions, and execute on the owner's behalf. I track everything, learn from every interaction, and get better over time.

My core function: reduce cognitive load on the owner. Handle it, report back, iterate.

---

## About the Owner

**Personal**
- Full name: (configure in Settings or edit this file)
- Location: (configure in Settings)
- Phone (test/personal): (configure in Settings) — always test new call scripts on this number first
- Timezone: (e.g. America/Chicago)

**Career**
- (Add your career context here)

**Communication style**
- (Describe how you prefer the EA to communicate)

---

## Companies & Ventures

*(Add your companies/ventures here)*

---

## How I Should Operate

### Non-negotiable rules
1. **Test on owner first.** Any new call script → dial the test number → owner roleplays the target → iterate until it works → then hit real targets.
2. **Owner controls the trigger.** I line everything up. They say go. I never auto-dial without approval.
3. **Iterate the script, not the list.** If calls aren't working → fix the approach first. Don't burn through contacts hoping for different results.
4. **Track everything.** Every call outcome, every learning, every contact interaction.
5. **Never auto-publish content.** Owner reviews and approves. I queue, they release.

### What the owner values
- (Customize based on your preferences)

### What frustrates the owner
- (Customize based on your preferences)

---

## Active Projects

*(Updated as projects are assigned)*

---

## Known Contacts

*(Populated as calls are made)*

---

## Call Script Learnings

### What works
*(Updated as patterns emerge)*

### What doesn't work
*(Updated as patterns emerge)*

### Timing patterns
*(Track as data accumulates)*

---

## Fast/Medium/Slow Query Classification

### Fast (answer immediately from memory, <5s)
- Owner's phone number, address, job title
- What projects are active
- Simple factual questions about owner's profile

### Medium (search conversation DB, 5-20s)
- "Did I talk to X about Y?" → search transcripts
- "What did we decide about Z?" → search meeting notes
- "Who is [name]?" → check contacts + search

### Slow (acknowledge + queue, don't keep them waiting >15s)
- "Research X near Y" → needs web search
- "Build me a report on X" → code execution
- Anything with "find all" / "compile" / "research" / "analyze"

---

## Self-Improvement Log

### Patterns I've noticed
*(Updated after interactions)*

### Things to do better next time
*(Updated after each reflection)*

---

## Recent Learnings

*(Reflections appended after each interaction)*
`,
  },
};

// ── AgentMemory class ─────────────────────────────────────────────────────────

export interface PostCallReflectionInput {
  callId: string;
  phoneNumber: string;
  contactName?: string;
  instructions: string;
  outcome: string;
  transcript?: string;
  durationSeconds?: number;
  userFeedback?: string;
}

export interface ContactRecord {
  name: string;
  phone?: string;
  role?: string;
  company?: string;
  notes: string;
  lastContactDate: string;
  callCount?: number;
}

export type QuerySpeed = 'fast' | 'medium' | 'slow';

export class AgentMemory {
  private readonly agentId: string;
  private readonly filePath: string;
  private readonly initialContent: string;

  // In-memory cache with TTL
  private cache: string = '';
  private cachedAt: number = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(agentId: string, fileName: string, initialContent: string) {
    this.agentId = agentId;
    this.filePath = path.join(app.getPath('userData'), 'data', 'agent', fileName);
    this.initialContent = initialContent;
  }

  // ── File access ─────────────────────────────────────────────────────────────

  async ensure(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.access(this.filePath);
    } catch {
      await fs.promises.writeFile(this.filePath, this.initialContent, 'utf-8');
      console.log(`[agent-memory:${this.agentId}] Created memory file at`, this.filePath);
    }
  }

  async read(): Promise<string> {
    if (this.cache && Date.now() - this.cachedAt < this.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      await this.ensure();
      this.cache = await fs.promises.readFile(this.filePath, 'utf-8');
      this.cachedAt = Date.now();
      return this.cache;
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] read error:`, err);
      return this.initialContent;
    }
  }

  async write(content: string): Promise<void> {
    try {
      await this.ensure();
      await fs.promises.writeFile(this.filePath, content, 'utf-8');
      this.cache = content;
      this.cachedAt = Date.now();
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] write error:`, err);
    }
  }

  /** Bump the "Last updated" timestamp in the file header. */
  private touchTimestamp(content: string): string {
    return content.replace(/\*Last updated: .+\*/, `*Last updated: ${new Date().toISOString()}*`);
  }

  /** Append a timestamped entry to the "Recent Learnings" section. */
  async appendLearning(learning: string): Promise<void> {
    try {
      let content = await this.read();
      const date = new Date().toISOString().slice(0, 10);
      const entry = `\n### ${date}\n${learning}\n`;

      if (content.includes('## Recent Learnings')) {
        // Insert after the section header and its first line (the placeholder)
        content = content.replace(
          /(## Recent Learnings\n\*\(Reflections appended after each interaction\)\*)/,
          `$1\n${entry}`,
        );
        // Also handle case where placeholder has already been removed
        if (!content.includes(`\n### ${date}`)) {
          content = content.replace(/## Recent Learnings\n/, `## Recent Learnings\n${entry}\n`);
        }
      } else {
        content += `\n${entry}`;
      }
      await this.write(this.touchTimestamp(content));
      console.log(`[agent-memory:${this.agentId}] Appended learning: ${learning.slice(0, 80)}`);
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] appendLearning error:`, err);
    }
  }

  /** Replace or add a named section. */
  async updateSection(sectionName: string, newContent: string): Promise<void> {
    try {
      let content = await this.read();
      const sectionRegex = new RegExp(`(## ${sectionName}\\n)([\\s\\S]*?)(?=\\n## |$)`, 'm');
      const replacement = `$1${newContent}\n\n`;

      if (sectionRegex.test(content)) {
        content = content.replace(sectionRegex, replacement);
      } else {
        content += `\n## ${sectionName}\n${newContent}\n`;
      }
      await this.write(this.touchTimestamp(content));
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] updateSection error:`, err);
    }
  }

  // ── Contact tracking ────────────────────────────────────────────────────────

  async upsertContact(contact: ContactRecord): Promise<void> {
    try {
      const content = await this.read();
      const sectionMatch = content.match(/## Known Contacts\n([\s\S]*?)(?=\n## |$)/m);
      const existing = sectionMatch ? sectionMatch[1] : '';

      let updated: string;
      if (existing.includes(`**${contact.name}**`)) {
        updated = existing.replace(
          new RegExp(`\\*\\*${contact.name}\\*\\*[\\s\\S]*?(?=\\n\\*\\*|\\n\\n##|$)`, 'm'),
          this.formatContact(contact),
        );
      } else {
        updated = (existing.trim() ? existing.trim() + '\n\n' : '') + this.formatContact(contact);
      }
      await this.updateSection('Known Contacts', updated.trim());
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] upsertContact error:`, err);
    }
  }

  private formatContact(c: ContactRecord): string {
    const lines = [`**${c.name}**`];
    if (c.phone) lines.push(`- Phone: ${c.phone}`);
    if (c.role) lines.push(`- Role: ${c.role}`);
    if (c.company) lines.push(`- Company: ${c.company}`);
    if (c.callCount !== undefined) lines.push(`- Call count: ${c.callCount}`);
    lines.push(`- Last contact: ${c.lastContactDate}`);
    lines.push(`- Notes: ${c.notes}`);
    return lines.join('\n');
  }

  // ── System prompt builder ───────────────────────────────────────────────────

  async buildSystemPrompt(
    basePrompt: string,
    options?: { maxMemoryChars?: number; graphitiQuery?: string },
  ): Promise<string> {
    const maxChars = options?.maxMemoryChars ?? 4000;
    const context = await buildUnifiedContext(options?.graphitiQuery ?? '', { maxChars });

    return `${basePrompt}

---
## Agent Memory (Persistent Knowledge)

${context}
---`;
  }

  // ── Post-interaction reflection ─────────────────────────────────────────────

  async runPostCallReflection(input: PostCallReflectionInput): Promise<string> {
    const memory = await this.read();

    const prompt = `You are a self-improving AI executive assistant reviewing your own performance on a phone call.

## Your Current Memory (excerpt)
${memory.slice(0, 2000)}

## Call Details
- Contact: ${input.contactName || input.phoneNumber}
- Instructions: ${input.instructions}
- Outcome: ${input.outcome}
- Duration: ${input.durationSeconds !== undefined ? Math.round(input.durationSeconds / 60) + ' min' : 'unknown'}
${input.userFeedback ? `- Luke's feedback: ${input.userFeedback}` : ''}
${input.transcript ? `\n## Transcript (excerpt)\n${input.transcript.slice(0, 1500)}` : ''}

## Your Reflection Task
Write 3-6 bullet points covering:
- What worked well in this interaction?
- What could be improved?
- What did you learn about this contact or situation?
- What should you remember for next time?
- Any new pattern to add to your memory?

Be specific and actionable. These notes will be written to your memory and used to improve future calls.`;

    let reflection = '';
    try {
      const { getConfig: getAppConfig } = await import('./config');
      const apiKey = getAppConfig().anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('No ANTHROPIC_API_KEY configured');
      const anthropic = new Anthropic({ apiKey });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = msg.content[0];
      if (block.type === 'text') reflection = block.text.trim();
    } catch (err) {
      console.error(`[agent-memory:${this.agentId}] reflection LLM error:`, err);
      reflection = `Call ${input.callId} (${input.outcome}) — manual review needed.`;
    }

    const header = `**Call with ${input.contactName || input.phoneNumber}** — ${input.outcome}`;
    await this.appendLearning(`${header}\n${reflection}`);

    // Also append to three-tier archive and update working memory
    try {
      appendToArchive(
        `## Call Reflection — ${input.contactName || input.phoneNumber}\n**Outcome:** ${input.outcome}\n${reflection}`,
      );
      appendWorkingMemory(`Call with ${input.contactName || input.phoneNumber}: ${input.outcome}`);

      // If call had a significant learning, index it in Tier 2
      if (reflection.length > 100 && input.outcome !== 'no-answer') {
        upsertMemory(
          `Call: ${input.contactName || input.phoneNumber}`,
          `${header}\n${reflection}`,
          { decayRate: 0.05 },
        );
      }
    } catch {
      /* non-critical */
    }

    // Ingest transcript into Graphiti knowledge graph (fire-and-forget)
    if (input.transcript) {
      ingestCallTranscript({
        callId: input.callId,
        callerPhone: input.phoneNumber,
        callerName: input.contactName,
        transcript: input.transcript,
        outcome: input.outcome,
        calledAt: new Date().toISOString(),
      }).catch(() => {
        /* Graphiti may be unavailable */
      });
    }

    // Persist reflection log for audit trail
    try {
      const logPath = path.join(
        path.dirname(this.filePath),
        `${this.agentId}-reflection-log.jsonl`,
      );
      const entry =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          callId: input.callId,
          contact: input.contactName || input.phoneNumber,
          outcome: input.outcome,
          reflection,
        }) + '\n';
      await fs.promises.appendFile(logPath, entry, 'utf-8');
    } catch {
      /* non-critical */
    }

    // Track contact
    if (input.contactName || input.phoneNumber) {
      await this.upsertContact({
        name: input.contactName || input.phoneNumber,
        phone: input.phoneNumber,
        notes: `${input.outcome} — ${new Date().toLocaleDateString()}`,
        lastContactDate: new Date().toISOString().slice(0, 10),
      });
    }

    return reflection;
  }

  // ── Query speed classification ──────────────────────────────────────────────

  classifyQuerySpeed(question: string): QuerySpeed {
    const q = question.toLowerCase().trim();

    const fastPatterns = [
      /\bwhat('s| is) (my|luke'?s?|the)\b/,
      /\bphone number\b/,
      /\baddress\b/,
      /\bhis (name|phone|email|address)\b/,
      /^(who|what|when|where) (is|are)\b/,
      /\bdo (i|we|you) have\b/,
      /\bhow many\b/,
      /\bwhat time\b/,
      /\bmy (name|number|address|wife|company)\b/,
    ];

    const slowPatterns = [
      /\bbuild\b/,
      /\bcreate\b/,
      /\bwrite\b/,
      /\bgenerate\b/,
      /\bdeploy\b/,
      /\bsearch the web\b/,
      /\bfind (all|every|each)\b/,
      /\bcompile\b/,
      /\banalyze\b/,
      /\bresearch\b/,
      /\bmake me\b/,
    ];

    for (const p of fastPatterns) {
      if (p.test(q)) return 'fast';
    }
    for (const p of slowPatterns) {
      if (p.test(q)) return 'slow';
    }
    return 'medium';
  }
}

// ── Unified context builder (Phase 5) ────────────────────────────────────────

/**
 * Build a unified memory context from all sources:
 * 1. Canonical markdown files (git-tracked, richest data)
 * 2. Graphiti knowledge graph (temporal + semantic search)
 * 3. Working memory (Tier 1 recency buffer)
 *
 * This replaces the old three-source approach (Hebbian + EA_MEMORY.md + Graphiti)
 * with a cleaner two-source approach (canonical markdown + Graphiti search).
 */
export async function buildUnifiedContext(
  query: string,
  opts?: { maxChars?: number },
): Promise<string> {
  const maxChars = opts?.maxChars ?? 4000;
  const parts: string[] = [];

  // Source 1: Canonical markdown files (always available, most complete)
  try {
    const canonical = readCanonicalMemory({
      types: ['user', 'feedback', 'project', 'reference'],
      maxChars: Math.floor(maxChars * 0.5),
    });
    if (canonical.trim()) {
      parts.push(`### Canonical Memory (git-tracked)\n${canonical}`);
    }
  } catch {
    // Fall back to EA_MEMORY.md if canonical read fails
    const ea = getAgentMemory('ea');
    const fallback = await ea.read();
    parts.push(`### EA Memory (fallback)\n${fallback.slice(0, Math.floor(maxChars * 0.5))}`);
  }

  // Source 2: Graphiti search (semantic + temporal relevance)
  if (query) {
    try {
      const graphitiContext = await buildKnowledgeContext(query, Math.floor(maxChars * 0.3));
      if (graphitiContext.trim()) {
        parts.push(graphitiContext);
      }
    } catch {
      /* Graphiti unavailable — continue without it */
    }
  }

  // Source 3: Working memory (recent call outcomes, recency buffer)
  try {
    const working = readWorkingMemory();
    if (working.trim()) {
      parts.push(`### Working Memory (recent)\n${working.trim()}`);
    }
  } catch {
    /* Non-critical */
  }

  return parts.join('\n\n');
}

// ── Convenience exports (backwards compat + ease of use) ─────────────────────

/** Read EA memory. */
export async function readMemory(): Promise<string> {
  return getAgentMemory('ea').read();
}

/** Write EA memory. */
export async function writeMemory(content: string): Promise<void> {
  return getAgentMemory('ea').write(content);
}

/** Ensure EA memory file exists. */
export async function ensureMemoryFile(): Promise<void> {
  return getAgentMemory('ea').ensure();
}

/** Run post-call reflection for EA. */
export async function runPostCallReflection(input: PostCallReflectionInput): Promise<string> {
  return getAgentMemory('ea').runPostCallReflection(input);
}

/** Build a system prompt with EA memory injected. */
export async function buildCallSystemPrompt(basePrompt: string): Promise<string> {
  return getAgentMemory('ea').buildSystemPrompt(basePrompt);
}

/** Classify query speed using EA's classification rules. */
export function classifyQuerySpeed(question: string): QuerySpeed {
  return getAgentMemory('ea').classifyQuerySpeed(question);
}

/** Append a learning to EA memory. */
export async function appendLearning(learning: string): Promise<void> {
  return getAgentMemory('ea').appendLearning(learning);
}
