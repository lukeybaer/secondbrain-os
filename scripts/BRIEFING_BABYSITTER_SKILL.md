# Briefing Babysitter Skill

How Amy drives a briefing to genuinely clean. This is the operating model, locked by ExampleCo 2026-06-14. "This is how we work."

## The one rule

**You fix the self-healer, NOT the card.** A clean card is a byproduct of a working overnight self-heal. The goal is to make the OVERNIGHT refresh produce clean cards autonomously. Hand-patching a card's content (splicing markdown, padding a metric) is the wrong move and a regression every time. If a card is broken, the self-healer for that card is broken; fix that.

Mid-day rescue is not a separate, stronger path. Run the actual overnight command graph, with only clock budget and observation changed. If a daytime/babysat run patches a broken executor, gate, probe, generator, deploy wait, or card healer, land that patch as self-healer capability and rerun the same overnight graph before calling the blocker fixed.

## What "clean" means

A technical term: EVERY card clean AND all systems healthy, verified on the live page. See `feedback_clean_briefing_is_a_technical_term.md`, the per-card acceptance criteria in `dev-plans/briefing-clean-definition-2026-06-14.html`, and `memory/project_briefing_spec.md`. Gate: `npm run verify:briefing-cards` (`scripts/verify-briefing-cards-live.js`) plus the per-card criteria. No bs fallbacks: done with real content, or blocked/defective, never looks-filled (`feedback_no_bs_fallback_done_or_blocked.md`).

## The loop (parallel, per card, with dedicated QC)

1. **Run the overnight refresh the way it runs overnight.** `scripts/overnight-self-heal-orchestrator.js` parses the BLOCKERS section into tasks and spawns a session per blocker (investigate / fix / test / consult Codex / commit / push / verify). Plus the briefing build (`cloud-morning-briefing.js` cloud path, `manual-briefing-v3.js` PC path, `refresh-news-only.js` news). Then publish.
2. **Observe the broken cards.** Run the gate against the live dashboard and read each card against its acceptance criteria. List every card that is not clean.
3. **Parallel-loop the broken cards.** Spawn ONE agent per broken card, in parallel, each git-worktree-isolated to avoid races. Each agent:
   - locates WHERE the self-heal fails for that card (the per-card heal logic, the generator, the probe, the source query),
   - fixes the SELF-HEALER for that card (not the card content), test-first, Codex-reviewed on meaningful changes,
   - runs that card's self-heal the way overnight would,
   - **runs a dedicated QC for that card** (a check that the card is genuinely clean per its criteria, on the live render),
   - loops fix -> self-heal -> QC until the QC passes or it hits a real decision-blocker.
4. **Re-run the full overnight refresh, re-gate.** Repeat from step 2 until all cards clean and systems healthy.
5. **Keep trying until you cannot or time runs out** (`feedback_self_heal_keep_trying_until_cant_or_timeout.md`). Hard-block ONLY for drastic, over-$20, or irreversible decisions, stating the decision and what is clean vs not (`feedback_blocker_fix_with_reasonable_assumptions.md`). Fixing self-heal may need ExampleCo's help; ask when genuinely stuck.

## Self-heal health checkpoints

The babysitter loop itself is part of System Health. Track whether every blocker has: live defect capture, owner classification, prior ledger read, duplicate tactic gate, concrete QC restatement, new tactic or material change, failing proof, adversarial/peer review for meaningful changes, fix, push/deploy, deploy or artifact-hash wait, affected refresh, targeted QC, full live QC, and post-QC reflection. Missing checkpoints are a Self-heal health defect.

Mode-equivalence is also a checkpoint: mid-day rescue and scheduled overnight must use the same defect source, ledger, worktree isolation, land/push/deploy path, deploy wait, live QC, and reflection schema. A validator pass with empty card coverage, such as `ok:true` with `cards:{}`, is red. Expected rendered cards come from `scripts/lib/briefing-card-manifest.js`, never from the current validator output.

Until the hard preflight exists, do the manual mode-equivalence checklist before launching agents:

- same overnight command graph
- same typed defect source
- same repair ledger path
- same worktree isolation and serialized landing path
- same deploy or artifact-hash wait
- same targeted QC and full live QC
- same post-QC reflection schema

The hard preflight to build reads `scripts/lib/briefing-heal-run-graph.json` and exits nonzero before agents start on any unapproved graph difference.

## Watch live (play-by-play), fix early

Babysitting means a REAL-TIME play-by-play, not passive waiting for the completion/push event (`feedback_realtime_watch_not_passive_wait.md`). Each heal session streams its live output to a tailable log at `data/agent/heal-sessions/<slug>-<uniq>.log` (the orchestrator wires `onStream` into `heal-executor`). Tail those logs and each worktree's `git status`/HEAD as the run goes, and fix the MOMENT something breaks (a failing command, a missing dependency, a hang), then re-run. Do not wait the 30-minute session budget to confirm a failure you can already see. The heals run worktree-isolated, so `node_modules` is junctioned into each heal worktree (`scripts/lib/isolated-heal-session.js`) or the session cannot run tests and just burns its budget.

## Morning communication

The 5:30 Telegram message is a current-state checkpoint, not a completion claim. Refresh live render QC, quote `green/total` only from the fresh same-date `dashboard-qc-result.json`, name non-green cards as work ongoing, and include the tokenized dashboard link. The 5:29 server attempt and 5:30 runner fallback share one marker. After the bounded healer, send another message only for a real state transition: every card now clean, or the terminal repair window ended non-clean. Never translate a pre-healer markdown failure into "retries exhausted."

## Key files

- Self-healer: `scripts/overnight-self-heal-orchestrator.js` (parallel fan-out, `--observe`/`--parallel`/`--midday`, mode-announce), `scripts/lib/heal-scheduler.js`, `scripts/lib/isolated-heal-session.js` (worktree + node_modules junction + serialized landing), `scripts/health-self-heal.js`, `scripts/lib/heal-executor.js`, `scripts/lib/channel-health-monitor.js` (probes).
- Live session logs (the play-by-play): `data/agent/heal-sessions/*.log`.
- Generators: `scripts/cloud-morning-briefing.js` (cloud, must never emit filler), `scripts/manual-briefing-v3.js` (PC, the real LinkedIn draft enrichment + news), `scripts/refresh-news-only.js`.
- Renderer + per-card parsers: `ec2-server.js` (parse + tile render + knownBlockerBanner).
- Gate + criteria: `scripts/verify-briefing-cards-live.js`, `dev-plans/briefing-clean-definition-2026-06-14.html`, `memory/project_briefing_spec.md`.
- Run log: `data/agent/overnight-self-heal-runs.jsonl`.

## Anti-patterns (do not)

- Do NOT hand-fix a card (splice markdown, pad a metric). Fix the self-healer.
- Do NOT work card-by-card sequentially when you can parallel-loop. One agent per broken card.
- Do NOT declare clean from a function check. Verify the live rendered page with the gate.
- Do NOT ship filler to make a tile non-empty. Done or blocked/defective only.
- Do NOT use a fixed retry count. Keep trying until you cannot or time runs out.
- Do NOT passively wait for the completion/push event. Tail the live session logs (`data/agent/heal-sessions/*.log`) and fix the moment something breaks.
- Do NOT count a day-only hand rescue as overnight capability. Land the self-healer fix and rerun the actual overnight graph.
- Do NOT accept clean validation with no card coverage or after skipped/timed-out prerequisites.
