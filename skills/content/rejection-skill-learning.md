# Skill: Rejection-Skill-Learning (RSL)

**Type:** Automated hook
**Trigger:** Every video rejection with feedback in ContentPipeline.tsx
**Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)

---

## What This Skill Does

Every time Luke rejects a video with a note in the Content Pipeline, the RSL hook fires automatically. It:

1. **Classifies** the rejection feedback against `video-quality-rubric.json` using Haiku
2. **Updates the rubric** — bumps weight on matched criteria, marks misses, adds new criteria if needed
3. **Appends to `skills/content/LEARNINGS.md`** — structured, human-readable learning entry
4. **Maintains automation priority** — criteria with the most misses surface to the top of `automation_priority[]`

The nightly 3:00 AM scheduler re-reads the rubric and updates `automation_priority` so the video pipeline knows which quality checks need better automation next.

---

## The RSL Loop

```
Luke rejects video
       ↓
empire:rejectVideo fires (existing handler)
       ↓
empire:processRejectionLearning fires (new handler)
       ↓
Haiku classifies rejection → returns matched_criteria + new_criteria + summary
       ↓
video-quality-rubric.json updated:
  - weight += 0.1 per matched criterion (max 5.0)
  - miss_count++ if was_miss = true
  - detection_accuracy recalculated
  - new criterion added if Haiku found a genuinely new issue
  - automation_priority recomputed by miss_count desc
       ↓
skills/content/LEARNINGS.md appended:
  - Date, video title, rejection target
  - Which rubric criteria were affected
  - Which were "misses" (QC should have caught it)
  - What the system should do differently
       ↓
3:00 AM scheduler reads automation_priority
  → video pipeline knows which checks to prioritize automating
```

---

## Miss vs. Normal Rejection

A **miss** means the QC system _should_ have caught this automatically but didn't. Haiku sets `was_miss: true` only for objective, machine-detectable issues:

| was_miss = true (QC should detect) | was_miss = false (human judgment) |
| ---------------------------------- | --------------------------------- |
| Silent gap at start                | Hook isn't compelling enough      |
| Missing thumbnail file             | Thumbnail feels generic           |
| Audio levels too loud              | Pacing feels off                  |
| Black frames                       | Title could be stronger           |
| Video too short/long               | Wrong vibe for the channel        |

Miss counts drive `automation_priority` — criteria with the most misses get automated first.

---

## Rubric Weight System

Weights start at `1.0`. Each rejection that maps to a criterion bumps it by `+0.1` (max `5.0`). Higher weight = higher priority in QC scoring. The video pipeline reads weights to decide which checks are blocking vs. advisory.

---

## Files

| File                                       | Purpose                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| `content-review/video-quality-rubric.json` | Live rubric — weights, miss counts, automation priority     |
| `skills/content/LEARNINGS.md`              | Human-readable rejection history                            |
| `src/main/rejection-skill-learning.ts`     | RSL logic — classification, rubric update, LEARNINGS append |
| `src/main/ipc-handlers.ts`                 | `empire:processRejectionLearning` IPC handler               |

---

## Usage Count Tracking

**Total rejections processed:** auto-tracked in rubric per-criterion
**Last evolved:** 2026-04-06
**Uses:** 0 (new)
