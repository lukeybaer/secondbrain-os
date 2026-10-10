'use strict';

// A proposed reachout has to be about the person, not about Amy's talking point.
//
// 2026-08-17 (ExampleCo, LNK-1): "every single reach out you propose is all about
// getting people's feedback on where human judgment should sit before software.
// I think I've seen that proposed reach out like 50 times. It needs to be
// personal to the person, to my relationship context with them." And on the
// trigger: "for PRIVATE_NAME, you're saying saw his recent post. What post?"
//
// Two separate defects, so two separate checks.
//
// 1. A named trigger. "Saw his recent post" is not a trigger, it is a claim
//    that a trigger exists. The proposal must say WHAT the person posted, said
//    or did. Same category as the empty news sentence: reporting that a reason
//    exists without stating the reason.
// 2. Relationship specificity. A draft that would read identically if sent to
//    any of 200 contacts is a template, and ExampleCo has already seen it fifty
//    times. It must carry something drawn from that person's file.

// Trigger phrases that assert a reason without giving one.
const VAGUE_TRIGGERS = [
  /\bsaw (?:his|her|their|your) recent post\b/i,
  /\bnoticed (?:his|her|their|your) (?:recent )?(?:post|update|activity)\b/i,
  /\brecent(?:ly)? (?:posted|shared|active)\b(?![^.]*\babout\b)/i,
  /\bcame across (?:his|her|their|your) profile\b/i,
  /\bhas been (?:posting|sharing) about\s*$/i,
];

// The pitch ExampleCo says he has seen fifty times. Matched on its shape so a
// reworded version of the same pitch does not slip through.
const OVERUSED_PITCH = [
  /human judg(?:e)?ment\s+(?:should\s+)?sit/i,
  /where\s+human\s+judg(?:e)?ment\b/i,
  /\bbefore\s+(?:the\s+)?software\b/i,
];

// Evidence that the draft actually used the person's file rather than a
// template: a concrete shared referent.
const PERSONAL_SIGNAL = [
  /\b(?:when we|after we|since we|you and I|we worked|we met|we spoke|last time we)\b/i,
  /\bat\s+[A-Z][A-Za-z&.\-]+/, // a named employer or venue
  /\byour\s+(?:work|team|move|role|launch|talk|paper|company)\s+(?:on|at|with)\s+\S+/i,
];

function checkReachout({ trigger = '', draft = '', peopleFileRead = false } = {}) {
  const problems = [];
  const t = String(trigger || '').trim();
  const d = String(draft || '').trim();

  if (!t) problems.push('no trigger given: say what the person actually posted, said or did');
  else if (VAGUE_TRIGGERS.some((rx) => rx.test(t))) {
    problems.push('trigger asserts a reason without stating it: name the post or the event');
  }

  if (!d) problems.push('no draft given');
  if (OVERUSED_PITCH.some((rx) => rx.test(d))) {
    problems.push('uses the overused human-judgment-before-software pitch; make it personal');
  }
  if (d && !PERSONAL_SIGNAL.some((rx) => rx.test(d))) {
    problems.push('draft would read identically to any contact: no shared referent from their file');
  }
  if (!peopleFileRead) {
    problems.push('people file was not read before drafting');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { VAGUE_TRIGGERS, OVERUSED_PITCH, PERSONAL_SIGNAL, checkReachout };
