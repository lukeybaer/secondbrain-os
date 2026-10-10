// skill-run-wrapper.js
//
// One-call wrapper that ties the three harness-evolution-loop modules
// (skill-lessons + skill-predictions + skill-harness-baseline) into a
// single self-refining execution unit. Today each module works in
// isolation; nothing actually chains them, so the loop is wired but
// not loaded. This wrapper is the glue.
//
// Pattern from the agentic harness engineering 3-layer approach
// (https://x.com/omarsar0/status/2049492169887748365 and arxiv 2604.25850):
//   * Layer 1 (lessons):    pre-run reads the last N entries to bias behavior
//   * Layer 2 (predictions): expected outcome is written BEFORE the run; the
//                            post-run actual is diffed, the diff is the signal
//   * Layer 3 (baseline):    post-run quality is compared to the git-tracked
//                            baseline; degradation triggers a revert rec
//
// Plus the Machina LESSONS.md pattern
// (https://x.com/exm7777/status/2052131046645510583): every run appends a
// 2-line "input pattern -> outcome" entry so the next run learns from this one.
//
// Usage:
//
//   const { wrapSkillRun } = require('./skill-run-wrapper');
//
//   const result = await wrapSkillRun({
//     skillName: 'daily-briefing',
//     runId: `run-${Date.now()}`,
//     expected: { briefingExists: true, sectionCount: 9, errors: 0 },
//     input: 'daily 5:30 AM CT scheduled run',
//     run: async ({ priorLessons, prediction }) => {
//       // ... do the work, returning the actual metrics
//       return { briefingExists: true, sectionCount: 9, errors: 0 };
//     },
//     summarize: (actual) => `shipped ${actual.sectionCount} sections`,
//   });
//
//   // result has: { ok, actual, prediction, diff, allMatched, lessonAppended,
//   //              baseline, baselineComparison, degraded }
//
// Failure handling: if run() throws, the wrapper still records the actual
// outcome ({ error: 'message' }), appends a "FAIL" lesson, and records the
// run for the next pass to see. The error is re-thrown to the caller so
// the scheduled-task runner can decide whether to alert.

const lessons = require('./skill-lessons');
const predictions = require('./skill-predictions');
const baseline = require('./skill-harness-baseline');

async function wrapSkillRun(args) {
  const {
    skillName,
    runId,
    expected,
    input,
    run,
    summarize,
    saveBaselineIfAbsent = true,
    lessonsContextLimit = 10,
  } = args;

  if (!skillName || typeof skillName !== 'string') {
    throw new Error('wrapSkillRun requires skillName');
  }
  if (!runId || typeof runId !== 'string') {
    throw new Error('wrapSkillRun requires runId');
  }
  if (typeof run !== 'function') {
    throw new Error('wrapSkillRun requires run() function');
  }

  // Layer 1: read prior lessons. They become an input to the run() body
  // so the work can self-refine based on what worked / what failed before.
  const priorLessons = lessons.readRecentLessons(skillName, lessonsContextLimit);
  const priorLessonsContext = lessons.lessonsAsContext(skillName, lessonsContextLimit);

  // Layer 2: write the prediction BEFORE running. The diff between
  // expected and actual is the per-run learning signal.
  let prediction = null;
  if (expected && typeof expected === 'object') {
    prediction = predictions.writePrediction(skillName, { expected, runId }).data;
  }

  // Run the actual work. Catch + record on failure -- a failed run still
  // needs to land in LESSONS.md so the NEXT run is biased away from the
  // failure mode, instead of repeating it silently.
  let actual = null;
  let runError = null;
  let startedAt = new Date().toISOString();
  let completedAt = null;
  try {
    actual = await run({ priorLessons, prediction, priorLessonsContext });
  } catch (err) {
    runError = err && err.message ? err.message : String(err);
    actual = { error: runError };
  }
  completedAt = new Date().toISOString();

  // Layer 2: record the actual outcome against the prediction.
  let diff = null;
  let allMatched = false;
  if (prediction) {
    try {
      const recorded = predictions.recordActual(skillName, { runId, actual });
      diff = recorded.diff;
      allMatched = !!recorded.allMatched;
    } catch (err) {
      // Recording is best-effort; don't fail the whole run on a write hiccup.
      diff = null;
    }
  }

  // Append a 2-line lesson. The outcome string is the caller-supplied
  // summary (preferred) or a default derived from match/error state. The
  // input string is the caller-supplied label (preferred) or runId.
  let lessonAppended = false;
  let lessonError = null;
  let outcomeText = '';
  if (runError) {
    outcomeText = `FAIL: ${runError}`;
  } else if (typeof summarize === 'function') {
    try {
      outcomeText = summarize(actual) || 'completed';
    } catch (err) {
      outcomeText = 'completed (summarize threw)';
    }
  } else {
    outcomeText = allMatched
      ? 'completed; all predicted metrics matched'
      : 'completed; some predicted metrics drifted';
  }
  const inputText = input || `run ${runId}`;
  try {
    lessons.appendLesson(skillName, { input: inputText, outcome: outcomeText });
    lessonAppended = true;
  } catch (err) {
    lessonError = err && err.message ? err.message : String(err);
  }

  // Layer 3: compare to baseline. Only compares numeric actual metrics;
  // non-numeric actuals (booleans, strings) are matched exactly.
  let baselineRow = baseline.loadBaseline(skillName);
  let baselineComparison = null;
  let degraded = false;
  if (!baselineRow && saveBaselineIfAbsent && !runError && actual && typeof actual === 'object') {
    try {
      baselineRow = baseline.saveBaseline(skillName, actual);
    } catch (err) {
      baselineRow = null;
    }
  }
  if (baselineRow && actual && typeof actual === 'object' && !runError) {
    try {
      baselineComparison = baseline.compareToBaseline(skillName, actual);
      degraded = !!baselineComparison.degraded;
    } catch (err) {
      baselineComparison = null;
    }
  }

  const result = {
    ok: !runError,
    skillName,
    runId,
    startedAt,
    completedAt,
    actual,
    prediction,
    diff,
    allMatched,
    lessonAppended,
    lessonError,
    outcomeText,
    baseline: baselineRow,
    baselineComparison,
    degraded,
    error: runError,
  };

  if (runError) {
    // Re-throw so the scheduled-task runner can decide whether to alert.
    const e = new Error(runError);
    e.skillRunResult = result;
    throw e;
  }

  return result;
}

module.exports = { wrapSkillRun };
