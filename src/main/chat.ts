import { app } from "electron";
import OpenAI from "openai";
import { getConfig } from "./config";
import { getAllConversationMeta } from "./database";
import { loadConversation, ConversationMeta } from "./storage";
import { getProfileAsText, extractAndLearnFromMessage } from "./user-profile";
import { listCallRecords, CallRecord } from "./calls";
import { listPersonas } from "./personas";
import * as fs from "fs";
import * as path from "path";

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: getConfig().openaiApiKey });
}

function chatDebugLog(msg: string): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "error.log"),
      `[${new Date().toISOString()}] CHAT: ${msg}\n`,
      "utf-8",
    );
  } catch { /* best-effort */ }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallAction {
  type: "initiate_call";
  phoneNumber: string;
  instructions: string;
  personalContext: string;
  leaveVoicemail: boolean;
  personaId?: string;
  personaName?: string;
}

export interface CreateProjectAction {
  type: "create_project";
  name: string;
  description: string;
  strategy: string;
  tags: string[];
}

export type ChatAction = CallAction | CreateProjectAction;

export interface ChatResult {
  response: string;
  action?: ChatAction;
}

// Conservative token budget per API call (leaves room for system prompt + history + response)
const CALL_TOKEN_BUDGET = 100_000;
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Detect aggregate/count questions at the code level — never rely on the AI
// planner for this, since it might return needsTranscripts:true and route into
// the filter which will aggressively trim the result set.
function isAggregateQuery(question: string): boolean {
  return /\b(how many|count|list all|show all|all meetings|all conversations|every meeting|every conversation|total|in total|ever|across all|all time)\b/i.test(question);
}


// ── Call intent detection ───────────────────────────────────────────────────

const CALL_KEYWORDS = /\b(call|phone|ring|dial|reach out to|give .{1,30} a call)\b/i;

// Hard exclusion: any message asking to search, summarize, or retrieve past info
// is NEVER a call request, even if it incidentally contains the word "call"
const SEARCH_INTENT = /\b(summarize|summary|summaries|bullets?|key points?|takeaways?|recap|did (?:you|u) see|what did|what were|what was said|find|search|look up|feedback|overview|highlights?|last (?:week|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|tell me about|remind me|what happened|review|from (?:last|the) (?:week|meeting|chat|call|conversation))\b/i;

function callRecordBlock(record: CallRecord): string {
  const date = new Date(record.createdAt).toLocaleString();
  const status = record.completed ? "✓ Completed" : record.status === "ended" ? "Ended" : record.status;
  const lines = [
    `## ${date} — Call to ${record.phoneNumber} — ${status}`,
    `Goal: ${record.instructions}`,
  ];
  if (record.personalContext) lines.push(`Context: ${record.personalContext}`);
  if (record.summary) lines.push(`Summary: ${record.summary}`);
  if (record.transcript) lines.push(`Transcript:\n${record.transcript.slice(0, 600)}`);
  lines.push("---");
  return lines.join("\n");
}

function searchCallsByTerms(terms: string[]): CallRecord[] {
  const all = listCallRecords();
  if (terms.length === 0) return all.slice(0, 10);
  return all
    .map(c => {
      const text = [c.instructions, c.personalContext ?? "", c.summary ?? "", c.transcript ?? "", c.phoneNumber]
        .join(" ").toLowerCase();
      const score = terms.reduce((s, t) => s + (text.includes(t.toLowerCase()) ? 1 : 0), 0);
      return { c, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ c }) => c);
}

type CallIntentResult =
  | { isCall: false }
  | { isCall: true; action: CallAction }
  | { isCall: true; clarifyingQuestion: string };

async function detectCallIntent(
  question: string,
  history: ChatMessage[],
  openai: OpenAI,
): Promise<CallIntentResult> {
  // Hard exclusion: search/summary queries are never calls
  if (SEARCH_INTENT.test(question) && !CALL_KEYWORDS.test(question)) return { isCall: false };

  // Quick bail-out: no explicit call keyword
  // The botAskedForNumber bypass is intentionally removed — it caused false positives
  // where summarization queries triggered call detection because a prior message
  // happened to mention a phone number. Now we require an explicit call verb.
  if (!CALL_KEYWORDS.test(question)) return { isCall: false };

  chatDebugLog(`detectCallIntent: triggered for "${question.slice(0, 80)}"`);

  const recentHistory = history.slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

  // Gather context — all best-effort, never let errors abort call detection
  let profileText = "";
  let callHistoryText = "(no call history yet)";
  let personasText = "";

  try { profileText = getProfileAsText(); } catch { /* ignore */ }

  try {
    const recentCalls = listCallRecords().slice(0, 12);
    if (recentCalls.length > 0) {
      callHistoryText = recentCalls.map((c, i) => {
        const date = new Date(c.createdAt).toLocaleDateString();
        const status = c.completed ? "completed" : c.status === "ended" ? "ended" : c.status;
        return `[${i + 1}] ${date} → ${c.phoneNumber}: "${c.instructions.slice(0, 120)}" — ${status}`;
      }).join("\n");
    }
  } catch { /* ignore */ }

  try {
    const personas = listPersonas();
    if (personas.length > 0) {
      personasText = `\n## Available personas (the user may reference these by name)\n${personas.map(p => `- "${p.name}" → id: ${p.id}`).join("\n")}\n`;
    }
  } catch { /* ignore */ }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a call intent detector for an app that can place AI-powered phone calls on the user's behalf.
Determine if this message is a request to place a phone call.
${profileText ? `\n## Known facts about the user\n${profileText}\n` : ""}${personasText}
## Recent call history
${callHistoryText}

Rules:
- "make a call", "call X", "phone X", "give X a call", "place a call" ARE call requests
- Resolve contacts by relationship ("my wife") or name using the known facts above
- When referencing a prior call ("like last time", "the call about X", "same as before"), copy that call's phoneNumber and adapt its instructions
- personaId: if the user mentions a persona by name, use its id from the available personas list; else null

Return ONLY valid JSON, no other text:
{
  "isCallRequest": true | false,
  "phoneNumber": "+1XXXXXXXXXX" | null,
  "instructions": "GOAL + APPROACH — what the AI must accomplish AND key points on how to do it. Write this as guidance for the AI caller, NOT as a script to read aloud. Example: 'Goal: Convince the person to reschedule the meeting to next week. Approach: Be friendly and understanding, acknowledge inconvenience, suggest Tuesday or Wednesday as alternatives, confirm they will get a calendar invite.' Another example: 'Goal: Make the person feel appreciated and have a good day. Approach: Call as a warm check-in, express genuine appreciation for who they are, ask how they are doing, offer support if they need anything — keep it brief and sincere, do not just read compliments.' The AI will speak naturally from this guidance — never write a pre-written script." | null,
  "personalContext": "any background info the AI should know (names, account details, history, relationship context)" | null,
  "leaveVoicemail": true | false,
  "personaId": "persona-uuid" | null,
  "personaName": "Persona Name" | null,
  "clarifyingQuestion": "ask this if a required field is missing" | null
}`,
        },
        {
          role: "user",
          content: `${recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : ""}User message: "${question}"`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const raw = completion.choices[0].message.content ?? "{}";
    chatDebugLog(`detectCallIntent: GPT raw = ${raw.slice(0, 200)}`);
    const p = JSON.parse(raw);

    if (!p.isCallRequest) return { isCall: false };

    if (!p.phoneNumber || !p.instructions) {
      const q = p.clarifyingQuestion || (!p.phoneNumber ? "What phone number should I call?" : "What should I say or do on the call?");
      chatDebugLog(`detectCallIntent: missing fields, asking: ${q}`);
      return { isCall: true, clarifyingQuestion: q };
    }

    chatDebugLog(`detectCallIntent: action → ${p.phoneNumber} | "${p.instructions?.slice(0, 60)}"`);
    return {
      isCall: true,
      action: {
        type: "initiate_call",
        phoneNumber: p.phoneNumber,
        instructions: p.instructions,
        personalContext: p.personalContext || "",
        leaveVoicemail: p.leaveVoicemail ?? false,
        personaId: p.personaId || undefined,
        personaName: p.personaName || undefined,
      },
    };
  } catch (err: any) {
    chatDebugLog(`detectCallIntent: error = ${err?.message}`);
    return { isCall: false };
  }
}

// ── Project intent detection ───────────────────────────────────────────────

const PROJECT_KEYWORDS = /\b(create|add|new|start|set up|make)\s+(?:a\s+)?project\b/i;

async function detectProjectIntent(
  question: string,
  openai: OpenAI,
): Promise<{ isProject: false } | { isProject: true; action: CreateProjectAction }> {
  if (!PROJECT_KEYWORDS.test(question)) return { isProject: false };

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Determine if the user is asking to create a project in a workflow manager.
Return JSON:
{
  "isProjectRequest": true | false,
  "name": "project name" | null,
  "description": "what this project is about" | null,
  "strategy": "first-person notes on approach, contacts, goals (1-3 sentences)" | null,
  "tags": ["tag1", "tag2"] or []
}`,
        },
        { role: "user", content: question },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const p = JSON.parse(completion.choices[0].message.content ?? "{}");
    if (!p.isProjectRequest || !p.name) return { isProject: false };

    return {
      isProject: true,
      action: {
        type: "create_project",
        name: p.name,
        description: p.description || "",
        strategy: p.strategy || "",
        tags: Array.isArray(p.tags) ? p.tags : [],
      },
    };
  } catch {
    return { isProject: false };
  }
}

// ── Phase 1: AI query planner ──────────────────────────────────────────────

interface SearchPlan {
  people: string[];
  topics: string[];
  keywords: string[];
  needsTranscripts: boolean;
  explanation: string;
}

async function planSearch(
  question: string,
  history: ChatMessage[],
  openai: OpenAI,
): Promise<SearchPlan> {
  const recentHistory = history.slice(-4).map(m => `${m.role}: ${m.content}`).join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Analyze a question about a meeting transcript library and extract a search plan.
Return JSON:
- people: names to find (e.g. ["Jack", "Jack Smith"]). Include first + last names separately.
- topics: subjects/themes (e.g. ["product roadmap", "hiring"])
- keywords: other search terms (e.g. ["deadline", "Q3"])
- needsTranscripts: true only if the answer requires reading actual spoken text (specific quotes, detailed narrative). False for counts, lists, who attended, topic summaries.
- explanation: one sentence describing what to find`,
      },
      {
        role: "user",
        content: `${recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : ""}Question: "${question}"`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  try {
    const p = JSON.parse(completion.choices[0].message.content!);
    return {
      people: p.people ?? [],
      topics: p.topics ?? [],
      keywords: p.keywords ?? [],
      needsTranscripts: p.needsTranscripts ?? true,
      explanation: p.explanation ?? question,
    };
  } catch {
    return { people: [], topics: [], keywords: [], needsTranscripts: true, explanation: question };
  }
}

// ── Phase 2: Local metadata scan ───────────────────────────────────────────

function searchTranscriptFullText(terms: string[], metas: ConversationMeta[]): ConversationMeta[] {
  const convsDir = path.join(getConfig().dataDir, "conversations");
  const scored = metas.map(meta => {
    let score = 0;
    try {
      const transcriptPath = path.join(convsDir, meta.id, "transcript.txt");
      if (fs.existsSync(transcriptPath)) {
        const text = fs.readFileSync(transcriptPath, "utf-8").toLowerCase();
        for (const term of terms) {
          if (text.includes(term)) score += 2;
        }
      }
    } catch { /* best-effort */ }
    return { meta, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ meta }) => meta);
  return scored;
}

function searchByPlan(plan: SearchPlan): ConversationMeta[] {
  const all = getAllConversationMeta();

  // Combine all search terms regardless of how the planner categorized them
  const allTerms = [
    ...plan.people.flatMap(p => p.toLowerCase().split(/\s+/)),
    ...plan.topics.flatMap(t => t.toLowerCase().split(/\s+/)),
    ...plan.keywords.map(k => k.toLowerCase()),
  ].filter(t => t.length > 1);

  if (allTerms.length === 0) return all;

  const metaMatches = all.map(meta => {
    let score = 0;
    for (const term of allTerms) {
      // Always check speakers and peopleMentioned — don't rely on the planner
      // correctly categorizing names into plan.people vs plan.keywords
      if (meta.speakers.some(s => s.toLowerCase().includes(term))) score += 20;
      if (meta.peopleMentioned.some(p => p.toLowerCase().includes(term))) score += 15;
      if (meta.companiesMentioned.some(c => c.toLowerCase().includes(term))) score += 12;
      if (meta.title.toLowerCase().includes(term)) score += 10;
      if (meta.topics.some(t => t.toLowerCase().includes(term))) score += 6;
      if (meta.keywords.some(k => k.toLowerCase().includes(term))) score += 5;
      if (meta.summary.toLowerCase().includes(term)) score += 3;
      if (meta.decisions.some(d => d.toLowerCase().includes(term))) score += 2;
    }
    return { meta, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ meta }) => meta);

  // If metadata search found nothing, fall back to full-text transcript search.
  // This catches terms (acronyms, company codes, etc.) that the tagger didn't extract.
  if (metaMatches.length === 0) {
    chatDebugLog(`searchByPlan: no metadata matches, trying full-text transcript search for: ${JSON.stringify(allTerms)}`);
    return searchTranscriptFullText(allTerms, all);
  }

  return metaMatches;
}

// ── Phase 3: AI relevance filter ───────────────────────────────────────────

async function filterToRelevant(
  metas: ConversationMeta[],
  question: string,
  plan: SearchPlan,
  openai: OpenAI,
): Promise<ConversationMeta[]> {
  if (metas.length <= 12) return metas;

  // No hard cap — send all candidates so we don't silently drop matches.
  // Summaries are compact (~50 tokens each), so 300 candidates = ~15k tokens.
  const candidates = metas;
  const summaries = candidates.map((m, i) =>
    `[${i}] ${m.title} (${m.date}) | Speakers: ${m.speakers.join(", ")} | People: ${m.peopleMentioned.join(", ")} | ${m.summary}`
  ).join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Review meeting summaries and identify which are relevant to the question.
Return JSON: {"relevant": [0, 3, 7, ...]} — indices of relevant meetings.
Be inclusive. Searching for: ${plan.explanation}`,
      },
      { role: "user", content: `Question: "${question}"\n\nMeetings:\n${summaries}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  try {
    const result = JSON.parse(completion.choices[0].message.content!);
    const indices: number[] = result.relevant ?? result.indices ?? [];
    const filtered = indices.map(i => candidates[i]).filter(Boolean);
    return filtered.length > 0 ? filtered : candidates.slice(0, 20);
  } catch {
    return candidates.slice(0, 20);
  }
}

// ── Context block builders ──────────────────────────────────────────────────

type LoadedConv = { meta: ConversationMeta; transcript: string };

function metaBlock(meta: ConversationMeta): string {
  return `## ${meta.title} (${meta.date})
Speakers: ${meta.speakers.join(", ")} | Duration: ${meta.durationMinutes} min | Type: ${meta.meetingType}
People mentioned: ${meta.peopleMentioned.join(", ")}
Summary: ${meta.summary}
Topics: ${meta.topics.join(", ")}
Decisions: ${meta.decisions.join("; ")}
---`;
}

function fullBlock(meta: ConversationMeta, transcript: string): string {
  return `## ${meta.title} (${meta.date})
Speakers: ${meta.speakers.join(", ")} | Duration: ${meta.durationMinutes} min
People mentioned: ${meta.peopleMentioned.join(", ")}
Summary: ${meta.summary}

**Transcript:**
${transcript}
---`;
}

function convTokens(conv: LoadedConv, withTranscript: boolean): number {
  return estimateTokens(withTranscript
    ? fullBlock(conv.meta, conv.transcript)
    : metaBlock(conv.meta));
}

// ── Token-aware batch grouping ──────────────────────────────────────────────
// Groups conversations into batches where each batch fits within CALL_TOKEN_BUDGET.
// Never truncates — just splits into more batches if needed.

function groupIntoBatches(convs: LoadedConv[], withTranscripts: boolean): LoadedConv[][] {
  const overhead = 2000; // system prompt + question + response buffer
  const budget = CALL_TOKEN_BUDGET - overhead;

  const batches: LoadedConv[][] = [];
  let current: LoadedConv[] = [];
  let currentTokens = 0;

  for (const conv of convs) {
    const tokens = convTokens(conv, withTranscripts);

    if (currentTokens + tokens > budget && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(conv);
    currentTokens += tokens;
  }

  if (current.length > 0) batches.push(current);
  return batches.length > 0 ? batches : [[]];
}

// ── Map-reduce ──────────────────────────────────────────────────────────────
// For each batch: gpt-4o-mini extracts all relevant findings.
// Final call: gpt-4o synthesizes everything into the answer (streamed).

async function mapReduce(
  convs: LoadedConv[],
  question: string,
  plan: SearchPlan,
  aggregate: boolean,
  history: ChatMessage[],
  openai: OpenAI,
  callsContext: string,
  onDelta: ((delta: string) => void) | undefined,
): Promise<string> {
  const useTranscripts = plan.needsTranscripts && !aggregate;
  const batches = groupIntoBatches(convs, useTranscripts);

  // MAP: extract findings from each batch in parallel where possible
  const findingsPromises = batches.map(async (batch, i) => {
    const context = useTranscripts
      ? batch.map(c => fullBlock(c.meta, c.transcript)).join("\n\n")
      : batch.map(c => metaBlock(c.meta)).join("\n\n");

    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are extracting information from a batch of meeting records to help answer a question.
Question: "${question}"
Context: ${plan.explanation}

Extract ALL relevant information from these conversations:
- Names, dates, who was present
- Relevant quotes or statements (if transcripts provided)
- Relevant decisions or outcomes
- Counts and patterns
Be thorough. This is batch ${i + 1} of ${batches.length} — your findings will be combined with other batches.`,
        },
        { role: "user", content: context },
      ],
      temperature: 0,
      max_tokens: 1500,
    });

    const content = result.choices[0].message.content ?? "";
    return `=== Batch ${i + 1}/${batches.length}: ${batch.length} conversations (${batch.map(c => c.meta.title).slice(0, 3).join(", ")}${batch.length > 3 ? "..." : ""}) ===\n${content}`;
  });

  // Run batches — process sequentially to avoid overwhelming the API
  const findings: string[] = [];
  for (const p of findingsPromises) {
    findings.push(await p);
  }

  // REDUCE: synthesize all findings into final answer (streamed)
  const systemWithDataDir = SYSTEM_PROMPT.replace("{{DATA_DIR}}", getConfig().dataDir);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemWithDataDir}

You have analyzed ALL ${convs.length} conversations across ${batches.length} batches.
Do NOT mention batches in your answer — give a direct, complete answer based on the findings below.${aggregate ? `\nIMPORTANT: These ${convs.length} conversations are the complete result set. Count every one listed — do not refilter based on your own judgment.` : ""}
${callsContext ? `\n# Call records\n${callsContext}` : ""}
# Complete findings from all ${convs.length} conversations
${findings.join("\n\n")}`,
    },
    ...history.map(m => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
    { role: "user", content: question },
  ];

  let fullResponse = "";
  const stream = await openai.chat.completions.create({
    model: getConfig().openaiModel,
    messages,
    temperature: 0.3,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    fullResponse += delta;
    onDelta?.(delta);
  }

  return fullResponse;
}

// ── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are SecondBrain, an AI assistant embedded in a desktop app that stores and searches the user's Otter.ai meeting transcripts. You can also help place phone calls.

## How to answer questions
- Reference specific meetings by title and date
- Quote relevant transcript excerpts when helpful
- Synthesize patterns across multiple meetings when asked
- Be direct and concise — answer the question, don't pad
- When counting conversations, be exact based only on what's provided
- If information isn't in the provided context, say so clearly

## Phone calls
- If the user asks you to make a call, extract the phone number, instructions, and any personal context
- If you don't have enough info, ask for it before proceeding

Data directory: {{DATA_DIR}}`;

// ── Main chat function ──────────────────────────────────────────────────────

export async function chat(
  question: string,
  history: ChatMessage[],
  onDelta?: (delta: string) => void,
): Promise<ChatResult> {
  const openai = getOpenAI();
  const config = getConfig();

  // Background: learn about the user from what they said
  extractAndLearnFromMessage(question, config.openaiApiKey).catch(() => {});

  // Phase 0a: Check for project creation intent
  const projectIntent = await detectProjectIntent(question, openai);
  if (projectIntent.isProject) {
    const { name, description } = projectIntent.action;
    const msg = `Ready to create project **${name}**${description ? `: ${description}` : ""}. Confirm to add it to your Projects tab.`;
    onDelta?.(msg);
    return { response: msg, action: projectIntent.action };
  }

  // Phase 0b: Check for call intent — skip entirely for obvious search/summary queries
  const callIntent = (SEARCH_INTENT.test(question) && !CALL_KEYWORDS.test(question))
    ? ({ isCall: false } as const)
    : await detectCallIntent(question, history, openai);
  if (callIntent.isCall) {
    if ("clarifyingQuestion" in callIntent) {
      onDelta?.(callIntent.clarifyingQuestion);
      return { response: callIntent.clarifyingQuestion };
    }
    if ("action" in callIntent) {
      const { phoneNumber, instructions, leaveVoicemail } = callIntent.action;
      const vmNote = leaveVoicemail ? " (will leave voicemail if no answer)" : "";
      const msg = `Ready to call **${phoneNumber}**${vmNote}.\n\nI'll say: ${instructions}`;
      onDelta?.(msg);
      return { response: msg, action: callIntent.action };
    }
  }

  // Phase 1: Understand what to search for
  const plan = await planSearch(question, history, openai);
  chatDebugLog(`Question: "${question}" | Plan: people=${JSON.stringify(plan.people)} topics=${JSON.stringify(plan.topics)} keywords=${JSON.stringify(plan.keywords)} needsTranscripts=${plan.needsTranscripts}`);

  // Phase 2: Scan ALL metadata locally — no cap
  let matchedMetas = searchByPlan(plan);
  chatDebugLog(`searchByPlan returned ${matchedMetas.length} of ${getAllConversationMeta().length} total`);

  // Also search call records by the same terms
  const callTerms = [...plan.people, ...plan.keywords, ...plan.topics].map(t => t.toLowerCase());
  const relevantCalls = searchCallsByTerms(callTerms);
  const callsContext = relevantCalls.length > 0
    ? relevantCalls.map(callRecordBlock).join("\n")
    : "";

  // Phase 3: Decide how to handle the match set
  const aggregate = isAggregateQuery(question);
  chatDebugLog(`isAggregateQuery=${aggregate}`);
  let relevantMetas: ConversationMeta[];

  if (matchedMetas.length === 0) {
    // Nothing matched — fall back to recent conversations
    relevantMetas = getAllConversationMeta().slice(0, 15);
    chatDebugLog(`No matches, falling back to 15 recent`);
  } else if (aggregate || !plan.needsTranscripts) {
    // Count/list/aggregate query: NEVER filter — pass every local match.
    // Metadata is ~150 tokens each; 300 matches = ~45k tokens, well within budget.
    // Any filtering here causes undercounting and wrong answers.
    relevantMetas = matchedMetas;
    chatDebugLog(`Aggregate or no-transcript: passing all ${matchedMetas.length} matches`);
  } else if (matchedMetas.length > 12) {
    // Detail/transcript query: AI-filter to find the most relevant to read deeply.
    relevantMetas = await filterToRelevant(matchedMetas, question, plan, openai);
    chatDebugLog(`AI-filtered to ${relevantMetas.length} from ${matchedMetas.length}`);
  } else {
    relevantMetas = matchedMetas;
    chatDebugLog(`Small set, using all ${matchedMetas.length}`);
  }

  // Phase 4: Load conversations
  const convs = relevantMetas
    .map(meta => loadConversation(meta.id))
    .filter(Boolean) as LoadedConv[];

  chatDebugLog(`Loaded ${convs.length} conversations (${relevantMetas.length - convs.length} failed to load)`);

  if (convs.length === 0) {
    // No conversations — just answer directly (but still include call records if any)
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT.replace("{{DATA_DIR}}", config.dataDir) +
          "\n\nNo meeting conversations are imported yet. Tell the user to import some from the Import page." +
          (callsContext ? `\n\n# Call records\n${callsContext}` : ""),
      },
      ...history.map(m => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: "user", content: question },
    ];
    let resp = "";
    const stream = await openai.chat.completions.create({ model: config.openaiModel, messages, temperature: 0.3, stream: true });
    for await (const chunk of stream) { const d = chunk.choices[0]?.delta?.content || ""; resp += d; onDelta?.(d); }
    return { response: resp };
  }

  // For aggregate queries, always use metadata-only — we need all matches to fit
  // in one call and the model must count every one without refiltering.
  const useTranscripts = plan.needsTranscripts && !aggregate;

  // Phase 5: Check if everything fits in a single call
  const totalTokens = convs.reduce((sum, c) => sum + convTokens(c, useTranscripts), 0);
  const overhead = 3000; // system + history + question

  if (totalTokens + overhead <= CALL_TOKEN_BUDGET) {
    // Everything fits — single call, full fidelity
    const context = useTranscripts
      ? convs.map(c => fullBlock(c.meta, c.transcript)).join("\n\n")
      : convs.map(c => metaBlock(c.meta)).join("\n\n");

    const aggregateInstruction = aggregate
      ? `\n\nIMPORTANT: The ${convs.length} conversations below are ALL the matches from a complete scan of ${getAllConversationMeta().length} total conversations. Count or list based strictly on what is shown — do not apply your own filtering or judgment about who "really" attended.`
      : "";

    const systemWithDataDir = SYSTEM_PROMPT.replace("{{DATA_DIR}}", config.dataDir);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${systemWithDataDir}${aggregateInstruction}\n\n# Matched conversations (${convs.length} of ${getAllConversationMeta().length} total)\nSearch context: ${plan.explanation}\n\n${context}${callsContext ? `\n\n# Call records\n${callsContext}` : ""}`,
      },
      ...history.map(m => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: "user", content: question },
    ];

    let fullResponse = "";
    const stream = await openai.chat.completions.create({
      model: config.openaiModel,
      messages,
      temperature: 0.3,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      fullResponse += delta;
      onDelta?.(delta);
    }

    return { response: fullResponse };
  }

  // Phase 5b: Too large for one call — map-reduce across batches
  // Every conversation is fully processed, nothing dropped
  return { response: await mapReduce(convs, question, plan, aggregate, history, openai, callsContext, onDelta) };
}
