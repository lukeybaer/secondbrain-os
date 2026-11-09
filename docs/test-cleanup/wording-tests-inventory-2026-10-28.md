# Wording-only tests inventory, 2026-10-28

S-8 decision (owner decision): a test proves behavior (an input and an output a person would notice), rules are enforced where they act, and docs that list code facts are generated from code. This inventory is the classifier output over the whole suite at the base of the S-8 branch. It is data-free: it names files and what they read, never contents.

## How a test is flagged

`scripts/lib/wording-test-lint.js` flags a test file when its assertions are on text read from a repo source or doc file (js, ts, md, sh, html, yml) and it never calls the code under test: no relative require or import of repo code, no spawned process, no evaluated code. Fixtures, temp files and generated output are not flagged. The explicit, rare opt-out is a comment `// wording-test-allowed: <reason>`. The land gate (`scripts/land.js`) fails a land when a changed or added test file is flagged; old files are not re-checked until they change. `npm run verify:no-wording-tests` runs the same check against `origin/master`; `node scripts/verify-no-wording-tests.js --all` lists every flagged file.

## Counts

- Test files scanned: 2151
- Flagged: 175
- DELETE (pure wording, remove): 34
- CONVERT (guards real behavior, needs a behavior test): 124, of which 6 converted in the first batch
- KEEP (legitimate cross-surface or constitution contract): 17
- S-8 finish (2026-10-29): of the 118 remaining CONVERT rows, 82 converted to behavior tests (DONE), 33 deleted as wording-only (DELETED), 1 left (REMAINING: ec2-server-no-reflow-single-deploy, cited by a Gravity authority doc), 2 out of scope (voice-prose-salvage, voice-single-concurrency).
- S-8 close (2026-10-29): the 2 out-of-scope rows converted (84 DONE). The claude-proxy.js turn dedupe and taskkill coverage dropped by 6a78d3030 is restored in scripts/__tests__/claude-proxy-voice-turn-dedupe.test.js (tests/helpers/claude-proxy-harness.cjs runs the real handlers against fake children).

A prior audit (P4 slice 6, 2026-10-23) classified 154 of these source-grep files as KEEP on the argument that the rule is still enforced somewhere. S-8 supersedes that: a rule belongs where it acts (hook, gate, deploy step), and a grep for its wording is not enforcement.

## DELETE (34)

| File | Reads | Why |
|---|---|---|
| scripts/__tests__/approved-briefing-spec-contract.test.js | project_briefing_spec.md | asserts wording in the briefing spec doc |
| scripts/__tests__/aws-costs-honest-unavailable.test.js | ec2-server.js | one regex pin on ec2-server.js |
| scripts/__tests__/aws-clientapp-profile-usage-inventory.test.js | scripts/aws-cost-section.js, scripts/lib/aws-cost-usage.js | string pins on two cost scripts |
| scripts/__tests__/startup-invoice-skill-contract.test.js | SKILL.md, LEARNINGS.md, openai.yaml, memory/reference_startup_invoice_skill.md | asserts wording in a skill, its learnings and a memory file |
| scripts/__tests__/PRIVATE_NAME-mission-partner-memory.test.js | owner_life_goals_current.md, PRIVATE_NAME.md | asserts wording in two memory files |
| scripts/__tests__/ec2-morning-briefing-run-mechanical-pass.test.js | ec2-morning-briefing-run.sh | absence of strings and a comment wording in a shell script |
| scripts/__tests__/ec2-morning-briefing-run-parity-snapshot.test.js | ec2-morning-briefing-run.sh | absence of strings in a shell script |
| scripts/__tests__/ec2-sync-snapshot-persistence.test.js | ec2-server.js | string pins on ec2-server.js |
| scripts/__tests__/failed-prevention-communication-standard.test.js | memory/feedback_owner_communication_standard.md, memory/requirements/communication-standards.md | asserts wording in the communication standard docs |
| scripts/__tests__/feedback-topic-index.test.js | INDEX.md, MEMORY.md | asserts wording and a row count in the memory topic index |
| scripts/__tests__/gmail-s3-flow-cloud-schedule.test.js | install-ec2-gmail-s3-flow-cron.sh, deploy-ec2-server.sh | string pins on a cron installer and the deploy script (deploy prints its own PASS line) |
| scripts/__tests__/helper-cap-single-truth.test.js | memory/AMY_REQUIREMENTS.md, memory/requirements/agent-work.md | doc-vs-doc wording check across memory files |
| scripts/__tests__/install-signal-cli-ec2.test.js | install-signal-cli-ec2.sh | string pins on an installer script (version, paths, flags) |
| scripts/__tests__/life-archive-index-cloud-schedule.test.js | install-ec2-life-archive-index-cron.sh, deploy-ec2-server.sh | string pins on a cron installer and the deploy script (deploy prints its own PASS line) |
| scripts/__tests__/peer-review-fallback-memory.test.js | feedback_codex_own_the_goal_not_the_bug.md, feedback_peer_review_fresh_eyes_per_peer.md, feedback_adversarial_review_methodology.md | asserts wording in memory feedback files |
| scripts/__tests__/peer-review-scope-single-truth.test.js | memory/archive/2026-10-23_feedback_when_to_call_codex_broad_rule.md | asserts wording in an archived memory file |
| scripts/__tests__/run-scheduled-skill-no-markdown-flag-removed.test.js | scripts/run-scheduled-skill.js, scripts/daily-video-topic-gen.js | absence of one flag string in two scripts |
| scripts/__tests__/session-cloud-deploy-wiring.test.js | scripts/deploy-ec2-server.sh, scripts/install-session-cloud-plane-cron.sh, scripts/session-sweep.mjs, scripts/session-cloud-plane.js | string pins on deploy, installer, IAM and producer scripts |
| scripts/__tests__/shared-checkout-sweep-documented.test.js | scripts/lib/briefing-card-producers.js, memory/feedback_branch_cleanliness_isolated_worktrees.md | asserts wording in a memory rule and one string in a producer |
| scripts/__tests__/signal-raw-archive-iam.test.js | ../infra/apply-signal-raw-archive-iam.sh | string pins on an IAM installer script |
| scripts/__tests__/client-app-live-render-source.test.js | ec2-server.js | regex pins on ec2-server.js render source |
| scripts/__tests__/system-health-specific-blocker-copy.test.js | ec2-server.js | string pins on ec2-server.js copy text |
| scripts/__tests__/telegram-image-reading-contract.test.js | ec2-server.js, scripts/lib/telegram-amy-session-runner.js | duplicate of telegram-session-parity (kept) |
| scripts/__tests__/telegram-recent-life-fastpath.test.js | ec2-server.js, scripts/lib/telegram-amy-session-runner.js, scripts/lib/capability-registry.js | source text pins on the chat runner and registry |
| scripts/__tests__/telegram-spine-first-dispatch.test.js | ec2-server.js, scripts/lib/telegram-amy-session-runner.js, scripts/lib/capability-registry.js | source text pins on the chat runner and registry |
| scripts/__tests__/telegram-voice-runtime-deploy.test.js | install-telegram-voice-runtime.sh, deploy-ec2-server.sh | string pins and index ordering on the deploy script and installer |
| scripts/__tests__/upload-slot-manual-bypass.test.js | ec2-server.js | four assertions on a local copy of shouldRun (tests itself) plus string pins on ec2-server.js |
| scripts/__tests__/video-production-benchmark-motion-skill.test.js | SKILL.md, examplechannel-narrator-themes.md, examplechannel-benchmark-motion.md, film.html | asserts wording and file routing in a skill and its templates |
| scripts/__tests__/video-production-source-flow-contract.test.js | SKILL.md, feedback_video_source_cut_narrative_flow.md, RULES_INDEX.md | asserts wording in a skill and two memory files |
| scripts/__tests__/viral-precut-deploy-wiring.test.js | scripts/deploy-ec2-server.sh, scripts/install-ec2-viral-precut-cron.sh | string pins on the deploy script and a cron installer (deploy exits 1 itself when the cron is missing) |
| scripts/__tests__/voice-fargate-entrypoint-contract.test.js | entrypoint.sh | regex pins on a Dockerfile and entrypoint |
| src/main/__tests__/desktop-startup-light.test.ts | src/main/index.ts | index-of ordering pins on src/main/index.ts |
| src/main/__tests__/multi-part-requirements-guard.test.ts | feedback_no_stopping_to_ask.md, feedback_communication.md | asserts wording in two memory feedback files |
| src/main/__tests__/scheduled-skills-paths.test.ts | SKILL.md, cloud-scheduled-fleet.js | asserts wording in retired-task SKILL.md files and absence in a schedule list |

## CONVERT (done) (6)

| File | Reads | Why |
|---|---|---|
| scripts/__tests__/bedrock-funded-lane-token-card.test.js | collect-bedrock-budget-usage.js, refresh-briefing-generated-sections.js | now runs fetchBudget with the AWS CLI stubbed (percent, no limit, denied) |
| scripts/__tests__/otter-fetch-has-user-agent.test.js | otter-audio-download.js | now calls otterFetch with a stubbed fetch (User-Agent and abort signal) |
| scripts/__tests__/plan-video-build-cli.test.js | plan-video-build-cli.js | now spawns the real CLI and checks exit codes and messages |
| src/main/__tests__/feedback-dispatch-to-claude.test.ts | dispatch-feedback-to-claude.js, ipc-handlers.ts | now builds the real prompt and checks what the session is told (IPC source pins dropped) |
| src/main/__tests__/potoken-provider-health-probe.test.ts | health-self-heal.js, pre-briefing-diagnostic.js | now runs the real probe with curl stubbed (green, red, non-200, Windows quiet) |
| src/main/__tests__/rejection-into-rubric.test.ts | process-rejection-into-rubric.js, ipc-handlers.ts | now classifies and analyzes real rejection notes (IPC source pin dropped) |

## CONVERT (118): 84 DONE, 33 DELETED, 1 REMAINING (2026-10-29)

| File | Reads | Why | Status |
|---|---|---|---|
| scripts/__tests__/act-now-retry-safe.test.js | process-dispatches.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DELETED |
| scripts/__tests__/amy-e2e/briefing-dashboard-life-widgets.test.js | ec2-server.js, scripts/lib/briefing-daily-discipline.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/amy-e2e/e5-session-archive-intact.test.js | archive-session-to-s3.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/amy-proxy-timeout-falls-through.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/amy-telegram-conversation-context.test.js | ec2-server.js, scripts/lib/telegram-owner-session.js, scripts/lib/telegram-amy-session-runner.js, memory/requirements/channels.md | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/approve-viral-clip-with-feedback.test.js | ../../ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: renders the real drilldown cards, runs the client approve/reject handlers and the POST routes against a fixture proposal file |
| scripts/__tests__/atomic-release-pm2-followers.test.js | atomic-release.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/bedrock-spawn-no-grandchild-pipe.test.js | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DELETED |
| scripts/__tests__/big-decisions-live-render.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/briefing-card-face-clean-layout.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/briefing-dismiss-removes-item.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/briefing-night-circuit-wiring.test.js | scripts/overnight-watch-report.js | guards real wiring; needs a behavior test that calls the code | DELETED |
| scripts/__tests__/briefing-publish-pipeline-passes-publish-flag.test.js | overnight-briefing-orchestrator.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| scripts/__tests__/comm-coaching-render.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/controller-transaction-fence-coverage.test.js | briefing-card-controller.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DELETED |
| scripts/__tests__/deploy-big-decisions-state.test.js | deploy-ec2-server.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/deploy-ec2-server-local-mode.test.js | deploy-ec2-server.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/deploy-ec2-server-require-scan-gate.test.js | deploy-ec2-server.sh, atomic-release.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/deploy-otter-probe-ownership.test.js | deploy-ec2-server.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/deploy-restores-executable-bits.test.js | ec2-sync-build-path.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/deploy-worktree-lease.test.js | deploy-ec2-server.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/ec2-server-briefing-token-load-order.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/ec2-server-control-url-bounded.test.js | ec2-server.js, scripts/lib/vapi-control-request.js, src/main/live-call-control.ts | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/ec2-server-life-backup-deploy-parity.test.js | ec2-server.js, server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/ec2-server-no-reflow-single-deploy.test.js | deploy-ec2-server.sh, atomic-release.sh, install-healer-deploy-owner.sh, install-overnight-capacity-measurement-cron.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | REMAINING: cited by dev-plans/core/devops-release.md (a Gravity authority doc); retiring it needs a same-day Gravity amendment |
| scripts/__tests__/ec2-server-voice-audio-preload-none.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: renders the voice-confirmation and speaker-pareto drilldowns and checks every audio tag is preload="none" |
| scripts/__tests__/ec2-server-voice-people-render-cost.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: runs knownVoiceprintPeopleFromRegistry through a recording fs; counts come from the rosters artifact, no per-call dir is read, memoized within the TTL |
| scripts/__tests__/global-identity-cap.test.js | scripts/ec2-global-identity-cap-run.sh, scripts/install-ec2-voice-recluster-cron.sh, scripts/install-ec2-otter-call-healer-cron.sh, scripts/ec2-otter-call-healer-run.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DONE |
| scripts/__tests__/gmail-attachment-briefing-row.test.js | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| scripts/__tests__/gmail-backfill-skip-local-seen.test.js | health-self-heal.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DELETED |
| scripts/__tests__/graphiti-deploy-off.test.js | deploy-graphiti-indexed.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DONE |
| scripts/__tests__/graphiti-indexed-search-overlay.test.js | docker-compose.graphiti.yml, scripts/deploy-ec2-server.sh, scripts/lib/deploy-graphiti-indexed.sh, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/heal-tests-reaps-before-run.test.js | heal-tests.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DELETED |
| scripts/__tests__/inbound-call-report-owner-gate-parity.test.js | scripts/vapi-end-of-call.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/values-row-layout.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: replaced by tests/values-row-layout.pw.spec.ts, which renders the real values rows and CSS in Chromium and measures title and why widths |
| scripts/__tests__/linkedin-blocked-on-owner-flow.test.js | ec2-server.js, scripts/cloud-morning-briefing.js, scripts/linkedin-bulk-scan.js, scripts/linkedin-dm-scan.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: scanners run in a sandbox with a fake Chromium (red status, EC2 sync), the cloud card renders blocked on the owner, the Blockers drilldown and refresh routes run sliced from ec2-server.js |
| scripts/__tests__/linkedin-dm-scan-chained.test.js | linkedin-bulk-scan.js | guards real wiring; needs a behavior test that calls the code | DONE: runs the real bulk scan in a sandbox; DM scan runs after context close, a DM failure keeps exit 0, --skip-dm-chain skips it |
| scripts/__tests__/venture-app-scheduler.test.js | the campaign scheduler installer and run scripts | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/news-free-discovery-ladder.test.js | refresh-news-only.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| scripts/__tests__/news-source-pareto-tile-shows-both-numbers.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/no-self-talk-in-render.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/no-ssh-instructions-in-user-content.test.js | ec2-server.js, scripts/health-self-heal.js, scripts/manual-briefing-v3.js, scripts/pre-briefing-diagnostic.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| scripts/__tests__/ExampleCo-decks-skill.test.js | ExampleCo-decks.md, ExampleCo-decks.LESSONS.md, ExampleCo-context.md, MEMORY.md | mixed: doc wording plus a real data or file contract; keep the contract part as a behavior or schema test, drop the wording | DONE |
| scripts/__tests__/otter-lane-scope.test.js | scripts/ec2-otter-lane-scope-run.sh, scripts/install-ec2-otter-call-healer-cron.sh, scripts/ec2-otter-call-healer-run.sh, scripts/ec2-otter-derived-audio-retention-run.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DELETED |
| scripts/__tests__/otter-raw-revision-immutability.test.js | otter-wavlm-speaker-resolver.js, voice-incremental-recluster.js | guards real wiring; needs a behavior test that calls the code | DONE: runs the resolver with a stub embedding backend and applyAssignmentToCall; enriched files gain the identity, raw file hashes are unchanged |
| scripts/__tests__/outbound-call-stop-wiring.test.js | src/main/calls.ts, src/main/server.ts, scripts/vapi-self-call-status-test.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/per-card-briefing-migration-wiring.test.js | dev-plans/SPEC-per-card-briefing.md, ec2-server.js, scripts/ec2-morning-briefing-run.sh, docker-compose.graphiti.yml | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/process-dispatches-pins-cli-model.test.js | scripts/process-dispatches.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| scripts/__tests__/proxy-imports-what-it-calls.test.js | claude-proxy.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| scripts/__tests__/recall-broker-route-contract.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/refresh-news-bedrock-primary.test.js | refresh-news-only.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| scripts/__tests__/system-health-proof-scheduling.test.js | install-ec2-deploy-parity-cron.sh, deploy-ec2-server.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DONE |
| scripts/__tests__/targeted-refresh-side-effects.test.js | cloud-morning-briefing.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| scripts/__tests__/telegram-briefing-link-only.test.js | ec2-server.js, briefing-notify.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/telegram-send-scrubs-upstream-errors.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/tile-list-single-scroll.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/vapi-outbound-not-free-inbound.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/vapi-stream-fallback.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/video-production-finance-template.test.js | SKILL.md | mixed: doc wording plus a real data or file contract; keep the contract part as a behavior or schema test, drop the wording | DONE |
| scripts/__tests__/viral-clips-auth-and-honest-blocker.test.js | refresh-briefing-generated-sections.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| scripts/__tests__/viral-short-authentic-source.test.js | build-viral-clip.js | guards real wiring; needs a behavior test that calls the code | DONE |
| scripts/__tests__/voice-llm-cancellation-deadline.test.js | claude-proxy.js, ec2-server.js, scripts/lib/vapi-live-assistant.js, scripts/push-amy-vapi-config.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: runs streamClaudeLLM, streamViaLocalProxy and streamClaudeCLI with stubbed lanes; other cases are covered by the voice-cloud-inference, codex-app-server-client, voice-paid-primary, vapi-stream-fallback and voice-release-proof tests. Gap closed 2026-10-29: claude-proxy-voice-turn-dedupe.test.js runs the real Codex exec and Claude fallback handlers (supersede, exact-retry replay, tool-call no-repeat, taskkill /T with root fallback) |
| scripts/__tests__/voice-owner-send-honest-delivery.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: runs handleSendMessage against a sender applying the real telegramSendAllowed policy; owner send delivers, suppressed or failed sends report failed |
| scripts/__tests__/voice-prose-salvage.test.js | claude-proxy.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE: drives the real Claude voice lane with a fake child; prose is spoken, machinery is refused as unreadable |
| scripts/__tests__/voice-review-inline-limit.test.js | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE: renders 376 unknown and 200 unresolved voices; each lane shows exactly the limit and names how many more wait |
| scripts/__tests__/voice-single-concurrency.test.js | voice-fargate-trigger.js, otter-post-ingest-voice-intelligence.js | guards real wiring; needs a behavior test that calls the code | DONE: runs launchVoiceTask capacity gating and the real acquireLock/releaseLock against a temp dir |
| scripts/__tests__/youtube-auth-flow-source.test.js | youtube-auth.js, ec2-server.js, scripts/lib/credential-broker.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| scripts/__tests__/youtube-personal-channel-guard.test.js | ../../ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| sites/<private-site>/tests/rendered-html.test.mjs (private site; path withheld from the public mirror) | ../lib/motions.ts, ../app/page.tsx, ../db/motion-selection.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/amy-e2e-e4-camera-health-ui.test.ts | src/main/studio.ts, src/preload/index.ts, src/renderer/src/pages/Studio.tsx | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/amy-e2e-e4-partial-failure-records.test.ts | src/main/studio.ts | guards real wiring; needs a behavior test that calls the code | DELETED |
| src/main/__tests__/amy-e2e-e4-remux-render-intact.test.ts | src/main/studio.ts, src/main/studio-render.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/auto-regen-ec2-worker.test.ts | auto-regen-rejected-videos.js, install-ec2-auto-regen-cron.sh | pins deploy or installer script text; replace with a dry run of the script, or rely on the deploy's own PASS and health proof | DONE |
| src/main/__tests__/backup-cli-hardening.test.ts | backups.ts, backup-cli.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/briefing-content-pipeline-blocked.test.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| src/main/__tests__/briefing-output.test.ts | manual-briefing-v3.js, briefing-${todayIso}.md | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| src/main/__tests__/briefing-reputation-risk-provenance.test.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DELETED |
| src/main/__tests__/briefing-system-health-detail.test.ts | manual-briefing-v3.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| src/main/__tests__/briefing-test-failures-format.test.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DELETED |
| src/main/__tests__/briefing-us-news-section.test.ts | ec2-server.js, cloud-morning-briefing.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| src/main/__tests__/callback-owner-no-goal-bleed.test.ts | calls.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/health-self-heal-video-regen-wired.test.ts | health-self-heal.js | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| src/main/__tests__/llm-routing-guard.test.ts | claude-proxy.js, claude-runner.ts | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| src/main/__tests__/media-protocol-range.test.ts | index.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/self-health-startup-wiring.test.ts | startup-checks.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/snapshot-people-aggregator-filter.test.ts | ec2-server.js, snapshot-people-and-memory-delta.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| src/main/__tests__/telegram-raw-provider-egress.test.ts | telegram.ts | pins runtime wiring in a script that needs a small export plus a stubbed dependency to test by behavior | DONE |
| src/main/__tests__/thumbnail-aurora-pipeline.test.ts | auto-regen-rejected-videos.js, SKILL.md | mixed: doc wording plus a real data or file contract; keep the contract part as a behavior or schema test, drop the wording | DONE |
| src/main/__tests__/thumbnail-first-frame-defect-detector.test.ts | process-rejection-into-rubric.js | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/video-aurora-pipeline.test.ts | auto-regen-rejected-videos.js, SKILL.md | mixed: doc wording plus a real data or file contract; keep the contract part as a behavior or schema test, drop the wording | DONE |
| src/main/__tests__/video-pipeline-liveness.test.ts | ipc-handlers.ts, ContentPipeline.tsx, video-pipeline.ts | guards real wiring; needs a behavior test that calls the code | DONE |
| src/main/__tests__/video-reject-requires-reason.test.ts | ec2-server.js, auto-regen-rejected-videos.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/aws-costs-client-app-rendering.spec.ts | aws-cost-section.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/backwards-compat-during-migration.spec.ts | auto-regen-rejected-videos.js | guards real wiring; needs a behavior test that calls the code | DONE |
| tests/briefing-clean-contract.spec.ts | validate-briefing-quality.js, ec2-server.js, finance-rate-indexes.js, morning-shorts-proposals.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-copy-matches-state.spec.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| tests/briefing-detail-focus-on-click.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| tests/briefing-detail-overlay.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-drilldown-evidence.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| tests/briefing-loop-claims.spec.ts | manual-briefing-v3.js, heal-tests.js, SKILL.md | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| tests/briefing-memory-delta-per-entry-why.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-news-coverage.spec.ts | ec2-server.js, manual-briefing-v3.js, refresh-briefing-generated-sections.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| tests/briefing-people-memory-cards.spec.ts | ec2-server.js, snapshot-people-and-memory-delta.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-reputation-why.spec.ts | manual-briefing-v3.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-stuck-videos-tier-1.spec.ts | manual-briefing-v3.js, ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/briefing-system-health-naming.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| tests/content-pipeline-rejected-visibility.spec.ts | ContentPipeline.tsx | guards real wiring; needs a behavior test that calls the code | DONE |
| tests/ec2-askAmy-no-paid-api.spec.ts | ec2-server.js, claude-proxy.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/gmail-send-blank-body-guard.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/manual-briefing-noise-fixes.spec.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| tests/manual-briefing-proposals-use-contact-history.spec.ts | manual-briefing-v3.js, linkedin-network-news.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DELETED |
| tests/manual-briefing-sections.spec.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| tests/manual-briefing-clientapp-source.spec.ts | manual-briefing-v3.js | pins briefing generator source; call the generator with a fixture and assert the rendered card | DONE |
| tests/playwright-overlay-no-hardcoded-tags.spec.ts | playwright_aurora_overlay.js | guards real wiring; needs a behavior test that calls the code | DONE |
| tests/telegram-no-approval-notification.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |
| tests/vapi-infra-failure-guard.spec.ts | ec2-server.js, claude-runner.ts | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/video-approval-filters-exclude-posted.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DONE |
| tests/video-approvals-show-all-queued.spec.ts | ec2-server.js | pins the shape of ec2-server.js render/route source; needs the renderer exported or an HTTP fixture and an assertion on the output | DELETED |

## KEEP (17)

| File | Reads | Why |
|---|---|---|
| scripts/__tests__/bounded-helper-context-policy.test.js | memory/feedback_bounded_helper_context.md, memory/MEMORY.md, memory/requirements/agent-work.md, .codex/instructions.md | cross-surface parity (Claude, Codex, memory carry the same rule) |
| scripts/__tests__/briefing-watcher-owner-policy.test.js | memory/project_briefing_spec.md, memory/reference_ec2_claude_auth.md, memory/requirements/dependencies.md, memory/reference_amy_state_locations.md | owner policy parity between memory and the codex adapter |
| scripts/__tests__/communication-completeness-standard.test.js | memory/requirements/communication-standards.md, memory/AMY.md, memory/feedback_communication.md, .codex/instructions.md | cross-surface parity (standard present in every adapter) |
| scripts/__tests__/constitution-precedence.test.js | memory/AMY_AUTHORIZATIONS.md | constitution: the one precedence line must stay in the authorizations file |
| scripts/__tests__/gmail-attachment-intelligence-parity.test.js | AMY.md, memory-architecture.md | cross-surface parity contract |
| scripts/__tests__/graphiti-advisor-contract-wiring.test.js | .codex/instructions.md, scripts/claude-hooks/graphiti-advisor-start.mjs, scripts/claude-hooks/graphiti-advisor-context.mjs, memory/AMY_REQUIREMENTS.md | cross-surface contract across adapters, hooks and voice |
| scripts/__tests__/gravity-g8-authority.test.js | AMY_GRAVITY.md | constitution: law row and authority file must agree |
| scripts/__tests__/mandarin-cue-cards-skill-contract.test.js | SKILL.md, LEARNINGS.md, reference_mandarin_cue_cards_skill.md, real-time-intelligence.md | cited by name in the Mandarin core method doc (verify-core-doc-citations); core doc and test move together |
| scripts/__tests__/mandarin-listening-lessons-skill-contract.test.js | real-time-intelligence.md, mandarin-learning.md, SKILL.md, LEARNINGS.md | cited by name in the Mandarin core method doc (verify-core-doc-citations); core doc and test move together |
| scripts/__tests__/one-amy-surface-policy.test.js | scripts/lib/voice-internal-self-test.js, scripts/lib/voice-release-proof.js, AGENTS.md, memory/AMY.md | cross-surface parity (every surface adapter carries One Amy) |
| scripts/__tests__/paid-voice-primary-policy.test.js | memory/AMY_AUTHORIZATIONS.md, memory/AMY_GRAVITY.md | constitution: paid-API lane terms must match in the two authority files |
| scripts/__tests__/people-file-communication-loop.test.js | AMY.md, contacts.md, feedback_read_contacts_before_advising.md, feedback_send_messages_as_amy_by_default.md | cross-surface parity contract |
| scripts/__tests__/requirements-index-split.test.js | AMY_REQUIREMENTS.md, AMY_REQUIREMENTS-history-2026-10-23.md | size and split contract on the requirements index |
| scripts/__tests__/telegram-session-parity.test.js | ec2-server.js, telegram-amy-session-runner.js, channels.md | cross-surface parity (Chat runner equals session behavior) |
| src/main/__tests__/amy-versions-bundle-freshness.test.ts | index.js | freshness contract on a built bundle |
| src/main/__tests__/global-claude-md-imports-memory.test.ts | CLAUDE.global.md, MEMORY.md | parity: the global adapter must import Tier 1 memory |
| tests/communication-tldr-format.spec.ts | CLAUDE.global.md, MEMORY.md, feedback_communication_format_tldr_detail.md, instructions.md | cross-surface parity for the answer format (Claude, Codex, runtime formatters) |

