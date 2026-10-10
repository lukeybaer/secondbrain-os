'use strict';

// ExampleCo, 2026-08-16, after rating a good TLDR 6/10 and then seeing a better one:
// "what's the best way to have that happen each time? When you're bound to
// write a TLDR you should be bound to the communication rules too please."
//
// He is right that the binding was one-sided. tldr-position-guard.mjs demands a
// TLDR on every answer, but it is a Stop hook: it fires after the answer is
// already written, so it can only complain. The rules that decide whether the
// TLDR is any good arrived nowhere at all, which is why quality tracked
// whatever happened to be in context that day.
//
// So the rules ride in on the prompt, at the moment they can still change what
// gets written. This is the operative checklist, not the whole standard: the
// full text is memory/feedback_ExampleCo_communication_standard.md and it is far too
// long to inject per prompt. What is here is only the failure modes that
// actually keep recurring, which is what makes it worth its tokens.

const CHECKLIST = [
  'Brevity is the rule you break most. "As brief as possible while conveying the key decision, issue or status." A 190-word TLDR is a failure even when every word is true.',
  'No code-level detail in the TLDR. Commit hashes, test counters and compressed number triples like 787/12/1 are not English. Say the thing, not the identifier.',
  'Lead with what changes for ExampleCo. The least consequential item must not open the summary.',
  'One fact per sentence. If a sentence carries a semicolon plus two "and"s, split it.',
  'Never report your own process. "My two prime suspects" is your narrative, not his outcome.',
  'Every red or watcher item needs all three parts: what broke including root cause, the researched fix, then impact, complexity and risk with honest ignorance stated as ignorance.',
  'For red, watcher and pipeline explanations, begin with a component ExampleCo knows and expected versus actual. A graph node is a process and an arc is the information passed to the next process. Name the failed node or arc, accountable owner, guard, schedule/check time, retry or healer authority, and why protection failed. For a complex claim, give one exact dated anecdote: CT time, what actually ran, why it was ineffective, and ExampleCo-visible damage. Never substitute a hypothetical-only diagnosis when receipts exist.',
  'In How to fix, name the graph part being strengthened, why it was weak, and the new guard or proof that makes it stronger.',
  'An implementation request is a live-result contract. A shadow, watcher, observe-only, pilot, or phased rollout may verify risk but never substitutes for completing the requested build. Status words are a closed list: live in production, landed not deployed, in source not running, designed not built, built unwired, in progress now, not started with a reason. Never "implemented", never "approved and carried".',
  'Do not claim completion ExampleCo cannot see. If it is landed and deployed but not yet visible on his surface, lead with the fact that it is not finished from where he sits.',
  'Never state what you need from ExampleCo without numbered step-by-step instructions he can follow without asking a follow-up question.',
  'No em dashes anywhere. No flowery metaphor used to dumb something down; name the real mechanism and then say what it costs or produces.',
];

function communicationStandardBrief() {
  return [
    '### Communication standard (you are bound to a TLDR, so you are bound to these)',
    ...CHECKLIST.map((line, i) => `${i + 1}. ${line}`),
    'Full text: memory/feedback_ExampleCo_communication_standard.md. Check the TLDR against 1 to 4 before sending.',
  ].join('\n');
}

module.exports = { communicationStandardBrief, CHECKLIST };
