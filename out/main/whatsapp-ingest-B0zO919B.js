"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const electron = require("electron");
const index = require("./index.js");
const ingestHooks = require("./ingest-hooks-Kn1bdOl3.js");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const crypto__namespace = /* @__PURE__ */ _interopNamespaceDefault(crypto);
function stateDir() {
  return path__namespace.join(electron.app.getPath("userData"), "data", "whatsapp-ingest");
}
function stateFile() {
  return path__namespace.join(stateDir(), "state.json");
}
function loadState() {
  try {
    return JSON.parse(fs__namespace.readFileSync(stateFile(), "utf8"));
  } catch {
    return { processed: {} };
  }
}
function saveState(state) {
  fs__namespace.mkdirSync(stateDir(), { recursive: true });
  fs__namespace.writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf8");
}
function md5(content) {
  return crypto__namespace.createHash("md5").update(content).digest("hex");
}
function formatMessagesAsTranscript(chatName, messages) {
  if (messages.length === 0) return "";
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const firstDate = new Date(sorted[0].timestamp).toISOString().split("T")[0];
  const lastDate = new Date(sorted[sorted.length - 1].timestamp).toISOString().split("T")[0];
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;
  const lines = [
    `# WhatsApp: ${chatName}`,
    ``,
    `**Date range:** ${dateRange}`,
    `**Messages:** ${messages.length}`,
    ``,
    `## Conversation`,
    ``
  ];
  let currentDate = "";
  for (const msg of sorted) {
    const msgDate = new Date(msg.timestamp).toISOString().split("T")[0];
    if (msgDate !== currentDate) {
      currentDate = msgDate;
      lines.push(`### ${msgDate}`);
      lines.push("");
    }
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    const sender = msg.fromMe ? "the owner" : msg.fromName || chatName;
    const body = msg.body?.trim();
    if (body) {
      lines.push(`**${sender}** (${time}): ${body}`);
    }
  }
  return lines.join("\n");
}
let isIngesting = false;
async function ingestAllWhatsAppHistory(onProgress) {
  if (isIngesting) {
    return { processed: 0, skipped: 0, errors: ["Ingestion already in progress"], chats: [] };
  }
  if (index.getStatus() !== "ready") {
    return { processed: 0, skipped: 0, errors: ["WhatsApp not connected"], chats: [] };
  }
  isIngesting = true;
  const state = loadState();
  let processed = 0;
  let skipped = 0;
  const errors = [];
  const processedChats = [];
  try {
    onProgress?.({ phase: "fetching-chats", current: 0, total: 0 });
    console.log("[wa-ingest] Fetching chat list...");
    const chats = await index.getAllChats();
    console.log(`[wa-ingest] Found ${chats.length} chats`);
    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      onProgress?.({
        phase: "processing",
        current: i + 1,
        total: chats.length,
        chatName: chat.name
      });
      try {
        const result = await processChat(chat, state);
        if (result === "processed") {
          processed++;
          processedChats.push(chat.name);
        } else {
          skipped++;
        }
      } catch (e) {
        const errMsg = `Chat "${chat.name}": ${e.message}`;
        console.error(`[wa-ingest] Error:`, errMsg);
        errors.push(errMsg);
      }
      await sleep(500);
    }
    state.lastFullRun = (/* @__PURE__ */ new Date()).toISOString();
    saveState(state);
    console.log(
      `[wa-ingest] Complete: ${processed} processed, ${skipped} skipped, ${errors.length} errors`
    );
    onProgress?.({ phase: "complete", current: chats.length, total: chats.length });
  } finally {
    isIngesting = false;
  }
  return { processed, skipped, errors, chats: processedChats };
}
async function processChat(chat, state) {
  console.log(`[wa-ingest] Processing: ${chat.name} (${chat.id})`);
  const messages = await index.getChatHistory(chat.id, 1e3);
  if (messages.length === 0) {
    console.log(`[wa-ingest] Skipping "${chat.name}" , no messages`);
    return "skipped";
  }
  const textMessages = messages.filter(
    (m) => m.body && m.body.trim().length > 0 && m.type === "chat"
  );
  if (textMessages.length === 0) {
    console.log(`[wa-ingest] Skipping "${chat.name}" , no text messages`);
    return "skipped";
  }
  const transcript = formatMessagesAsTranscript(chat.name, textMessages);
  const hash = md5(transcript);
  const existing = state.processed[chat.id];
  if (existing && existing.hash === hash) {
    console.log(`[wa-ingest] Skipping "${chat.name}" , unchanged`);
    return "skipped";
  }
  console.log(`[wa-ingest] AI-tagging "${chat.name}" (${textMessages.length} messages)...`);
  const convId = `wa_${sanitizeId(chat.id)}`;
  const firstMsgDate = new Date(Math.min(...textMessages.map((m) => m.timestamp))).toISOString().split("T")[0];
  let meta;
  try {
    meta = await index.tagWhatsAppConversation(
      convId,
      chat.name,
      firstMsgDate,
      textMessages.length,
      transcript,
      chat.isGroup
    );
  } catch (e) {
    console.error(`[wa-ingest] Tag failed for "${chat.name}": ${e.message}`);
    meta = fallbackMeta(convId, chat, textMessages, firstMsgDate);
  }
  index.saveConversation(meta, transcript);
  console.log(`[wa-ingest] Saved conversation: ${convId}`);
  ingestHooks.onDataIngested(
    ingestHooks.whatsappEvent({
      id: convId,
      from: chat.id,
      body: transcript.slice(0, 3e3),
      // Graphiti's practical limit
      contactName: chat.name,
      source: chat.isGroup ? "inbound" : "inbound",
      // treat all as inbound for archival
      timestamp: new Date(Math.max(...textMessages.map((m) => m.timestamp))).toISOString()
    })
  );
  if (textMessages.length >= 5 && meta.summary) {
    const memoryContent = [
      `WhatsApp conversation with ${chat.name}`,
      `Date range: ${firstMsgDate} , ${new Date(Math.max(...textMessages.map((m) => m.timestamp))).toISOString().split("T")[0]}`,
      `Messages: ${textMessages.length}`,
      `Summary: ${meta.summary}`,
      meta.topics?.length ? `Topics: ${meta.topics.join(", ")}` : "",
      meta.peopleMentioned?.length ? `People: ${meta.peopleMentioned.join(", ")}` : "",
      meta.decisions?.length ? `Decisions: ${meta.decisions.join("; ")}` : "",
      meta.personalDetails?.length ? `Personal details: ${meta.personalDetails.join("; ")}` : "",
      meta.goalsPlans?.length ? `Goals/plans: ${meta.goalsPlans.join("; ")}` : ""
    ].filter(Boolean).join("\n");
    index.upsertMemory(`whatsapp: ${chat.name}`, memoryContent, { decayRate: 0.05 });
  }
  index.appendToArchive(
    `[WhatsApp: ${chat.name}] ${textMessages.length} messages. ${meta.summary || "No summary."}`
  );
  state.processed[chat.id] = {
    hash,
    ingestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    chatName: chat.name,
    messageCount: textMessages.length
  };
  saveState(state);
  return "processed";
}
function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function fallbackMeta(convId, chat, messages, date) {
  return {
    id: convId,
    otterId: convId,
    title: `WhatsApp: ${chat.name}`,
    date,
    durationMinutes: messages.length,
    // proxy: 1 msg ≈ 1 min
    speakers: [chat.name, "the owner"],
    myRole: "participant",
    meetingType: chat.isGroup ? "group_chat" : "direct_message",
    summary: `WhatsApp conversation with ${chat.name} (${messages.length} messages)`,
    topics: [],
    keywords: [],
    peopleMentioned: [chat.name],
    companiesMentioned: [],
    decisions: [],
    sentiment: "routine",
    transcriptFile: "transcript.txt",
    taggedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
exports.ingestAllWhatsAppHistory = ingestAllWhatsAppHistory;
