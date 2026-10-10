'use strict';

// SYSTEM HEALTH METRIC DEFINITION REGISTRY.
//
// ExampleCo, 2026-09-23: every metric drill-down starts with the metric definition
// in plain English, exactly what is failing, and what happened versus what was
// expected. This registry is the single source of each metric's definition,
// its exact failure condition, and its expected pass condition, keyed by the
// stable work-unit id (never by a face label, which drifts on every rename).
// Each entry is derived from that metric's contract page at
// skills/cards/system_health/metrics/<slug>.md. The current actual value and
// failure text always come from the row's verdict data at render time.
//
// scripts/__tests__/metric-drilldown-header.test.js fails when any id in
// SYSTEM_HEALTH_MEASUREMENT_IDS lacks an entry here.

const SYSTEM_HEALTH_METRIC_DEFINITIONS = Object.freeze({
  "system_health:backups": Object.freeze({
    definition: "Checks whether last night's backup actually finished and could be restored, not just that a backup file exists somewhere. It protects ExampleCo from discovering during a real disaster that backups were silently broken.",
    expected: "A backup completion record no older than 30 hours, local and cloud copies matching, an identified backup object in its expected storage location, and a successful restore test no older than 8 days that is tied to that exact backup file and its checksum.",
    failure: "Fails when the backup completion record is missing or older than 30 hours, local and cloud copies do not match, the backup object cannot be found where expected, or the restore test is missing, older than 8 days, or not tied to that exact backup.",
  }),
  "system_health:ec2": Object.freeze({
    definition: "Confirms the main cloud server that runs Amy is up, reachable, and running every service it is required to run. This is the base machine almost everything else depends on, so if it is down, most of Amy's work stops.",
    expected: "The server responds to a current health check and every required background service on it is confirmed running.",
    failure: "Fails when the server does not respond, a required service is not running, or there is no current proof of a successful check.",
  }),
  "system_health:news-summaries": Object.freeze({
    definition: "A general check on whether the news summary generation process is producing output at all, and whether current evidence of that exists. It is a broader companion to the more detailed News write-ups check.",
    expected: "The news summary generation process ran successfully and produced current, readable evidence of its output.",
    failure: "Fails when summary generation did not run, produced no usable output, or the evidence proving it ran is missing or out of date.",
  }),
  "system_health:news-headlines-with-a-full-story": Object.freeze({
    definition: "Measures what share of news articles that already have a good headline also have their full three-paragraph story written and ready to publish. ExampleCo's standard is that every good headline has real substance behind it, with no half-finished articles slipping onto the briefing.",
    expected: "100 percent of articles with a passing headline also have their three-paragraph story available.",
    failure: "Fails when any article with a good headline is missing its three-paragraph story, or when the evidence needed to measure this is missing or unreadable.",
  }),
  "system_health:llm": Object.freeze({
    definition: "Confirms Amy's core AI models are actually reachable and answering right now, not just that a process or connection is technically running. Everything Amy does depends on being able to reach a working model.",
    expected: "A successful, current live test call to the AI model that returns a real response, not just the process or tunnel being present.",
    failure: "Fails when the live test call fails, the model executable cannot be found or started, or there is no current successful proof of a real response.",
  }),
  "system_health:automated-regression-suite": Object.freeze({
    definition: "A rollup of whether Amy's whole automated test suite is currently passing, and whether any failure needs action. It is the top-level signal that sits above all the individual test-category checks below it.",
    expected: "Current test-run evidence shows the suite passing, with results recent enough to trust.",
    failure: "Fails when current test evidence is missing, stale, or shows failures that require action.",
  }),
  "system_health:tests-briefing": Object.freeze({
    definition: "Confirms the automated tests covering briefing generation, its sections, and how it renders are currently passing, catching regressions before ExampleCo ever sees a broken briefing.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-dispatch": Object.freeze({
    definition: "Confirms the automated tests covering the loop that turns incoming Otter calls and Gmail into Amy dispatch actions are currently passing, protecting the pipeline that lets Amy act on new information.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-dashboard": Object.freeze({
    definition: "Confirms the automated tests covering how the dashboard parses and displays its data are currently passing, so the dashboard ExampleCo looks at cannot silently render wrong or broken.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-action-item-ranker": Object.freeze({
    definition: "Confirms the automated tests covering how action items are ranked and prioritized are currently passing, protecting whether ExampleCo sees the most important to-dos first.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-auto-reply": Object.freeze({
    definition: "Confirms the automated tests covering the safety rules around inbound auto-replies are currently passing, so Amy cannot start auto-replying in ways that were never approved.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-self-heal": Object.freeze({
    definition: "Confirms the automated tests covering Amy's self-repair controller and its loop discipline are currently passing, protecting the machinery that fixes other problems automatically.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-memory": Object.freeze({
    definition: "Confirms the automated tests covering memory file formatting and indexing are currently passing, protecting the integrity of what Amy remembers about ExampleCo.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-video": Object.freeze({
    definition: "Confirms the automated tests covering video quality checks and rubric tools are currently passing, protecting the pipeline that grades whether a finished video is good enough to publish.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-vapi": Object.freeze({
    definition: "Confirms the automated tests covering the phone-call assistant's prompt and configuration are currently passing, protecting the voice system Amy uses to call people on ExampleCo's behalf.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-ingest": Object.freeze({
    definition: "Confirms the automated tests covering how Otter calls, Gmail, and LinkedIn data get pulled into Amy are currently passing, protecting the intake side of the whole system.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-studio": Object.freeze({
    definition: "Confirms the automated tests covering the video studio renderer and thumbnail generation are currently passing, protecting the tools used to produce finished videos.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-devops": Object.freeze({
    definition: "Confirms the automated tests covering release hygiene and operational practices are currently passing, protecting how safely and cleanly changes get deployed.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:tests-other": Object.freeze({
    definition: "Confirms the remaining automated tests that do not fit any other category, including broader end-to-end checks, are currently passing, so nothing outside the named categories quietly rots.",
    expected: "Every test in this category passes with zero failures, every selected test file completes, the code checkout is clean and matches the running release, and the result is no more than 24 hours old.",
    failure: "Fails when a test in this category fails, a test file does not complete, the checkout does not match the release, or the result is missing or older than 24 hours.",
  }),
  "system_health:gmail-scan": Object.freeze({
    definition: "Confirms Amy can actually reach ExampleCo's Gmail and that the most recent scan for new mail completed successfully and recently. This is the trigger that lets Amy notice and act on new email.",
    expected: "A successful, current Gmail scan with proof recent enough to trust.",
    failure: "Fails when Gmail cannot be reached, the scan did not complete, or there is no current proof of a successful scan.",
  }),
  "system_health:api-audit": Object.freeze({
    definition: "Confirms Amy regularly checks which paid API keys and integrations are actually being used for real work versus sitting idle or duplicated, so ExampleCo is not paying for or exposed by credentials nobody needs. It looks at genuine usage, not just whether a key exists somewhere.",
    expected: "A current audit run with itemized findings on each credential's real usage, and a receipt proving the audit is recent.",
    failure: "Fails when the audit has not run recently, its findings are missing or incomplete, or the receipt proving it ran is stale.",
  }),
  "system_health:neo4j-cpu-cap": Object.freeze({
    definition: "Confirms the database server behind Amy's knowledge graph is staying within its CPU limit, so a runaway process there cannot overload the shared cloud server everything else runs on.",
    expected: "The CPU cap check shows the graph database using at most 1.5 CPUs, with a clean status and evidence no older than 36 hours.",
    failure: "Fails when the database is using more than 1.5 CPUs, the check status is not clean, or the evidence proving the check is missing or older than 36 hours.",
  }),
  "system_health:memory": Object.freeze({
    definition: "Confirms Amy's long-term written memory about ExampleCo is intact, readable, and not silently growing past a safe size. Corrupted or bloated memory risks Amy forgetting or misapplying facts about ExampleCo's life and businesses.",
    expected: "The memory files are readable and non-empty, zero formatting or broken-link issues are found by the memory checker, and the always-loaded memory summary file stays under its size limit, all confirmed by a receipt no older than one hour.",
    failure: "Fails when memory files cannot be read, the memory checker finds formatting or broken-link issues, the always-loaded summary file exceeds its size limit, or the proof receipt is missing, mismatched to the current release, or older than one hour.",
  }),
  "system_health:ExampleCo": Object.freeze({
    definition: "Loads the public ExampleCo website the way a fan would, so ExampleCo knows the live product is reachable. This is a real request to ExampleCo.com made when System Health renders, not a copied status.",
    expected: "ExampleCo.com answers HTTP 200 within 8 seconds on the check made for this render.",
    failure: "Fails when ExampleCo.com answers with an error status, times out, or cannot be reached.",
  }),
  "system_health:client-app-app": Object.freeze({
    definition: "Opens the Client App invoice app and asks its invoice system whether it is up, so ExampleCo knows the client can open the app and save invoices right now.",
    expected: "The Client App app page answers HTTP 200 and the invoice API health check answers ok, both on the check made for this render.",
    failure: "Fails when the app page does not load, or the invoice API health check errors, times out, or answers without ok.",
  }),
  "system_health:client-app-email": Object.freeze({
    definition: "Checks that the Google Workspace login Client App uses to email invoices to customers still works. It uses the app's own connection check, which sends no email.",
    expected: "The Client App email connection check answers ok on the check made for this render.",
    failure: "Fails when the email connection check errors, times out, or answers without ok, which means invoice emails may not reach customers.",
  }),
  "system_health:client-app-backups": Object.freeze({
    definition: "Confirms both layers of Client App's production backups in its own AWS account: every live table (customers, invoices, invoice lines, products, special prices, purchase orders and settings) can be restored to any minute of the last 35 days, and the nightly change-history job saved each changed record's previous version so the client can see what changed and what it was before. It only reads status and changes nothing.",
    expected: "All nine live tables report point-in-time recovery restorable to within the last hour, and the nightly change-history job finished within the last 26 hours with zero errors across customers, products, invoices, invoice lines and special prices.",
    failure: "Fails when any live table has recovery off or more than an hour behind, the nightly change-history job is older than 26 hours, reported errors or skipped a table, or either status cannot be read.",
  }),
  "system_health:spec-changes": Object.freeze({
    definition: "Watches how often the core briefing specification document is being edited, since frequent rewrites of the rules that define the briefing are a sign of instability rather than steady improvement. It counts changes; it does not judge whether current rules are being followed.",
    expected: "At most two commits touching the briefing specification document in the past 24 hours, confirmed by a receipt no older than one hour.",
    failure: "Fails when more than two changes to the specification landed in the past 24 hours, or the receipt proving the count is missing, mismatched, or older than one hour.",
  }),
  "system_health:video-pipeline": Object.freeze({
    definition: "Confirms ExampleCo's video production pipeline, the steps that turn raw source material into a finished branded video, is actually running and its quality checks are passing, with current proof of real progress.",
    expected: "The pipeline is executing normally, its quality gates are passing, and there is current proof of real progress.",
    failure: "Fails when the pipeline is stalled, a quality gate fails, or there is no current proof of progress.",
  }),
  "system_health:stuck-videos": Object.freeze({
    definition: "Finds videos stalled in production with no real progress being made, as opposed to videos that are legitimately still being worked on. It exists so a video does not sit silently abandoned in the queue while looking like it is still in progress.",
    expected: "No video sits in the queue past its expected working time without documented, concrete progress toward a corrected, approved version.",
    failure: "Fails when a video has stalled with no real progress, when a rejected video's underlying problem was retried without being fixed, or when the queue state does not honestly reflect what has and has not been done.",
  }),
  "system_health:scheduled-tasks": Object.freeze({
    definition: "Confirms Amy's recurring background jobs, like nightly analysis and maintenance runs, actually ran and produced current output on this release of the software, rather than silently failing or running stale code.",
    expected: "Every expected scheduled task, excluding any ExampleCo has explicitly paused, has a current, successful run receipt matching the current software release.",
    failure: "Fails when an expected task's receipt is missing, stale, or does not match the current release; owner-paused tasks are excluded from this count.",
  }),
  "system_health:cloud-briefing": Object.freeze({
    definition: "Confirms today's briefing was actually generated and published where ExampleCo can read it, as its own standalone proof separate from whether every individual card inside it is green.",
    expected: "A published briefing for today's date exists, with a timestamp that is not in the future and no more than 24 hours old.",
    failure: "Fails when no briefing was published for today, the publish timestamp is missing or in the future, or the publish evidence is older than 24 hours.",
  }),
  "system_health:briefing-delivery-slo": Object.freeze({
    definition: "Confirms the daily briefing actually reached ExampleCo, on both Telegram and email, by the 5:30:59 AM Central time deadline. This protects the basic promise that ExampleCo's briefing is waiting for him when he wakes up.",
    expected: "Both the Telegram and email deliveries are confirmed for today's date, with proof they arrived by 5:30:59 AM Central time.",
    failure: "Fails after the deadline when either delivery channel is missing, only partially confirmed, for the wrong date, or confirmed late. Before the deadline the status is simply unknown, never assumed green.",
  }),
  "system_health:amy-gravity": Object.freeze({
    definition: "Confirms Amy is actively checking herself against her own constitutional rules, the Laws of Amy Gravity that govern how she is allowed to operate, and that none of them are currently being violated.",
    expected: "A current, same-day check confirming fresh proof for every applicable law with no known violations.",
    failure: "Fails (is treated as red) when any law is found violated. The status is unknown, not passing, when the day's proof is simply missing.",
  }),
  "system_health:telegram-phone-intake": Object.freeze({
    definition: "Confirms ExampleCo's two inbound channels to Amy, Telegram and the phone system, are actually working right now, so a message or call from ExampleCo will not silently go nowhere.",
    expected: "Both Telegram and the phone system show a successful check result no older than 15 minutes.",
    failure: "Fails when either channel's latest result is missing, failed, inconclusive, dated in the future, or older than 15 minutes.",
  }),
  "system_health:dispatch-backlog": Object.freeze({
    definition: "Watches how much work is piled up waiting for Amy to act on and whether it is actually moving, so requests do not quietly sit untouched. A large but actively draining queue is fine; a queue where items sit frozen is the problem.",
    expected: "No more than 25 items pending, and no pending item has gone more than two hours without any progress.",
    failure: "Fails when more than 25 items are pending, any item has sat more than two hours with no progress, or the underlying queue or task records cannot be read.",
  }),
  "system_health:otter-speaker-enrichment": Object.freeze({
    definition: "Watches only the last seven days of recorded calls to make sure they have been fully processed: audio available, transcripts enriched, and speakers identified where possible. Older backlog does not count against this check; it is strictly about whether recent calls are being kept current.",
    expected: "Every call from the past seven days has its audio, transcript enrichment, and identity evidence successfully processed, with no broken or missing processing steps for that recent window.",
    failure: "Fails when a call from the past seven days is missing a required processing step, such as audio, enrichment, or a working identity resolver. Unidentified voices alone, when ExampleCo simply has not named them, are not a failure.",
  }),
  "system_health:otter-hypothesis-projection": Object.freeze({
    definition: "Confirms that provisional name guesses for unidentified voices on calls are being matched against the current, up-to-date list of who's who, rather than against an outdated list that could misattach a name to the wrong voice.",
    expected: "The name-guess data proves it was built from the exact same voice roster currently in use, verified by a matching identity checksum.",
    failure: "Fails when the name-guess data's checksum does not match the current voice roster, or when that proof is missing.",
  }),
  "system_health:otter-name-resolver": Object.freeze({
    definition: "Confirms the process that proposes names for unidentified voices on calls is current: its last complete run is no more than 4 hours old and it covered every unknown voice that existed when it ran. Calls that land after a run, or are still processing, wait for the next run and never turn this red.",
    expected: "The last run finished cleanly within the past 4 hours with zero failed targets, no targets blocked by a repeated-failure guard, and every unknown voice that existed at run time covered.",
    failure: "Fails when the resolver's own run failed or ended in a warning or undefined state, its last complete run is older than 4 hours, or it skipped an unknown voice that existed at its run time.",
  }),
  "system_health:voice-name-judge-orphans": Object.freeze({
    definition: "Finds name proposals for voices on calls that Amy already figured out, but that got silently lost and never shown to ExampleCo because the underlying call grouping shifted afterward. It protects against Amy quietly knowing something and never actually telling ExampleCo.",
    expected: "A current scan finds zero name proposals stranded and unreachable, with a one-time baseline established so future scans can be compared against it.",
    failure: "Fails (turns red) only when the scan itself cannot be trusted, such as it not being tied to the current voice-grouping run or a proposal file being unreadable. A nonzero count of already-known stranded proposals is an open backlog to work through, not treated as this failing state.",
  }),
  "system_health:otter-call-processing-sla": Object.freeze({
    definition: "Confirms calls recorded in the last 24 hours are being fully processed, transcribed, identified, and filed, within their expected time limits, so recent calls do not silently sit half-done. Older backlog is tracked separately and does not affect this check.",
    expected: "Zero calls from the past 24 hours have missed a processing stage deadline, and every call that landed in that window completes end to end within 60 minutes.",
    failure: "Fails when any call from the past 24 hours missed a processing stage deadline or the 60-minute overall completion target, or when the current processing record is missing or unreadable.",
  }),
  "system_health:otter-lifetime-call-processing-completion": Object.freeze({
    definition: "Tracks whether every phone call Otter has ever recorded, no matter how old, has been fully processed and closed out with complete, verified records.",
    expected: "every historical call has internally consistent closing records, a complete completion envelope, and no active stuck or exhausted repair job; older unprocessed calls stay a yellow catch up item and never count toward the red total",
    failure: "Fails (turns red) when a call's records conflict with each other, a completion envelope is missing or invalid, a repair job is stuck or exhausted, or the underlying proof is untrustworthy. Simply having old, not yet processed historical calls is yellow catch up, not red.",
  }),
  "system_health:voice-name-conflicts": Object.freeze({
    definition: "Checks whether Amy's confirmed identification of who is speaking on a call is ever confidently contradicted by later voice analysis.",
    expected: "no calibrated voice match crosses the confidence bar against a different enrolled person; any conflict is shown with the assigned voice, the best alternative match, its probability, and a real audio clip for review",
    failure: "Fails when a trained, calibrated voice model matches a different enrolled person at or above 99 percent calibrated probability, with a raw match score of at least 0.56, and a clear score margin over the person currently assigned.",
  }),
  "system_health:voiceprint-text-conflicts": Object.freeze({
    definition: "Counts true conflicts where a confident voice match to one enrolled person disagrees with a confident or obvious transcript name for a different person, meaning someone may be misidentified.",
    expected: "zero true conflicts, shown along with the total number of name judged rows it was checked against",
    failure: "Fails when at least one row shows a confident acoustic match to one enrolled person that disagrees with a confident transcript name for a different enrolled person. An unmatched voice paired with just a name guess is a separate, non red category and is not counted here.",
  }),
  "system_health:voice-people-projection": Object.freeze({
    definition: "Checks that every confirmed voice identity has been fully written into ExampleCo's People files with the latest ownership and call history.",
    expected: "the projection check is newer than any relevant identity or call content change, has no naming collisions, and every expected People file's voice and call content sections match the voice registry",
    failure: "Fails when the People file projection is missing or out of date, or does not match the current voice registry, for at least one confirmed voice identity.",
  }),
  "system_health:voice-confirmation-save-actions": Object.freeze({
    definition: "Tracks whether clicking Save on a voice identity confirmation actually completes end to end, including any required handoff to update the People file.",
    expected: "every save action reaches a durable acceptance, a completed background job, a projection event, and, when required, a completed People file handoff receipt",
    failure: "Fails when a save action is left pending, has failed, or has gone stale (stuck beyond its normal processing window with no newer progress), or when a required People file handoff never completed.",
  }),
  "system_health:backend-pm2-fleet": Object.freeze({
    definition: "Checks whether all of Amy's backend server processes are actually running and reporting in, not just that the server itself is reachable.",
    expected: "every required backend process is running, except Graphiti which may be intentionally stopped under approved owner policy, with a heartbeat and current release proof no older than 8 minutes",
    failure: "Fails when a required process is offline, unstable, or repeatedly restarting, or when the heartbeat or release proof is missing, older than 8 minutes, or dated in the future.",
  }),
  "system_health:ec2-disk": Object.freeze({
    definition: "Checks how full the cloud server's hard drive is, so Amy does not run out of space and crash.",
    expected: "disk usage stays below 90 percent, with a current release identity and a proof reading no older than 8 minutes",
    failure: "Fails when disk usage reaches or exceeds 90 percent, or the disk reading is missing, corrupted, older than 8 minutes, or dated in the future.",
  }),
  "system_health:ec2-ssh-sessions": Object.freeze({
    definition: "Counts how many SSH logins are open on the cloud server right now. A client that keeps opening tunnels and never closes them fills the server's memory and swap, which is what happened on October 3 with 4,870 open logins.",
    expected: "at most 300 open SSH logins, measured on the current release no more than 8 minutes ago",
    failure: "Fails when more than 300 SSH logins are open, or the login count is missing, corrupted, older than 8 minutes, or dated in the future.",
  }),
  "system_health:graphiti": Object.freeze({
    definition: "Checks whether Amy's knowledge graph service, the system that connects facts about people, projects, and events, is actually running.",
    expected: "the most recent health check reads healthy, with a real timestamp no older than 6 hours",
    failure: "Fails when the health check is missing, reports unhealthy or degraded, or its timestamp is older than 6 hours or dated in the future. A quiet overnight with no new entries is normal and does not fail this on its own.",
  }),
  "system_health:graphiti-advisor": Object.freeze({
    definition: "Checks whether the tool that lets Amy pull relevant background knowledge from the knowledge graph is working, separate from whether the knowledge graph service itself is up.",
    expected: "its own fresh, on the record verification run completes cleanly right after this exact check, not just a past successful result",
    failure: "Fails whenever this check has not been freshly reverified, or the evidence is missing, changed, or failed. It also stays honestly red, by design, while Graphiti recall remains turned off under current owner policy, since no live retrieval proof exists to show.",
  }),
  "system_health:recall-broker": Object.freeze({
    definition: "Checks whether the routing system that fetches remembered context for Amy to use is working correctly, separate from whether Graphiti itself is up.",
    expected: "its own fresh, on the record verification run completes cleanly right after this exact check, not just a past successful result",
    failure: "Fails whenever this check has not been freshly reverified, or the evidence is missing, changed, or failed. It also stays honestly red, by design, while recall remains turned off under current owner policy, since no live retrieval proof exists to show.",
  }),
  "system_health:backups-coverage": Object.freeze({
    definition: "Checks that every category of data Amy is supposed to protect actually has a completed, verified backup.",
    expected: "a current, fully complete backup proof exists with a nonzero and matching count of required versus checked items, verified in cloud storage, with no errors, for every source",
    failure: "Fails when the backup proof is missing, incomplete, contains errors, shows a mismatched or zero count of required versus checked items, or any source lacks verified inventory.",
  }),
  "system_health:life-archive-backup": Object.freeze({
    definition: "Tracks overall backup coverage and restore readiness across every personal data source Amy archives, such as email, calls, and messages.",
    expected: "verified cloud storage coverage and current activity, generally within the last 24 hours, confirmed for every reported source",
    failure: "Fails (turns yellow, never red) when backup or activity evidence for one or more sources is missing, incomplete, or older than the 24 hour freshness window.",
  }),
  "system_health:life-gmail": Object.freeze({
    definition: "Tracks how current the local archive of email data is against the live Gmail account.",
    expected: "new email activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new email activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-otter": Object.freeze({
    definition: "Tracks how current the local archive of Otter phone call transcripts is against the live Otter source.",
    expected: "new call transcript activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new transcript activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-vapi-amy": Object.freeze({
    definition: "Tracks how current the local archive of Amy's own outbound and inbound Vapi phone calls is against the live call source.",
    expected: "new call activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new call activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-linkedin-posts": Object.freeze({
    definition: "Tracks how current the local archive of LinkedIn posts is against the live LinkedIn source.",
    expected: "new post activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new post activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-linkedin-dms": Object.freeze({
    definition: "Tracks how current the local archive of LinkedIn direct messages is against the live LinkedIn source.",
    expected: "new direct message activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new message activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-whatsapp": Object.freeze({
    definition: "Tracks how current the local archive of WhatsApp messages is against the live WhatsApp source.",
    expected: "new message activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new message activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-dispatches": Object.freeze({
    definition: "Tracks how current the local archive of dispatched Amy commands and tasks is against the live dispatch source.",
    expected: "new dispatch activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new dispatch activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-codex-sessions": Object.freeze({
    definition: "Tracks how current the local archive of Codex AI coding sessions is against the live session source.",
    expected: "new session activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new session activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-claude-code-sessions": Object.freeze({
    definition: "Tracks how current the local archive of Claude Code AI coding sessions is against the live session source.",
    expected: "new session activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new session activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-sms-imessage": Object.freeze({
    definition: "Tracks how current the local archive of text messages and iMessages is against the live source on the phone.",
    expected: "new message activity and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new message activity or matching cloud upload has been observed within the last 24 hours, or the flow's health proof is missing.",
  }),
  "system_health:life-other-prompt-surfaces": Object.freeze({
    definition: "Tracks how current the archive of other AI chat tools, such as ChatGPT, Gemini, or Cursor prompt sessions, is against those live sources.",
    expected: "verified objects present in durable cloud storage under each configured export source; a cloud storage only source with no local mirror still counts as durably archived",
    failure: "Fails (turns yellow, never red) when no verified new content has landed in durable cloud storage for a configured source within the expected window, or the flow's health proof is missing.",
  }),
  "system_health:tests": Object.freeze({
    definition: "Reports the current status of Amy's automated test suite, the checks that confirm her code behaves correctly, grouped by product area but without a numeric pass or fail score tied to this dashboard row.",
    expected: "current runtime test proof for this build is available; tests run on the desktop and in continuous integration rather than against the live cloud build",
    failure: "Fails to render as a pass or fail; this row is informational rather than a red or green gate, and simply states whether current runtime test proof exists for this build.",
  }),
  "system_health:dev-ops": Object.freeze({
    definition: "Checks that Amy's code repository is clean, properly synced against the master branch, and free of release hygiene problems that could block or corrupt deployments.",
    expected: "the working checkout is proven caught up against origin master, with no missing, broken, or stale hooks, guards, or probes",
    failure: "Fails when the checkout has genuinely conflicting uncommitted changes against origin master, which becomes a human review gate, or when hooks, guards, or probes are missing, broken, or stale.",
  }),
  "system_health:deploy-parity": Object.freeze({
    definition: "Checks that the code actually running in production matches the exact code version that was supposed to be released, so nothing deployed halfway or out of sync.",
    expected: "the source code version, the released version, and the live running code version all match exactly",
    failure: "Fails when the source, release, or live running code versions do not match exactly.",
  }),
  "system_health:watcher-interventions": Object.freeze({
    definition: "Counts how many times overnight Amy's automated systems needed a human, attended rescue instead of recovering on their own.",
    expected: "zero interventions recorded for the current day",
    failure: "Fails when one or more interventions are recorded for the day. This is a historical fact for that date that cannot be healed away after the fact, only prevented on future nights.",
  }),
  "system_health:past-week-voice-name-judge-orphans": Object.freeze({
    definition: "Checks for name suggestions from the past week that no longer match any current voice group, meaning a recent call's speaker identification may have been lost in a system update.",
    expected: "zero orphaned name proposals tied to a voice cluster that contains a call dated within the last 7 days, other than ones the voice review queue already shows to ExampleCo with the coverage gap stated",
    failure: "Fails when one or more name proposals from the past week no longer resolve to their current voice cluster and are not shown on the voice review queue, or when the underlying data needed to verify this is missing, stale, or unreadable.",
  }),
  "system_health:session-transcript-freshness": Object.freeze({
    definition: "Tracks how far behind the cloud is in receiving Claude and Codex AI session transcripts from the desktop.",
    expected: "the desktop may be offline without being a problem, but once a transcript is observed, it should reach the cloud within 10 minutes",
    failure: "Fails when an observed session transcript on the desktop runs more than 10 minutes ahead of what the cloud has recorded.",
  }),
  "system_health:session-terminal-receipts": Object.freeze({
    definition: "Checks that every finished, failed, or cancelled Claude or Codex AI session has a verified, permanent transcript record saved.",
    expected: "every completed session has a checksum verified, full transcript receipt in permanent storage",
    failure: "Fails when a session shows a finished, failed, or cancelled status but lacks a checksum verified, full transcript receipt.",
  }),
  "system_health:session-search-projection": Object.freeze({
    definition: "Checks that finished AI session conversations are fully indexed for search, so Amy and ExampleCo can look them up later through search or Telegram.",
    expected: "every committed session event has completed both full text search indexing and, where applicable, knowledge graph indexing",
    failure: "Fails when a committed session event still has search or graph indexing pending, or when indexing accidentally includes hidden reasoning, raw tool output, or excluded people.",
  }),
  "system_health:signal-flow-message-completeness": Object.freeze({
    definition: "Checks that every single Signal message Amy received or sent over the last 24 hours was captured exactly once, with nothing lost or duplicated.",
    expected: "a live connection heartbeat no older than 5 minutes, a full 24 hours of message log coverage, and an exact one to one match between logged messages and captured events",
    failure: "Fails when the Signal connection heartbeat is missing or older than 5 minutes, less than 24 hours of coverage exists, or logged messages do not match captured events one to one.",
  }),
  "system_health:signal-flow-capture": Object.freeze({
    definition: "Checks that every Signal message from the last 24 hours has a permanent, unchangeable capture record proving it was received.",
    expected: "every admitted message from the past 24 hours has a complete capture receipt",
    failure: "Fails when any message from the past 24 hours is missing its capture receipt, or a stuck processing lock has gone unresolved for more than 15 minutes.",
  }),
  "system_health:signal-flow-archive": Object.freeze({
    definition: "Checks that every Signal message and its attachments from the last 24 hours have been permanently and verifiably saved to cloud storage.",
    expected: "a verified checksum proof exists in cloud storage for the raw message, the normalized message, and every attachment or preview, for every message from the past 24 hours",
    failure: "Fails when any message, attachment, or preview from the past 24 hours is missing its verified cloud storage proof.",
  }),
  "system_health:signal-flow-linked-context": Object.freeze({
    definition: "Checks that any link shared in a Signal message over the last 24 hours has been looked up and its content saved, or, if it truly could not be reached, explicitly recorded as unreachable.",
    expected: "every message from the past 24 hours has a settled record, either archived content for each shared link or an explicit reason the link could not be reached, and an explicit note when no link was shared",
    failure: "Fails when a message from the past 24 hours has a shared link with no settled outcome yet, meaning it is still pending or was skipped without a recorded reason.",
  }),
  "system_health:signal-flow-graphiti": Object.freeze({
    definition: "Checks that Signal messages and their shared links from the last 24 hours have been added to Amy's knowledge graph, when that feature is turned on.",
    expected: "while Graphiti stays turned off under current owner policy, an explicit advisory note is shown instead of a false pass; when enabled, every message and every cited link from the past 24 hours needs a completed graph entry",
    failure: "Fails (red) when the Graphiti on or off policy itself is missing or invalid, or when Graphiti is enabled but a message or link from the past 24 hours lacks its graph entry. A validly recorded owner off state is advisory yellow, not a false green.",
  }),
  "system_health:signal-flow-people-knowledge": Object.freeze({
    definition: "Checks that facts learned from Signal messages over the last 24 hours have been saved into ExampleCo's People files when the message was about a specific contact.",
    expected: "every message from the past 24 hours has a final record, either an update landed in the relevant People file, or an explicit note that it was a note to self, a group chat, or otherwise not about one person",
    failure: "Fails when a message from the past 24 hours has no final People knowledge record yet, or when a shared link's content changed after the record was made without being reprocessed.",
  }),
  "system_health:life-family": Object.freeze({
    definition: "Tracks how current Amy's durable life archive is for {source}, comparing the newest captured {source} activity with the newest matching upload to cloud storage. This is advisory coverage context, never a red defect.",
    expected: "new activity from {source} and a matching upload to durable cloud storage observed within the last 24 hours",
    failure: "Fails (turns yellow, never red) when no new activity or matching cloud upload from {source} has been observed within the last 24 hours, or its health proof is missing.",
  }),
});

// Summary rows the System Health section renders beside the metrics. They are
// not registered measurements (no healer, no ledger row), but they still get a
// drill-down, so they still need a definition.
const SYSTEM_HEALTH_SUMMARY_ROW_DEFINITIONS = Object.freeze({
  'system_health:unregistered-quality-gate': Object.freeze({
    definition:
      "Summarizes which System Health metrics are holding the briefing's publish quality gate today, so the non-green rows are named in one line.",
    expected:
      'a current list naming every non-green metric in the accepted daily roster, or zero when every metric is green',
    failure:
      'Fails when the summary is missing, was not re-validated for the current roster, or omits a non-green metric.',
  }),
});

const LIFE_FAMILY_ID = 'system_health:life-family';

function lifeSourceName(workUnitId, name) {
  const fromName = String(name || '').match(/^s*lifes*:s*(.+?)s*$/i);
  if (fromName) return fromName[1];
  const fromId = String(workUnitId || '').match(/^system_health:(?:unregistered-)?life-(.+)$/);
  return fromId ? fromId[1] : '';
}

/**
 * Resolve a metric's registry entry by exact work-unit id. Unregistered Life
 * coverage rows (for example Life: telegram_people) resolve through the Life
 * family entry with the source name substituted. Returns null otherwise.
 */
function resolveMetricDefinition(workUnitId, name) {
  const id = String(workUnitId || '');
  if (id && id !== LIFE_FAMILY_ID && SYSTEM_HEALTH_METRIC_DEFINITIONS[id]) {
    return SYSTEM_HEALTH_METRIC_DEFINITIONS[id];
  }
  if (SYSTEM_HEALTH_SUMMARY_ROW_DEFINITIONS[id]) return SYSTEM_HEALTH_SUMMARY_ROW_DEFINITIONS[id];
  const source = /^system_health:unregistered-life-/.test(id) || /^s*lifes*:/i.test(String(name || ''))
    ? lifeSourceName(id, name)
    : '';
  if (!source) return null;
  const family = SYSTEM_HEALTH_METRIC_DEFINITIONS[LIFE_FAMILY_ID];
  const fill = (text) => text.split('{source}').join(source);
  return {
    definition: fill(family.definition),
    expected: fill(family.expected),
    failure: fill(family.failure),
  };
}

module.exports = {
  SYSTEM_HEALTH_METRIC_DEFINITIONS,
  SYSTEM_HEALTH_SUMMARY_ROW_DEFINITIONS,
  resolveMetricDefinition,
};
