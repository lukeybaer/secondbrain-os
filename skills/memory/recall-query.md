# Skill: Memory Recall & Query

## Purpose
Find relevant memories quickly during live calls and other time-sensitive contexts. Never block on disk reads.

## Query Speed Classification

### Fast (<2s) , answer from working memory directly
- Owner's name, address, phone, family names, job title
- Active project names and statuses
- Any fact mentioned in the last 3 interactions

### Medium (2-10s) , load from Tier 2 indexed memory
- Contact history ("did I talk to X?")
- Project decisions ("what did we decide about Y?")
- Call outcomes for a specific number
- Facts that haven't come up recently

### Slow (>10s) , acknowledge and queue
- Cross-reference multiple sources
- Archive lookups (pre-2026 history)
- Web research
- Anything with "find all" / "compile" / "analyze"

## On Live Calls
- Fast: answer immediately
- Medium: "Give me just a moment, checking your notes..." → answer when loaded
- Slow: "That one needs some digging , I'll send you a Telegram summary in a few minutes."

## Graphiti Integration (when available)
- `mcp__graphiti__search(query)` for semantic + temporal search
- Falls back to local file search if Graphiti is unreachable
- Graphiti endpoint: configured via `ec2BaseUrl` in Settings (port 3003)

## Cache Rules
- Working memory (Tier 1): always in memory, 0 load cost
- Tier 2 files: cache for 5 minutes after last access
- Never cache Tier 3 (archive) , load on demand only

## Usage Count Tracking
- uses: 0
- last_evolved: never
