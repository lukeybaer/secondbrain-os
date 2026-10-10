'use strict';

// Why this exists.
//
// Measured across every Claude Code session on this machine over the three days
// to 2026-08-16, restricted to the 23 sessions that passed 50 assistant turns:
//
//   turns 1 to 50   n=1150   $0.1031 per turn
//   turns 51 and up n=5147   $0.2577 per turn
//
// Every turn past 50 costs 2.5x what the first fifty cost, because each one
// re-sends the whole accumulated transcript. Cache reads are 97.3% of that
// input so the per-token rate is already as low as it goes; the volume is the
// problem, not the price. Holding post-50 turns at the pre-50 rate is worth
// about $265 a day at list.
//
// ExampleCo approved compaction at 50 turns on 2026-08-16. Claude Code's own
// auto-compact triggers on context-window pressure, not on a turn count, and
// no turn-count setting is exposed, so a hook cannot truncate history directly.
// What it can do is change how the next turns are spent: past the budget, stop
// pulling whole files and command dumps into the transcript inline and push
// that reading into subagents, whose context does not accumulate here.
//
// That is the lever that actually moves the number. The growth is dominated by
// what each turn ADDS to the transcript, and a delegated read adds a summary
// instead of a file.

const DEFAULT_BUDGET_TURNS = 50;
// Re-injected on a stride rather than once, because a single notice 200 turns
// ago is not a live constraint. Prime-ish stride so it does not always land on
// the same kind of turn.
const REMINDER_STRIDE = 25;

/**
 * Count assistant turns in a Claude Code session transcript.
 * Accepts the raw JSONL text so the caller owns file IO and failure handling.
 */
function countAssistantTurns(transcriptText = '') {
  let turns = 0;
  for (const line of String(transcriptText).split('\n')) {
    if (!line.trim()) continue;
    // Cheap prefilter before the parse: most lines are not assistant rows.
    if (!line.includes('"assistant"')) continue;
    try {
      if (JSON.parse(line).type === 'assistant') turns += 1;
    } catch {
      /* a torn final line is normal while the session is live */
    }
  }
  return turns;
}

/**
 * Decide whether this prompt should carry a turn-budget directive.
 *
 * Fires at the budget and then every REMINDER_STRIDE turns, never on every
 * turn: a directive repeated 300 times is wallpaper, and it would itself add
 * to the growth it is trying to slow.
 */
function turnBudgetNotice(turnCount, { budgetTurns = DEFAULT_BUDGET_TURNS } = {}) {
  const turns = Number(turnCount);
  if (!Number.isFinite(turns) || turns < budgetTurns) return null;
  const over = turns - budgetTurns;
  if (over % REMINDER_STRIDE !== 0) return null;

  return [
    `### Session turn budget: ${turns} assistant turns, ${budgetTurns} is the budget`,
    `Every turn from here re-sends this whole transcript, and past turn ${budgetTurns} that has measured at about 2.5x the cost of an early turn. The fix is not to think less. It is to stop growing the transcript:`,
    '- Do not read whole files or dump long command output into this session. Send a subagent and keep only its conclusion. Its context does not accumulate here.',
    '- Prefer targeted reads (a line range, a single grep) over whole-file reads.',
    '- If the remaining work is separable, finish the current thread, write what the next session needs, and say plainly that a fresh session would be cheaper.',
    'This is a spending constraint, not a quality one. Do not truncate the work or skip verification to satisfy it.',
  ].join('\n');
}

module.exports = {
  countAssistantTurns,
  turnBudgetNotice,
  DEFAULT_BUDGET_TURNS,
  REMINDER_STRIDE,
};
