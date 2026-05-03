# Hooks: making rules stick mechanically

Memory files are easy to ignore. Tests run on every push. Hooks fire on every event. The closer a rule lives to the bottom of this stack, the harder it is to forget. This guide walks through how SecondBrain uses Claude Code hooks plus ingest hooks to turn one-time corrections into permanent infrastructure.

## What a Claude Code hook is

A hook is a shell command Claude Code runs automatically at a specific event. The hook script's stdout is injected into the conversation as additional context. The hook itself is deterministic, the AI is not. That separation is the whole trick: the hook enforces the workflow, the AI does the work.

Hooks are registered in `~/.claude/settings.json` (or this repo's `claude-config/settings.json` when you hardlink it). The schema:

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<optional pattern>",
        "hooks": [
          { "type": "command", "command": "bash scripts/claude-hooks/<your-hook>.sh" }
        ]
      }
    ]
  }
}
```

Common event names:

| Event              | Fires when                                                              |
| ------------------ | ----------------------------------------------------------------------- |
| `SessionStart`     | A new Claude Code session opens. Inject memory pointers, status, etc.   |
| `UserPromptSubmit` | The user sends a message. Match on `#hashtag` to trigger workflows.     |
| `PreToolUse`       | Before Claude calls a tool. Block writes outside an allowed directory.  |
| `PostToolUse`      | After a tool runs. Validate, lint, or extend the change.                |
| `Stop`             | Conversation ends. Archive the transcript, snapshot session state.      |

## The prevention hierarchy

When a rule gets violated, escalate up this hierarchy. Stronger rules sit at the top:

```
test  >  hook  >  npm script  >  CLAUDE.md  >  memory file
```

Why:

- **Test** runs on every commit and push. Cannot be skipped without intent. Failure is loud (red CI, blocked merge).
- **Hook** runs on every relevant event. Cannot be skipped because it fires before the AI sees anything. Failure is loud (the hook script writes to stdout).
- **npm script** has to be invoked manually. Catches the mistake when the developer remembers to run it.
- **CLAUDE.md** is loaded once at session start. The AI may forget mid-session.
- **Memory file** is loaded only if it gets referenced. Easiest to ignore.

When the SAME rule gets violated TWICE, escalate up the hierarchy. The second violation is evidence that the lower layer is not strong enough.

## Hashtag commands: the user-facing hook pattern

A hashtag hook intercepts a `UserPromptSubmit` event whose body contains a tag like `#learn`. The hook script writes a workflow into stdout; Claude Code injects that as system context; the AI follows the workflow on this turn.

The shipped hashtag commands:

| Hashtag      | What the hook injects                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `#learn`     | Save the current learning to a Tier 2 memory file with proper frontmatter, update the index, write a regression test if the learning is about code behavior, commit. All one transaction. |
| `#gap`       | Acknowledge the prior rule that was violated, explain why existing safeguards failed, fix it with the prevention hierarchy (test > hook > npm script > CLAUDE.md > memory file), confirm the new guard fires. |
| `#ppl`       | Audit every contact file, dedupe, categorize, cascade updates across files, clean stale references.                        |
| `#inbox`     | Trigger an immediate Gmail scan + contact enrichment from recent emails.                                                   |
| `#recall`    | Search the cross-session archive (S3 + local SQLite FTS5) and inject the top hits as context.                              |

Define your own hashtags by adding a hook to `claude-config/settings.json` and writing the workflow into a script under `scripts/claude-hooks/`.

### Example: registering #learn

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "#learn",
        "hooks": [
          { "type": "command", "command": "bash scripts/claude-hooks/learn-trigger.sh" }
        ]
      }
    ]
  }
}
```

The `learn-trigger.sh` script outputs the workflow text. The matcher is a substring check; if the user's prompt contains `#learn` anywhere, the hook fires.

## Ingest hooks: turning raw data into memory

Hashtag hooks let the user trigger workflows. **Ingest hooks** trigger workflows from incoming data. Every external data source (calls, transcripts, emails, messages) flows through an ingest pipeline that fans out to memory, contacts, knowledge graph, and search index.

The pattern (see `src/main/ingest-hooks.ts`):

```
Raw payload  ->  raw archival   (data/{module}/raw/<id>.json)
              ->  AI tagger      (entity extraction, intent, summary)
              ->  fan-out:
                    memory cascade   (update Tier 2 contact files)
                    knowledge graph  (addEpisode into Graphiti)
                    search index     (insert into SQLite FTS5)
                    contact event    (append to event-sourced contact log)
```

Every data source gets the same treatment. Calls, WhatsApp, Otter transcripts, Gmail threads, SMS, screen OCR. The fan-out is identical; only the source-specific parser changes.

### Flagship example: Otter transcripts to people files

Otter.ai produces meeting transcripts with named participants. The ingest hook turns those into contact-file updates without the user having to do anything.

The flow:

1. **Pull**: a scheduled job calls Otter's API every N minutes, fetches new transcripts, writes the raw JSON to `data/otter/raw/<id>.json`. Raw archival first, before any processing.
2. **Match**: the participant list in the transcript header is matched against `memory/contacts/*.md`. Match by name, then by email, then fuzzy.
3. **Extract**: for each matched contact, the AI tagger runs over the transcript looking for new facts about that person. Communication preferences, project context, personal mentions, follow-up commitments.
4. **Cascade**: the new facts get appended to the contact file's History section with a `(Otter)` tag and a timestamp. The contact file's frontmatter `last_otter_touch` field updates. Graphiti gets an `addEpisode()` for the new facts. The contact event log gets a `meeting_attended` event.
5. **Commit**: the changes get committed to git so you have a forensic record of when each fact was learned.

The result: every meeting you have flows into your contact file for that person automatically. The next time the EA references them, it has the context from the last meeting without you having to summarize anything.

The reverse direction also works. The same hook pattern handles:

- **Gmail threads** -> contact files get `(Gmail)`-tagged history entries
- **WhatsApp messages** -> contact files get `(WhatsApp)`-tagged history entries
- **Phone calls (Vapi)** -> contact files get `(Call)`-tagged history entries with the call transcript link
- **LinkedIn posts** -> contact files get `(LinkedIn)`-tagged history entries when someone you follow posts

The user does nothing. The hooks do everything. That's the point.

### Custom themes

The contact-enrichment hooks can scan transcripts for any theme you care about. By default, they extract entities (people, companies, places) and the standard relationship signals (warmth, last touch, communication preferences). You can configure additional themes per your own needs by adding fields to the contact-file frontmatter and extending the extraction prompt at `secondbrain/memory/reference_contact_extraction_prompt.md` (in your own repo, not this one).

The framework does not prescribe what themes to extract. It gives you the cascade so you can extract whatever you care about.

## SessionStart hooks: never start blank

The `SessionStart` event is the strongest tool for "make the EA always remember X". The hook runs once at the start of every session, in every repo. SecondBrain uses it to inject:

1. The Tier 1 pointer file (`memory/MEMORY.md`)
2. The state-locations table
3. The behavioral rules
4. The active schedules

This means a fresh session in any repo (yours or someone else's, as long as the hook is registered) opens already knowing who the owner is, what the rules are, and where to look for everything.

Example registration:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash scripts/claude-hooks/session-start-inject.sh" }] }
    ]
  }
}
```

The `session-start-inject.sh` script just `cat`s the relevant files to stdout. Simple, fast, idempotent.

## PreToolUse hooks: hard guardrails

`PreToolUse` runs before Claude calls any tool. Use it to block actions you never want, regardless of what the AI thinks it should do.

Shipped guardrails:

- **`memory-path-enforce.sh`** blocks writes to `~/.claude/memory/` absolute paths and rewrites them to the project-relative `memory/` path. Prevents permission prompts.
- **`em-dash-guard.mjs`** blocks any tool input containing U+2014 (em dash) because the owner has decreed plain hyphens. Mechanical enforcement of a rule that would otherwise live only in CLAUDE.md.
- **`run-tests-before-pr.sh`** blocks `git push` until the test suite passes.
- **`test-coverage-guard.mjs`** blocks `git commit` when staged production code has no matching test changes.

Each one is one short script. The pattern: read the tool input from stdin (it arrives as JSON), check whatever invariant you want, exit non-zero with a stderr message to block.

```bash
#!/usr/bin/env bash
# Block any Bash command that contains 'rm -rf /'
input=$(cat)
if echo "$input" | grep -q "rm -rf /"; then
  echo "Blocked: rm -rf / is never allowed" >&2
  exit 1
fi
exit 0
```

Register it as a `PreToolUse` hook with `matcher: "Bash"`. Done. Now even a prompt-injection attack can't run rm -rf /.

## PostToolUse hooks: validate after the fact

`PostToolUse` runs after a tool completes. Use it to validate the result, run side effects, or cascade to other systems.

Shipped examples:

- **`memory-validation.sh`** runs after any write to `memory/`. Validates frontmatter, checks the index is up to date.
- **`vapi-validation.sh`** runs after a Vapi call command. Validates the prompt format.
- **`archive-session-to-s3.sh`** runs on `Stop`. Uploads the session jsonl to S3 plus an enriched meta JSON, updates the local SQLite FTS index. The `#recall` hashtag reads from this archive.

## Writing your own hook: the recipe

1. **Pick the event.** Most hooks are `UserPromptSubmit` (hashtag triggers) or `PreToolUse` (guardrails).

2. **Write the script** under `scripts/claude-hooks/<your-hook>.sh` (or .js, .py, anything Claude Code can execute). Read tool input from stdin if you need it. Write your output to stdout. Exit non-zero to block (PreToolUse) or to fail loud (others).

3. **Register it** in `claude-config/settings.json` under the right event with the right matcher.

4. **Test it** by triggering the event and checking the script ran. Hooks fail silently if misconfigured, so verify before assuming it works.

5. **Document it** in `memory/feedback_<rule>_via_hook.md` so the rule it enforces shows up in your memory index.

## Common mistakes

**Putting business logic in the hook.** Hooks should be deterministic. If your hook does AI inference, you have two AI loops fighting each other. Keep hooks dumb; let the AI do the smart work in response to the hook's injected context.

**Forgetting to handle the matcher pattern correctly.** `UserPromptSubmit` matchers are substring checks against the prompt body. `PreToolUse` matchers are tool names. Get them mixed up and your hook never fires.

**No exit code.** A PreToolUse hook that wants to block must exit non-zero. Exit 0 = "approved, proceed".

**Writing to stderr instead of stdout for context injection.** Claude Code injects stdout into the conversation. stderr goes to the user's terminal log. If you want the AI to see your context, write it to stdout.

**Forgetting to make the script executable** (Linux/macOS). `chmod +x scripts/claude-hooks/your-hook.sh`. On Windows, the shebang is interpreted by Git Bash; the `command` field in settings.json should be `bash scripts/claude-hooks/your-hook.sh` to be explicit.

## Where to look in this repo

- `claude-config/settings.json`     The hook registration block, hardlinked to `~/.claude/settings.json`
- `scripts/claude-hooks/`           14 shipped hooks. Read these first to see the patterns.
- `src/main/ingest-hooks.ts`        The ingest fan-out pipeline (memory + graph + search + contact events)
- `src/main/contact-event-sourcing.ts`  The append-only contact event log that ingest hooks write to
- `src/main/memory-index.ts`        The memory cascade that ingest hooks call when they update Tier 2

The hashtag hooks (`#learn`, `#gap`, `#ppl`, `#inbox`, `#recall`) are the easiest to read and modify. Start there.
