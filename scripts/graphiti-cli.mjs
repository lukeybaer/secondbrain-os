#!/usr/bin/env node
// graphiti-cli.mjs
//
// Standalone Node CLI that talks to the Graphiti MCP server at
// http://127.0.0.1:8000/mcp without needing the Electron-app TypeScript
// build path. Used by:
//   - archive-session-to-s3.sh (Stop hook) to ingest each Claude Code
//     session into Graphiti as a chat-session episode.
//   - recall-context-inject.mjs and sb-session-search.py to query
//     Graphiti as the primary semantic source, with FTS5 sessions.db
//     as the keyword fallback.
//   - dispatch-context-helper.js for the same unified retrieval.
//
// Subcommands:
//   add  --name <n> --body <text> [--source <tag>] [--time <iso>] [--group <id>]
//   add-from-meta <meta_path>   (Claude Code session meta JSON)
//   search <query> [--limit N] [--group <id>] [--json]
//   recent [--limit N] [--group <id>] [--json]
//   health
//
// Repairs a missing local SSH tunnel before falling through when Graphiti is
// genuinely unreachable. Exit 0 with no output keeps archive callers from
// breaking their primary pipeline.

import { readFileSync } from "node:fs";
import tunnelModule from "./lib/graphiti-tunnel.js";

const { ensureGraphitiTunnel } = tunnelModule;

const URL = process.env.GRAPHITI_URL || "http://127.0.0.1:8000";
const DEFAULT_GROUP = process.env.GRAPHITI_GROUP_ID || "owner-ea";
const TIMEOUT_INIT = 10_000;
const TIMEOUT_TOOL = 30_000;

let _sessionId = null;
let _requestId = 0;

// Node 24 on Windows can hit a libuv assertion when fetch keepalive
// sockets close during process.exit(). Defer the exit one tick so the
// cleanup completes before the event loop tears down.
function cleanExit(code) {
  setImmediate(() => process.exit(code));
}

async function ensureSession() {
  try {
    const tunnel = await ensureGraphitiTunnel({ baseUrl: URL });
    if (!tunnel.reachable) return null;
    if (_sessionId) return _sessionId;
    const res = await fetch(`${URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "secondbrain-cli", version: "1.0" },
        },
        id: ++_requestId,
      }),
      signal: AbortSignal.timeout(TIMEOUT_INIT),
    });
    const sid = res.headers.get("mcp-session-id");
    if (!sid) {
      const text = await res.text();
      if (/data:\s*\{/.test(text)) _sessionId = "no-header-session";
      else return null;
    } else {
      _sessionId = sid;
      try { await res.text(); } catch {}
    }
    // Required: notifications/initialized
    try {
      await fetch(`${URL}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": _sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {}
    return _sessionId;
  } catch {
    _sessionId = null;
    return null;
  }
}

async function tool(name, args) {
  const sid = await ensureSession();
  if (!sid) return null;
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sid !== "no-header-session") headers["Mcp-Session-Id"] = sid;
    const res = await fetch(`${URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
        id: ++_requestId,
      }),
      signal: AbortSignal.timeout(TIMEOUT_TOOL),
    });
    const text = await res.text();
    const m = text.match(/data:\s*(\{.*\})/);
    const json = m ? JSON.parse(m[1]) : JSON.parse(text);
    if (json.error) return null;
    const c = json.result?.content;
    if (c?.[0]?.text) return JSON.parse(c[0].text);
    return json.result ?? null;
  } catch {
    _sessionId = null;
    return null;
  }
}

async function cmdHealth() {
  try {
    const tunnel = await ensureGraphitiTunnel({ baseUrl: URL });
    if (!tunnel.reachable) {
      console.error(`graphiti unreachable: ${tunnel.reason || 'tunnel unavailable'}`);
      cleanExit(2);
      return;
    }
    const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      console.error(`graphiti unhealthy: HTTP ${r.status}`);
      cleanExit(2);
      return;
    }
    const j = await r.json();
    console.log(JSON.stringify(j));
    cleanExit(0);
  } catch (e) {
    console.error(`graphiti unreachable: ${e.message}`);
    cleanExit(2);
  }
}

async function cmdAdd(opts) {
  if (!opts.name || !opts.body) {
    console.error("add: --name and --body required");
    cleanExit(2);
    return;
  }
  const r = await tool("add_memory", {
    name: opts.name,
    episode_body: opts.body.slice(0, 8000),
    source_description: opts.source || "cli",
    source: "text",
    group_id: opts.group || DEFAULT_GROUP,
    ...(opts.time ? { reference_time: opts.time } : {}),
  });
  if (r) {
    console.log("ok");
    cleanExit(0);
    return;
  }
  console.error("add: graphiti unavailable or rejected");
  cleanExit(2);
}

async function cmdAddFromMeta(metaPath) {
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    console.error(`cannot parse ${metaPath}: ${e.message}`);
    cleanExit(2);
  }
  // Build a single episode body from corpus_user + corpus_assistant + topic.
  // Cap at 6 KB so Graphiti's entity extractor doesn't choke.
  const parts = [];
  if (meta.topic_guess) parts.push(`Topic: ${meta.topic_guess}`);
  if (meta.first_prompt) parts.push(`First prompt: ${meta.first_prompt}`);
  if (meta.tool_calls?.length) parts.push(`Tools used: ${meta.tool_calls.join(", ")}`);
  if (meta.corpus_user) parts.push(`User messages (sampled):\n${meta.corpus_user}`);
  if (meta.corpus_assistant) parts.push(`Amy responses (sampled):\n${meta.corpus_assistant}`);
  if (meta.last_response) parts.push(`Last response: ${meta.last_response}`);
  const body = parts.join("\n\n").slice(0, 6000);
  const repo = meta.repo || "ExampleCo";
  const sid = (meta.session_id || "?").slice(0, 8);
  const date = (meta.started_at || "").slice(0, 10);
  const r = await tool("add_memory", {
    name: `Claude Code session ${sid} (${repo} ${date})`,
    episode_body: body,
    source_description: `chat-session:${meta.session_id || "ExampleCo"}`,
    source: "text",
    group_id: DEFAULT_GROUP,
    reference_time: meta.started_at || new Date().toISOString(),
  });
  if (r) {
    console.log(`ok session=${sid}`);
    cleanExit(0);
    return;
  }
  console.error(`add-from-meta: graphiti unavailable for session ${sid}`);
  cleanExit(2);
}

async function cmdSearch(opts) {
  if (!opts.query) {
    console.error("search: query required");
    cleanExit(2);
  }
  const r = await tool("search_memory_facts", {
    query: opts.query,
    group_ids: [opts.group || DEFAULT_GROUP],
    max_facts: opts.limit || 10,
  });
  const facts = r?.facts || [];
  if (opts.json) {
    console.log(JSON.stringify(facts, null, 2));
    cleanExit(0);
    return;
  }
  if (facts.length === 0) {
    console.log("(no graphiti hits)");
    cleanExit(0);
    return;
  }
  for (const f of facts.filter((x) => !x.invalid_at)) {
    const date = (f.valid_at || "").slice(0, 10);
    console.log(`[${date}] ${f.fact}`);
  }
  cleanExit(0);
}

async function cmdRecent(opts) {
  const r = await tool("get_episodes", {
    group_ids: [opts.group || DEFAULT_GROUP],
    max_episodes: opts.limit || 10,
  });
  const eps = r?.episodes || [];
  if (opts.json) {
    console.log(JSON.stringify(eps, null, 2));
    cleanExit(0);
    return;
  }
  for (const e of eps) {
    const date = (e.created_at || "").slice(0, 10);
    console.log(`[${date}] ${e.name}: ${(e.episode_body || "").slice(0, 120).replace(/\s+/g, " ")}`);
  }
  cleanExit(0);
}

function parseFlags(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      opts[k] = v;
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { opts, rest } = parseFlags(argv.slice(1));
  if (opts.limit) opts.limit = parseInt(opts.limit, 10);
  switch (cmd) {
    case "health":
      return cmdHealth();
    case "add":
      return cmdAdd(opts);
    case "add-from-meta":
      return cmdAddFromMeta(rest[0]);
    case "search":
      return cmdSearch({ ...opts, query: rest.join(" ") });
    case "recent":
      return cmdRecent(opts);
    default:
      console.error("usage: graphiti-cli.mjs <health|add|add-from-meta|search|recent> [...]");
      cleanExit(2);
  }
}

main();
