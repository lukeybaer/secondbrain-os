'use strict';

// The processed-first rule for questions about what was said in a call.
// One source for every surface: gravity-router.mjs injects it into Claude
// prompts that ask about a call, and codex-amy-prelude.js carries it in every
// Codex prelude (Codex app sessions, codex-run phases, Telegram's Codex rung).
// Authority: memory/feedback_call_questions_use_processed_transcript.md.

const CALL_WORDS = /\b(call|calls|meeting|meetings|conversation|conversations|1:1|one on one|mbr|interview|interviews)\b/i;
const QUESTION_WORDS = /\b(what|who|whom|when|why|did|said|say|says|saying|told|tell|happened|happen|discuss|discussed|decide|decided|decision|mention|mentioned|ask|asked|agree|agreed|talk|talked|recap|summar\w*|remind)\b|\?/i;
// Engineering work on the call pipeline or voice stack is not a question about
// what was said, and it legitimately reads raw Otter files.
const DEV_WORDS = /\b(pipeline|deploy|vitest|commit|repo|healer|fargate|webhook|voiceprint|diariz\w*|backfill|ledger|debug|stack trace)\b|\b(api|function|method|tool|system|rpc|http|fetch|network|recursive)\s+calls?\b/i;

const RULE = [
  '### Call questions: processed transcript first (ExampleCo, 2026-09-25)',
  'Answer questions about a call or meeting from the PROCESSED, speaker-labeled transcript, never from raw Otter text.',
  'Call data lives on EC2, so run these there (from a PC: `ssh -i ~/.ssh/sb-key.pem ec2-user@ExampleCo "cd /opt/secondbrain && <command>"`):',
  '1. Find the call: `node scripts/otter-speaker-transcript.js --find "<title words, person, or date>"`.',
  '2. Read it: `node scripts/otter-speaker-transcript.js --otid <id>`. It prints the processed labeled transcript, and raw Otter text only when the call is unprocessed, under an UNPROCESSED notice.',
  '3. Say "X said" only for confirmed names; say "probably X" for a (guess); never name the speaker of a [speaker not named] line; cite [time]s.',
  'Do not open data/otter/raw or grep raw transcripts to answer a call question; engineering work on the Otter pipeline itself may read raw files. Tell ExampleCo when you had to use the unprocessed fallback.',
].join('\n');

// Telegram sessions reach call data only through broker tools, so their
// prompt carries the same rule phrased for the otter-query tool.
const TOOL_RULE =
  'For a question about what was said in a call or meeting, use the otter-query tool: {"query": "..."} finds the call, then {"id": "<id>"} returns its processed, speaker-labeled transcript. Say "X said" only for confirmed names, "probably X" for a (guess), never name a [speaker not named] line, cite [time]s, and say so when a call was unprocessed. Never read raw Otter files for this.';

function isCallQuestion(prompt) {
  const text = String(prompt || '');
  return CALL_WORDS.test(text) && QUESTION_WORDS.test(text) && !DEV_WORDS.test(text);
}

module.exports = { CALL_WORDS, QUESTION_WORDS, DEV_WORDS, RULE, TOOL_RULE, isCallQuestion };
