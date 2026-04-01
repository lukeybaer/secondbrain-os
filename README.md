# SecondBrain

An open-source Electron desktop app that turns AI into an autonomous executive assistant. It makes phone calls on your behalf, ingests meeting transcripts, manages workflows, screens inbound communications, and learns from every interaction — all running locally on your machine.

**Status: Active development.** Core features work. Many planned capabilities are still being built.

---

## What It Does

SecondBrain is designed around a simple idea: your AI assistant should be able to **do things**, not just answer questions. It makes outbound phone calls via [Vapi.ai](https://vapi.ai), imports and searches your meeting transcripts from [Otter.ai](https://otter.ai), manages projects and tasks, and maintains persistent memory that survives restarts.

The assistant runs autonomously but with guardrails — critical actions (sharing PII, making commitments, publishing content) require explicit approval via Telegram before proceeding.

### Tested & Working

- **Meeting transcript import** — Fetch conversations from Otter.ai, extract metadata, full-text search
- **Chat** — Ask questions about your meetings with AI-powered context retrieval
- **Outbound AI phone calls** — Configure personas, initiate calls via Vapi.ai, listen in live via WebRTC
- **Persona management** — Create and manage different AI voice personalities for different call scenarios
- **Call continuation** — The agent can pick up where it left off and keep pursuing a goal until complete
- **Project/task tracking** — Organize call campaigns and workflows with outcome tracking
- **Content pipeline** — Review, approve, or reject AI-generated video content before publishing

### In Development

- Inbound call screening and intelligent routing
- WhatsApp Business integration
- Daily briefing generation
- Temporal knowledge graph (Graphiti) integration
- Phone number takeover (Twilio port → Vapi → intelligent routing)
- PII vault with encrypted storage and approval-gated sharing

---

## Architecture

### Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 28 (Chromium 120) |
| Frontend | React 18 + TypeScript |
| Backend (main process) | Node.js + better-sqlite3 |
| Build tool | electron-vite (Vite 5) |
| Voice AI | Vapi.ai |
| LLM | Claude (Anthropic) + OpenAI |
| Notifications | Telegram Bot API |
| Testing | Vitest (unit) + Playwright (E2E) |

### Process Architecture

```
┌─────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                │
│                                                 │
│  config.ts ─── API keys, settings (JSON file)   │
│  calls.ts ──── Vapi.ai call orchestration       │
│  chat.ts ───── LLM chat with meeting context    │
│  server.ts ─── HTTP webhooks (port 3002)        │
│  agent-memory.ts ── Persistent agent memory     │
│  memory-index.ts ── Three-tier Hebbian memory   │
│  database-sqlite.ts ── SQLite + FTS5 search     │
│  otter.ts ──── Otter.ai transcript import       │
│  personas.ts ─ AI voice personality configs     │
│  projects.ts ─ Project/task management          │
│  telegram.ts ─ Approval requests & alerts       │
│  pii-vault.ts ─ AES-256 encrypted PII storage  │
│                                                 │
│  ┌──── IPC Bridge (contextBridge) ────┐         │
│  │  preload/index.ts                  │         │
│  │  Exposes typed window.api object   │         │
│  └────────────────────────────────────┘         │
│                                                 │
│  Renderer Process (React)                       │
│  ├── Chat ─── Query meeting transcripts         │
│  ├── Import ─ Fetch from Otter.ai               │
│  ├── Conversations ─ Browse transcript library  │
│  ├── Calls ── Initiate & monitor AI calls       │
│  ├── WhatsApp ── Message inbox (WIP)            │
│  ├── Projects ── Workflow management            │
│  ├── Personas ── AI personality editor          │
│  ├── Content Pipeline ── Video review queue     │
│  └── Settings ── API keys & preferences         │
└─────────────────────────────────────────────────┘
```

### IPC Pattern

All main <-> renderer communication flows through Electron's IPC with a typed context bridge:

1. **Renderer** calls `window.api.calls.initiate(phone, instructions, ...)`
2. **Preload** maps to `ipcRenderer.invoke("calls:initiate", ...)`
3. **Main** handles via `ipcMain.handle("calls:initiate", handler)`
4. Response resolves as a typed Promise in the renderer

### Data Storage

All data is stored as local JSON files and SQLite — no external database required.

```
%APPDATA%/secondbrain/
├── config.json              # API keys and settings
├── secondbrain.db           # SQLite (approvals, whitelist, conversations FTS)
├── data/
│   ├── conversations/       # Otter.ai transcripts (meta.json + transcript.txt)
│   ├── calls/               # Call records (one JSON per call)
│   ├── personas.json        # AI voice personalities
│   ├── projects.json        # Projects and tasks
│   ├── agent/
│   │   ├── EA_MEMORY.md     # Persistent agent memory (Markdown)
│   │   └── memory/          # Three-tier indexed memory
│   └── pii-vault/           # AES-256 encrypted sensitive data
└── content-review/          # Video approval queue
```

---

## The Memory System

SecondBrain uses a **three-tier Hebbian memory** architecture designed to minimize token spend while keeping relevant context accessible.

### Why This Matters

LLM context windows are expensive. Stuffing every fact into every prompt wastes tokens and money. The memory system solves this by organizing knowledge into tiers based on recency and relevance, so only what matters right now gets loaded into the prompt.

### How It Works

```
Tier 1 — Working Memory (always loaded, zero cost)
├── MEMORY.md: ≤50 lines of pointers and recent facts
├── Loaded into every prompt automatically
└── Cost: ~200 tokens per request

Tier 2 — Indexed Memory (loaded on demand)
├── One Markdown file per topic (e.g., "dentist-project.md")
├── Each entry has a Hebbian weight (0.0 to 1.0)
├── Weights decay daily — unused facts fade naturally
├── Accessed facts get weight boosted (reinforcement)
├── Mentioned ≥3 times → auto-promoted to weight 0.8
├── MD5 dedup prevents duplicate entries
└── Cost: only loaded when relevant (~500-3000 tokens)

Tier 3 — Archive (loaded only on explicit recall)
├── Daily append-only log (archive/YYYY-MM-DD.md)
├── Entries below weight 0.05 pruned weekly
└── Cost: zero unless explicitly queried
```

**The result:** Most prompts carry ~200 tokens of memory context instead of thousands. The agent still has access to everything — it just doesn't pay for it until it needs it.

### Hebbian Decay

Inspired by how biological memory works: connections that fire together strengthen, unused connections weaken. Each memory entry has:

- **weight** (0.0-1.0): How relevant this fact is right now
- **decay_rate** (0.02-0.10): How fast it fades without reinforcement
- **mentions**: Access count — frequent access = higher weight
- **valid_at / invalid_at**: Temporal validity for facts that change over time

---

## The Approval System

The assistant operates autonomously but gates critical actions through a Telegram approval loop:

```
AI agent on a call → needs to share PII or make a commitment
        │
        ▼
Creates approval request in SQLite
Sends Telegram message to owner:
  "John Smith is asking for your address. YES to share, NO to decline."
        │
        ▼
Agent tells caller: "One moment while I check on that..."
(holds for up to 60 seconds)
        │
Owner replies YES/NO on Telegram
        │
        ▼
Agent continues with approved/denied response
Audit trail logged to SQLite
```

**Approval categories:**
- `share_pii` — Sharing personal information
- `transfer_call` — Transferring to the owner's private line
- `commit_to_action` — Making promises or commitments
- `reputation_risk` — Anything that could affect reputation
- `content_approval` — Publishing content

---

## Getting Started

### Prerequisites

- Node.js 18+
- Windows 10/11 (primary platform; macOS/Linux untested)
- API keys for services you want to use (see Settings page)

### Install

```bash
git clone https://github.com/yourusername/secondbrain.git
cd secondbrain
npm install
```

### Run in Development

```bash
npm run dev
```

This starts the Electron app with hot reload. On first launch, go to **Settings** and configure your API keys:

| Key | Required For |
|-----|-------------|
| OpenAI API Key | Chat, call transcription, persona summaries |
| Vapi API Key | Outbound phone calls |
| Vapi Phone Number ID | Caller ID for outbound calls |
| Telegram Bot Token | Approval requests and notifications |
| Telegram Chat ID | Your Telegram user ID |
| Otter.ai credentials | Meeting transcript import |
| Anthropic API Key | Agent reflections and behavior tuning |

### Build

```bash
npm run build        # Compile TypeScript
npm run dist         # Build Windows installer (.exe)
```

### Test

```bash
npm test             # Vitest unit tests
npm run test:e2e     # Playwright E2E tests
npx tsc --noEmit     # Type check
```

---

## Project Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App entry, window creation, startup
│   ├── ipc-handlers.ts      # All IPC handler registrations
│   ├── config.ts            # Configuration loading/saving
│   ├── chat.ts              # LLM chat with conversation context
│   ├── calls.ts             # Vapi.ai call lifecycle
│   ├── personas.ts          # AI voice personalities
│   ├── projects.ts          # Project/task management
│   ├── agent-memory.ts      # Persistent agent memory (Markdown)
│   ├── memory-index.ts      # Three-tier Hebbian memory
│   ├── database-sqlite.ts   # SQLite schema and migrations
│   ├── server.ts            # HTTP server for Vapi webhooks
│   ├── telegram.ts          # Telegram bot integration
│   ├── otter.ts             # Otter.ai API client
│   ├── pii-vault.ts         # AES-256 encrypted PII storage
│   └── empire/              # Content generation pipeline (Python)
├── preload/
│   └── index.ts             # Context bridge (window.api)
└── renderer/
    └── src/
        ├── App.tsx           # Tab router and sidebar
        ├── pages/            # Feature pages (Chat, Calls, Projects, etc.)
        ├── components/       # Shared UI components
        └── lib/              # Client utilities (WebRTC audio, etc.)
```

---

## Design Principles

1. **Autonomous but gated** — The assistant runs independently. Critical actions require explicit approval.
2. **Local-first** — All data stored on your machine. No cloud database. No vendor lock-in.
3. **Cost-optimized** — Cheap models for automated tasks (gpt-4o-mini), expensive models only where quality demands it (live voice calls). Claude Max plan for zero-cost agent sessions.
4. **Persistent memory** — Every interaction is logged. Memory survives restarts. Hebbian decay keeps it relevant.
5. **Graceful degradation** — External services down? Fall back to local data. No hard failures.
6. **Transparency** — All decisions logged with timestamps. PII sharing audited. Reputation risks flagged.

---

## Teaching the Agent About You

SecondBrain's agent learns and improves over time. Here's how the learning pipeline works:

### On First Launch

The app creates a generic `EA_MEMORY.md` in your local data directory (`%APPDATA%/secondbrain/data/agent/`). Edit this file to tell the agent about yourself — your name, location, communication preferences, active projects. The more context you give it, the better it performs.

### After Every Call

The agent automatically runs a **post-call reflection** — it reviews the transcript, extracts learnings, and appends them to its memory file. These reflections include:
- What worked and what didn't
- New contact information discovered
- Patterns to apply to future calls

Learnings are written to the agent's local memory AND indexed into the Tier 2 Hebbian memory system, so they naturally influence future prompts.

### Memory as a Living Document

The agent's memory files are Markdown. You can edit them directly, add sections, correct mistakes. The agent treats its memory as ground truth. If you want it to change behavior, update the memory.

### Personal Config Repo (Recommended)

For backing up your memory files, personal CLAUDE.md, and API configs, we recommend maintaining a **private companion repo** alongside this public one. This follows the [OpenClaw config pattern](https://github.com/TechNickAI/openclaw-config):

```
your-projects/
├── secondbrain/              # This public repo (code)
└── secondbrain-config/       # Your private repo (personal data)
    ├── memory/               # Your Tier 1/2/3 memory files
    ├── CLAUDE.md             # Your personal project instructions
    └── install.sh            # Symlinks private files into the public repo
```

The `install.sh` script creates symlinks so your personal files appear in the right locations within the public repo, but are never committed to it (`.gitignore` ensures this). See `memory.example/` for the expected file structure.

---

## Caveats

This project is under active development. Some honest context:

- **Windows-primary.** Built and tested on Windows 10. macOS and Linux are untested.
- **Single-user design.** This is a personal assistant, not a multi-tenant SaaS. Auth, permissions, and multi-user concerns are out of scope.
- **Many features are partially built.** WhatsApp integration, daily briefings, knowledge graph, and inbound call routing exist in code but are not fully tested or may have known issues.
- **The content pipeline assumes a specific external workflow** (video generation → review → YouTube upload). It won't be useful out of the box without adaptation.
- **API keys are required** for most features. Without them, only the settings page and basic UI navigation work.
- **No mobile app.** Desktop Electron only.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and development guidelines.

---

## License

MIT
