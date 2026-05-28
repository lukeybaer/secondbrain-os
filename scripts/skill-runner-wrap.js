#!/usr/bin/env node
// skill-runner-wrap.js
//
// Universal wrapper for scheduled-task skills. Phase 2 of the
// harness-evolution-loop (see memory/project_harness_evolution_loop.md).
//
// Usage:
//   const { runWithLessons } = require('./scripts/skill-runner-wrap');
//   const result = await runWithLessons('video-aurora', {
//     input: 'AILifeHacks daily batch, 4 videos requested',
//     run: async (ctx) => {
//       // ctx.lessonsContext has the last N LESSONS.md entries as a prompt fragment
//       // ... do the work ...
//       return { outcome: '4 videos shipped, 3 approved', returnValue: result };
//     },
//   });

const lessons = require('./skill-lessons');

async function runWithLessons(skillName, { input, run, contextDepth = 10 }) {
  if (!skillName || typeof run !== 'function') {
    throw new Error('runWithLessons requires skillName and run() function');
  }
  const lessonsContext = lessons.lessonsAsContext(skillName, contextDepth);
  const ctx = { lessonsContext, skillName };
  let outcomeRecord;
  try {
    outcomeRecord = await run(ctx);
    const outcomeStr = (outcomeRecord && outcomeRecord.outcome) || 'completed (no outcome reported)';
    lessons.appendLesson(skillName, { input: String(input || '(none)'), outcome: outcomeStr });
    return outcomeRecord && Object.prototype.hasOwnProperty.call(outcomeRecord, 'returnValue')
      ? outcomeRecord
      : { outcome: outcomeStr, returnValue: outcomeRecord };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    lessons.appendLesson(skillName, { input: String(input || '(none)'), outcome: `FAILED: ${msg}` });
    throw err;
  }
}

module.exports = { runWithLessons };
