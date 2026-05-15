# Stack Roadmap

Forward-looking notes on where the stack could evolve. **Not** part of this PR's
code changes — captured here so the thinking lives in the repo instead of in
review comments.

The current stack (Electron + Vite + React + TypeScript + better-sqlite3 +
Node.js EC2 companion + Graphiti) is well-chosen for a local-first AI desktop
app. The ideas below are tactical splits to make as the product grows, not a
rewrite manifesto. Order them by pain you actually feel, not by novelty.

---

## 1. Split AI services out to Python (medium-term)

**What:** Move LLM-adjacent work (embeddings, vector ops, prompt orchestration,
custom transforms) into a Python service that the Electron main process and
EC2 gateway both call over a thin HTTP/gRPC boundary.

**Why it could pay off:**

- Python has the deepest LLM ecosystem — `langchain`, `langgraph`,
  `transformers`, `sentence-transformers`, `pgvector`/`chromadb` clients,
  fine-tuning tooling, eval frameworks.
- Keeping Node for app/UI logic and Python for AI logic plays to each
  language's strengths instead of forcing Node to fake its way through
  embeddings and tokenization.
- Easier to bring in ML engineers who don't write TypeScript.

**Why to be cautious:**

- Adds a second runtime to deploy and monitor.
- Drops the @anthropic-ai/sdk-from-Node convenience the app currently enjoys.
- IPC overhead matters if the call path is hot (sub-100ms expectations).

**Trigger:** When you find yourself wanting `numpy`/`torch` or a real vector DB
client in the Node code and the npm wrappers feel anaemic.

---

## 2. LangGraph for the stateful pipelines (medium-term)

**What:** Model the briefing generator, the video review/reject/regenerate
loop, and the call-campaign orchestrator as LangGraph state graphs instead of
hand-rolled control flow.

**Why it could pay off:**

- These are exactly the workloads LangGraph was built for: multi-step,
  branching, retry-aware, human-in-the-loop (Telegram approvals fit cleanly
  as graph interrupts), with explicit state you can checkpoint and resume.
- Gives free observability — every node transition is a trace point, useful
  for debugging "why did the 5:30am briefing miss the news section."
- Couples naturally with the Python split above.

**Why to be cautious:**

- The app already has Claude Code as an agent runtime per the README. Adding
  LangGraph on top is **duplication unless you scope it narrowly** to
  pipelines where Claude Code's loop isn't the right shape (long-running,
  scheduled, deterministic-state-machine work). Don't replace Claude Code
  with LangGraph; complement it.
- LangGraph state schemas are another thing to maintain.

**Trigger:** Next time a pipeline (briefing, video, calls) breaks in a way
that's hard to debug because the control flow is implicit. Migrate that
pipeline; leave the rest alone.

---

## 3. Go gateway for webhooks + EC2 frontend (long-term)

**What:** Replace the Node.js EC2 server with a small Go binary that:

- Receives Vapi / Twilio / Telegram webhooks
- Authenticates and validates payloads
- Fans them out to internal services (Python AI service, queues, SQLite sync)
- Serves the session-registry / intent-classifier endpoints

**Why it could pay off:**

- Webhook gateways are exactly where Go's strengths line up: high
  concurrency, low memory, single static binary, fast cold start.
- Removes Node from the always-on EC2 server (less memory, simpler PM2
  config, fewer security advisories to chase).
- Forces a clean contract between the desktop app, the gateway, and the AI
  service — boundaries you'll want anyway.

**Why to be cautious:**

- Splits the codebase across three languages (TS desktop, Go gateway, Python
  AI). Three deploy pipelines, three sets of CI.
- Only worth it once the EC2 server is doing enough work to justify the
  rewrite. A barely-loaded Node server is fine in Node.

**Trigger:** When the EC2 box hits memory pressure or you start writing
goroutine-shaped code in Node (worker pools, fan-out/fan-in over many
concurrent webhooks).

---

## 4. Knowledge-graph schema automation (medium-term, highest leverage)

**What:** Stop hand-curating entity types and relation schemas in Graphiti.
Instead, run an LLM-driven inference pass over each ingest batch that:

- Proposes new entity types and relations when the existing schema doesn't
  fit
- Detects schema drift (e.g., "Person.linkedinUrl" appearing where
  "Person.linkedin" was the convention)
- Generates SHACL/JSON-Schema constraints from observed patterns
- Surfaces proposed changes to the user via Telegram approval (consistent
  with the existing approval pattern) before applying

**Why it could pay off:**

- The graph already ingests heterogeneous data (calls, WhatsApp, Gmail,
  LinkedIn, screenshots). Manual schema curation doesn't scale; you'll
  always be one source behind.
- Graphiti handles entity dedup and contradiction resolution but doesn't
  evolve the schema for you.
- LLMs are unusually well-suited to schema inference — it's the kind of
  fuzzy-pattern-matching task they excel at.
- High leverage: every downstream feature (search, briefing, contact
  intelligence) gets sharper as the schema gets better.

**Why to be cautious:**

- Automated schema changes against a live graph are dangerous. Always gate
  through the existing Telegram approval loop.
- Versioning the schema and migrating historical episodes will get hairy.
  Plan for it before you ship.

**Trigger:** First time you notice the graph returning fragmented results
for a query that should have hit — e.g., LinkedIn events not joining to
contacts because the inferred entity type drifted. That's the schema
shouting.

---

## Order of operations if all four ship

1. **Schema automation first** — highest leverage, doesn't depend on the
   others, makes everything else more useful.
2. **Python AI service** — natural home for the schema-inference pass once
   it's bigger than a single prompt.
3. **LangGraph** — once the Python service exists, migrate the briefing
   pipeline first (most pain, most observable wins).
4. **Go gateway** — only when EC2 load justifies it. Don't do this for
   aesthetics.

Three of these can be deferred indefinitely without harm. Schema automation
is the one I'd start on the day a manual entity-type fix annoys you.
