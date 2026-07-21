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
const {
  HEADLINE_ONLY_NOTE_RE,
  isThreeExampleCoraphArticleSummary,
  newsSummaryHasSourceFailureProse,
} = require('./news-summarize.js');

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
const COVID_NEWS_TOPIC_RE =
  /\b(?:covid(?:-19)?|sars[-\s]?cov[-\s]?2|coronavirus|long covid|paxlovid|remdesivir|molnupiravir|booster|variant|vaccine|vaccination|antiviral)\b/i;

function isNewsCardTitle(title) {
  return NEWS_CARD_TITLE_RE.test(String(title || ''));
}

function isCovidNewsCardTitle(title) {
  return /^COVID(?:-19)?(?:\s+TREATMENTS\s*&\s*NEWS|\s+NEWS)?/i.test(String(title || '').trim());
}

function isTokenUsageCardTitle(title) {
  return /^(?:TOKEN USAGE|LLM SUBSCRIPTION)/i.test(String(title || '').trim());
}

// SYSTEM HEALTH is Amy's OWN internal-infra roster. It legitimately names its own
// subsystems as EVIDENCE ("active provider codex", "Backend PM2 fleet", "using
// Claude Max plan", "Graphiti container up"), the same soft vendor/process words
// (provider, pm2, Claude, Anthropic, OpenAI, Vapi) a news/token-usage card names.
// Running the blanket operational scrub over the whole card body then collapses
// the ENTIRE roster to the canned "Amy service status changed" line the moment a
// soft term survives the per-regex (non-global) replace -- every subsystem row
// vanishes and BLOCKERS (derived from the pre-scrub roster) contradicts it (ExampleCo
// 2026-07-01). So this card is soft-term-neutralized before the operational
// checks, exactly like token-usage: HARD error signatures (HTTP 5xx, *_error,
// backend :3001, "claude exit N", "pm2 reset", stack trace, traceback) are STILL
// caught + scrubbed, but a legitimate subsystem-evidence word never nukes the row
// set.
function isSystemHealthCardTitle(title) {
  return /^SYSTEM HEALTH\b/i.test(String(title || '').trim());
}

// SELF-HEAL HEALTH is Amy's OWN authoritative honest repair-outcome renderer
// (scripts/self-heal/self-heal-health-card.js). Its whole job is to report what the
// auto-repair attempted, cleared, and escalated, so its body legitimately says things
// like "the auto-repair ... could not fix it" and "N escalated". Those exact phrases
// are in SELF_NARRATION_BAN (the ban exists to stop Amy narrating an EXCUSE instead of
// fixing a card), but on THIS card they are factual status, not self-talk. Without an
// exemption the self-narration gate flagged the card, the cloud seam replaced it with
// the L4 "artifact unusable" block, and the final QC marked the briefing not-clean
// (live 2026-07-01 red card). This predicate scopes the exemption to this ONE card.
function isSelfHealHealthCardTitle(title) {
  return /^SELF-HEAL HEALTH\b/i.test(String(title || '').trim());
}

// AWS COSTS legitimately shows AWS Cost Explorer service names verbatim, which
// can include AI model names like "Claude Sonnet 4.6 (Amazon Bedrock Edition)"
// and "provider" attribution lines. These are real AWS billing line items, not
// operational leaks, so the card is soft-term-neutralized before the operational
// checks. HARD error signatures (HTTP 5xx, stack trace, etc.) still fire.
function isAwsCostsCardTitle(title) {
  return /^AWS COSTS\b/i.test(String(title || '').trim());
}

// Cards that legitimately name soft vendor/process/plan words as their OWN
// content and must NOT be collapsed by the operational scrub: the token-usage /
// LLM-subscription card, the SYSTEM HEALTH internal-infra roster, and the AWS
// COSTS card (which shows real AWS service billing names). News cards are
// handled on their own third-party-prose path.
function isSoftTermNeutralizedCardTitle(title) {
  return (
    isTokenUsageCardTitle(title) || isSystemHealthCardTitle(title) || isAwsCostsCardTitle(title)
  );
}

// The otter speaker-pareto card mixes Amy's status preamble (As of / Freshness /
// Repair / No ExampleCo action required) with THIRD-PARTY call exec-summary prose. The
// preamble ends where the call-history / lifetime content begins: lines from the
// first "Past 24 Hours" / "Day Before" / "Lifetime stats" heading onward are call
// content, not Amy status. Only the preamble can declare a real card blocker.
function otterStatusPreamble(body) {
  const lines = String(body || '').split('\n');
  const idx = lines.findIndex((l) => /^\s*(?:Past 24 Hours|Day Before|Lifetime stats)\b/i.test(l));
  return (idx === -1 ? lines : lines.slice(0, idx)).join('\n');
}

function systemHealthContentFailures({ id, title, body, surface = 'briefing-card' } = {}) {
  if (id !== 'system_health' && !isSystemHealthCardTitle(title)) return [];
  const redRows = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\u2717|âœ—|\?)\s+/.test(line));
  if (!redRows.length) return [];
  return [
    `${surface}:system_health: SYSTEM-HEALTH-RED ${redRows.length} subsystem row(s) are non-green: ${redRows
      .slice(0, 3)
      .join(' | ')}`,
  ];
}

function tokenUsageContentFailures({ id, title, body, surface = 'briefing-card' } = {}) {
  if (id !== 'token_usage' && !isTokenUsageCardTitle(title)) return [];
  const text = String(body || '');
  const failures = [];
  if (
    /\bClaude Max\b[\s\S]{0,240}\b(?:did not refresh|stale|unreachable|HTTP 403|invalid|expired)\b/i.test(
      text,
    ) ||
    /\b\d+h\s+stale\b/i.test(text)
  ) {
    failures.push(
      `${surface}:token_usage: TOKEN-USAGE-STALE Claude usage is stale or unreachable; the token card cannot be clean until it renders current usage or an honest blocked state`,
    );
  }
  if (/\bBedrock\b[\s\S]{0,160}\busage unavailable\b/i.test(text)) {
    failures.push(
      `${surface}:token_usage: TOKEN-USAGE-BEDROCK-MISSING Bedrock fallback usage is unavailable`,
    );
  }
  return [...new Set(failures)];
}

function markdownNumberedRows(body) {
  const rows = [];
  let current = null;
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      if (current) rows.push(current);
      current = { n: m[1], title: m[2], why: '' };
      continue;
    }
    if (current && line && !/^Source:/i.test(line) && !/^Google News/i.test(line)) {
      current.why += `${current.why ? ' ' : ''}${line}`;
    }
  }
  if (current) rows.push(current);
  return rows;
}

function markdownNewsArticleBlocks(body) {
  const rows = [];
  let current = null;
  let ExampleCoraph = [];
  let contentStarted = false;

  const flushExampleCoraph = () => {
    if (!current || !ExampleCoraph.length) return;
    current.paras.push(ExampleCoraph.join(' ').replace(/\s+/g, ' ').trim());
    ExampleCoraph = [];
  };
  const flushRow = () => {
    if (!current) return;
    flushExampleCoraph();
    rows.push(current);
    current = null;
    contentStarted = false;
  };

  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const numbered = line.match(/^\d+\.\s+(.+?)\s*$/);
    if (numbered) {
      flushRow();
      current = { title: numbered[1], paras: [] };
      continue;
    }
    if (!current) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushRow();
      continue;
    }
    if (/^(?:Source:|Google News\b)/i.test(line)) {
      flushExampleCoraph();
      contentStarted = true;
      continue;
    }
    if (!line) {
      if (contentStarted) flushExampleCoraph();
      continue;
    }
    if (!contentStarted) continue;
    ExampleCoraph.push(line);
  }
  flushRow();
  return rows;
}

function newsContentFailures({ id, title, body, surface = 'briefing-card' } = {}) {
  if (!isNewsCardTitle(title)) return [];
  const rows = markdownNewsArticleBlocks(body);
  if (!rows.length) return [];
  const sourceDiagnostics = rows.filter((row) =>
    newsSummaryHasSourceFailureProse(row.paras.join('\n\n')),
  );
  const malformed = rows.filter((row) => {
    if (row.paras.length === 1 && HEADLINE_ONLY_NOTE_RE.test(row.paras[0])) return false;
    return !isThreeExampleCoraphArticleSummary(row.paras, { title: row.title });
  });
  const prefix = `${surface}:${id}`;
  const failures = [];
  if (sourceDiagnostics.length) {
    failures.push(
      `${prefix}: NEWS-SOURCE-DIAGNOSTIC ${sourceDiagnostics.length} article row(s) contain source/fetch diagnostic prose instead of an article summary`,
    );
  }
  if (malformed.length) {
    const sample = malformed
      .slice(0, 3)
      .map((row) => row.title || 'untitled')
      .join('; ');
    failures.push(
      `${prefix}: NEWS-PROSE ${malformed.length} article row(s) are not three-ExampleCoraph summaries: ${sample}`,
    );
  }
  return failures;
}

function covidNewsContentFailures({ id, title, body, surface = 'briefing-card' } = {}) {
  if (id !== 'covid_news' && !isCovidNewsCardTitle(title)) return [];
  const rows = markdownNumberedRows(body);
  if (!rows.length) return [];
  const offTopic = rows.filter((row) => !COVID_NEWS_TOPIC_RE.test(`${row.title} ${row.why}`));
  if (!offTopic.length) return [];
  return [
    `${surface}:covid_news: COVID-TOPIC ${offTopic.length} row(s) are not visibly about COVID treatment/news`,
  ];
}

function splitMarkdownTableLine(line) {
  const text = String(line || '').trim();
  if (!/^\|.*\|$/.test(text)) return [];
  return text
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function otterMarkdownCallRows(body) {
  const lines = String(body || '').split(/\r?\n/);
  const rows = [];
  let header = null;
  for (const line of lines) {
    const cells = splitMarkdownTableLine(line);
    if (!cells.length) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const lowered = cells.map((cell) => cell.toLowerCase());
    if (
      lowered.some((cell) => /\b(?:call|title|meeting)\b/.test(cell)) &&
      lowered.some((cell) => /\bspeakers?\b/.test(cell)) &&
      lowered.some((cell) => /\b(?:summary|executive)\b/.test(cell))
    ) {
      header = lowered;
      continue;
    }
    if (!header) continue;
    const idx = {
      title: header.findIndex((cell) => /\b(?:call|title|meeting)\b/.test(cell)),
      speakers: header.findIndex((cell) => /\bspeakers?\b/.test(cell)),
      summary: header.findIndex((cell) => /\b(?:summary|executive)\b/.test(cell)),
    };
    rows.push({
      title: cells[idx.title] || '',
      speakers: cells[idx.speakers] || '',
      summary: cells[idx.summary] || '',
    });
  }
  return rows;
}

function otterCallTitleCore(title) {
  return String(title || '')
    .replace(/^(?:[A-Z][a-z]{2}\s+\d{1,2}\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function otterCallTitleLooksRawOrGeneric(title) {
  const core = otterCallTitleCore(title);
  if (!core || /^[-]+$/.test(core) || /^No calls$/i.test(core)) return false;
  if (
    !/\s/.test(core) &&
    core.length >= 12 &&
    /[A-Z]/.test(core) &&
    /[a-z]/.test(core) &&
    /[0-9_-]/.test(core)
  ) {
    return true;
  }
  const words = core.split(/\s+/).filter(Boolean);
  if (/needing title review/i.test(core)) return true;
  if (words.length <= 5 && /\b(?:meeting|call|session)$/i.test(core)) return true;
  if (
    words.length <= 6 &&
    /\b(?:strategy|analysis|performance|governance|mapping|balance|data|cash|planning)\b/i.test(
      core,
    ) &&
    /\b(?:meeting|call|session)$/i.test(core)
  ) {
    return true;
  }
  return false;
}

function summaryNamesPersonAsParticipant(summary, rx) {
  const text = String(summary || '');
  const match = text.match(rx);
  if (!match || match.index == null) return false;
  const name = match[0];
  const start = Math.max(0, match.index - 90);
  const end = Math.min(text.length, match.index + name.length + 90);
  const context = text.slice(start, end);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`${escaped}\\s*(?:'s|â€™s)`, 'i').test(context)) return false;
  if (/\bmentioned the other day\b/i.test(context)) return false;
  if (
    /\b(?:resource|resources|input|caveat|question|feedback|note|thread)s?\b/i.test(context) &&
    !/\bwith\b/i.test(context)
  ) {
    return false;
  }
  const participantPatterns = [
    new RegExp(
      `\\b(?:spoke|met|aligned|reviewed|discussed|worked|walked through|clarified|confirmed|decided|agreed)\\b[^.!?]{0,90}\\bwith\\s+${escaped}\\b`,
      'i',
    ),
    new RegExp(
      `\\bwith\\s+${escaped}\\b[^.!?]{0,90}\\b(?:aligned|reviewed|discussed|clarified|confirmed|decided|agreed|walked through)\\b`,
      'i',
    ),
    new RegExp(
      `\\b${escaped}\\b[^.!?]{0,80}\\b(?:aligned|reviewed|discussed|clarified|confirmed|decided|agreed|joined|asked|said|flagged)\\b`,
      'i',
    ),
    new RegExp(
      `\\bExampleCo\\s*,[^.!?]{0,120}\\b${escaped}\\b[^.!?]{0,120}\\b(?:aligned|reviewed|discussed|clarified|confirmed|decided|agreed)\\b`,
      'i',
    ),
  ];
  return participantPatterns.some((pattern) => pattern.test(context));
}

function otterCallHistoryContentFailures({ id, title, body, surface = 'briefing-card' } = {}) {
  if (id !== 'otter_speaker_pareto' && !/OTTER SPEAKER PARETO/i.test(title || '')) return [];
  const text = String(body || '');
  const failures = [];
  const prefix = `${surface}:otter_speaker_pareto`;
  if (/existing relevance scan ties it to/i.test(text)) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders boilerplate relevance-label prose instead of a source-grounded executive summary of the call`,
    );
  }
  if (
    /\bThis call focused on\b[\s\S]{0,220}\bsourced transcript segment/i.test(text) ||
    /\bno reliable decision or ExampleCo-owned next action was extracted\b/i.test(text)
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders generic fallback prose instead of what happened, decisions made, and ExampleCo next actions`,
    );
  }
  if (
    /Summary unavailable:\s*the processed transcript did not yield a coherent exec summary/i.test(
      text,
    )
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY-MISSING has a failed executive summary; missing call summaries are blockers, not clean content`,
    );
  }
  if (
    /\b(?:clearest source-backed read is|Touches [^.;]{0,120}; Contains|family wealth\s*\/\s*mission|relationship capital)\b/i.test(
      text,
    )
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders boilerplate relevance labels instead of what happened, decisions made, and ExampleCo next actions`,
    );
  }
  if (
    /\bDecisions\/actions:\s*(?:Yes|Yeah|Okay|Ok|Again|Always|A feedback|I think|Like|You know|For\b)/i.test(
      text,
    ) ||
    /\b[A-Z][A-Za-z0-9 '&/-]{4,80}:\s*(?:Yes|Yeah|Okay|Ok|Again|Always|A feedback|I think|Like|You know|For\b)/.test(
      text,
    )
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders transcript quotes instead of an executive summary of what happened, decisions, and ExampleCo next actions`,
    );
  }
  if (/\bcall covered again\b|\bI just want\b|\breally good start\b/i.test(text)) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY still reads like transcript fragments instead of an executive summary`,
    );
  }
  if (
    /\bcall covered\s+(?:tough|again|yes|yeah|okay|ok|so|and\s+i['â€™]?m|i['â€™]?m|i am|we['â€™]?re|we are|you know)\b/i.test(
      text,
    ) ||
    /\bcall covered\b[\s\S]{0,240}\b(?:i['â€™]?m|i am|we['â€™]?re|we are|trying to|get a deal|watching my budget|manager level people)\b/i.test(
      text,
    )
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders first-person transcript fragments instead of an executive summary`,
    );
  }
  if (/\b\d+\.\s+\d\w?\b/i.test(text)) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY splits a numeric value while trimming the call summary`,
    );
  }
  if (
    /\b(?:Briefing summary|Detail:)\b/i.test(text) ||
    /\b(?:and|or|with|to|for|from|between|around|whether)\.\s*(?:-|Day Before|Lifetime stats|$)/i.test(
      text,
    )
  ) {
    failures.push(
      `${prefix}: OTTER-CALL-SUMMARY renders labeled or clipped prose instead of complete executive-summary sentences`,
    );
  }
  const rows = otterMarkdownCallRows(text);
  const rawTitles = rows.filter((row) => otterCallTitleLooksRawOrGeneric(row.title));
  if (rawTitles.length) {
    failures.push(
      `${prefix}: OTTER-CALL-TITLE ${rawTitles.length} call title(s) are raw or generic calendar labels; titles must say what the meeting accomplished or decided`,
    );
  }
  const expectedPeople = [
    ['Ed', /\bEd(?:\s+Evans)?\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME(?:\s+Bluth)?\b/i],
    ['Zach', /\bZach(?:ary)?\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['PRIVATE_NAME', /\bExampleCo\s+Walker\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['PRIVATE_NAME Spillers', /\bPRIVATE_NAME(?:\s+Spillers)?\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['Phil', /\bPhil\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
  ];
  const missingPeople = [];
  for (const row of rows) {
    if (
      summaryNamesPersonAsParticipant(row.summary, /\bExampleCo\b/i) &&
      !/\bExampleCo\b/i.test(row.speakers)
    ) {
      missingPeople.push(`${row.title || 'call'}:ExampleCo`);
    }
    for (const [display, rx] of expectedPeople) {
      if (!summaryNamesPersonAsParticipant(row.summary, rx)) continue;
      if (rx.test(row.speakers)) continue;
      missingPeople.push(`${row.title || 'call'}:${display}`);
    }
  }
  if (missingPeople.length) {
    failures.push(
      `${prefix}: OTTER-SPEAKER-MISMATCH call summaries mention known people that are absent from the speaker roster: ${missingPeople.slice(0, 6).join(', ')}`,
    );
  }
  return [...new Set(failures)];
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
  // signature in the body are still checked. The token-usage and SYSTEM HEALTH
  // cards legitimately name soft vendor/process/plan words as their OWN content
  // (LLM plans; subsystem evidence like "active provider", "Backend PM2 fleet",
  // "Claude Max"), so they are soft-neutralized the same way. Every other card is
  // checked verbatim. HARD error signatures survive neutralization and still fail.
  const isNews = isNewsCardTitle(title);
  const isSoftNeutralized = isSoftTermNeutralizedCardTitle(title);
  const operationalScope = isNews
    ? [title, neutralizeNewsSoftTerms(body)].filter(Boolean).join('\n')
    : isSoftNeutralized
      ? neutralizeNewsSoftTerms(text)
      : text;

  const executive = assertExecutiveText(operationalScope, { surface: `${surface}:${id}` });
  failures.push(...executive.failures);

  // The SELF-HEAL HEALTH card is exempt from the self-narration TEXT gate: its
  // factual repair-outcome language ("the auto-repair ... could not fix it", "N
  // escalated") is a genuine report of what self-heal did, not an Amy excuse. Every
  // OTHER card is still checked verbatim, so real self-talk elsewhere is still caught.
  const selfNarration = isSelfHealHealthCardTitle(title) ? [] : findSelfNarration(text);
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
  //
  // STATUS cards (SYSTEM HEALTH, SELF-HEAL HEALTH) are exempt entirely: they
  // DISPLAY subsystem state, and every non-green row is separately mirrored into
  // the BLOCKERS card by deriveNonGreenSubsystemBlockers with a real repair step,
  // so an incidental "blocker"/"action required" substring in their status prose
  // (a self-heal "escalated and surfaced as blockers" line, a "✗ ... action
  // required to retry" row) is not a ExampleCo ask and must not wedge publish. This was
  // the recurring, self-heal-unfixable defect "live render qc system-health on
  // system_health ... escalated" (2026-07-01). The BLOCKERS card and every genuine
  // action card are still fully held to the contract below.
  const isStatusCard = /^(?:SYSTEM HEALTH|SELF-HEAL HEALTH)\b/i.test(title);
  const blockerScopeText = isStatusCard
    ? ''
    : /OTTER SPEAKER PARETO/i.test(title)
      ? [title, otterStatusPreamble(body)].filter(Boolean).join('\n')
      : text;
  const blockerTriggerText = /^BLOCKERS\b/i.test(title) ? body : blockerScopeText;
  if (/\bblocker|need from ExampleCo|action required\b/i.test(blockerTriggerText)) {
    const actionableLines = body
      .split('\n')
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
      .filter(lineLooksLikeExampleCoBlocker);
    if (!/No ExampleCo action required/i.test(blockerScopeText) && actionableLines.length === 0) {
      failures.push(`${surface}:${id}: blocker lacks a yes/no question or concrete steps`);
    }
  }

  failures.push(...systemHealthContentFailures({ id, title, body, surface }));
  failures.push(...tokenUsageContentFailures({ id, title, body, surface }));
  failures.push(...newsContentFailures({ id, title, body, surface }));
  failures.push(...covidNewsContentFailures({ id, title, body, surface }));
  failures.push(...otterCallHistoryContentFailures({ id, title, body, surface }));

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
// caught at the briefing level. The token-usage/LLM-subscription card and the
// SYSTEM HEALTH internal-infra roster are also neutralized narrowly because they
// legitimately name LLM plans / subsystem-evidence words as their own content.
// Other bodies + scaffolding pass verbatim.
function withAllowedSoftTermsNeutralized(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inNewsCard = false;
  let inSoftNeutralizedCard = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const legacyHeading = line.match(/^([A-Z]{2,}[^\n]{0,200}):\s*$/);
    const title = heading ? heading[1].trim() : legacyHeading ? legacyHeading[1].trim() : '';
    if (title) {
      inNewsCard = isNewsCardTitle(title);
      inSoftNeutralizedCard = isSoftTermNeutralizedCardTitle(title);
      out.push(inSoftNeutralizedCard ? neutralizeNewsSoftTerms(line) : line);
      continue;
    }
    out.push(inNewsCard || inSoftNeutralizedCard ? neutralizeNewsSoftTerms(line) : line);
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
  let inSoftNeutralizedCard = false;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    if (inSoftNeutralizedCard) {
      // News, token-usage, and SYSTEM HEALTH bodies can legitimately name
      // providers / LLM plans / subsystem-evidence words. Scrub hard leaks while
      // preserving those soft terms via the mask/scrub/restore path, matching
      // qcCard(). This is what keeps a legitimate soft term from collapsing the
      // whole card body to the canned service-status line (SYSTEM HEALTH roster
      // vanishing, ExampleCo 2026-07-01).
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
      inSoftNeutralizedCard = isNewsCardTitle(title) || isSoftTermNeutralizedCardTitle(title);
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
  systemHealthContentFailures,
  tokenUsageContentFailures,
  newsContentFailures,
  markdownNewsArticleBlocks,
  covidNewsContentFailures,
  otterCallHistoryContentFailures,
  isNewsCardTitle,
  isCovidNewsCardTitle,
  isTokenUsageCardTitle,
  isSystemHealthCardTitle,
  isAwsCostsCardTitle,
  isSelfHealHealthCardTitle,
  isSoftTermNeutralizedCardTitle,
};
