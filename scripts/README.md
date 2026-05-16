# scripts/

Utility scripts that support SecondBrain's backend workflows. Scripts are
grouped by domain below. Languages used: TypeScript (`.ts`), JavaScript
(`.js` / `.mjs`), Python (`.py`), PowerShell (`.ps1`), Shell (`.sh`), and
Windows batch (`.bat` / `.cmd`).

> **Running TypeScript scripts** — use `npx ts-node <script>.ts` or
> `node --loader ts-node/esm <script>.ts` (Node 18+). A `tsconfig.node.json`
> at the repo root covers the main process build.

---

## Daily briefing

| Script | Lang | Purpose |
|---|---|---|
| `daily-briefing.bat` | bat | Windows launcher — runs the morning briefing pipeline end-to-end |
| `pre-briefing-diagnostic.js` | js | Checks all data sources are reachable before generation starts |
| `pre-briefing-diagnostic.bat` | bat | Windows wrapper for the diagnostic above |
| `briefing-to-docx.py` | py | Converts a generated Markdown briefing to a Word `.docx` file and saves to Desktop |
| `open-latest-briefing.cmd` | cmd | Opens the most recently generated briefing file in the default app |

---

## Knowledge graph (Graphiti)

| Script | Lang | Purpose |
|---|---|---|
| `graphiti-cli.mjs` | mjs | Interactive CLI for querying and managing the Graphiti temporal knowledge graph (search nodes, episodes, wipe, reseed) |
| `seed-graphiti.ts` | ts | Seeds the Graphiti graph from the local memory files and contact data on first setup |
| `backfill-gmail-to-graphiti.mjs` | mjs | One-shot backfill — reads historical Gmail threads and inserts them as episodes into Graphiti |
| `backfill-linkedin-to-graphiti.mjs` | mjs | One-shot backfill — reads LinkedIn scan data and inserts contacts/relationships into Graphiti |

---

## Ingest & data pipeline

| Script | Lang | Purpose |
|---|---|---|
| `ingest-queue-drain.ts` | ts | Drains the ingest queue: processes all pending items (calls, WhatsApp, Gmail, meetings) |
| `ingest-gmail-watcher.mjs` | mjs | Long-running watcher — polls Gmail for new messages and enqueues them for ingest |
| `ingest-linkedin-watcher.mjs` | mjs | Long-running watcher — polls LinkedIn for profile changes and enqueues updates |
| `whatsapp-ingest-standalone.js` | js | Standalone WhatsApp message ingest — used when the Electron app is not running |
| `fetch-recent-gmail.py` | py | Fetches recent Gmail messages via the Gmail API and saves raw JSON to disk |
| `send-gmail.py` | py | Sends an email via the Gmail API (used by the agent for outbound email) |
| `gmail-attach.js` | js | Handles Gmail attachment download and local storage |
| `transcribe.py` | py | Transcribes an audio file using Whisper (used for meeting audio and call recordings) |

---

## Session & memory

| Script | Lang | Purpose |
|---|---|---|
| `session-search.ts` | ts | Full-text search across archived Claude Code session transcripts stored in SQLite |
| `sb-session-search.py` | py | Python variant of session search — used in scripts that can't import TypeScript |
| `backfill-sessions-to-s3.py` | py | Backfills all local session archives to S3 (one-shot, run after setting up AWS) |
| `build-sessions-db-py.py` | py | Builds the local SQLite sessions database from raw `.jsonl` transcript files |
| `recurate-all.ts` | ts | Re-runs curation/tagging over all existing sessions (useful after model upgrades) |

---

## Content pipeline (video & social)

| Script | Lang | Purpose |
|---|---|---|
| `produce-linkedin-video.js` | js | Original LinkedIn video production workflow (v1) |
| `produce-linkedin-v2.js` | js | LinkedIn video production v2 — improved scripting and b-roll logic |
| `produce-linkedin-v3.js` | js | LinkedIn video production v3 — current version with override support |
| `write-v3-override.js` | js | Writes a manual override for a v3 LinkedIn video script before rendering |
| `final-render.js` | js | Triggers the final render pass on a video that has passed content review |
| `ec2-build-from-queue.py` | py | Reads the EC2 build queue and triggers remote video rendering jobs on EC2 |
| `sync-videos-from-ec2.js` | js | Downloads completed rendered videos from EC2 to the local content-review folder |
| `hyperframes-thumbnail.js` | js | Generates thumbnails for Hyperframes-format video content |
| `setup-hyperframes.sh` | sh | One-time setup for the Hyperframes rendering environment |
| `seedance-broll.py` | py | Generates B-roll footage using the Seedance AI video API |
| `push-stale-uploads-now.js` | js | Immediately pushes any videos stuck in the stale-upload queue |
| `stale-red-escalation.js` | js | Escalates uploads that have been red (failed) for more than N hours via Telegram |
| `feature-backlog.js` | js | Reads and formats the feature backlog for the daily briefing content-pipeline section |
| `seed-feature-backlog.js` | js | Seeds the feature backlog database from a source JSON file |

---

## People & relationship intelligence

| Script | Lang | Purpose |
|---|---|---|
| `linkedin-bulk-scan.js` | js | Bulk-scans a list of LinkedIn profiles and saves raw HTML + structured data |
| `linkedin-bulk-scan-login.cmd` | cmd | Handles LinkedIn login before bulk scan (saves session cookies) |
| `run-linkedin-scan.cmd` | cmd | Wrapper to kick off a named LinkedIn scan job |
| `people-health-check.js` | js | Scores relationship warmth for all contacts and flags anyone overdue for outreach |
| `collect-pain-events.js` | js | Scrapes and stores pain/health journal entries for the owner's personal health tracking |

---

## Agent & process management

| Script | Lang | Purpose |
|---|---|---|
| `launch-agents.ps1` | ps1 | PowerShell launcher — starts all background agent processes (watchers, scheduler, Claude proxy) |
| `claude-proxy-supervisor.js` | js | Supervises the Claude Code CLI proxy process and restarts it on crash |
| `run-scheduled-skill.js` | js | Runs a single named scheduled skill (called by Windows Task Scheduler) |
| `dispatch-context-helper.js` | js | Injects additional context into a Claude agent session dispatch |
| `build-amy-snapshot.js` | js | Builds a versioned snapshot of the Amy persona config for rollback |
| `register-scheduled-tasks.ps1` | ps1 | Registers all SecondBrain jobs in Windows Task Scheduler |
| `detect-monitors.ps1` | ps1 | Detects available monitors and outputs JSON (used by Time Machine to pick a capture target) |

---

## Backup & infrastructure

| Script | Lang | Purpose |
|---|---|---|
| `backup-cli.ts` | ts | CLI for the 6-tier backup system — create, list, restore, and verify snapshots |
| `health-self-heal.bat` | bat | Windows batch launcher for the automated health-check-and-self-heal loop |
| `verify-foundation.sh` | sh | Asserts all foundation invariants are met (Tier 1 memory, config, data dirs) |
| `install-git-hooks.sh` | sh | Installs the git hooks from `scripts/git-hooks/` into `.git/hooks/` |

---

## AWS Athena

Located in `scripts/athena/`.

| Script | Lang | Purpose |
|---|---|---|
| `sessions-ddl.sql` | sql | DDL for the Athena table that indexes S3-archived session transcripts |
| `setup-athena.sh` | sh | One-time setup — creates the Athena database, table, and S3 output location |

---

## Claude Code hooks

Located in `scripts/claude-hooks/`. These run automatically at Claude Code
lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`). See [`docs/HOOKS_GUIDE.md`](../docs/HOOKS_GUIDE.md)
for the full hook architecture.

| Script | Trigger | Purpose |
|---|---|---|
| `session-start-inject.sh` | SessionStart | Injects working memory and Tier 1 context into every session |
| `session-start-inject-ingest.sh` | SessionStart | Additionally triggers any pending ingest-queue items on session start |
| `briefing-context-inject.sh` | SessionStart | Injects the most recent briefing summary into sessions that need it |
| `git-context-inject.sh` | SessionStart | Injects current branch, recent commits, and diff summary |
| `recall-context-inject.mjs` | SessionStart | Injects Graphiti recall results relevant to the opening prompt |
| `usage-inject.sh` | SessionStart | Injects Claude token usage stats from the previous session |
| `archive-session-to-s3.sh` | Stop | Archives the completed session transcript to S3 |
| `flush-session.sh` | Stop | Flushes session state to disk and updates working memory |
| `notify-on-stop.sh` | Stop | Sends a Telegram notification when a long-running session ends |
| `em-dash-guard.mjs` | PreToolUse | Blocks file writes that contain em-dashes (house style rule) |
| `gap-guard.sh` | PreToolUse | Blocks tool use when a `#gap` knowledge gap is unresolved |
| `inbox-guard.sh` | PreToolUse | Prevents the agent from reading the inbox without an explicit instruction |
| `independence-guard.sh` | PreToolUse | Prevents the agent from taking autonomous actions outside approved scope |
| `memory-path-enforce.sh` | PreToolUse | Enforces that memory writes go to the correct tier path |
| `memory-validation.sh` | PreToolUse | Validates memory file structure before writes are committed |
| `vapi-validation.sh` | PreToolUse | Validates Vapi call parameters before the call is initiated |
| `content-qc-gate.sh` | PreToolUse | Blocks content publish until QC criteria are met |
| `ppl-guard.sh` | UserPromptSubmit | Intercepts `#ppl` hashtag commands and routes them to the people workflow |
| `gap-trigger.sh` | UserPromptSubmit | Intercepts `#gap` hashtag and opens the gap-capture workflow |
| `learn-trigger.sh` | UserPromptSubmit | Intercepts `#learn` hashtag and opens the learning-capture workflow |
| `learn-and-usage.sh` | PostToolUse | Updates Hebbian memory weights after tool use |
| `learn-and-usage.js` | PostToolUse | JS companion to `learn-and-usage.sh` for structured weight updates |
| `contact-enrichment.sh` | PostToolUse | Enriches contact files after call/message tool use |
| `force-completion.sh` | PostToolUse | Forces session completion when a blocking condition is met |
| `stall-detector.sh` | PostToolUse | Detects and alerts when the agent has been stuck for too long |
| `session-coordination.mjs` | PostToolUse | Coordinates multi-session state when parallel agents are running |
| `test-coverage-guard.mjs` | PostToolUse | Blocks commits that drop below the test-coverage threshold |
| `run-tests-before-pr.sh` | PostToolUse | Runs the test suite before any PR-creation tool use |
| `usage-tracker.js` | PostToolUse | Tracks per-session tool-use counts for the daily token-usage briefing section |

---

## Git hooks

Located in `scripts/git-hooks/`. Installed via `scripts/install-git-hooks.sh`.

| Script | Hook | Purpose |
|---|---|---|
| `commit-msg` | commit-msg | Enforces conventional commit format on every commit message |

---

## Vapi MCP server

Located in `scripts/vapi-mcp/`.

| Script | Lang | Purpose |
|---|---|---|
| `server.js` | js | MCP (Model Context Protocol) server that exposes Vapi call management as Claude tools |
