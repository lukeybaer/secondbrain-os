# Skill: Memory Consolidation

## Purpose
Compress, promote, and archive memories so the EA's context stays sharp and relevant. Follows Hebbian reinforcement: neurons that fire together, wire together.

## Three-Tier Architecture

### Tier 1 , Working Memory (MEMORY.md, ≤50 lines)
Always loaded. Pointers only. Updated after every significant interaction.
- The owner's active projects (3-5 entries max)
- Current call targets
- Recent decisions or commitments
- Active reputation flags (unreviewed)

### Tier 2 , Indexed Memory (memory/*.md + index.json)
One file per topic. Loaded on demand. Scored by weight.
- Load all files with weight ≥ 0.3 when building system prompts
- Keep ≤8 files in active rotation (the rest stay on disk)

### Tier 3 , Archive (memory/archive/YYYY-MM-DD.md)
Daily append-only. Loaded only on explicit recall.
- Move Tier 2 entries with weight < 0.05 to archive
- Archive also receives nightly batch of call transcripts

## Hebbian Scoring Rules

| Event | Weight Change |
|-------|--------------|
| First mention | Set to 0.2 |
| 3+ mentions | Promote to 0.8 |
| Accessed today | Reset decay clock |
| Not accessed | Decay by `decay_rate` per day |
| Contradicted | Mark `invalid_at`, weight → 0, never delete |
| Weekly prune | Delete entries with weight < 0.05 AND invalid |

## Deduplication
Before adding any new memory:
1. Compute MD5 of normalized content
2. Check against `memory_hashes` set in index.json
3. If duplicate: update `mentions` count + reset decay clock, don't add new entry

## Nightly Consolidation (run at 2 AM CT)
1. Load all Tier 2 files
2. Apply daily decay: `weight = weight * (1 - decay_rate)`
3. Promote entries with mentions ≥ 3 and weight < 0.5 → set weight = 0.8
4. Archive entries with weight < 0.05
5. Update index.json
6. Commit changes to git

## Usage Count Tracking
- uses: 0
- last_evolved: never
