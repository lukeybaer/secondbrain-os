"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const index = require("./index.js");
function onDataIngested(event) {
  ingestToGraphiti(event).catch(
    (err) => console.warn(`[ingest-hook] Graphiti ingest failed for ${event.source}: ${err.message}`)
  );
  ingestToWorkingMemory(event);
}
async function ingestToGraphiti(event) {
  const body = event.body.slice(0, 3e3);
  if (body.length < 10) return;
  await index.addEpisode({
    name: event.name,
    episode_body: body,
    source_description: `${event.source}:${event.sourceId ?? "unknown"}`,
    reference_time: event.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
    group_id: "owner-ea"
  });
}
function ingestToWorkingMemory(event) {
  try {
    const contact = event.contactName || event.phone || "unknown";
    const summary = event.body.slice(0, 80).replace(/\n/g, " ");
    index.appendWorkingMemory(`[${event.source}] ${contact}: ${summary}`);
  } catch {
  }
}
function otterEvent(opts) {
  return {
    name: `Otter: ${opts.title}`,
    body: opts.transcript,
    source: "otter-transcript",
    sourceId: opts.id,
    timestamp: opts.date
  };
}
function whatsappEvent(msg) {
  const direction = msg.source === "inbound" ? "inbound" : "outbound";
  return {
    name: `WhatsApp ${direction}: ${msg.contactName || msg.from}`,
    body: msg.body,
    source: direction === "inbound" ? "whatsapp-inbound" : "whatsapp-outbound",
    sourceId: msg.id,
    phone: msg.from,
    contactName: msg.contactName,
    timestamp: msg.timestamp
  };
}
function smsEvent(msg) {
  const direction = msg.source === "inbound" ? "inbound" : "outbound";
  return {
    name: `SMS ${direction}: ${msg.from}`,
    body: msg.body,
    source: direction === "inbound" ? "sms-inbound" : "sms-outbound",
    sourceId: msg.id,
    phone: msg.source === "inbound" ? msg.from : msg.to,
    timestamp: msg.timestamp
  };
}
function callEvent(opts) {
  const body = [
    opts.instructions ? `Goal: ${opts.instructions}` : "",
    opts.outcome ? `Outcome: ${opts.outcome}` : "",
    opts.transcript
  ].filter(Boolean).join("\n\n");
  return {
    name: `Call: ${opts.contactName || opts.phoneNumber}`,
    body,
    source: "call-transcript",
    sourceId: opts.callId,
    phone: opts.phoneNumber,
    contactName: opts.contactName
  };
}
function briefingEvent(type, text) {
  return {
    name: `${type === "daily" ? "Morning" : "Evening"} Briefing`,
    body: text,
    source: type === "daily" ? "briefing-daily" : "briefing-evening",
    sourceId: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
  };
}
function chatSessionEvent(opts) {
  return {
    name: `Chat session: ${opts.summary.slice(0, 60)}`,
    body: opts.transcript,
    source: "chat-session",
    sourceId: opts.sessionId
  };
}
function stripHtmlToText(html) {
  if (!html) return "";
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n");
  s = s.replace(/<br\s*\/?>(?=)/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
function gmailEvent(opts) {
  const plain = opts.bodyIsHtml ? stripHtmlToText(opts.body) : opts.body;
  const headerLine = `From: ${opts.from}${opts.to ? ` | To: ${opts.to}` : ""} | Subject: ${opts.subject}`;
  const composed = `${headerLine}

${plain}`;
  return {
    name: `Gmail ${opts.direction}: ${opts.subject.slice(0, 80) || "(no subject)"}`,
    body: composed,
    source: opts.direction === "inbound" ? "gmail-inbound" : "gmail-outbound",
    sourceId: opts.messageId,
    contactName: opts.contactName,
    timestamp: opts.timestamp
  };
}
function linkedinEvent(opts) {
  const headerLine = opts.contactUrl ? `Contact: ${opts.contactName} (${opts.contactUrl})` : `Contact: ${opts.contactName}`;
  const composed = `${headerLine}

${opts.body}`;
  return {
    name: `LinkedIn ${opts.type}: ${opts.contactName}`,
    body: composed,
    source: opts.type === "message" ? "linkedin-message" : "linkedin-profile",
    sourceId: opts.id,
    contactName: opts.contactName,
    timestamp: opts.timestamp
  };
}
exports.briefingEvent = briefingEvent;
exports.callEvent = callEvent;
exports.chatSessionEvent = chatSessionEvent;
exports.gmailEvent = gmailEvent;
exports.linkedinEvent = linkedinEvent;
exports.onDataIngested = onDataIngested;
exports.otterEvent = otterEvent;
exports.smsEvent = smsEvent;
exports.stripHtmlToText = stripHtmlToText;
exports.whatsappEvent = whatsappEvent;
