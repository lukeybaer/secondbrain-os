# Skills that learn

A skill is a named, repeatable job that keeps a log of lessons and uses them the next time it runs.

## Two kinds of skills

| Kind | Lives in | Runs by | Lesson log |
|---|---|---|---|
| Scheduled skill | `scheduled-tasks/<name>/SKILL.md` | `node scripts/run-scheduled-skill.js <name>` | `LESSONS.md`, written automatically |
| Reusable skill | `skills/<domain>/<name>/SKILL.md` | Your agent, when the skill's description matches the request | `LEARNINGS.md`, appended by the agent |

## The learning loop

For a scheduled skill, the runner does this on every run:

1. Reads the last 10 entries in the skill's `LESSONS.md` and adds them to the prompt (`scripts/skill-runner-hooks.js`).
2. Runs the skill, either through the Claude or Codex CLI or directly when the folder has a `direct.json`.
3. Appends one entry to `LESSONS.md` with the input and an outcome built from the last three lines of output (`scripts/skill-lessons.js`).

Each entry looks like this:

    ## 2026-09-14T13:00:00.000Z
    - input: scheduled run (direct): scripts/examples/hello-lessons.js
    - outcome: <last lines of output>

## Try the example

From the repository root, run the example skill twice:

    node scripts/run-scheduled-skill.js hello-lessons
    node scripts/run-scheduled-skill.js hello-lessons

Then open `scheduled-tasks/hello-lessons/LESSONS.md`. It has one entry per run, and the second run reports the lesson recorded by the first.

## Create a scheduled skill

1. Copy `scheduled-tasks/hello-lessons` to `scheduled-tasks/<your-skill>`.
2. For a model-driven skill, delete `direct.json` and write the instructions in `SKILL.md`. Install and sign in to the Claude CLI or the Codex CLI.
3. For a script-driven skill, point `direct.json` at your script. Its `args` can use `$DATE`, `$DATA_DIR`, and `$ROOT`.
4. Run `node scripts/run-scheduled-skill.js <your-skill>`.
5. Schedule that command with cron, Windows scheduled tasks, or launchd.

## Create a reusable skill

1. Copy `skills/example/weekly-review` to `skills/<domain>/<your-skill>`.
2. Keep the `name` and `description` frontmatter. The description tells the agent when to use the skill.
3. Keep the instructions to read the last 10 entries of `LEARNINGS.md` before starting and to append one entry when finished.

## Where things run

- Skills run in place in your clone and append to `LESSONS.md` there.
- To run each skill in a separate git worktree instead, set `SECONDBRAIN_ISOLATE_SCHEDULED_SKILLS=1`. Worktrees go under `~/sb-sessions` by default. Set `SECONDBRAIN_SESSION_ROOT` to put them somewhere else.
- Outcome records go to your data folder: `%APPDATA%\secondbrain\data` on Windows, `/opt/secondbrain/data` on Linux, and `~/.secondbrain/data` on macOS. Set `SECONDBRAIN_DATA_DIR` to change it. The data folder must be outside the git repository, or the runner refuses to start.

## Pinning a job to one machine

`config/state-ownership.json` ships empty, so every skill runs as an unregistered local job. Add an entry under `scheduled_jobs` only when a job must run on one specific host. The runner then refuses to run that job anywhere else.

## Notes

- Run skills from a git clone of this repository. The runner checks git state before it runs.
- Lessons are plain Markdown in git, so you can review, edit, and share them.
