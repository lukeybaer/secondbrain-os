import * as fs from "fs";
import * as path from "path";
import { getConfig } from "./config";
import { listPersonas } from "./personas";
import { getAgentMemory } from "./agent-memory";
import { createApproval, createReputationEvent } from "./database-sqlite";
import { sendApprovalRequest, sendMessage } from "./telegram";

async function detectCompletion(instructions: string, transcript: string): Promise<boolean> {
  const config = getConfig();
  if (!config.openaiApiKey || !transcript.trim()) return false;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You determine if a phone call achieved its goal. Reply with only the JSON: {\"completed\": true} or {\"completed\": false}." },
          { role: "user", content: `Goal: ${instructions.trim()}\n\nTranscript:\n${transcript.trim()}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 20,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const result = JSON.parse(data.choices[0]?.message?.content ?? "{}");
    return result.completed === true;
  } catch {
    return false;
  }
}

export type CallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "forwarding"
  | "ended"
  | "error";

export interface CallRecord {
  id: string;
  createdAt: string;
  phoneNumber: string;
  instructions: string;
  personalContext: string;
  personaId?: string;
  leaveVoicemail?: boolean;
  completed?: boolean;      // true = goal was accomplished
  isCallback?: boolean;     // true = inbound call received on Vapi number
  status: CallStatus;
  listenUrl?: string;
  endedReason?: string;
  transcript?: string;
  summary?: string;
  durationSeconds?: number;
}

function getCallsDir(): string {
  return path.join(getConfig().dataDir, "calls");
}

function ensureCallsDir(): void {
  const dir = getCallsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveCallRecord(record: CallRecord): void {
  ensureCallsDir();
  fs.writeFileSync(
    path.join(getCallsDir(), `${record.id}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
}

export function loadCallRecord(callId: string): CallRecord | null {
  const file = path.join(getCallsDir(), `${callId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as CallRecord;
  } catch {
    return null;
  }
}

export function listCallRecords(): CallRecord[] {
  ensureCallsDir();
  const dir = getCallsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as CallRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is CallRecord => r !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function buildVoicemailSection(leaveVoicemail: boolean): string {
  if (!leaveVoicemail) {
    return `\n## Answering machines & voicemail\nIf you reach voicemail or an automated greeting, hang up politely without leaving a message.`;
  }
  return `\n## Answering machines & voicemail\nIf you reach voicemail or an automated greeting, leave a brief, natural-sounding message. Do NOT recite your task or instructions. Simply say you're calling on behalf of a customer, that you'll try again, and ask them to call back if convenient. Keep it under 20 seconds. Then hang up.`;
}

async function buildSystemPrompt(
  instructions: string,
  personalContext: string,
  leaveVoicemail: boolean,
  personaInstructions?: string,
): Promise<string> {
  const contextSection = personalContext.trim()
    ? `\n## Personal context you may use\n${personalContext.trim()}\n`
    : "";

  let base: string;
  if (personaInstructions?.trim()) {
    // When a persona is set, it owns the voicemail instructions — don't override with generic text.
    base = `${personaInstructions.trim()}

## Your goal for this call
${instructions.trim()}
${contextSection}
## How to handle this call
- Speak naturally — do NOT read the goal as a script or monologue. Have a real conversation.
- The goal above tells you WHAT to accomplish. HOW you get there is up to you — be human, adapt, listen.
- If they seem busy or distracted, be brief. If they want to chat, engage warmly.
- Stay in character throughout.
## Ending the call
- When the goal is accomplished (or clearly can't be), wrap up warmly and say goodbye.
- Don't drag it out once the purpose is fulfilled.`;
  } else {
    base = `You are a helpful AI assistant making a phone call on behalf of the user.

## Your goal for this call
${instructions.trim()}
${contextSection}
## How to handle this call
- Speak naturally — do NOT read the goal as a script or monologue. Have a real conversation.
- The goal above tells you WHAT to accomplish. HOW you get there is up to you — listen, adapt, be genuine.
- If asked who you are, say you're calling on behalf of a customer.
- Do NOT reveal that you are an AI unless directly and sincerely asked.
${buildVoicemailSection(leaveVoicemail)}
## Ending the call
- When the goal is accomplished (or clearly can't be), wrap up politely and say goodbye.`;
  }

  // Inject EA agent memory for pre-call context
  try {
    const ea = getAgentMemory("ea");
    return await ea.buildSystemPrompt(base, { maxMemoryChars: 2500 });
  } catch {
    return base;
  }
}

function buildFirstMessage(hasPersona: boolean): string {
  // If a persona is set, return empty string so Vapi generates the opener
  // from the system prompt (which contains the full persona instructions).
  // A literal firstMessage is spoken verbatim before the AI reads the system
  // prompt, so persona greeting instructions are ignored when it's set.
  if (hasPersona) return "";
  return "Hello, is this a good time to talk?";
}

export async function initiateCall(
  phoneNumber: string,
  instructions: string,
  personalContext: string,
  personaId?: string,
  leaveVoicemail?: boolean,
): Promise<{ success: boolean; callId?: string; listenUrl?: string; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey || !config.vapiPhoneNumberId) {
    return { success: false, error: "Vapi API key and Phone Number ID are required. Add them in Settings." };
  }

  const personaInstructions = personaId
    ? listPersonas().find((p) => p.id === personaId)?.instructions
    : undefined;

  const systemPrompt = await buildSystemPrompt(instructions, personalContext, leaveVoicemail ?? false, personaInstructions);

  const body = {
    phoneNumberId: config.vapiPhoneNumberId,
    customer: { number: normalizePhone(phoneNumber) },
    assistant: {
      model: {
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }],
      },
      voice: { provider: "11labs", voiceId: "paula" },
      firstMessage: buildFirstMessage(!!personaInstructions),
      endCallPhrases: ["goodbye", "thank you, bye", "have a great day", "bye bye"],
    },
  };

  let res: Response;
  try {
    res = await fetch("https://api.vapi.ai/call/phone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.vapiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return { success: false, error: `Network error: ${err.message}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { success: false, error: `Invalid response from Vapi (HTTP ${res.status})` };
  }

  if (!res.ok) {
    return { success: false, error: data?.message ?? `Vapi error (HTTP ${res.status})` };
  }

  const listenUrl = data?.monitor?.listenUrl as string | undefined;

  const record: CallRecord = {
    id: data.id,
    createdAt: new Date().toISOString(),
    phoneNumber: normalizePhone(phoneNumber),
    instructions,
    personalContext,
    personaId: personaId || undefined,
    leaveVoicemail: leaveVoicemail ?? false,
    status: (data.status as CallStatus) ?? "queued",
    listenUrl,
  };
  saveCallRecord(record);

  return { success: true, callId: data.id, listenUrl };
}

export async function refreshCallStatus(
  callId: string,
): Promise<{ success: boolean; record?: CallRecord; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey) {
    return { success: false, error: "Vapi API key not configured." };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
  } catch (err: any) {
    return { success: false, error: `Network error: ${err.message}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { success: false, error: `Invalid response from Vapi (HTTP ${res.status})` };
  }

  if (!res.ok) {
    return { success: false, error: data?.message ?? `Vapi error (HTTP ${res.status})` };
  }

  const existing = loadCallRecord(callId);
  if (!existing) return { success: false, error: "Call record not found locally." };

  let durationSeconds: number | undefined;
  if (data.startedAt && data.endedAt) {
    durationSeconds = Math.round(
      (new Date(data.endedAt).getTime() - new Date(data.startedAt).getTime()) / 1000,
    );
  }

  const transcript = data.transcript ?? existing.transcript;
  const justEnded = data.status === "ended" && existing.status !== "ended";

  const updated: CallRecord = {
    ...existing,
    status: (data.status as CallStatus) ?? existing.status,
    endedReason: data.endedReason ?? existing.endedReason,
    transcript,
    summary: data.summary ?? existing.summary,
    durationSeconds: durationSeconds ?? existing.durationSeconds,
    listenUrl: data.status === "ended" ? undefined : existing.listenUrl,
  };
  saveCallRecord(updated);

  // Auto-detect completion and always sync the callback assistant when a call finishes
  if (justEnded) {
    if (transcript && existing.completed === undefined) {
      detectCompletion(existing.instructions, transcript).then((completed) => {
        const fresh = loadCallRecord(updated.id);
        if (fresh && fresh.completed === undefined) {
          saveCallRecord({ ...fresh, completed });
        }
        // Always update callback assistant so it has latest context for this number
        syncCallbackAssistant(existing.phoneNumber);
      });
    } else {
      // No transcript to analyze — still sync so callback assistant is up to date
      syncCallbackAssistant(existing.phoneNumber);
    }
  }

  return { success: true, record: updated };
}

export async function hangUpCall(callId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey) return { success: false, error: "Vapi API key not configured." };
  try {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    return { success: res.ok };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function markCallCompleted(callId: string, completed: boolean): CallRecord | null {
  const record = loadCallRecord(callId);
  if (!record) return null;
  const updated = { ...record, completed };
  saveCallRecord(updated);
  return updated;
}

/** Recent ended calls to a given number (both complete and incomplete), newest first. */
function recentCallsByPhone(phoneNumber: string, limit = 5): CallRecord[] {
  const normalized = phoneNumber.replace(/[^\d+]/g, "");
  return listCallRecords()
    .filter((r) => r.status === "ended" && r.phoneNumber.replace(/[^\d+]/g, "") === normalized)
    .slice(0, limit);
}

async function buildCallbackAssistantConfig(callerPhone: string): Promise<object> {
  const history = recentCallsByPhone(callerPhone);
  const incomplete = history.filter((r) => !r.completed);

  let systemPrompt: string;
  if (history.length === 0) {
    systemPrompt = `You are a helpful AI assistant receiving an inbound call. Greet the caller politely and ask how you can help them today.`;
  } else {
    const latest = history[0];
    const personaInstructions = latest.personaId
      ? listPersonas().find((p) => p.id === latest.personaId)?.instructions
      : undefined;

    // Build identity section — strip outbound-calling framing from persona instructions
    // by wrapping with an explicit inbound override so the AI doesn't announce itself
    // as if it's making a call.
    const identitySection = personaInstructions?.trim()
      ? `## Your identity (persona)\n${personaInstructions.trim()}\n\n> IMPORTANT: You are RECEIVING this call, not making it. Do NOT use language like "I'm calling on behalf of..." — answer naturally as if you picked up the phone.`
      : `You are a helpful AI assistant representing the user.`;

    const historyText = history
      .map((r, i) => {
        const date = new Date(r.createdAt).toLocaleString();
        const statusLabel = r.completed ? "✓ Completed" : "✗ Incomplete";
        const outcome = r.summary ?? (r.transcript ? "See transcript excerpt below." : "No answer / voicemail.");
        return `### Call ${i + 1} — ${date} — ${statusLabel}\nGoal: ${r.instructions.trim()}\nOutcome: ${outcome}${r.transcript ? `\nTranscript:\n${r.transcript.slice(0, 500)}` : ""}`;
      })
      .join("\n\n");

    const currentGoal = incomplete.length > 0
      ? `Continue working toward the original goal: "${incomplete[0].instructions.trim()}"`
      : `The original goal ("${latest.instructions.trim()}") was already completed. Be friendly and helpful with whatever they need.`;

    systemPrompt = `${identitySection}

## Call history with this person
${historyText}

## Your task now
${currentGoal}

## Rules
- You are receiving their call — pick up naturally, e.g. "Hey, thanks for calling back!"
- Reference the prior call context only if relevant — don't robotically repeat it
- Do NOT reveal that you are an AI unless directly and sincerely asked
- When the goal is accomplished (or the caller is satisfied), wrap up warmly and end the call`;
  }

  const firstMessage = incomplete.length > 0
    ? "Hey, thanks for calling back!"
    : history.length > 0
      ? "Hey there! Good to hear from you."
      : "Hello, how can I help you today?";

  const tools = [
    {
      type: "function",
      function: {
        name: "run_claude_code",
        description:
          "Queue a coding task for Claude Code to execute on the owner's computer. The owner will be called back when the task is complete. Use this when the owner asks you to fix a bug, add a feature, write code, or make any change to their codebase.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "A clear description of the coding task. Be specific — include file names, what to change, and expected behavior.",
            },
            priority: {
              type: "string",
              enum: ["normal", "urgent"],
              description:
                "How urgently Luke needs this done. Urgent tasks get called back immediately when done.",
            },
          },
          required: ["task"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_knowledge",
        description:
          "Search the owner's conversation history, meeting notes, and stored knowledge to answer a question during the call. Use this when the owner asks things like 'did I talk about X?', 'what did I decide about Y?', 'who did I speak with about Z?'. Tell the owner 'give me just a moment' before calling this.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to search for in the owner's knowledge base.",
            },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_approval",
        description:
          "Request the owner's approval before sharing any personal information or taking a consequential action. ALWAYS call this before: sharing the owner's address, phone number, email, or any personal/financial details. Put the caller on a brief hold while waiting ('One moment while I check on that.'). The owner will receive a Telegram notification and reply YES or NO within 60 seconds.",
        parameters: {
          type: "object",
          properties: {
            request_type: {
              type: "string",
              enum: ["share_pii", "transfer_call", "commit_to_action", "reputation_risk"],
              description: "The category of action requiring approval.",
            },
            description: {
              type: "string",
              description:
                "Plain-English description of what you're about to do, e.g. 'Share the owner's home address with the caller who is asking for a delivery location.'",
            },
            data_category: {
              type: "string",
              description:
                "The type of data being shared (home_address, phone_number, email, employer, financial, etc.)",
            },
          },
          required: ["request_type", "description"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "flag_reputation_risk",
        description:
          "Flag any statement or situation during the call that could be embarrassing, defamatory, legally risky, or misrepresent the owner's positions. Do NOT engage with the claim — flag it immediately and continue the call. Examples: caller making false accusations, AI output that could misrepresent the owner, any discussion of illegal activity.",
        parameters: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["false_statement", "legal_threat", "defamation", "misrepresentation", "illegal_activity", "other"],
              description: "The type of reputation risk.",
            },
            description: {
              type: "string",
              description: "Brief description of what was said and why it's a risk.",
            },
            severity: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
              description: "How serious the risk is.",
            },
            excerpt: {
              type: "string",
              description: "The exact quote or statement from the transcript that triggered the flag.",
            },
          },
          required: ["category", "description", "severity"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bridge_in_luke",
        description:
          "Connect the caller directly to the owner. Use this when the caller asks to speak with the owner, be transferred, be patched through, or be connected. If you don't know the caller's name, ask 'Who should I say is calling?' before invoking this. Tell the caller 'Let me get them for you — one moment' before calling this.",
        parameters: {
          type: "object",
          properties: {
            caller_name: {
              type: "string",
              description: "The caller's name. Ask first if unknown: 'Who should I say is calling?'",
            },
            topic: {
              type: "string",
              description: "One-sentence description of why the caller wants to reach Luke.",
            },
          },
          required: ["caller_name", "topic"],
        },
      },
    },
  ];

  const capabilitiesSection = `
## Coding Tasks
When the owner asks you to write code, fix a bug, or make any technical change:
- Use the run_claude_code tool immediately
- Tell the owner: "I've queued that for Claude Code. I'll call you back when it's done — usually within a few minutes."
- Then end the call gracefully

## Knowledge Queries
When the owner asks about past conversations, decisions, or contacts:
- Use query_knowledge IMMEDIATELY — don't try to answer from memory
- While it runs, tell the owner: "Give me just a moment, checking your notes..."
- When you get the result, read it naturally as part of your response
- If no result found: "I didn't find anything specific on that — want me to dig deeper?"

## Connecting Callers to the Owner (Patch-In / Bridge-In)
When a caller asks to speak with the owner, be connected, or be transferred:
- Ask their name if you don't have it: "Who should I say is calling?"
- Tell them: "Let me get them for you — one moment."
- Call bridge_in_luke IMMEDIATELY — do not hesitate or ask further questions
- Do NOT say you can't connect them — you CAN, always try

## Your Capabilities
You can:
- Make and receive calls on the owner's behalf
- Queue coding tasks and call back with results
- Search the owner's conversation history and meeting notes in real time
- Request approvals via Telegram for sensitive information sharing
- Connect callers directly to the owner via bridge-in`;

  // Inject EA agent memory into callback assistant
  let finalSystemPrompt = systemPrompt + capabilitiesSection;
  try {
    const ea = getAgentMemory("ea");
    finalSystemPrompt = await ea.buildSystemPrompt(finalSystemPrompt, { maxMemoryChars: 2000 });
  } catch { /* non-critical */ }

  return {
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: finalSystemPrompt }],
      tools,
    },
    voice: { provider: "11labs", voiceId: "paula" },
    firstMessage,
    endCallPhrases: ["goodbye", "thank you, bye", "have a great day", "bye bye"],
  };
}

/**
 * Fetch recent calls on our Vapi phone number and import any inbound callbacks
 * we don't already have records for. Runs completion detection and marks the
 * original outbound call(s) complete if the goal was achieved on the callback.
 */
export async function fetchAndSyncInboundCalls(): Promise<void> {
  const config = getConfig();
  if (!config.vapiApiKey || !config.vapiPhoneNumberId) return;

  let res: Response;
  try {
    res = await fetch(
      `https://api.vapi.ai/call?phoneNumberId=${config.vapiPhoneNumberId}&limit=20`,
      { headers: { Authorization: `Bearer ${config.vapiApiKey}` } },
    );
  } catch { return; }
  if (!res.ok) return;

  let vapiCalls: any[];
  try {
    const data = await res.json();
    vapiCalls = Array.isArray(data) ? data : (data.results ?? []);
  } catch { return; }

  for (const vc of vapiCalls) {
    if (!vc.id) continue;
    if (loadCallRecord(vc.id)) continue;          // already tracked
    if (vc.type === "outboundPhoneCall") continue; // we create these ourselves

    const callerPhone: string = vc.customer?.number ?? "";
    let durationSeconds: number | undefined;
    if (vc.startedAt && vc.endedAt) {
      durationSeconds = Math.round(
        (new Date(vc.endedAt).getTime() - new Date(vc.startedAt).getTime()) / 1000,
      );
    }

    // Inherit the goal from the most recent incomplete outbound call to this number
    const outboundHistory = listCallRecords().filter(
      (r) =>
        !r.isCallback &&
        r.status === "ended" &&
        r.phoneNumber.replace(/[^\d+]/g, "") === callerPhone.replace(/[^\d+]/g, ""),
    );
    const incompleteOutbound = outboundHistory.filter((r) => !r.completed);
    const goalRecord = incompleteOutbound[0] ?? outboundHistory[0];

    const record: CallRecord = {
      id: vc.id,
      createdAt: vc.createdAt ?? new Date().toISOString(),
      phoneNumber: callerPhone || "unknown",
      instructions: goalRecord?.instructions ?? "Inbound callback",
      personalContext: "",
      isCallback: true,
      status: (vc.status as CallStatus) ?? "ended",
      endedReason: vc.endedReason,
      transcript: vc.transcript,
      summary: vc.summary,
      durationSeconds,
    };
    saveCallRecord(record);

    // Run completion detection and propagate to original outbound calls
    if (record.status === "ended" && record.transcript && goalRecord) {
      detectCompletion(goalRecord.instructions, record.transcript).then((completed) => {
        const fresh = loadCallRecord(record.id);
        if (fresh && fresh.completed === undefined) {
          saveCallRecord({ ...fresh, completed });
        }
        if (completed) {
          // Mark all incomplete outbound calls to this number as complete
          for (const orig of incompleteOutbound) {
            const origFresh = loadCallRecord(orig.id);
            if (origFresh && !origFresh.completed) {
              saveCallRecord({ ...origFresh, completed: true });
            }
          }
          // Update callback assistant to reflect completion
          syncCallbackAssistant(callerPhone);
        }
      });
    }
  }
}

/**
 * After an incomplete call ends, update the dedicated callback Vapi assistant's system
 * prompt with the full call history so the next inbound callback gets full context.
 * The assistant is already linked to the phone number — we just update its content.
 */
/** Link the callback assistant to the current phone number (idempotent). Does NOT touch assistant content. */
export async function linkCallbackAssistantToPhoneNumber(): Promise<void> {
  const config = getConfig();
  if (!config.vapiApiKey || !config.callbackAssistantId || !config.vapiPhoneNumberId) return;
  try {
    await fetch(`https://api.vapi.ai/phone-number/${config.vapiPhoneNumberId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assistantId: config.callbackAssistantId }),
    });
  } catch {
    // Best-effort
  }
}

/** Update the callback assistant's system prompt with the latest call history for callerPhone. */
export async function syncCallbackAssistant(callerPhone: string): Promise<void> {
  const config = getConfig();
  if (!config.vapiApiKey || !config.callbackAssistantId) return;

  const assistantBody = await buildCallbackAssistantConfig(callerPhone);
  try {
    await fetch(`https://api.vapi.ai/assistant/${config.callbackAssistantId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(assistantBody),
    });
  } catch {
    // Best-effort — don't throw
  }

  // Keep phone number linked in case it changed in settings
  await linkCallbackAssistantToPhoneNumber();
}

/**
 * Handle a Vapi function-call webhook for the callback assistant.
 * Returns the result object to send back to Vapi, or null if the
 * function name is not recognised.
 */
export async function handleVapiFunctionCall(
  functionName: string,
  parameters: Record<string, any>,
): Promise<{ result: string } | null> {
  const ec2Url = getConfig().ec2BaseUrl;
  if (!ec2Url) return null; // Backend URL not configured — set in Settings

  if (functionName === "run_claude_code") {
    const task: string = parameters.task;
    // Fire-and-forget POST to /commands
    fetch(`${ec2Url}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "claude",
        prompt: task,
        replyTo: "vapi",
        replyPhone: getConfig().vapiPhoneNumberId,
      }),
    }).catch(console.error);
    return { result: "Task queued. Luke will be called back when complete." };
  }

  if (functionName === "query_knowledge") {
    const question: string = parameters.question;
    let queryId: string;
    try {
      const resp = await fetch(`${ec2Url}/queries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await resp.json();
      queryId = data.id;
    } catch (err: any) {
      return { result: "I had trouble reaching the knowledge base right now. I'll send you the answer on Telegram." };
    }

    // Poll up to 20s for an answer
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => setTimeout(r, 1000));
      try {
        const statusResp = await fetch(`${ec2Url}/queries/${queryId}`);
        const status = await statusResp.json();
        if (status.answer) return { result: status.answer };
      } catch {
        // keep polling
      }
    }
    return { result: "I checked your notes but couldn't retrieve an answer in time. I'll send you the result on Telegram." };
  }

  if (functionName === "request_approval") {
    const approvalId = `appr_${Date.now()}`;
    const now = new Date().toISOString();
    const config = getConfig();

    createApproval({
      id: approvalId,
      request_type: (parameters.request_type as any) ?? "commit_to_action",
      description: parameters.description ?? "EA requesting approval",
      data_category: parameters.data_category,
      created_at: now,
    });

    if (config.telegramChatId) {
      // Build PendingApproval shape for sendApprovalRequest
      const approval = {
        id: approvalId,
        request_type: (parameters.request_type as any) ?? "commit_to_action",
        description: parameters.description ?? "EA requesting approval",
        data_category: parameters.data_category,
        created_at: now,
        status: "pending" as const,
      };

      let resolved: { approved: boolean } | null = null;

      await new Promise<void>((resolve) => {
        sendApprovalRequest(config.telegramChatId!, {
          ...approval,
          resolve: (r) => { resolved = r; resolve(); },
        }).catch(() => resolve());

        // Timeout after 55s — Vapi holds the function call for up to 60s
        setTimeout(() => resolve(), 55_000);
      });

      if (resolved?.approved) {
        return { result: "Approved by Luke. You may share the requested information." };
      }
      return { result: "Luke declined. Do not share that information. Let the caller know it's not available." };
    }

    return { result: "Approval system not configured. Cannot share sensitive information." };
  }

  if (functionName === "bridge_in_luke") {
    const callerName: string = parameters.caller_name ?? "someone";
    const topic: string = parameters.topic ?? "unknown topic";
    // We don't have the live call ID here, so use a placeholder — the bridge session
    // tracking in initiateBridgeIn handles the outbound dial to Luke's private SIM.
    const callerPhone: string = parameters.caller_phone ?? "";
    try {
      const result = await initiateBridgeIn(
        parameters.live_call_id ?? "unknown",
        callerPhone,
        callerName,
        topic,
      );
      if (result.success) {
        return { result: `Calling Luke now — ${callerName}, please hold while I connect you.` };
      }
      return { result: `I wasn't able to reach Luke right now (${result.error ?? "unavailable"}). I'll let him know you called.` };
    } catch (err: any) {
      return { result: "I had trouble connecting to Luke. I'll pass along your message." };
    }
  }

  if (functionName === "flag_reputation_risk") {
    const eventId = `rep_${Date.now()}`;
    createReputationEvent({
      id: eventId,
      flagged_at: new Date().toISOString(),
      category: parameters.category ?? "other",
      description: parameters.description ?? "Reputation risk flagged",
      severity: parameters.severity ?? "medium",
      transcript_excerpt: parameters.excerpt,
    });

    const config = getConfig();
    if (config.telegramChatId) {
      sendMessage(
        config.telegramChatId,
        `⚠️ REPUTATION RISK\nCategory: ${parameters.category}\nSeverity: ${parameters.severity}\n${parameters.description}`,
      ).catch(() => undefined);
    }

    return { result: "Flagged and logged. Continue the call normally." };
  }

  return null;
}

// ── Bridge-In (Epic 11) ───────────────────────────────────────────────────────

export interface BridgeSession {
  id: string;
  live_call_id: string;       // Vapi call ID of the caller on hold
  caller_phone: string;
  bridge_call_id?: string;    // Vapi call ID to Luke's private SIM
  status: "pending" | "bridging" | "connected" | "declined" | "failed";
  created_at: string;
  connected_at?: string;
}

// In-memory bridge sessions (short-lived — only active during a call)
const activeBridgeSessions = new Map<string, BridgeSession>();

/**
 * Initiate bridge-in: put caller on hold, call Luke's private SIM,
 * ask if he wants to be connected. If YES → conference. If NO → EA resumes.
 *
 * Flow:
 *   1. EA puts caller on hold via Vapi transfer to hold room
 *   2. Initiate outbound call to Luke's private SIM
 *   3. Luke answers → EA: "You have [caller] about [topic]. Bridge in?"
 *   4. Luke says "Yes" → Vapi conference transfer merges both legs
 *   5. EA drops off, caller+Luke continue directly
 */
export async function initiateBridgeIn(
  liveCallId: string,
  callerPhone: string,
  callerName: string,
  topic: string,
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey) {
    return { success: false, error: "Vapi not configured" };
  }

  const privateSim = config.lukeyPrivateSim;
  if (!privateSim) {
    return { success: false, error: "Private SIM not configured — add it in Settings" };
  }

  const sessionId = `bridge_${Date.now()}`;
  const session: BridgeSession = {
    id: sessionId,
    live_call_id: liveCallId,
    caller_phone: callerPhone,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  activeBridgeSessions.set(sessionId, session);

  // Initiate outbound call to the owner's private SIM
  const bridgePrompt = `You are bridging a live call. A caller named ${callerName} is on hold about: "${topic}". Tell the owner who is holding and ask: "Want me to connect you?" If they say Yes, use the connect_caller tool. If No, end this call and tell the other line they're not available.`;

  const body = {
    phoneNumberId: config.vapiPhoneNumberId,
    customer: { number: normalizePhone(privateSim) },
    assistant: {
      model: {
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "system", content: bridgePrompt }],
        tools: [
          {
            type: "transferCall",
            destinations: [{
              type: "number",
              number: callerPhone,
              message: "Connecting you now.",
            }],
          },
        ],
      },
      voice: { provider: "11labs", voiceId: "paula" },
      firstMessage: `Hey Luke — you've got ${callerName} holding about "${topic}". Want me to connect you?`,
      endCallPhrases: ["goodbye", "no thanks", "not now"],
    },
    metadata: { bridge_session_id: sessionId, live_call_id: liveCallId },
  };

  try {
    const res = await fetch("https://api.vapi.ai/call/phone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.vapiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      session.status = "failed";
      return { success: false, error: err.message ?? `Vapi error ${res.status}` };
    }

    const data = await res.json() as any;
    session.bridge_call_id = data.id;
    session.status = "bridging";
    activeBridgeSessions.set(sessionId, session);

    return { success: true, sessionId };
  } catch (err: any) {
    session.status = "failed";
    return { success: false, error: err.message };
  }
}

/** Get an active bridge session by ID. */
export function getBridgeSession(sessionId: string): BridgeSession | null {
  return activeBridgeSessions.get(sessionId) ?? null;
}

/** Update bridge session status (called when Vapi webhooks fire). */
export function updateBridgeSession(sessionId: string, update: Partial<BridgeSession>): void {
  const session = activeBridgeSessions.get(sessionId);
  if (!session) return;
  Object.assign(session, update);
  if (update.status === "connected" || update.status === "declined" || update.status === "failed") {
    // Clean up after a reasonable delay
    setTimeout(() => activeBridgeSessions.delete(sessionId), 5 * 60 * 1000);
  }
}

/** List all active bridge sessions (for debugging/status display). */
export function listActiveBridgeSessions(): BridgeSession[] {
  return Array.from(activeBridgeSessions.values());
}
