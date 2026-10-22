// A model rung may run the test suite. Tests that spawn run-scheduled-skill.js
// with { ...process.env } are legitimate probes, not a nested start, so the
// rung marker never reaches them.
delete process.env.AMY_SCHEDULED_SKILL_MODEL_RUNG;
