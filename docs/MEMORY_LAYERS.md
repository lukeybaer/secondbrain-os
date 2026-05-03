# Memory architecture: setting up tiered memory

This guide walks through how SecondBrain's memory is laid out and how to wire your own copy of it. The goal is an EA that remembers you across sessions without dragging the entire knowledge base into every prompt.

If you do nothing, Claude Code starts every session with no memory of you. SecondBrain replaces that with a four-tier architecture: a small always-loaded pointer file, a per-topic file system loaded on demand, an append-only archive, and an optional knowledge graph layered on top.

## The four tiers at a glance

| Tier         | Where                                          | Loaded when      | Purpose                                                                                |
| ------------ | ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| Tier 1       | `memory/MEMORY.md`                             | every session    | Pointers only. Names the canonical files. Tells the EA where to look, not what to think. |
| Tier 2       | `memory/*.md` + `memory/contacts/*.md`         | on demand        | One file per topic, with frontmatter. Pulled in by semantic search or direct reference. |
| Tier 3       | `memory/archive/` + `data/{module}/raw/`       | offline          | Append-only raw payloads. The ground truth you can rebuild from.                       |
| Graphiti     | optional Docker container                      | on query         | Temporal knowledge graph. Lets you ask "what was true about X in March?".              |

The discipline: Tier 1 stays small (under 200 lines). Tier 2 holds the actual content. Tier 3 is your forensic archive. Graphiti is an enhancement, not a requirement.

## Tier 1: the pointer file

`memory/MEMORY.md` is the only memory file the EA reads on every session start. Keep it under 200 lines. It should be 90% pointers and 10% essential context.

What belongs in Tier 1:

- The owner's identity (name, role, top three current focuses)
- The non-negotiable behavioral rules (3 to 6 rules, no more)
- A directory of where everything else lives, with one-line descriptions
- The current week's active projects (3 to 5 entries max)

What does NOT belong in Tier 1:

- Long descriptions of preferences (those go in Tier 2 feedback files)
- Contact details (Tier 2 contacts/)
- Project history (Tier 2 project_*.md)
- Last week's notes (Tier 3 archive/)

If Tier 1 starts growing past 200 lines, split content into Tier 2 files and replace it with a one-line pointer. A bloated Tier 1 means every session pays a token tax for context the EA might not even need.

### Example skeleton

```markdown
# Working memory (Tier 1)

You are the EA. Same brain as the host LLM, not a persona adapter.

## How to work with the owner
- (3-6 high-priority rules. No more.)

## Subagents preferred
Delegate heavy research, file walks, deep dives to subagents. The main thread is the orchestrator.

## State locations
| What                      | Where                              | Tracked |
|---------------------------|------------------------------------|---------|
| Tier 2 memory             | `memory/*.md`                      | git     |
| Contact files             | `memory/contacts/*.md`             | git     |
| Tier 3 archive            | `memory/archive/`                  | git     |
| Daily briefings           | `data/briefings/`                  | git     |
| Raw ingest payloads       | `data/{otter,gmail,linkedin,whatsapp}/raw/` | git |

## Where to find what, by topic
- Identity, goals, projects -> `memory/user_profile.md`
- Family + life context    -> `memory/user_family.md`
- Communication style      -> `memory/feedback_communication.md`
- All behavioral rules     -> `memory/RULES_INDEX.md`
- Active project: X        -> `memory/project_x.md`

## Active schedules
- (cron entries that fire automatically)

## Hashtag commands
- `#learn` -> save to Tier 2, update index, commit
- `#gap`   -> regression workflow with prevention hierarchy
- `#ppl`   -> contacts cleanup
```

A regression test can enforce the size cap. See `src/main/__tests__/tier1-discipline.test.ts` for the pattern: assert `wc -l memory/MEMORY.md` stays under the threshold and fail the build if it grows.

## Tier 2: per-topic files with frontmatter

Every Tier 2 file is a single Markdown file with YAML frontmatter at the top. The frontmatter describes what the file is so the index can find it without reading the whole document.

```markdown
---
name: Short identifier visible in the index
description: One-line hook explaining when to read this file
type: user | feedback | project | reference
canonical: true   # optional, marks the source of truth for a topic
level: 1          # optional, load order hint when multiple files match
---

(content here)
```

Recommended file naming convention:

| Prefix       | What it holds                                                  |
| ------------ | -------------------------------------------------------------- |
| `user_*`     | Facts about the owner (identity, family, companies, vehicles)  |
| `feedback_*` | Behavioral rules learned from corrections                      |
| `project_*`  | Per-project state (active projects only, archive when done)    |
| `reference_*`| Static reference material (snippets, addresses, configurations) |
| `_*`         | Auto-generated index files (e.g. `_gmail-daily-intel.md`)      |

The contacts directory follows a different convention: one file per person at `memory/contacts/<slug>.md`, with a master `INDEX.md` that lists everyone by category.

### One file per topic

When in doubt, create a new file. Memory files are cheap. Long files that mix three topics are expensive because the EA has to load all three to reference any one. A 200-line `feedback_communication_style.md` beats a 2000-line `feedback_general.md`.

When two files start to overlap, merge them and leave a redirect at the old name. Drift between two files saying contradictory things is worse than a single canonical source.

## Tier 3: the archive (your forensic record)

Tier 3 is what you can rebuild Tier 2 from if it ever gets corrupted. Two parts:

1. **`memory/archive/`** holds Tier 2 entries that have been superseded or fallen out of relevance. Append-only, never delete. When a project completes, move its `project_x.md` here under `archive/projects/project_x.md` so the active set stays small.

2. **`data/{module}/raw/`** holds the unprocessed payloads from every ingest source. When you receive a Gmail thread, write the raw JSON there before any processing. When you import an Otter transcript, save the full transcript JSON there. The raw archival principle: never let a processing failure destroy the original data. If the parser is buggy, you can rerun it against the raw archive and recover.

Example layout:

```
data/
  gmail/
    raw/
      2026-05-02-thread-abc123.json   # raw Gmail message + headers
  otter/
    raw/
      2026-05-02-transcript-xyz.json  # raw Otter transcript with timestamps
  linkedin/
    raw/
      2026-05-02-feed-snapshot.html
  whatsapp/
    raw/
      2026-05-02-message-batch.json
```

This is the rule that lets you re-extract entities, re-run summarization, or audit a hallucination after the fact. Without it, every processing bug is permanent data loss.

## Optional: Graphiti as a fourth layer

[Graphiti](https://github.com/getzep/graphiti) is a temporal knowledge graph from Zep AI. SecondBrain wires it in as a search-and-recall layer over Tier 2.

What it adds:
- Semantic search across all your memory files (find "the conversation about pricing" without remembering which file it's in)
- Temporal reasoning ("what was the policy in March?" returns the version that was true in March, not today)
- Entity resolution (deduplicate "John", "John Smith", "j.smith@" into one canonical entity)

What it does NOT add:
- Anything you can't already do with grep + the filesystem if you read every file
- Faster lookups for facts you already know the file path for

The recommended pattern: every Tier 2 write fires `addEpisode()` into Graphiti in the same transaction. The graph never drifts from the filesystem because every change goes through both. See `src/main/memory-index.ts` for the cascade.

You can run SecondBrain without Graphiti. Tier 1 + Tier 2 + Tier 3 is the full architecture. Graphiti is performance for queries you don't already know the path to.

## Setting up your own memory

Step 1: Create `memory/MEMORY.md` with the skeleton above. Add your name, your top 3 focuses, and 3 to 6 behavioral rules.

Step 2: Make a `memory/user_profile.md` Tier 2 file with your identity in detail. Keep MEMORY.md as a pointer to it.

Step 3: Set up `memory/contacts/INDEX.md` even if it's empty. The hashtag hooks for contact enrichment will populate it.

Step 4: Create `memory/archive/` as an empty directory. Commit a placeholder `.gitkeep` so git tracks it.

Step 5: Write your first `feedback_*.md` file the next time you correct the EA. The `#learn` hook (see [HOOKS_GUIDE.md](HOOKS_GUIDE.md)) automates this.

Step 6 (optional): Stand up Graphiti via Docker once Tier 2 has grown to ~30 files. It's overkill before then.

## Common mistakes

**Putting content in Tier 1.** "Just this once" becomes 50 'just this once's. Tier 1 is for pointers. Move content to a named Tier 2 file and link to it.

**One huge `notes.md` instead of per-topic files.** Search costs scale with file size. The EA has to read every line of `notes.md` to answer a question about your sister, even if 90% of the file is about your car.

**Editing Tier 3 archive.** It is append-only by convention. If you change history, you lose your forensic record. Add a new file with a correction, do not edit the original.

**No frontmatter.** Without it, the index has to guess what each file is for. Spend 30 seconds writing the frontmatter; save the EA from loading the wrong file later.

**No raw archival.** The cheapest mistake to avoid. Always write the raw payload to `data/{module}/raw/` BEFORE processing it. Disk is cheap; data loss is permanent.

## Where to look in this repo

- `src/main/memory-index.ts`    The Tier 1 + Tier 2 loader, semantic search dispatch, frontmatter parser
- `src/main/agent-memory.ts`    The buildUnifiedContext function that assembles a system prompt from the tiers
- `src/main/graphiti-client.ts` The optional Graphiti integration
- `skills/memory/`              Two skill files documenting the consolidation + recall workflows
