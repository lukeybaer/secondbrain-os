# SecondBrain patterns cheat sheet

Battle-tested architectural patterns from running an autonomous AI executive assistant on Claude Code. Each section is a self-contained pattern you can adopt. All examples point at specific files in this repo so you can read the real implementation, not a sanitized mock.

**TL;DR** for every pattern:

- Personal memory across sessions → 3-tier markdown + Graphiti graph + session archive
- Learning loop that actually sticks → hashtag hooks that save to typed memory files
- Daily briefings that don't lie → canonical spec as contract + per-section regression tests
- Foundation that doesn't drift → state-as-contract tests + commit-msg honesty guard
- Every prompt searchable forever → S3 Stop hook + SQLite FTS5 + Athena external table
- Main thread never thrashes → delegate heavy research to subagents (main is quarterback)
- Nothing important lives on one disk → raw archival before any processing

---

## 1. Personal memory architecture (3 tiers + Graphiti + session archive)

**Problem:** Claude Code sessions start fresh every time. The model has no persistent memory of you. Putting everything into one bloated CLAUDE.md makes every session slow and context-expensive.

**Pattern:** four tiers, loaded on demand.

| Tier     | Where                                    | Loaded        | Purpose                                                                                             |
| -------- | ---------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 1        | `memory/MEMORY.md`                       | every session | pointers only, 150-200 lines max, names the canonical files so sessions don't rediscover state      |
| 2        | `memory/*.md` + `memory/contacts/*.md`   | on demand     | one file per topic, frontmatter-tagged, recalled by semantic search or direct reference from Tier 1 |
| 3        | `memory/archive/` + `data/{module}/raw/` | offline       | append-only raw payloads, rebuildable ground truth                                                  |
| Graphiti | EC2 Docker, port 8000                    | on query      | semantic + temporal graph layer on top of Tier 2                                                    |

Every Tier 2 write fires `addEpisode()` into Graphiti in the same transaction so the graph never drifts from the filesystem. See `src/main/memory-index.ts` and `src/main/graphiti-client.ts`.

**Tier 2 file frontmatter:**

```markdown
---
name: Short identifier
description: One-line hook shown in the index
type: user | feedback | project | reference
canonical: true # optional; marks sources of truth
level: 1 # optional; load order hint
---
```

**Tier 1 discipline:** Tier 1 is a pointer file. No content lives here. If content starts accumulating, it's wrong. This is the pattern that prevents "every session rediscovers the filesystem from scratch." A machine-verified regression test enforces it: see section 4 (foundation invariants).

**Where to look:** `src/main/memory-index.ts` (375 lines), `src/main/agent-memory.ts` (buildUnifiedContext function), `src/main/__tests__/tier1-discipline.test.ts`.

---

## 2. Hashtag hooks that make learning cascade

**Problem:** Telling Claude "remember this" rarely persists anything actionable across sessions. "Lessons learned" docs go stale because nothing forces them to get written down.

**Pattern:** Claude Code `UserPromptSubmit` hooks intercept hashtag commands and inject structured workflows. The hashtag is the user's shortcut; the workflow is the discipline the hook enforces.

Implemented hooks in this repo:

| Hashtag            | Hook                                         | What it does                                                                                                                                                                 |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#learn`           | `scripts/claude-hooks/learn-trigger.sh`      | save learning to Tier 2 memory file + update index if new topic + addEpisode into Graphiti + write regression test if it's about code behavior + commit, all one transaction |
| `#gap`             | `scripts/claude-hooks/gap-trigger.sh`        | regression/process failure workflow: acknowledge prior rule, explain architectural flaw, self-reflect, fix with prevention hierarchy, confirm cannot recur                   |
| `#ppl`             | `scripts/claude-hooks/contact-enrichment.sh` | audit all contacts, dedupe, categorize, cascade updates across files                                                                                                         |
| `#inbox` / `#mail` | (workflow injection)                         | Gmail scan + contact enrichment from recent emails                                                                                                                           |

**Hook registration** (in `~/.claude/settings.json`, which in this repo is hardlinked to `claude-config/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "#learn",
        "hooks": [{ "type": "command", "command": "bash scripts/claude-hooks/learn-trigger.sh" }]
      }
    ]
  }
}
```

**Why it works:** the hook isn't the AI. The hook is a deterministic shell script that prepends a system message to the conversation with the workflow the user wants followed. The AI then does the work. This is mechanical enforcement of "you must follow this process when the user types this shortcut."

**Prevention hierarchy** for rules that need to stick: `test > hook > npm script > CLAUDE.md > memory file`. Tests are strongest because they run on every commit/push and fail loud. Memory files are weakest because they rely on the AI reading them. If a rule is violated twice, escalate it up the hierarchy.

**Where to look:** `scripts/claude-hooks/` (14 tracked hook scripts), `claude-config/settings.json` for the registration block.

---

## 3. Daily briefings that don't lie (spec as contract)

**Problem:** You build a briefing that reads today's news and emails, and six months later one section silently omits data because the upstream pipeline changed. The briefing still looks fine but half the sections are stale or hallucinated.

**Pattern:** a canonical spec file + per-section regression test + a rule that every section must have (a) a data fn, (b) a formatter, (c) a regression assertion.

**The spec:** `memory/project_briefing_spec.md` (private in this repo, but the structure is the pattern). It enumerates every section by number, names the data source, and fixes the order. When something's "explicitly removed," it says so in a section at the bottom so future edits don't accidentally re-add deleted content.

**The regression test:** `src/main/__tests__/briefing-output.test.ts` loops over the spec sections and asserts each one: data fn exists, header string appears in the output, freshness window holds (e.g. nightly-enhancements.jsonl entry within 24h).

**The implementation:** `scripts/manual-briefing-v3.js` with one function per section (getOvernightEnhancements, getLinkedInIntel, getCommunicationsSummary, etc.). Each function reads its own data source and returns structured data; a formatter pushes lines into the message buffer. No hardcoded strings. No "Claude rewrites the whole briefing every morning", the briefing is deterministic and auditable.

**The failure mode this prevents:** on 2026-04-10, this codebase's briefing silently omitted an entire section because the spec listed it but the implementation had no data function for it. The regression test now asserts spec-section ↔ implementation parity, so a new spec section that lacks an implementation fails `npm test` immediately. See `memory/feedback_briefing_spec_sections_must_be_implemented.md`.

**Where to look:** `scripts/manual-briefing-v3.js`, `src/main/__tests__/briefing-output.test.ts`.

---

## 4. Foundation invariants that don't drift (state as contract)

**Problem:** your Tier 1 memory file has a table of "where all the state lives" with columns for "tracked in git / local only / ephemeral." The table is documentation. It lies after a week. A commit adds a new file; the table doesn't get updated. Two months later you're scoping a spec from a table that no longer matches reality.

**Pattern:** turn the table into a contract. Parse the markdown in a test. For each row, verify against `git ls-files` and `fs.existsSync`. If a row says "tracked" and the path isn't in git, fail the test.

**The test:** `src/main/__tests__/tier1-discipline.test.ts` has three state-table assertions:

1. No row is flagged "needs migration" (hard fail, drift must be resolved before commit)
2. Every path in every row exists on disk (catches typos, deletions, renames)
3. Every row marked `git` is actually known to `git ls-files` (catches table-vs-reality drift)

Uses a cached `git ls-files` set at `beforeAll` time to avoid parallel subprocess contention on Windows. See `src/main/__tests__/parse-state-locations-table.ts` for the markdown table parser.

**npm script:** `npm run verify:foundation` runs just this file in ~2 seconds. Wire it into:

- pre-push hook (blocks push on drift)
- daily health check (alerts on drift)
- nightly enhancement loop (asserts green before any automated work)

**Commit-msg honesty guard:** `.git/hooks/commit-msg` (tracked at `scripts/git-hooks/commit-msg`) rejects any commit whose subject claims completion ("overhaul", "foundation", "Phase N-M", "complete", "finish", "done") while its body mentions "deferred", "TODO", "not yet", "still pending". Catches the specific failure mode where a commit subject says "Phase 1-10 overhaul" and the body quietly mentions "Phases 5, 7, 9, 11 deferred." Install via `bash scripts/install-git-hooks.sh`.

**The mindset shift:** documentation that isn't verified decays. Documentation that a test asserts stays honest forever. Every claim in a "where things are" doc is a test assertion waiting to be written.

**Where to look:** `src/main/__tests__/tier1-discipline.test.ts`, `src/main/__tests__/parse-state-locations-table.ts`, `scripts/git-hooks/commit-msg`, `scripts/install-git-hooks.sh`, `scripts/verify-foundation.sh`.

---

## 5. Session archive (every prompt searchable forever)

**Problem:** you tell Claude Code a requirement. Next week you come back and Claude has no memory of the conversation. You re-explain. Claude hears it slightly differently. Drift compounds across sessions until the AI is "confused about what you wanted."

**Pattern:** every session transcript auto-uploads to S3 on session exit. A metadata JSON per session is generated with first prompt, last response, timestamps, tool calls, and topic guess. That metadata is indexed in both SQLite FTS5 locally (fast grep) and Athena external table globally (SQL over all time). When Amy builds memory context for a query, she consults the session archive as a retrieval tier before answering, so "do you remember" questions pull receipts from the actual prior conversation.

**Architecture:**

```
Claude Code session ends
  ↓ Stop hook
scripts/claude-hooks/archive-session-to-s3.sh
  ↓ builds metadata from transcript
  ↓ aws s3 cp with SSE-AES256
s3://<bucket>/
  meta/{repo}/YYYY-MM-DD/SESSION.json          ← indexed
  transcripts/{repo}/YYYY-MM-DD/SESSION.jsonl  ← full fidelity
  ↓
  ├── scripts/session-search.ts (SQLite FTS5, ~/.secondbrain/sessions.db)
  ├── scripts/athena/sessions-ddl.sql (AwsDataCatalog.secondbrain.session_meta)
  └── src/main/session-archive.ts (Tier-4 memory retrieval)
```

**Metadata shape** (one file per session):

```json
{
  "session_id": "abcd1234-...",
  "repo": "secondbrain",
  "started_at": "2026-04-11T14:30:00Z",
  "ended_at": "2026-04-11T15:47:12Z",
  "message_count": 47,
  "tool_calls": ["Bash", "Edit", "Agent"],
  "first_prompt": "Can you add a new feature to the briefing...",
  "last_response": "Shipped in commit abc1234. Tests green.",
  "topic_guess": "briefing section add"
}
```

**Why separate meta and transcript prefixes:** Athena's JsonSerDe parses every line of every file it finds at the LOCATION. Transcript jsonl files have one JSON object per line with the wrong schema, pointing Athena at a mixed prefix produces thousands of NULL rows. Separating into `meta/` and `transcripts/` lets the external table point cleanly at `meta/` only.

**Why SQLite FTS5 plus Athena:** SQLite gives sub-millisecond local grep with snippet highlighting for Amy's retrieval tier. Athena gives SQL over the whole archive without spinning up a database. Both read from the same S3 meta files, one source of truth, two query surfaces.

**Example queries:**

```sql
-- Athena: sessions per day
SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n
FROM secondbrain.session_meta
GROUP BY substr(started_at, 1, 10)
ORDER BY day DESC LIMIT 14;

-- Athena: did you ever ask about X?
SELECT session_id, started_at, first_prompt
FROM secondbrain.session_meta
WHERE lower(first_prompt) LIKE '%dentist%'
ORDER BY started_at DESC;
```

```bash
# Local SQLite FTS5
npx ts-node scripts/session-search.ts build
npx ts-node scripts/session-search.ts search "phase overhaul"
npx ts-node scripts/session-search.ts recent 10
```

**Where to look:** `scripts/claude-hooks/archive-session-to-s3.sh`, `scripts/backfill-sessions-to-s3.py`, `scripts/session-search.ts`, `scripts/athena/sessions-ddl.sql`, `scripts/athena/setup-athena.sh`, `claude-config/athena-sessions.md`, `src/main/session-archive.ts`, `src/main/__tests__/session-archive.test.ts`.

---

## 6. Subagent quarterback (main thread as orchestrator)

**Problem:** when you ask Claude Code to do a big task, it burns context on research and file-walking, then runs out of room for the actual implementation. Or it gets sidetracked by a tangent and loses the original thread.

**Pattern:** main thread is the quarterback. Heavy research, deep file walks, long-horizon tasks, and anything that would bloat the main context get delegated to subagents via the `Agent` tool. The main thread holds the plan, routes work, and integrates results.

**When to delegate:**

- "Find every file that imports X" → `Explore` subagent
- "Design an implementation approach for this 10-file refactor" → `Plan` subagent
- "Read AMY_REBUILD_PLAN.md + AMY_REQUIREMENTS.md + audit current disk state" → `general-purpose` subagent (parallel)
- Running 2-3 independent investigations → multiple subagents in ONE message (parallelism)

**When NOT to delegate:**

- Reading one specific file (just use `Read`)
- Grepping for a known symbol (just use `Grep`)
- Simple edits (just use `Edit`)
- Tasks where you need to SEE the context yourself to make the next decision

**The quarterback rule:** the main thread should never duplicate work a subagent is already doing. Delegate, wait, synthesize. Don't also search in parallel "just in case."

**Where to look:** examples of this pattern in commit messages that say "launched 3 Explore agents in parallel."

---

## 7. Raw archival before processing

**Problem:** you ingest from Gmail, the ingest code has a bug, the bug silently drops 20% of the emails. You don't notice for a week. By then the source has moved on and you can't recover.

**Pattern:** every ingest path writes the full raw payload to `data/{module}/raw/` BEFORE any parsing, filtering, or transformation. Raw archival is the commitment. The rule is "if a new ingest source is added and the raw-archival step is missing, that's a regression." This means:

1. Processing is always rebuildable, if the parser has a bug, you re-run it against the raw archive and get the correct results with no data loss
2. The raw/ directory is a ground-truth log that's also git-tracked so it replicates everywhere the repo does
3. Every ingest is testable: feed a raw payload to the parser, assert the structured output

**Pre-commit lint for ingest files:** the `PreToolUse` hook `scripts/claude-hooks/ingest-hook-lint.sh` injects a reminder system message when Claude edits any file matching `*ingest*|*webhook*|*import*|*fetch*|*poll*|*sync*|*listener*|*handler*`, it reads "RAW ARCHIVAL + GRAPHITI CHECK: You are editing an ingest/data-intake file. BEFORE any parsing, the full raw payload MUST be written to data/{module}/raw/." That's a mechanical enforcement of the principle on every edit of an ingest file.

**Where to look:** `scripts/ingest-gmail.ts`, `src/main/whatsapp-ingest.ts`, `data/otter/raw/`, `data/gmail/raw/`, and the `memory/feedback_raw_archival_principle.md` rule (not synced; the principle is above).

---

## 8. Run everything through one Claude subscription

**Problem:** building an agentic system with OpenAI or Anthropic APIs burns real money. A single mis-configured nightly loop can rack up hundreds of dollars before anyone notices.

**Pattern:** route every LLM call through your Claude Pro or Max subscription via the `claude` CLI subprocess, and enforce it with a test.

**Enforcement:** `src/main/__tests__/llm-routing-guard.test.ts` walks every source file and fails if any non-allowlisted file contains `api.openai.com/v1/chat/completions`, `api.groq.com/...`, or `api.anthropic.com/v1/messages`. A small allowlist of legacy migration paths keeps passing with a TODO to drive the list to zero over time. New files with paid-API calls fail the test.

**The subprocess pattern** for running Claude from code: `src/main/claude-runner.ts` uses `runClaudeCode(prompt)` / `runClaudeCodeContinue(prompt)` to spawn the `claude` CLI with `CLAUDECODE` unset so nested sessions don't inherit the wrong auth. Same pattern for async briefing work, overnight enhancement loops, and live call `run_claude_code` tools.

**Where to look:** `src/main/__tests__/llm-routing-guard.test.ts`, `src/main/claude-runner.ts`.

---

## How to copy these patterns into your own repo

Most patterns here are a few files. Rough recipe:

1. Copy `scripts/claude-hooks/*.sh` that you want and register them in `~/.claude/settings.json` under the matching hook event
2. Copy `src/main/__tests__/tier1-discipline.test.ts` + `parse-state-locations-table.ts` and rename the assertions to match your memory file's shape
3. Copy `scripts/git-hooks/commit-msg` and `scripts/install-git-hooks.sh`, run the installer once per clone
4. For the session archive: adapt `scripts/claude-hooks/archive-session-to-s3.sh` and change the bucket name, then run `scripts/backfill-sessions-to-s3.py` once to seed
5. For the memory retrieval integration: copy `src/main/session-archive.ts` and call `buildSessionArchiveContext(query)` from wherever you assemble your system prompt

Everything in this repo is under the license in `LICENSE`. Lift whatever's useful.

---

## See also

- `README.md`, what SecondBrain does and why
- `CONTRIBUTING.md`, how to submit changes
- `KNOWN_FIXES.md`, gotchas and workarounds
- `SECONDBRAIN_PLAN.md`, high-level roadmap
