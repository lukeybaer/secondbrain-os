#!/usr/bin/env node
'use strict';

const {
  assertExecutiveText,
  containsRawOperationalLeak,
  scrubExecutiveText,
} = require('./executive-surface-policy.js');
const {
  findSelfNarration,
  scrubBriefingMarkdown,
  isRealExampleCoAction,
} = require('./briefing-clean-contract.js');

// News card titles carry THIRD-PARTY article prose, not Amy's operational status
// text. That prose legitimately mentions vendor/process words the operational
// leak filter flags ("Claude", "Anthropic", "OpenAI", "provider", "Vapi") and
// even "PM2.5" particulates (matches /\bpm2\b/). Applying the operational scrub
// to news bodies zeroed real summaries and, at the briefing-final stage, replaced
// the WHOLE briefing with the canned service-status message ("no cards found").
//
// Fix (Codex-reviewed): we do NOT blanket-exempt news bodies (that would let a
// HARD internal leak -- "HTTP 500 backend :3001 pm2 reset claude exit 1 stack
// trace" -- slip through inside a news card). Instead, in a news body we
// neutralize ONLY the SOFT false-positive terms (bare vendor/process names that
// a real article legitimately uses), then run the FULL operational-leak check
// over the rest. Hard error-shaped signatures (HTTP NNN, *_error, backend :3001,
// "claude exit N", "pm2 reset", stack trace, traceback, telegram) are STILL
// caught even in a news body. The shared RAW_OPERATIONAL_PATTERNS policy is
// unchanged (Telegram/Vapi/notify/spine still rely on it). 2026-06-22.
const NEWS_CARD_TITLE_RE =
  /\b(?:AI\s*&\s*TECH NEWS|US NEWS|WORLD NEWS|US IMMIGRATION NEWS|MORTGAGE INDUSTRY NEWS|COVID-19 TREATMENTS & NEWS|GROUP NEWS)\b/i;

function isNewsCardTitle(title) {
  return NEWS_CARD_TITLE_RE.test(String(title || ''));
}

function isTokenUsageCardTitle(title) {
  return /^(?:TOKEN USAGE|LLM SUBSCRIPTION)/i.test(String(title || '').trim());
}


// The otter speaker-pareto card mixes Amy's status preamble (As of / Freshness /
// Repair / No ExampleCo action required) with THIRD-PARTY call exec-summary prose. The
// preamble ends where the call-history / lifetime content begins: lines from the
// first "Past 24 Hours" / "Day Before" / "Lifetime stats" heading onward are call
// content, not Amy status. Only the preamble can declare a real card blocker.
function otterStatusPreamble(body) {
  const lines = String(body || '').split('\n');
  const idx = lines.findIndex((l) =>
    /^\s*(?:Past 24 Hours|Day Before|Lifetime stats)\b/i.test(l),
  );
  return (idx === -1 ? lines : lines.slice(0, idx)).join('\n');
}

// SOFT false-positive terms: bare vendor / process / particulate words an article
// legitimately uses. In a NEWS body these are replaced with a neutral token
// BEFORE the operational-leak check, so they do not trip the gate -- but only
// when they stand alone, NOT when they are part of a hard error signature. We
// replace "pm2" only when NOT immediately followed by " reset/restart/..." (the
// operational form) so "PM2.5" passes while "pm2 reset" stays a hard leak.
// ONE combined alternation of the soft false-positive terms. A SINGLE global
// regex is used for both neutralize + mask so matches are found in left-to-right
// TEXT order (a per-pattern loop captures Anthropic-then-Claude-then-OpenAI even
// when they appear in a different order in the prose, which scrambled the restore
// order -- Codex review 2026-06-22). Negative lookaheads keep the HARD operational
// forms ("claude exit N", "pm2 reset/restart/...") OUT of the soft set so they
// still trip the leak gate.
const NEWS_SOFT_FALSE_POSITIVE_RE =
  /\b(?:Anthropic|Claude\b(?!\s+exit\b)|OpenAI|provider|Vapi|pm2\b(?!\s*(?:reset|restart|reload|stop|start|kill|delete|logs|status)))/gi;

// Replace soft false-positive vendor/particulate terms in news prose with a
// neutral token so they do not trip the operational-leak gate, while hard
// error-shaped signatures remain intact and detectable.
function neutralizeNewsSoftTerms(text) {
  return String(text || '').replace(NEWS_SOFT_FALSE_POSITIVE_RE, 'newsterm');
}

function lineLooksLikeExampleCoBlocker(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  if (/^(?:clean|clear|blocked|ready|passes|pass|failed|fails)\?\s*(?:yes|no)\b/i.test(s)) {
    return true;
  }
  if (/\?\s*$/.test(s) && /\b(yes|no|approve|confirm|choose|which)\b/i.test(s)) return true;
  if (/^\d+\.\s+\S+/.test(s)) return true;
  if (isRealExampleCoAction(s)) return true;
  return /\b(click|open|sign in|log in|approve|enter|paste|choose)\b/i.test(s);
}

function qcCard(card, { surface = 'briefing-card' } = {}) {
  const id = card && card.id ? String(card.id) : 'ExampleCo';
  const title = card && card.title ? String(card.title) : '';
  const body = card && card.body ? String(card.body) : '';
  const text = [title, body].filter(Boolean).join('\n');
  const failures = [];

  // For a NEWS card, neutralize only the SOFT vendor/particulate false positives
  // in the body before the operational checks; the title + every hard error
  // signature in the body are still checked. Non-news cards are checked verbatim.
  const isNews = isNewsCardTitle(title);
  const isTokenUsage = isTokenUsageCardTitle(title);
  const operationalScope = isNews
    ? [title, neutralizeNewsSoftTerms(body)].filter(Boolean).join('\n')
    : isTokenUsage
      ? neutralizeNewsSoftTerms(text)
    : text;

  const executive = assertExecutiveText(operationalScope, { surface: `${surface}:${id}` });
  failures.push(...executive.failures);

  const selfNarration = findSelfNarration(text);
  if (selfNarration.length) failures.push(`${surface}:${id}: self narration: ${selfNarration[0]}`);

  if (containsRawOperationalLeak(operationalScope))
    failures.push(`${surface}:${id}: raw operational detail`);

  // Scope the blocker-actionability trigger so THIRD-PARTY content prose cannot
  // falsely demand a ExampleCo action. The otter speaker-pareto card ExampleCos call
  // exec-summaries that legitimately contain the word "blocker" (a call where
  // ExampleCo discussed briefing blockers); only its Amy-status preamble can declare a
  // real card blocker. A fresh roster then never false-blocks publish, while a
  // real "Freshness: BLOCKER:" preamble line still requires the recognized escape
  // or a concrete step. 2026-06-28 EC2 publish abort.
  const blockerScopeText = /OTTER SPEAKER PARETO/i.test(title)
    ? [title, otterStatusPreamble(body)].filter(Boolean).join('\n')
    : text;
  if (/\bblocker|need from ExampleCo|action required\b/i.test(blockerScopeText)) {
    const actionableLines = body
      .split('\n')
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
      .filter(lineLooksLikeExampleCoBlocker);
    if (!/No ExampleCo action required/i.test(blockerScopeText) && actionableLines.length === 0) {
      failures.push(`${surface}:${id}: blocker lacks a yes/no question or concrete steps`);
    }
  }

  return { ok: failures.length === 0, id, failures };
}

function splitMarkdownCards(markdown) {
  const lines = String(markdown || '').split('\n');
  const cards = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const legacyHeading = line.match(/^([A-Z]{2,}[^\n]{0,200}):\s*$/);
    const title = heading ? heading[1].trim() : legacyHeading ? legacyHeading[1].trim() : '';
    if (title) {
      if (current) cards.push(current);
      current = {
        id: title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
        title,
        body: '',
      };
      continue;
    }
    if (current) current.body += (current.body ? '\n' : '') + line;
  }
  if (current) cards.push(current);
  return cards;
}

// Reassemble briefing markdown for the FINAL operational full-read with each
// news card's BODY soft-term-neutralized: bare vendor/particulate words (Claude,
// Anthropic, PM2.5, ...) are replaced so legitimate news prose does not trip the
// scrub, but HARD error signatures (HTTP NNN, backend :3001, claude exit N, pm2
// reset, stack trace) are left intact so a real leak inside a news card is still
// caught at the briefing level. Token/LLM usage is also neutralized narrowly
// because that card legitimately names LLM plans. Other bodies + scaffolding
// pass verbatim.
function withAllowedSoftTermsNeutralized(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inNewsCard = false;
  let inTokenUsageCard = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const legacyHeading = line.match(/^([A-Z]{2,}[^\n]{0,200}):\s*$/);
    const title = heading ? heading[1].trim() : legacyHeading ? legacyHeading[1].trim() : '';
    if (title) {
      inNewsCard = isNewsCardTitle(title);
      inTokenUsageCard = isTokenUsageCardTitle(title);
      out.push(inTokenUsageCard ? neutralizeNewsSoftTerms(line) : line);
      continue;
    }
    out.push(inNewsCard || inTokenUsageCard ? neutralizeNewsSoftTerms(line) : line);
  }
  return out.join('\n');
}

function qcBriefingMarkdown(markdown) {
  const scrubbed = scrubBriefingMarkdown(markdown);
  const cards = splitMarkdownCards(scrubbed);
  const failures = [];
  if (!/^#\s+Daily Briefing\b/m.test(scrubbed)) {
    failures.push('briefing: missing Daily Briefing heading');
  }
  if (cards.length === 0) failures.push('briefing: no cards found');
  for (const card of cards) {
    const result = qcCard(card);
    failures.push(...result.failures);
  }
  // The briefing-final full read runs over the scaffold + non-news bodies only;
  // news prose is neutralized first so a legitimate vendor word in an article
  // does not nuke the whole briefing.
  const fullRead = assertExecutiveText(withAllowedSoftTermsNeutralized(scrubbed), {
    surface: 'briefing-final',
  });
  failures.push(...fullRead.failures);
  return { ok: failures.length === 0, failures, cardsChecked: cards.length, markdown: scrubbed };
}

// Repair PER CARD, never the whole assembled briefing at once. A non-news card
// whose body ExampleCos an operational leak gets scrubbed (scrubExecutiveText); a
// news card's body is preserved verbatim (its third-party prose is not Amy
// status text). This is what keeps a single leaked error from collapsing the
// entire briefing into the canned service-status message.
// Scrub a NEWS card body: mask the soft vendor/particulate terms so the scrub
// does not rewrite them, run the normal scrubExecutiveText (which still catches
// + scrubs any HARD error signature), then restore the soft terms. A clean news
// body round-trips unchanged; a news body that smuggles a real error leak gets
// that leak scrubbed without nuking the soft vendor words or the whole briefing.
const SOFT_TERM_MASK = 'NEWSTERM';
function scrubNewsBody(text) {
  const original = String(text || '');
  // Mask soft terms with a SINGLE left-to-right pass so the captured list is in
  // the same order they appear in the prose -- restoring left-to-right then puts
  // each original term back in its own slot (Codex review: a per-pattern loop
  // scrambled the restore order when vendor names interleaved).
  const captured = [];
  const masked = original.replace(NEWS_SOFT_FALSE_POSITIVE_RE, (m) => {
    captured.push(m);
    return SOFT_TERM_MASK;
  });
  const scrubbedBody = scrubExecutiveText(masked);
  // Restore in capture (== text) order. If the scrub collapsed to the canned
  // service-status (a hard leak remained), there is no mask to restore.
  let i = 0;
  return scrubbedBody.replace(new RegExp(SOFT_TERM_MASK, 'g'), () =>
    i < captured.length ? captured[i++] : '',
  );
}

function repairBriefingMarkdown(markdown) {
  const scrubbed = scrubBriefingMarkdown(markdown);
  const lines = scrubbed.split('\n');
  const out = [];
  let inNewsCard = false;
  let inTokenUsageCard = false;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    if (inNewsCard || inTokenUsageCard) {
      // News and token-usage bodies can legitimately name providers/LLM plans.
      // Scrub hard leaks while preserving those soft terms, matching qcCard().
      out.push(scrubNewsBody(buffer.join('\n')));
    } else {
      out.push(scrubExecutiveText(buffer.join('\n')));
    }
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const legacyHeading = line.match(/^([A-Z]{2,}[^\n]{0,200}):\s*$/);
    const title = heading ? heading[1].trim() : legacyHeading ? legacyHeading[1].trim() : '';
    if (title) {
      flush();
      inNewsCard = isNewsCardTitle(title);
      inTokenUsageCard = isTokenUsageCardTitle(title);
      out.push(line); // heading is scaffold, kept as-is
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join('\n');
}

module.exports = {
  lineLooksLikeExampleCoBlocker,
  qcCard,
  qcBriefingMarkdown,
  repairBriefingMarkdown,
  splitMarkdownCards,
  isNewsCardTitle,
};
