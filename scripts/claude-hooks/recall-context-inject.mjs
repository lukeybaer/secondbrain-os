#!/usr/bin/env node
// recall-context-inject.mjs
//
// UserPromptSubmit hook. Triggered on prompts containing "#recall" or
// "#prior". Builds a unified retrieval context block from:
//   1. Graphiti knowledge graph (semantic, temporal, primary)
//   2. ~/.secondbrain/sessions.db FTS5 (keyword fallback / fidelity)
// and injects the result as additionalContext so the current session
// can see what prior conversations and ingests across all sources
// (Claude Code, otter, calls, sms, whatsapp, briefings, etc.) covered.
//
// Cross-repo: works in any Claude Code session in any repo because it
// reads user-level state, not project-scoped. This is the "any session
// should be able to do this too, and it's all one query" piece
// (2026-04-30).
//
// Hook contract: prints JSON to stdout. Claude Code merges
// hookSpecificOutput.additionalContext into the prompt context.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin } from "node:process";

const DB_PATH = join(homedir(), ".secondbrain", "sessions.db");
const SCRIPTS_DIR = join(homedir(), "secondbrain", "scripts");
const PY_CLI = join(SCRIPTS_DIR, "sb-session-search.py");
const GRAPHITI_CLI = join(SCRIPTS_DIR, "graphiti-cli.mjs");

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(""));
  });
}

function emit(additionalContext) {
  if (!additionalContext) {
    process.exit(0);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }),
  );
  process.exit(0);
}

function stripTriggers(prompt) {
  // Remove the trigger tokens themselves from the search query.
  return prompt
    .replace(/#recall\b/gi, "")
    .replace(/#prior\b/gi, "")
    .trim();
}

function queryGraphiti(query) {
  if (!existsSync(GRAPHITI_CLI)) return [];
  try {
    const out = execFileSync("node", [GRAPHITI_CLI, "search", query, "--limit", "8", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 12_000,
    });
    const facts = JSON.parse(out || "[]");
    return Array.isArray(facts) ? facts : [];
  } catch {
    return [];
  }
}

function querySessionsFts(query) {
  if (!existsSync(DB_PATH) || !existsSync(PY_CLI)) return [];
  try {
    const out = execFileSync("python", [PY_CLI, "search", query, "--limit", "5", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const hits = JSON.parse(out || "[]");
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
}

function formatGraphitiHits(facts) {
  if (!facts.length) return "";
  const live = facts.filter((f) => !f.invalid_at).slice(0, 8);
  if (!live.length) return "";
  const lines = ["### Graphiti (semantic + temporal, primary)"];
  for (const f of live) {
    const date = (f.valid_at || "").slice(0, 10) || "(undated)";
    const fact = (f.fact || "").trim().slice(0, 240).replace(/\s+/g, " ");
    lines.push(`- [${date}] ${fact}`);
  }
  return lines.join("\n");
}

function formatSessionHits(hits) {
  if (!hits.length) return "";
  const lines = ["### Session archive FTS5 (keyword, fallback)"];
  for (const r of hits) {
    const date = (r.started_at || "").slice(0, 10) || "(undated)";
    const sid = (r.session_id || "").slice(0, 8);
    const topic = (r.topic_guess || "").trim().slice(0, 140).replace(/\s+/g, " ");
    const fp = (r.first_prompt || "").trim().slice(0, 180).replace(/\s+/g, " ");
    const lr = (r.last_response || "").trim().slice(0, 180).replace(/\s+/g, " ");
    lines.push(`- [${date}] ${r.repo} ${sid} (msgs=${r.message_count})`);
    if (topic) lines.push(`  topic : ${topic}`);
    if (fp) lines.push(`  user  : ${fp}`);
    if (lr) lines.push(`  amy   : ${lr}`);
  }
  lines.push(`(For full session: python ${PY_CLI} show <id>)`);
  return lines.join("\n");
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const prompt = payload.prompt || "";
  if (!/#recall\b|#prior\b/i.test(prompt)) {
    process.exit(0);
  }
  const query = stripTriggers(prompt);
  if (!query) {
    emit("[recall] #recall used without text after it; nothing to search.\nTry: #recall AWS quota");
    return;
  }
  // Run both stores via separate sync calls. Each is its own process
  // spawn so Node's event loop is not blocked while the other runs.
  // Total wall time is dominated by the slower one (Graphiti, ~5 to 12s).
  const graphitiFacts = queryGraphiti(query);
  const sessionHits = querySessionsFts(query);
  if (graphitiFacts.length === 0 && sessionHits.length === 0) {
    emit(`[recall] no prior memory matched: ${query}\n(Graphiti and sessions.db both empty for this query.)`);
    return;
  }
  const blocks = [];
  const g = formatGraphitiHits(graphitiFacts);
  const s = formatSessionHits(sessionHits);
  if (g) blocks.push(g);
  if (s) blocks.push(s);
  emit(blocks.join("\n\n"));
}

main();
