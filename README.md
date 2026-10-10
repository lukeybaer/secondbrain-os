# SecondBrain

**An open-source AI executive assistant that lives on your desktop.** It makes phone calls, scans your Otter.ai meetings, recognizes who is speaking by voice, and runs skills that learn from every run, all with your existing Claude Pro or Max subscription.

No per-token API costs. No cloud dependency for core features. One Electron app that turns Claude into a full-time executive assistant.

---

## Why SecondBrain?

Most AI tools are chatbots — you ask a question, you get an answer. SecondBrain is different. It's an **autonomous agent** that takes action on your behalf:

- **It makes phone calls for you.** Need to find a dentist who'll do a cleaning without requiring new X-rays? SecondBrain calls them one by one, negotiates, tracks outcomes, and reports back — while you listen in live if you want.
- **It remembers everything.** Every conversation, every meeting, every WhatsApp message gets saved and indexed on your machine. Ask "what did PRIVATE_NAME say about the project timeline last Tuesday?" and get an answer in seconds.
- **It watches your screen.** The Time Machine captures screenshots and audio continuously, OCRs every frame, and makes your entire digital life full-text searchable. Like macOS Rewind, but open source and private.
- **It costs almost nothing to run.** The entire system uses your Claude Pro or Max subscription for all LLM reasoning. No OpenAI bills, no per-token metering, no surprise invoices. Claude Code handles the agent loop natively, which means your flat-rate subscription powers an always-on executive assistant.

---

## Features

### AI Phone Calls (Vapi.ai)

Configure AI voice personas, initiate outbound calls, and listen in live via WebRTC. The agent follows your instructions, navigates phone trees with real DTMF tones, requests approval via Telegram before sharing sensitive info, and records full transcripts. Chain calls into campaigns — the agent learns from each call and refines its approach.

### Time Machine (Screen + Audio Recording)

Continuous screenshot capture (every 3 seconds) with OCR text extraction, plus system audio recording in hourly Opus segments. Everything is indexed in SQLite with FTS5 full-text search. Browse a visual timeline, search by text on screen, or let the AI reference what you were doing at any point in time. Local retention with automatic S3 archival.

### WhatsApp Integration

Connect your personal WhatsApp via QR code (whatsapp-web.js) or the Meta Business Cloud API. Incoming and outgoing messages are captured, enriched with contact intelligence, and ingested into the knowledge graph. Full chat history bulk import with AI-powered entity extraction — people, topics, decisions, and personal details are all indexed automatically.

### Temporal Knowledge Graph (Graphiti), optional

SecondBrain can feed calls, meetings, and messages into a self-hosted [Graphiti](https://github.com/getzep/graphiti) knowledge graph for time-aware search. It ships turned off: `config/graphiti-runtime-policy.json` sets ingestion and recall to disabled, so nothing is sent to a graph until you run your own Graphiti service and enable that policy.

### Phone Number Takeover (Twilio + Vapi)

Port your real phone number to Twilio, route it through Vapi for intelligent inbound screening. The AI answers, classifies intent, and either handles the call autonomously, requests your approval, or bridges you in live. Outbound SMS/MMS via Twilio Cloud API with attachment handling.

### Backup Management

Enterprise-grade 6-tier backup retention: daily (30 days), tri-daily (60 days), weekly (90 days), monthly (1 year), quarterly (3 years), yearly (forever). Automated 3:30 AM snapshots of all data, config, and SQLite databases. S3-backed with local copies. Full restore capability with manifest tracking.

### Three-Tier Hebbian Memory

Biologically-inspired memory architecture that minimizes token spend while keeping the agent contextually aware:

| Tier               | What                                                                                     | Cost                |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| **Working Memory** | Always-loaded pointers and recent facts (~50 lines)                                      | ~200 tokens/request |
| **Indexed Memory** | Per-topic files with Hebbian weight decay — unused facts fade, accessed facts strengthen | Loaded on demand    |
| **Archive**        | Daily append-only logs, auto-pruned when weight drops below threshold                    | Zero unless queried |

The result: most prompts carry ~200 tokens of memory context instead of thousands. The agent still has access to everything — it just doesn't pay for it until it needs it.

### Otter.ai Meeting Scanning

The desktop app checks Otter.ai every 5 minutes, then tags, saves, and indexes each new transcript. You can also pull a date range from the command line. See [docs/otter-scanning.md](docs/otter-scanning.md).

### Voice Matching

Recognize who is speaking in recorded calls with local speaker separation, voice embeddings, a speaker resolver, and a people-file sync, all on your own machine. See [docs/voice-matching.md](docs/voice-matching.md).

### Skills That Learn

Scheduled skills read their recent lessons before each run and log a new lesson after it. A runnable example is included. See [docs/skills-framework.md](docs/skills-framework.md).

### Phone Brain

`claude-proxy.js` lets Vapi phone calls use your Codex or Claude subscription as the language model, switching lanes automatically when one provider fails. See [docs/phone-brain.md](docs/phone-brain.md).

### Project & Task Tracking

Organize call campaigns and multi-step workflows. Link tasks to phone calls, track outcomes (agreed / declined / no-answer / needs-follow-up), and let the agent work through a list autonomously.

### Telegram Approval System

Critical actions are gated through a real-time Telegram approval loop. When the AI needs to share your address, make a commitment, or take a reputation-affecting action, it pauses, sends you a Telegram message with context, and waits for your YES/NO. Full audit trail in SQLite.

---

## Architecture

### The Claude Pro/Max Advantage

This is one of the most beautiful parts of SecondBrain's architecture: **every LLM call runs through your existing Claude Pro or Max subscription.** Claude Code provides the agent runtime natively — tool use, multi-step reasoning, memory management, and autonomous execution are all handled by your flat-rate plan.

There are no per-token API costs for the core agent loop. No metering. No surprise bills. Your $20/month Pro subscription (or Max for heavier usage) powers an always-on executive assistant that makes phone calls, processes hundreds of WhatsApp messages, generates daily briefings, and manages your entire digital life.

External APIs are only used for specialized capabilities that Claude can't provide directly: Vapi for voice synthesis/telephony, Twilio for SMS/phone routing, and Telegram for mobile notifications. Everything else — reasoning, summarization, entity extraction, memory management, conversation tagging — runs on Claude.

### Hybrid Local + Cloud

SecondBrain runs as a desktop Electron app with a cloud companion on AWS:

```
┌──────────────────────────────────────────────────────────────┐
│  Your Desktop (Electron)                                      │
│                                                                │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐    │
│  │ React UI    │  │ Node.js Main │  │ SQLite + FTS5     │    │
│  │ Dark theme  │←→│ Process      │←→│ Local JSON store  │    │
│  │ All pages   │  │ IPC bridge   │  │ Encrypted PII     │    │
│  └─────────────┘  └──────┬───────┘  └───────────────────┘    │
│                          │                                     │
│  ┌───────────────────────┼───────────────────────────────┐    │
│  │ Time Machine          │  WhatsApp     Content Pipeline│    │
│  │ FFmpeg capture ───────│──────────────────────────────→│    │
│  │ OCR + FTS5 search     │  Puppeteer    Video review    │    │
│  │ S3 archival           │  Cloud API    Social posts    │    │
│  └───────────────────────┼───────────────────────────────┘    │
└──────────────────────────┼────────────────────────────────────┘
                           │ SSH tunnel + HTTPS
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  AWS EC2 (Always-On Companion)                                │
│                                                                │
│  ┌─────────────────────┐  ┌──────────────────────────────┐   │
│  │ Node.js API Server  │  │ Graphiti (Docker)            │   │
│  │ Port 3001           │  │ Temporal Knowledge Graph     │   │
│  │                     │  │ Neo4j + Vector embeddings    │   │
│  │ • Vapi webhooks     │  │ Port 8000 (localhost)        │   │
│  │ • Telegram commands │  │                              │   │
│  │ • Session registry  │  │ • Entity deduplication       │   │
│  │ • Data sync cache   │  │ • Contradiction resolution   │   │
│  │ • Intent classifier │  │ • Time-aware fact retrieval  │   │
│  └─────────────────────┘  └──────────────────────────────┘   │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ S3 Storage                                              │  │
│  │ • Time Machine screenshots + audio archive              │  │
│  │ • 6-tier backup snapshots (daily → yearly)              │  │
│  │ • Lifecycle policies for cost optimization              │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  Elastic IP │ PM2 process manager │ SSH key auth              │
└──────────────────────────────────────────────────────────────┘
```

**Why hybrid?** The desktop app gives you local-first data ownership, zero-latency UI, and native OS integration (screen capture, audio recording, system tray). The EC2 companion handles always-on services that need to receive webhooks 24/7 (Vapi call events, Telegram commands) and runs the Graphiti knowledge graph in Docker.

The two communicate over an SSH tunnel — the Electron app forwards port 8000 for Graphiti access and syncs state to the EC2 server via HTTPS. If the EC2 is unreachable, the desktop app gracefully degrades: local memory and SQLite search continue working, webhook-dependent features queue until reconnection.

### AWS Infrastructure

| Service                 | Purpose                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **EC2**                 | Always-on Node.js server + Graphiti Docker container. Elastic IP for stable webhook endpoints. PM2 for process management and auto-restart. |
| **S3**                  | Time Machine archive (screenshots + audio), backup snapshots with lifecycle policies. Bucket: private, server-side encryption.              |
| **SSM Parameter Store** | Secure storage for API tokens and secrets. Retrieved at runtime, never hardcoded.                                                           |
| **IAM**                 | Scoped roles for S3 access and SSM reads. Principle of least privilege.                                                                     |

### Data Flow

```
Otter.ai transcripts ──┐
WhatsApp messages ──────┤
Phone call transcripts ─┤──→ AI Tagger ──→ SQLite FTS5 ──→ Searchable
SMS / MMS ──────────────┤                 ──→ Graphiti ────→ Knowledge Graph
Screen OCR text ────────┤                 ──→ Memory ──────→ Agent Context
Email threads ──────────┘                 ──→ Contacts ────→ Enrichment
```

Every data source flows through a unified ingestion pipeline: raw archival first (immutable), then AI tagging, then fan-out to search index, knowledge graph, memory tiers, and contact enrichment. The raw payload is always preserved for future reprocessing.

### IPC Pattern

All main ↔ renderer communication flows through Electron's IPC with a typed context bridge:

1. **Renderer** calls `window.api.calls.initiate(phone, instructions, ...)`
2. **Preload** maps to `ipcRenderer.invoke("calls:initiate", ...)`
3. **Main** handles via `ipcMain.handle("calls:initiate", handler)`

Response resolves as a typed Promise. No Node APIs leak into the renderer process.

### Data Storage

All data is local JSON files and SQLite — no external database required for core functionality:

```
%APPDATA%/secondbrain/              (macOS: ~/Library/Application Support/secondbrain/)
├── config.json                     # API keys and settings
├── secondbrain.db                  # SQLite (search, approvals, conversations)
├── data/
│   ├── conversations/              # Meeting transcripts
│   ├── calls/                      # Call records (one JSON per call)
│   ├── personas.json               # AI voice personalities
│   ├── projects.json               # Projects and tasks
│   ├── agent/
│   │   ├── EA_MEMORY.md            # Persistent agent memory
│   │   └── memory/                 # Three-tier indexed memory
│   ├── pii-vault/                  # AES-256 encrypted sensitive data
│   └── timemachine/                # Screenshots, audio, OCR index
├── backups/                        # Local backup snapshots
└── content-review/                 # Video approval queue
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Windows 10/11 or macOS
- A Claude Pro or Max subscription (for the agent runtime)
- API keys for external services you want to use (see Settings page)

### Install

```bash
# clone this repository with the HTTPS URL shown by the Code button, then:
cd secondbrain-os
npm install
```

### Run

```bash
npm run dev
```

This starts the Electron app with hot reload. On first launch, open **Settings** and configure your API keys:

| Key                  | Required For                      |
| -------------------- | --------------------------------- |
| Vapi API Key         | Outbound AI phone calls           |
| Vapi Phone Number ID | Caller ID for outbound calls      |
| Telegram Bot Token   | Approval loop and daily briefings |
| Telegram Chat ID     | Your Telegram user ID             |
| Otter.ai credentials | Meeting transcript import         |
| Twilio credentials   | SMS/MMS and inbound call routing  |

### Build

```bash
npm run build        # Compile TypeScript
npm run dist         # Package for your platform
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
├── main/                        # Electron main process
│   ├── index.ts                 # App entry, window creation, startup
│   ├── ipc-handlers.ts          # All IPC handler registrations
│   ├── config.ts                # Configuration management
│   ├── calls.ts                 # Vapi.ai call orchestration
│   ├── timemachine.ts           # Screen + audio capture engine
│   ├── timemachine-db.ts        # Time Machine SQLite + FTS5
│   ├── whatsapp-web.ts          # WhatsApp Web (Puppeteer)
│   ├── whatsapp.ts              # WhatsApp Cloud API
│   ├── briefing.ts              # Daily briefing generator
│   ├── graphiti-client.ts       # Temporal knowledge graph (MCP)
│   ├── backups.ts               # 6-tier backup management
│   ├── scheduler.ts             # Cron-style task scheduler
│   ├── agent-memory.ts          # Persistent agent memory
│   ├── memory-index.ts          # Three-tier Hebbian memory
│   ├── database-sqlite.ts       # SQLite schema + migrations
│   ├── server.ts                # HTTP webhooks (Vapi, Twilio)
│   ├── telegram.ts              # Telegram bot integration
│   ├── pii-vault.ts             # AES-256 encrypted PII storage
│   ├── video-pipeline.ts        # Content generation pipeline
│   └── __tests__/               # Vitest unit tests
├── preload/
│   └── index.ts                 # Context bridge (window.api)
└── renderer/
    └── src/
        ├── App.tsx              # Tab router and sidebar
        └── pages/               # Feature pages
            ├── Chat.tsx         # AI-powered conversation search
            ├── Calls.tsx        # Phone call management + listen-in
            ├── TimeMachine.tsx  # Visual timeline + search
            ├── WhatsApp.tsx     # Message inbox
            ├── ContentPipeline.tsx  # Video review queue
            ├── Projects.tsx     # Workflow management
            └── Settings.tsx     # API keys and preferences
```

---

## Design Principles

1. **Autonomous but gated.** The assistant acts independently. Critical actions (sharing PII, making commitments, publishing content) require explicit approval via Telegram.
2. **Local-first.** All data lives on your machine. No cloud database. No vendor lock-in. The EC2 companion is optional and enhances — it doesn't gatekeep.
3. **Flat-rate AI.** Claude Pro/Max subscription handles all LLM reasoning at zero marginal cost. External APIs only where Claude can't (voice synthesis, telephony, notifications).
4. **Persistent memory.** Every interaction feeds the knowledge graph. Hebbian decay keeps context relevant without manual curation.
5. **Raw archival.** Every data source saves the full raw payload before processing. You can always reprocess historical data with better models later.
6. **Graceful degradation.** External service down? Fall back to local data. No hard failures, no blocking dependencies.

**Patterns cheat sheet:** the architectural patterns behind SecondBrain (3-tier personal memory, hashtag hooks, daily briefing as contract, foundation invariants, session archive to S3, subagent quarterback, raw archival) are documented with file-path citations in [`docs/patterns.md`](docs/patterns.md). Lift whatever's useful for your own projects.

---

## Teaching the Agent About You

SecondBrain's agent learns from every interaction, but you can accelerate this:

### Memory Files

The agent stores knowledge in Markdown files at `%APPDATA%/secondbrain/data/agent/memory/`. You can read and edit these directly — the agent treats its memory as ground truth. Add facts about yourself, your preferences, your contacts, and your projects.

### Post-Call Reflection

After every phone call, the agent automatically reviews the transcript, extracts learnings, and updates its memory. Contact information, communication preferences, and relationship context all get indexed for future calls.

### Knowledge Graph

An optional Graphiti knowledge graph can build a time-aware model of your conversations and commitments. It is off by default. See the Graphiti section under Features.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and code standards.

---

## License

MIT

## Public application scope

This snapshot includes the Electron application and reusable libraries. Run `npm install`, then `npm run build` or `npm run dev`. Private briefing IPC, scheduled automations, and the operator HTTP service are excluded from the public entry. Otter transcript polling runs once Otter.ai credentials are configured. Operator release tools and scripts with excluded dependencies are also omitted. Those services require a separate implementation and configuration; they are not activated by this app.
