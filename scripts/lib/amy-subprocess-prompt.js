'use strict';

// Single source of truth for "is this prompt an Amy-internal subprocess /
// automation self-registration, NOT a real ExampleCo ask". The desktop renderer
// (refresh-briefing-generated-sections.js) and the cloud renderer
// (cloud-morning-briefing.js) both classify spine session/agent tasks for the
// AMY PROJECTS card, and they MUST agree: Codex peer review 2026-06-23 caught the
// cloud filter being narrower than the desktop one (it let the
// "<owner>'s executive assistant is drafting ..." template and the nightly-cron
// skill prompts back into the user card). Keep this list as the authoritative set.
//
// Category, not literal triggers: these are the recurring SHAPES of
// machine-originated prompts (system-prompt templates, scheduled-cron skill
// bodies, ping/probe replies, envelope wrappers), never a one-incident literal.
const AMY_SUBPROCESS_PROMPT_RES = [
  /^Return exactly:/i,
  /^Output (exactly|only)/i,
  /^Write EXACTLY \d+ ExampleCoraph/i,
  /^Your previous summary had ExampleCoraphs/i,
  /^Rewrite EXACTLY \d+ ExampleCoraph/i,
  /^.{1,40}'s executive assistant is drafting/i, // owner-EA self-draft template (name-free, shape-based)
  // Any "You are Amy ..." opening is a subprocess/system-prompt template
  // (generating, doing overnight self-heal work, a news summarizer, etc).
  /^You are Amy\b/i,
  /^You are the (claude|news|briefing) summarizer/i,
  /^You are an? (assistant|expert|evaluator|reviewer|writer|news)/i,
  /^You are optimi[sz]ing/i, // token-usage optimisation cron prompt
  /^Generate (\d+|a|the) (proposals?|summary|thumbnail|caption|script)/i,
  /^Summarize the following/i,
  /^Summarize each article/i,
  /^Classify the following/i,
  /^Extract \w+ from/i,
  /^Score this/i,
  /^Rate this/i,
  /^Translate /i,
  /^Refine the following/i,
  /^Given the following/i,
  /^You will (receive|be given|analyze|score|rate|classify)/i,
  /^TASK:/i,
  /^Context:/i,
  /^System:/i,
  /^<task>/i,
  /^<system>/i,
  /^<scheduled-task/i, // scheduled-task wrapper (cron sessions)
  /^<command-name>/i, // slash-command invocations
  // Scheduled-cron skill prompt openings (de-enveloped skill bodies that slip
  // the wrapper guard above).
  /^Nightly\b/i,
  /^Scan (recent|all|the|every|your|Gmail|LinkedIn|contact)/i,
  /^Run the daily (executive )?briefing/i,
  /^Generate the briefing/i,
  /^Reply with exactly:/i,
  /^\[User\]:/i, // spine subprocess prompts logged with a "[User]:" prefix
];

function isAmySubprocessPrompt(p) {
  if (!p) return true;
  const t = String(p).trim();
  if (t.length < 12) return true; // too short to be a real ask
  return AMY_SUBPROCESS_PROMPT_RES.some((re) => re.test(t));
}

module.exports = { isAmySubprocessPrompt, AMY_SUBPROCESS_PROMPT_RES };
