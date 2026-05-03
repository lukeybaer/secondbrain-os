#!/usr/bin/env node
// em-dash-guard.mjs
//
// Mechanical enforcement of the owner's "no em dashes in ANY output" rule
// (CLAUDE.md global behavioral rules).
//
// Two modes, dispatched by hook event:
//   PreToolUse on Bash|Edit|Write|NotebookEdit
//     -> scan tool_input for em dash (U+2014) or en dash (U+2013)
//     -> exit 2 + stderr message blocks the tool call
//   Stop
//     -> read the transcript, scan the last assistant turn's text
//     -> exit 2 + stderr forces Claude to continue and rewrite
//
// Commit messages, file writes, and chat output all funnel through this
// guard. There is no soft-mode: any em or en dash is rejected.

import { readFileSync } from "node:fs";

// U+2014 EM DASH, U+2013 EN DASH. We do NOT touch hyphens (U+002D).
const FORBIDDEN = /[—–]/;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findOffending(text) {
  if (typeof text !== "string") return null;
  const m = text.match(FORBIDDEN);
  if (!m) return null;
  const idx = m.index;
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + 30);
  const snippet = text.slice(start, end).replace(/\n/g, "\\n");
  const charName = m[0] === "—" ? "EM DASH (U+2014)" : "EN DASH (U+2013)";
  return { charName, snippet };
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

function handlePreToolUse(payload) {
  const input = payload.tool_input ?? {};
  // Fields that may carry user-facing text
  const candidates = [
    ["command", input.command],
    ["content", input.content],
    ["new_string", input.new_string],
    ["old_string", input.old_string],
    ["file_text", input.file_text],
  ];
  for (const [field, value] of candidates) {
    const hit = findOffending(value);
    if (hit) {
      fail(
        [
          "[em-dash-guard] BLOCKED: " + hit.charName + " found in tool input field '" + field + "'.",
          "Snippet: ..." + hit.snippet + "...",
          "",
          "the owner's rule (CLAUDE.md global): No em dashes in ANY output. Use commas, periods, or plain hyphens (-) instead.",
          "Rewrite this tool call without em or en dashes and retry.",
        ].join("\n")
      );
    }
  }
}

function handleStop(payload) {
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) return;
  let transcript;
  try {
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    return;
  }
  // Transcript is JSONL. Walk backwards to find the last assistant message.
  const lines = transcript.split(/\r?\n/).filter(Boolean);
  let lastAssistantText = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content ?? entry.content ?? [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          lastAssistantText = block.text + "\n" + lastAssistantText;
        }
      }
    } else if (typeof content === "string") {
      lastAssistantText = content;
    }
    if (lastAssistantText) break;
  }
  if (!lastAssistantText) return;
  const hit = findOffending(lastAssistantText);
  if (hit) {
    // Exit 2 with stderr injects a system message and forces Claude to continue.
    fail(
      [
        "[em-dash-guard] " + hit.charName + " detected in your last message.",
        "Snippet: ..." + hit.snippet + "...",
        "",
        "the owner's rule (CLAUDE.md global): No em dashes in ANY output. Rewrite the offending sentence(s) using commas, periods, or plain hyphens (-).",
        "Continue the turn by sending a corrected version of just the affected text.",
      ].join("\n")
    );
  }
}

const raw = readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  // No-op: if the hook can't parse the payload it shouldn't block.
  process.exit(0);
}

const event = payload.hook_event_name || payload.event || "";
if (event === "PreToolUse") {
  handlePreToolUse(payload);
} else if (event === "Stop") {
  handleStop(payload);
}
process.exit(0);
