// A model rung may run the test suite. Tests that spawn run-scheduled-skill.js
// with { ...process.env } are legitimate probes, not a nested start, so the
// rung marker never reaches them.
delete process.env.AMY_SCHEDULED_SKILL_MODEL_RUNG;

// A watched job (the System Health category refresh, a night healer) may run the
// suite too. Its registration belongs to that outer job, not to the code under
// test: inherited, watchedLimitMs() swaps every guessed limit for the 3 hour one
// and tests that pin a module's own limit fail (tests-ingest, 2026-11-09). A test
// that needs watched behavior sets these itself.
delete process.env.AMY_WATCHED_JOB_ID;
delete process.env.AMY_WATCHED_JOB_PROGRESS;
