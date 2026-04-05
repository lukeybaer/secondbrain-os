# Example Project

This is a Tier 2 memory file — one per topic. The agent creates these automatically
as it learns, or you can create them manually.

## Overview
- Goal: Demonstrate the memory file structure
- Status: Active

## Key Facts
- Tier 2 files are loaded on demand when relevant to the current query
- Each file has a Hebbian weight (0.0-1.0) that decays over time
- Accessing a file reinforces its weight (prevents decay)
- Files mentioned 3+ times get auto-promoted to weight 0.8

## Learnings
- (The agent appends learnings here after interactions)
