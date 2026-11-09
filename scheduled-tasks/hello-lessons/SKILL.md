---
name: hello-lessons
description: Minimal example of a scheduled skill that records a lesson after every run.
---

# hello-lessons

This example shows the skill learning loop end to end.

1. Before each run, the runner reads the last 10 entries in `LESSONS.md` next to this file and adds them to the prompt.
2. This skill has a `direct.json`, so the runner executes `scripts/examples/hello-lessons.js` directly instead of calling a model.
3. After the run, the runner appends one entry to `LESSONS.md` with the input and an outcome built from the last lines of output.

Run it from the repository root:

    node scripts/run-scheduled-skill.js hello-lessons

Run it twice, then open `scheduled-tasks/hello-lessons/LESSONS.md` to see one entry per run.

To build a model-driven skill instead, copy this folder, delete `direct.json`, and write the task for the model in `SKILL.md`. The runner then sends that text, plus the recent lessons, to the Claude or Codex CLI.
