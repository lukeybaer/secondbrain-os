# SecondBrain Architecture

## Overview

SecondBrain is an Electron desktop application built with TypeScript, React, and SQLite. It is designed as a local-first autonomous executive assistant that integrates multiple data sources, AI reasoning, real-time telephony, and a hybrid local/cloud backend.

The repo is structured into three primary layers:

- `src/main`: Electron main process and backend services, native OS integration, database, AI orchestration, and background workers.
- `src/preload`: Electron preload bridge exposing strongly scoped IPC APIs to the renderer.
- `src/renderer/src`: React renderer UI, client navigation, and calls into backend services through `window.api`.

## High-Level Runtime Architecture

### Electron Process Model

SecondBrain uses the standard Electron split between:

- **Main process** (`src/main/index.ts`): creates the app window, initializes local services, registers IPC handlers, starts background workers, and launches a minimal HTTP server.
- **Renderer process** (`src/renderer/src/App.tsx` and page components): provides the user interface and interacts with the main process only through the preload API.
- **Preload script** (`src/preload/index.ts`): exposes a hardened `window.api` object to the renderer, mapping UI actions to `ipcRenderer.invoke` and event listeners.

### Startup flow

1. Electron starts and runs `src/main/index.ts`.
2. Config is loaded from `%APPDATA%/secondbrain/config.json` via `src/main/config.ts`.
3. The app initializes local storage:
   - SQLite database via `src/main/database-sqlite.ts`
   - PII vault via `src/main/pii-vault.ts`
   - Memory index via `src/main/memory-index.ts`
4. The browser window is created and the preload script is attached.
5. IPC handlers are registered via `src/main/ipc-handlers.ts` and `src/main/briefing-api.ts`.
6. Background services start:
   - `src/main/server.ts` starts a local HTTP server
   - `src/main/command-queue.ts` processes queued agent tasks
   - `src/main/knowledge-worker.ts` handles background knowledge and memory work
   - `src/main/data-sync.ts` syncs remote data/state
   - `src/main/scheduler.ts` runs scheduled jobs
   - `src/main/otter-ingest.ts` polls Otter.ai for new transcripts
   - `src/main/startup-checks.ts` validates system prerequisites

## Key Modules and Responsibilities

### `src/main/index.ts`

- Bootstraps the Electron app.
- Creates the main `BrowserWindow`.
- Registers custom `media://` protocol support for local media playback.
- Ensures single-instance locking through both Electron and a temporary lock file.
- Starts core persistence and helper subsystems.

### `src/main/config.ts`

- Manages application configuration and API keys.
- Stores config in `config.json` inside Electron `app.getPath('userData')`.
- Defines default API models and cost policy guidance for OpenAI, Anthropic, and other providers.

### `src/main/ipc-handlers.ts`

- Maps renderer `window.api` calls to backend service functions.
- Handles major app features including:
  - configuration
  - Otter import
  - conversations
  - chat sessions
  - WhatsApp integration
  - SMS / Twilio
  - personas
  - call initiation and status
  - projects, tasks, todos
  - backups
  - PII scanning
  - agent memory
  - studio recording and processing
  - Time Machine capture and search
- Pushes event updates from main to renderer for realtime UI refreshes.

### `src/preload/index.ts`

- Exposes a safe `api` object to the renderer when `contextIsolation` is enabled.
- Routes IPC commands such as `api.calls.initiate(...)`, `api.whatsapp.connect()`, and `api.timemachine.search(...)`.
- Registers push event listeners for inbound SMS, WhatsApp messages, call status updates, task updates, and studio progress.

### `src/renderer/src/App.tsx`

- Implements the main application shell and navigation sidebar.
- Loads pages for core app sections: Briefing, Chat, Import, Conversations, Messages, WhatsApp, Calls, Projects, Tasks, Personas, Content Pipeline, Studio, Time Machine, Backups, Settings.
- Uses `window.api` to fetch data, invoke actions, and subscribe to events.

## Data Sources and Integrations

### Otter.ai

- `src/main/otter.ts` and `src/main/otter-ingest.ts` support Otter authentication, transcript fetching, and scheduled ingestion.
- The UI can open a login browser window and capture Otter cookies.
- Imported transcripts are tagged and stored as conversations.

### WhatsApp

- `src/main/whatsapp-web.ts` uses `whatsapp-web.js` to connect to personal WhatsApp via QR code.
- The main process manages status, chat lists, chat history, message sending, and event subscriptions.
- Incoming WhatsApp messages are forwarded to the renderer and ingested into the system.

### Telephony / Vapi

- `src/main/calls.ts` handles outbound voice calls through Vapi.
- The app can initiate calls, refresh status, load call records, hang up, and sync callbacks.
- `src/main/server.ts` listens for webhook events from Vapi on local port `3002`, including:
  - function-call approval requests
  - status updates
  - transcripts
- Approval requests are persisted into SQLite and optionally routed to Telegram.

### SMS / Twilio

- `src/main/twilio-sms.ts` handles inbound/outbound SMS and media messaging.
- The renderer can list, search, send SMS, and ingest webhook payloads.

### Telegram

- `src/main/telegram.ts` is responsible for sending approval notifications and briefing alerts.
- Telegram acts as the trusted owner notification channel for approval gating.

### Graphiti / Knowledge Graph

- `src/main/graphiti-client.ts` encapsulates communication with an external Graphiti knowledge graph.
- Graphiti is not bundled in the Electron app; it is expected to run on a companion always-on server.
- The graph stores time-aware facts, entities, and relationships.

## Data Storage and Persistence

### Local JSON files

- Config and feature-specific data are stored in the local Electron user data directory.
- Example data stores include personas, projects, session files, and content pipeline drafts.

### SQLite database

- `src/main/database-sqlite.ts` provides a persistent relational store using `better-sqlite3`.
- Tables include:
  - `pending_approvals`
  - `whitelist`
  - `reputation_events`
  - `process_locks`
  - `tm_frames`, `tm_frames_fts`
  - `tm_audio_segments`, `tm_audio_fts`
  - `tm_conversations`
- The app uses FTS5 search indexes for Time Machine OCR and audio transcript full-text search.

### PII vault

- `src/main/pii-vault.ts` manages encrypted storage of sensitive fields.
- Sensitive data is separated from general app data and encrypted at rest.

### Time Machine archive

- Screenshots, audio segments, transcripts, and metadata are stored as local assets.
- A local HTTP media protocol and file loading support playback from the renderer.
- The app also supports uploading archived assets to S3 via remote sync.

## Agent & Memory Architecture

### Three-tier memory

SecondBrain implements layered memory for efficient context and long-term recall:

1. **Working Memory**
   - Recently active facts and pointers.
   - Loaded quickly and included in immediate prompts.
2. **Indexed Memory**
   - Per-topic indexed memory blocks stored in the file system.
   - Managed by `src/main/memory-index.ts` and `src/main/memory-temperature.ts`.
3. **Archive**
   - Append-only daily logs and raw transcripts.
   - Queried only when needed to minimize token usage.

### Agent memory and reflections

- `src/main/agent-memory.ts` reads and writes memory files for the agent.
- `src/main/agent-reflection.ts` performs summarization and post-call reflection.
- `src/main/claude-runner.ts` and `src/main/claude-overlay.ts` provide hooks to Claude-based command execution and overlay interactions.

## UI / Renderer Flows

### Top-level pages

The React UI contains dedicated pages for:

- `Briefing`: daily briefing management and dispatch.
- `Chat`: conversational AI chat interface.
- `Import`: Otter transcript import workflows.
- `Conversations`: browse and search imported conversations.
- `Messages` / `WhatsApp`: SMS and WhatsApp messaging.
- `Calls`: outbound telephony and call status.
- `Projects` / `Tasks` / `Todos`: workflow and task management.
- `Personas`: voice persona configuration.
- `Content Pipeline`: review and approve generated media.
- `Studio`: recording and production controls.
- `TimeMachine`: screen capture search and playback.
- `Backups`: snapshot and restore controls.
- `Settings`: API keys and app preferences.

### Event-driven updates

The renderer subscribes to push events from main for:

- incoming SMS (`sms:onInbound`)
- WhatsApp status/message updates (`whatsapp:onStatusChange`, `whatsapp:onMessage`)
- call status updates (`calls:onStatusPush`)
- background task pushes (`tasks:onPush`)
- studio progress updates (`studio:onProgress`)

This enables near-real-time UI updates without polling.

## Local HTTP API

### `src/main/server.ts`

- Hosts a minimal built-in HTTP server listening on port `3002`.
- Implements REST routes for health checks, Vapi webhooks, SMS ingestion, briefing file access, and approval orchestration.
- Uses a lightweight router and JSON request parsing.
- Stores approval state in SQLite and resolves callbacks when Telegram responses arrive.

### Purpose

The local server is primarily used for:

- receiving external webhooks from telephony and SMS providers
- bridging live telephony events into local approval workflows
- exposing simple local REST endpoints for background jobs and remote sync

## Build and Tooling

### Build system

- `electron-vite` is used to bundle the Electron app.
- `vite` builds the renderer and packages the main process with TypeScript support.
- `electron-builder` and `electron-packager` are configured in `package.json` for distribution.

### Scripts

- `npm run dev`: start Electron development mode.
- `npm run build`: compile the app.
- `npm run dist`: package a Windows installer.
- `npm test`: run Vitest.
- `npm run test:e2e`: run Playwright browser tests.
- `npm run verify:foundation`: run foundational integrity tests.

## Important Technical Details

### Security and sandboxing

- `contextIsolation` is enabled in the renderer.
- The renderer only accesses native Electron functionality via the `window.api` object.
- Node integration is disabled in the renderer.
- The app denies camera/microphone permissions by default.

### Single-instance guard

- The app uses Electron's `requestSingleInstanceLock()`.
- It also maintains a temp lock file at `${os.tmpdir()}/secondbrain-app.lock` to prevent duplicate instances across dev and packaged builds.

### Media loading

- A custom `media://` protocol is registered so local media files can be played safely from the renderer.
- This avoids cross-protocol restrictions when loading assets from disk.

## Summary

This codebase is a hybrid desktop AI assistant with a strong local-first design:

- UI in React + Electron renderer
- Backend orchestration, telephony, AI, and storage in the Electron main process
- Secure IPC through a typed preload bridge
- Local persistence via SQLite, JSON, and encrypted vaults
- External integrations for Otter.ai, WhatsApp, SMS, Vapi telephony, Telegram, and Graphiti
- Background worker patterns for ingestion, scheduling, and knowledge management

The overall architecture is organized around enabling an autonomous agent experience while keeping data ownership local and minimizing expensive external LLM usage.
