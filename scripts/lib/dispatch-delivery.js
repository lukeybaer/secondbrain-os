// dispatch-delivery.js
//
// Pure logic for the managed-wait redesign: wait-policy defaults, completion
// channel selection, speech-safe result phrasing, and a mid-call spine summary.
// Wired into ec2-server.js (addCommand, deliverCommandResult, check_spine) and
// process-dispatches.js. 2026-06-02.
//
// Channels:
//  - telegram        : text with the PR link (default, always safe)
//  - voice_if_live   : speak into the call if it is still active, else telegram
//  - voice_callback  : place an outbound call (only on explicit "call me back")
const { speechSafe } = require('./speech-safe');
const { sanitizeLiveStatusSpeech } = require('./vapi-voice-output');
const { compactSessionTitleForVoice } = require('./voice-session-title');
const {
  buildLiveStateItems,
  formatLiveStateAnswer,
  normalizeProbeLevel,
} = require('./live-dev-state');
const {
  displaySpineQueryForVoice,
  isArchiveQueryTerms,
  isProjectStatusQueryTerms,
  normalizeSpineQueryForVoice,
  spineQueryTerms,
} = require('./voice-spine-query');

const DEFAULT_NO_PROGRESS_MS = 5 * 60 * 1000;
const DEFAULT_CEILING_MS = 60 * 60 * 1000;
const LIVE_STATUS_FRESH_MS = 2 * 60 * 60 * 1000;
const RECENT_COMPLETE_MS = 24 * 60 * 60 * 1000;
// Same horizon as recent completions, but named for spoken session lookup policy.
const RECENT_SESSION_LOOKUP_MS = RECENT_COMPLETE_MS;
const PROJECT_TERMINAL_PROOF_MS = 24 * 60 * 60 * 1000;
// The local Codex mirror is expected to sync every few minutes. Older source
// mtimes are usable as historical evidence, not active/recent proof.
const CODEX_MIRROR_FRESH_MS = 10 * 60 * 1000;
// Voice session lookup can still name a recent parent session when the mirror
// sync is lagging, but only within a bounded window. Older snapshots go back to
// stale-proof language so Amy does not imply current progress from old data.
const CODEX_MIRROR_RECENT_EVIDENCE_MS = 4 * 60 * 60 * 1000;

// Default wait policy by origin. Voice commands default to background+notify; the
// result is spoken if the caller is still on the line, otherwise Telegram.
function defaultWaitPolicy(replyTo) {
  if (replyTo === 'vapi') return { mode: 'background', deliveryChannel: 'voice_if_live' };
  return { mode: 'background', deliveryChannel: 'telegram' };
}

// Capture an explicit "call me back" from the spoken task so the completion
// actually dials ExampleCo (voice_callback), not just the default speak-if-live.
// 2026-06-02: a real call asked "do X and call me back"; the promise was wired to
// nothing because only the default policy was applied. This closes that gap.
const CALL_BACK_RE =
  /\bcall (?:me|him|us) (?:back|when)\b|\bcall back\b|\bcall me (?:once|after|as soon as)\b|\bring me back\b|\bphone me (?:back|when)\b/i;
function inferWaitPolicy(taskText, replyTo) {
  if (replyTo === 'vapi' && CALL_BACK_RE.test(String(taskText || ''))) {
    return { mode: 'background', deliveryChannel: 'voice_callback' };
  }
  return defaultWaitPolicy(replyTo);
}

// Classify a dispatched task as 'research' (answer a question from the archive,
// no file changes) vs 'code' (change the repo). A research ask routed through the
// code executor + autoland always fails the test gate and never produces the
// answer (observed 2026-06-03: "search memory for a contact history" failed that
// way). Research runs read-only and returns the answer; code keeps the autoland
// path. Default is 'code' to preserve existing behavior for anything ambiguous.
const RESEARCH_RE =
  /\b(search|summari[sz]e|recall|look up|find out|deep dive|what (?:did|do|is|are|was|were)|who (?:is|are|was)|when (?:did|was)|how (?:did|does).*(?:start|evolve|go)|history of|tell me about|give me (?:the|a) (?:history|summary|rundown|background)|review .*(?:interaction|history|relationship|thread))\b/i;
const CODE_RE =
  /\b(fix|add|build|implement|create (?:a|the|file|section)|deploy|refactor|edit|change|update the (?:briefing|dashboard|code|section)|write (?:a |the )?test|append .* to .*\.(?:js|ts|md|json)|patch|wire|rename|remove)\b/i;
function classifyTaskKind(prompt) {
  const t = String(prompt || '');
  if (CODE_RE.test(t)) return 'code';
  if (RESEARCH_RE.test(t)) return 'research';
  return 'code';
}

// Absolute run budget for a command: the user-set deadline if any, clamped to a
// sane floor and the hard ceiling so "never times out" never means "never dies".
function resolveDeadlineMs(waitPolicy, ceilingMs = DEFAULT_CEILING_MS) {
  const wp = waitPolicy || {};
  let ms = Number(wp.deadlineMs) || Number(wp.holdSeconds) * 1000 || 0;
  if (!ms || ms <= 0) ms = ceilingMs;
  return Math.max(60 * 1000, Math.min(ms, ceilingMs));
}

// Which delivery channel to actually use at completion time.
function chooseDeliveryChannel(cmd, callIsActive) {
  const wp = (cmd && cmd.waitPolicy) || defaultWaitPolicy(cmd && cmd.replyTo);
  const want = wp.deliveryChannel || 'telegram';
  if (cmd && cmd.replyTo === 'telegram') return 'telegram';
  if (want === 'telegram') return 'telegram';
  if (want === 'voice_callback') return 'voice_callback';
  // voice_if_live
  return callIsActive ? 'voice_say' : 'telegram';
}

// A structured result {oneLiner, prUrl, branch, detail} formatted per channel.
// Voice gets a speech-safe one-liner (no URLs/branches). Telegram gets the
// one-liner plus the tappable PR link.
function formatResultForChannel(result, channel) {
  const r = result || {};
  const oneLiner = (
    r.oneLiner ||
    r.summary ||
    (r.ok ? 'Done.' : 'That ran into a problem.')
  ).trim();
  if (channel === 'voice_say' || channel === 'voice_callback') {
    return speechSafe(oneLiner) || 'Done.';
  }
  // telegram
  const icon = r.ok === false ? '✗' : '✓';
  const link = r.prUrl ? `\nPR: ${r.prUrl}` : '';
  return `${icon} ${oneLiner}${link}`;
}

// Speak a whole-number count with a correctly pluralized unit so Amy never says
// "about 1 minutes" or "about 1 hours" on a live call. "1 minute" / "2 minutes".
function pluralUnit(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function agePhrase(iso, nowMs) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return '';
  const ageMin = Math.max(0, Math.round((nowMs - ts) / 60000));
  if (ageMin === 0) return 'less than a minute';
  if (ageMin < 90) return `about ${pluralUnit(ageMin, 'minute')}`;
  const ageHrs = Math.max(1, Math.round(ageMin / 60));
  return `about ${pluralUnit(ageHrs, 'hour')}`;
}

// Speak a task's pre-computed ageHours (may be fractional) as a clean spoken
// phrase: round to whole hours, pluralize, and say "less than an hour" instead
// of "about 0 hours" so the read-back never sounds broken.
function ageHoursPhrase(ageHours) {
  if (ageHours === null || ageHours === undefined) return '';
  const h = Math.round(Number(ageHours) || 0);
  if (h <= 0) return ', less than an hour old';
  return `, about ${pluralUnit(h, 'hour')} old`;
}

function taskTitle(t) {
  return String((t && (t.title || t.prompt || t.id)) || 'a task')
    .replace(/\s+/g, ' ')
    .trim();
}

function latestHistoryNote(t) {
  const hist = Array.isArray(t && t.history) ? t.history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const note = String((hist[i] && hist[i].note) || '').trim();
    if (note) return note;
  }
  return '';
}

// Mid-call spine query: summarize in-flight/recent dev commands and active
// durable spine tasks for speech. Reads the command queue plus task-spine
// active rows; newest first.
function summarizeSpineForVoice(commands, nowMs, maxItems = 4, activeTasks = []) {
  const list = (commands || [])
    .filter((c) => c && c.type === 'claude')
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, maxItems);
  const taskList = (activeTasks || [])
    .filter((t) => t && (t.title || t.prompt))
    .slice(0, Math.max(0, maxItems - list.length));
  if (!list.length && !taskList.length)
    return 'You have no dev tasks or active spine sessions queued or running right now.';
  const parts = list.map((c) => {
    const what = speechSafe(String(c.prompt || c.title || 'a task')).slice(0, 80);
    const age = agePhrase(c.createdAt, nowMs);
    const state =
      c.status === 'done'
        ? 'finished'
        : c.status === 'failed'
          ? 'failed'
          : c.status === 'running' || c.status === 'forwarded' || c.status === 'in_progress'
            ? `running for ${age || 'a while'}`
            : 'queued';
    return `${what}: ${state}`;
  });
  for (const t of taskList) {
    const what = speechSafe(taskTitle(t)).slice(0, 80);
    const status = String(t.status || 'active').replace(/_/g, ' ');
    const age = ageHoursPhrase(t.ageHours);
    const origin = t.origin ? ` via ${speechSafe(String(t.origin)).slice(0, 30)}` : '';
    parts.push(`${what}: ${status}${age}${origin}`);
  }
  return parts.join('. ') + '.';
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SPINE_DETAIL_SCOPE = 'command queue, task spine, and Codex thread snapshot';
const SPINE_DETAIL_SCOPE_VOICE = 'the live command queue, task spine, and Codex thread mirror';
const GENERIC_SPINE_TERMS = new Set([
  'stat',
  'status',
  'statuses',
  'update',
  'updates',
  'session',
  'sessions',
  'task',
  'tasks',
  'progress',
  'recent',
  'going',
  'thing',
  'that',
  'it',
  'one',
]);
const BROAD_SINGLE_TERM_STATUS_QUERIES = new Set([
  'amy',
  'brain',
  'briefing',
  'call',
  'calls',
  'card',
  'cards',
  'claude',
  'codex',
  'dashboard',
  'email',
  'gmail',
  'graphiti',
  'memory',
  'session',
  'sessions',
  'spine',
  'task',
  'tasks',
  'vapi',
  'voice',
]);
const PROJECT_SCOPE_TERMS = new Set([
  'amy',
  'bai',
  'briefing',
  'claude',
  'codex',
  'dashboard',
  'graphiti',
  'itm',
  'ExampleCo',
  'ExampleCo',
  'resilience',
  'secondbrain',
  'snack',
  'spine',
  'vapi',
  'voice',
]);
const QUERY_FILLER_TERMS = new Set([
  'a',
  'an',
  'and',
  'about',
  'but',
  'for',
  'in',
  'into',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);
const SUBAGENT_QUERY_TERMS = new Set(['child', 'companion', 'rung', 'rescue', 'sub', 'subagent']);
const ACTIVE_DETAIL_STATUSES = new Set([
  'active',
  'active or recent',
  'active_or_recent',
  'awaiting review',
  'awaiting_review',
  'blocked',
  'callback due',
  'callback_due',
  'forwarded',
  'in progress',
  'in_progress',
  'needs feedback',
  'needs_feedback',
  'pending',
  'queued',
  'recent',
  'running',
  'started',
]);
const TERMINAL_DETAIL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'done',
  'failed',
  'removed non actionable',
  'removed_non_actionable',
]);

function searchTerms(value) {
  return spineQueryTerms(value);
}

function isGenericSpineQuery(query) {
  const terms = searchTerms(query);
  return terms.length > 0 && terms.every((term) => GENERIC_SPINE_TERMS.has(term));
}

function isBroadSingleTermStatusQuery(query) {
  const terms = searchTerms(query);
  return terms.length === 1 && BROAD_SINGLE_TERM_STATUS_QUERIES.has(terms[0]);
}

function isBroadStatusQuery(query) {
  const terms = searchTerms(query);
  if (isBroadSingleTermStatusQuery(query)) return true;
  const filler = new Set(['a', 'an', 'and', 'about', 'but', 'for', 'on', 'the', 'to', 'with']);
  const meaningfulTerms = terms.filter((term) => !filler.has(term));
  return (
    meaningfulTerms.length > 1 &&
    meaningfulTerms.length <= 8 &&
    meaningfulTerms.some((term) => BROAD_SINGLE_TERM_STATUS_QUERIES.has(term))
  );
}

function isProjectLiveStatusQuery(query) {
  return isProjectStatusQueryTerms(searchTerms(query));
}

function isStatusLikeLookup(query) {
  const terms = searchTerms(query);
  return (
    isProjectLiveStatusQuery(query) ||
    terms.some((term) =>
      [
        'active',
        'current',
        'deploy',
        'deployment',
        'latest',
        'progress',
        'session',
        'status',
        'thread',
        'work',
      ].includes(term),
    )
  );
}

function detailStatus(record) {
  return String((record && record.status) || '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function isActiveDetailRecord(record) {
  const status = detailStatus(record);
  if (!status) return false;
  return (
    ACTIVE_DETAIL_STATUSES.has(status) || /\brunning|queued|active|progress|pending\b/.test(status)
  );
}

function recordUpdatedMs(record) {
  return (
    Date.parse((record && (record.updatedAt || record.completedAt || record.createdAt)) || '') || 0
  );
}

function isFreshLiveStatusRecord(record, nowMs) {
  const ts = recordUpdatedMs(record);
  return isActiveDetailRecord(record) && ts > 0 && nowMs - ts <= LIVE_STATUS_FRESH_MS;
}

function isFreshTerminalStatusRecord(record, nowMs) {
  const ts = recordUpdatedMs(record);
  return isTerminalDetailRecord(record) && ts > 0 && nowMs - ts <= LIVE_STATUS_FRESH_MS;
}

function isRecentlyCompleteDetailRecord(record, nowMs) {
  const ts = recordUpdatedMs(record);
  return isTerminalDetailRecord(record) && ts > 0 && nowMs - ts <= RECENT_COMPLETE_MS;
}

function isStaleCodexMirrorRecord(record, nowMs) {
  if (!record || record._source !== 'codex-thread-index') return false;
  const ts = Date.parse(record._sourceMtime || '');
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > CODEX_MIRROR_FRESH_MS;
}

function isTooOldCodexMirrorForRecentEvidence(record, nowMs) {
  if (!record || record._source !== 'codex-thread-index') return false;
  const ts = Date.parse(record._sourceMtime || '');
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > CODEX_MIRROR_RECENT_EVIDENCE_MS;
}

function isPlausiblyRecentDetailRecord(record, nowMs) {
  const ts = recordUpdatedMs(record);
  if (isTooOldCodexMirrorForRecentEvidence(record, nowMs)) return false;
  if (!ts || nowMs - ts > RECENT_SESSION_LOOKUP_MS) return false;
  return isActiveDetailRecord(record) || isTerminalDetailRecord(record);
}

function isRecentProjectTerminalProof(record, nowMs) {
  const ts = recordUpdatedMs(record);
  return (
    isTerminalDetailRecord(record) &&
    ts > 0 &&
    nowMs - ts <= PROJECT_TERMINAL_PROOF_MS &&
    hasSubstantiveTaskSpineResult(record)
  );
}

function isTerminalDetailRecord(record) {
  const status = detailStatus(record);
  if (!status) return false;
  return TERMINAL_DETAIL_STATUSES.has(status) || /\bdone|complete|failed|cancel/i.test(status);
}

function recordSourceText(record) {
  const source = record && record.source && typeof record.source === 'object' ? record.source : {};
  return [
    record && record.id,
    record && record.title,
    record && record.prompt,
    record && record.result,
    record && record.resultSummary,
    record && record.progressNote,
    record && record.latestStatus,
    record && record.latestUserPrompt,
    Array.isArray(record && record.tags) ? record.tags.join(' ') : '',
    record && record.status,
    record && record.kind,
    record && record.origin,
    record && record.surface,
    record && record.runner,
    record && record.threadName,
    record && record.thread_name,
    record && record.cwd,
    record && record._source,
    record && record._sourcePath,
    source.type,
    source.ref,
    latestHistoryNote(record),
  ].join(' ');
}

function isLowSignalIngest(record) {
  if (record && (record._source === 'codex-thread-index' || record.origin === 'codex')) return false;
  const source = record && record.source && typeof record.source === 'object' ? record.source : {};
  const text = normalizeSearchText(
    [
      record && record.id,
      record && record.kind,
      record && record.origin,
      record && record.title,
      record && record.prompt,
      record && record._sourcePath,
      record && record._source,
      source.type,
      source.ref,
    ].join(' '),
  );
  return (
    /\bingest\b/.test(text) ||
    /\bgmail\b/.test(text) ||
    /\bvapi\b|\bamy call\b|\bvoice call\b|\bcall transcript\b|\bend of call\b|\bcall log\b/.test(
      text,
    )
  );
}

function isAgentSessionRecord(record) {
  const text = normalizeSearchText(recordSourceText(record));
  return /\bcodex\b|\bclaude\b|\bagent\b|\bsession\b|\bworktree\b|\bthread\b|\bcoding\b/.test(text);
}

function isSubagentSessionRecord(record) {
  const text = normalizeSearchText(recordSourceText(record));
  return /\bsubagent\b|\bsub agent\b|\bcompanion task\b|\bcodex companion\b|\brescue rung\b|\bchild session\b|\bcodex amy preload\b/.test(
    text,
  );
}

function wantsSubagentSessions(query) {
  return searchTerms(query).some((term) => SUBAGENT_QUERY_TERMS.has(term));
}

function isNoisyCodexWorkerRecord(record, queryTerms = []) {
  if (!record || record._source !== 'codex-thread-index') return false;
  const text = normalizeSearchText(recordSourceText(record));
  const terms = new Set(queryTerms || []);
  if (/\bwrite exactly \d+ ExampleCoraphs summarizing this news article/.test(text)) {
    return !['article', 'news', 'summarize', 'summary', 'ExampleCoraph'].some((term) =>
      terms.has(term),
    );
  }
  if (/\bExampleCo ExampleCo s executive assistant is drafting a linkedin conversation starter/.test(text)) {
    return !['linkedin', 'contact', 'conversation', 'starter', 'draft'].some((term) =>
      terms.has(term),
    );
  }
  return false;
}

function recordSourceLabel(record) {
  const sourcePath = String((record && record._sourcePath) || '');
  if (record && record._source === 'codex-thread-index') return 'Codex thread snapshot';
  if (/codex-thread-index|session_index\.jsonl/i.test(sourcePath)) return 'Codex thread snapshot';
  if (record && record._kind === 'command') return 'command queue';
  if (sourcePath || (record && record._kind === 'task')) return 'task spine';
  return 'spine record';
}

function voiceSourceLabel(record) {
  const label = recordSourceLabel(record);
  if (label === 'Codex thread snapshot') return 'Codex thread';
  if (label === 'command queue') return 'live command';
  if (label === 'task spine') return 'spine task';
  return 'spine record';
}

function hasSubstantiveTaskSpineResult(record) {
  if (recordSourceLabel(record) !== 'task spine') return false;
  const text = normalizeSearchText(
    [
      record && record.resultSummary,
      latestHistoryNote(record),
      record && record.detail,
      record && record.progressNote,
      record && record.latestStatus,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return text.length > 20 && !/^codex amy preload/.test(text);
}

function voiceTaskTitle(record, max = 86) {
  const title = compactSessionTitleForVoice(taskTitle(record), max);
  return title.slice(0, max).trim();
}

function statusForVoice(record) {
  return (
    String((record && record.status) || 'ExampleCo')
      .replace(/_/g, ' ')
      .trim() || 'ExampleCo'
  );
}

function voiceLatestNote(record, max = 140) {
  const detail = speechSafe(
    String((record && record.detail) || '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!detail) return '';
  const prompt = speechSafe(
    String((record && record.prompt) || '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (normalizeSearchText(detail) === normalizeSearchText(prompt)) return '';
  const lower = detail.toLowerCase();
  if (
    lower.includes('worktree') ||
    /[a-z]:\\/.test(detail) ||
    /https?:\/\//i.test(detail) ||
    /codex-thread-|source scope|command queue|task spine/i.test(detail)
  ) {
    return '';
  }
  return detail.slice(0, max).trim();
}

function staleMirrorVoicePhrase(record, nowMs) {
  if (!record || record._source !== 'codex-thread-index') return '';
  const ts = Date.parse(record._sourceMtime || '');
  if (!Number.isFinite(ts)) return ' The Codex mirror timestamp is missing, so this may be stale.';
  if (nowMs - ts <= CODEX_MIRROR_FRESH_MS) return '';
  const age = agePhrase(record._sourceMtime, nowMs);
  return age ? ` The Codex mirror itself is ${age} old, so this may be stale.` : '';
}

function staleSourcePhrase(record, nowMs) {
  if (!record || record._source !== 'codex-thread-index') return '';
  const ts = Date.parse(record._sourceMtime || '');
  if (!Number.isFinite(ts)) return '';
  if (nowMs - ts <= 10 * 60 * 1000) return '';
  const age = agePhrase(record._sourceMtime, nowMs);
  return age ? ` Snapshot source refreshed ${age} ago, so this may be stale.` : '';
}

function mirrorCautionLead(record, nowMs) {
  const phrase = staleMirrorVoicePhrase(record, nowMs).trim();
  return phrase ? `${phrase} ` : '';
}

function recordPriority(record) {
  let score = 0;
  if (isActiveDetailRecord(record)) score += 40;
  if (isAgentSessionRecord(record)) score += 25;
  if (record && record._source === 'codex-thread-index') score += 20;
  if (record && record._kind === 'command') score += 10;
  if (isLowSignalIngest(record)) score -= 35;
  if (isTerminalDetailRecord(record)) score -= 15;
  return score;
}

function compareSpineCandidates(a, b, nowMs) {
  const aFresh = liveStatusRank(a.record, nowMs);
  const bFresh = liveStatusRank(b.record, nowMs);
  return (
    bFresh - aFresh ||
    b.priority - a.priority ||
    b.score - a.score ||
    b.record._sortTs - a.record._sortTs
  );
}

function liveStatusRank(record, nowMs) {
  if (!isFreshLiveStatusRecord(record, nowMs)) return 0;
  const label = recordSourceLabel(record);
  if (label === 'task spine') return 3;
  if (label === 'command queue') return 2;
  if (label === 'Codex thread snapshot') return 1;
  return 1;
}

function uniqueSpineRecords(records) {
  const seen = new Set();
  const out = [];
  for (const record of records || []) {
    const title = normalizeSearchText(taskTitle(record));
    const detail = normalizeSearchText(
      record && (record.detail || record.resultSummary || record.prompt || record.oneLiner || ''),
    ).slice(0, 220);
    const key = [
      recordSourceLabel(record),
      title || normalizeSearchText(recordSourceText(record)).slice(0, 220),
      detail,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function isExactTitleMatch(record, query) {
  const title = normalizeSpineQueryForVoice(taskTitle(record));
  const q = normalizeSpineQueryForVoice(query);
  return Boolean(q && title && title.includes(q));
}

function scoreSpineRecord(record, query) {
  const q = normalizeSpineQueryForVoice(query);
  if (!q) return 1;
  const terms = q.split(/\s+/).filter((x) => x.length > 2);
  const text = normalizeSpineQueryForVoice(recordSourceText(record));
  if (!terms.length) return text.includes(q) ? 1 : 0;
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits++;
  }
  return hits / terms.length;
}

function scopedNoLiveStatusMatch(query, reason = '') {
  const display = speechSafe(displaySpineQueryForVoice(query) || query || 'that topic');
  if (reason) {
    return `I ${reason} for ${display}, not active or recent project or session proof in ${SPINE_DETAIL_SCOPE_VOICE}.`;
  }
  return `I do not have active or recent project or session proof for ${display} in ${SPINE_DETAIL_SCOPE_VOICE}.`;
}

function briefSourceLabel(label) {
  const value = String(label || '').trim();
  if (/codex thread mirror/i.test(value)) return 'the Codex mirror';
  if (/codex thread/i.test(value)) return 'a Codex thread';
  if (/live command/i.test(value)) return 'a live command';
  if (/task spine|spine task|spine item/i.test(value)) return 'a spine task';
  return value ? `a ${value}` : 'the spine';
}

function statusForBrief(status) {
  const text = String(status || '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!text) return 'ExampleCo';
  if (/^active or recent$/i.test(text)) return 'active or recent';
  return text;
}

function clueTermsForVoiceQuery(query) {
  const terms = searchTerms(query);
  return terms.filter(
    (term) =>
      term.length > 2 &&
      !PROJECT_SCOPE_TERMS.has(term) &&
      !GENERIC_SPINE_TERMS.has(term) &&
      !QUERY_FILLER_TERMS.has(term),
  );
}

function recordHasVoiceQueryClue(record, query) {
  const clues = clueTermsForVoiceQuery(query);
  if (!clues.length) return true;
  const text = normalizeSpineQueryForVoice(recordSourceText(record));
  return clues.some((term) => text.includes(term));
}

function recordMatchesAnyQueryTerm(record, queryTerms = []) {
  const terms = (queryTerms || []).filter((term) => term && !QUERY_FILLER_TERMS.has(term));
  if (!terms.length) return true;
  const text = normalizeSpineQueryForVoice(recordSourceText(record));
  return terms.some((term) => text.includes(term));
}

function briefProgressText(value, max = 170) {
  const text = sanitizeLiveStatusSpeech(speechSafe(value || ''))
    .replace(/\bLatest:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!max || text.length <= max) return text;
  return text
    .slice(0, max)
    .replace(/\s+\S*$/, '')
    .replace(/[,:;]+$/, '')
    .trim();
}

function titleLabelText(value, max = 58) {
  let text = compactSessionTitleForVoice(value, Math.max(max * 3, 160));
  if (!text) return '';
  const firstQuestion = text.split('?')[0].trim();
  if (firstQuestion.length >= 12) text = firstQuestion;
  const firstClause = text.split(/[,.]/)[0].trim();
  if (firstClause.length >= 12 && firstClause.length < text.length) text = firstClause;
  text = text
    .replace(
      /^(?:how\s+(?:big|much)\s+(?:is|are|does|do|can|should)\s+|(?:what|why|where|when)\s+(?:is|are|does|do|can|should)\s+)/i,
      '',
    )
    .replace(/^is\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(/\bonly$/i, '')
    .replace(/\bamy\b/gi, 'Amy')
    .replace(/\bvapi\b/gi, 'Vapi')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^([a-z])/, (m) => m.toUpperCase());
  if (!max || text.length <= max) return text;
  return text
    .slice(0, max)
    .replace(/\s+\S*$/, '')
    .replace(/[,:;]+$/, '')
    .trim();
}

function formatLikelyMatchesForVoice(records, nowMs, options = {}) {
  const minItems = options.minItems || 2;
  const recordList = uniqueSpineRecords(records);
  const hasTerminal = recordList.some((record) => isTerminalDetailRecord(record));
  const hasOlderRecent = recordList.some((record) => {
    const ts = recordUpdatedMs(record);
    return ts > 0 && nowMs - ts > LIVE_STATUS_FRESH_MS;
  });
  const prefix =
    options.prefix ||
    (hasTerminal
      ? 'I found a few recent or completed matches'
      : hasOlderRecent
        ? 'I found a few recent matches'
        : 'I found a few likely matches');
  const seen = new Set();
  const items = [];
  for (const record of recordList) {
    const label = titleLabelText(voiceTaskTitle(record, 58), 58) || 'unnamed session';
    const key = normalizeSearchText(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    items.push(label);
    if (items.length >= 3) break;
  }
  if (items.length < minItems) return '';
  const joined =
    items.length === 2 ? items.join(', and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  const sourceFreshness =
    recordList.map((record) => mirrorCautionLead(record, nowMs)).find(Boolean) || '';
  return `${sourceFreshness}${prefix}: ${joined}.`;
}

function formatBriefSpineStatus(liveItems, { query = '', nowMs = Date.now() } = {}) {
  const items = Array.isArray(liveItems) ? liveItems.filter(Boolean) : [];
  if (!items.length) return '';
  const item = items[0];
  const objective = briefProgressText(item.objective || query || 'the best match', 90);
  const sourceRecord =
    item.record ||
    (item.sourceKind ? { _source: item.sourceKind, _sourceMtime: item.sourceMtime } : item);
  const sourceFreshness = mirrorCautionLead(sourceRecord, nowMs);
  const baseStatus = statusForBrief(item.status);
  // Stale-but-under-cap Codex mirrors can identify a likely session, but they
  // must not claim live progress. Terminal statuses stay terminal.
  const status =
    sourceFreshness && /^(active or recent|active|in progress|running|queued|progress|pending)$/i.test(baseStatus)
      ? 'a likely recent match'
      : baseStatus;
  const source = briefSourceLabel(item.source);
  const freshness = item.freshness ? ` updated ${item.freshness}` : '';
  const progress = briefProgressText(item.lastProgress || '', 160);
  if (progress) {
    return `${sourceFreshness}${objective} is ${status} from ${source}${freshness}: ${progress}.`;
  }
  if (item.confidence === 'title-status-only') {
    return `${sourceFreshness}${objective} is ${status} from ${source}${freshness}, but I only have title and status, not deeper progress yet.`;
  }
  return `${sourceFreshness}${objective} is ${status} from ${source}${freshness}.`;
}

function summarizeSpineDetailForVoice({
  commands = [],
  tasks = [],
  query = '',
  nowMs = Date.now(),
  maxItems = 3,
  probeLevel = 0,
  detailLevel = undefined,
  progressByTaskId = {},
  commandByTaskId = {},
} = {}) {
  const genericQuery = isGenericSpineQuery(query);
  const broadStatusQuery =
    !genericQuery && (isBroadStatusQuery(query) || isProjectLiveStatusQuery(query));
  const statusLookup = !isArchiveQueryTerms(searchTerms(query)) && isStatusLikeLookup(query);
  const scoringQuery = genericQuery ? '' : normalizeSpineQueryForVoice(query);
  const displayQuery = genericQuery ? '' : displaySpineQueryForVoice(query);
  const commandRecords = (commands || [])
    .filter((c) => c && c.type === 'claude')
    .map((c) => ({
      ...c,
      _kind: 'command',
      title: c.title || c.prompt,
      detail: c.progressNote || c.result || c.oneLiner || '',
      _sortTs: Date.parse(c.updatedAt || c.createdAt || '') || 0,
    }));
  const taskRecords = (tasks || [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      ...t,
      _kind: 'task',
      title: t.title || t.prompt,
      detail: latestHistoryNote(t) || t.resultSummary || t.prompt || '',
      _sortTs: Date.parse(t.updatedAt || t.completedAt || t.createdAt || '') || 0,
    }));
  let rawScored = [...commandRecords, ...taskRecords].map((r) => ({
    record: r,
    score: scoreSpineRecord(r, scoringQuery),
    priority: recordPriority(r),
  }));
  if (!wantsSubagentSessions(query)) {
    rawScored = rawScored.filter((x) => !isSubagentSessionRecord(x.record));
  }
  const scored = rawScored.filter((x) => !scoringQuery || x.score >= 0.34);
  let candidates = scored;
  if (scoringQuery) {
    const exactTitleMatches = scored.filter(
      (x) =>
        isExactTitleMatch(x.record, scoringQuery) &&
        (!statusLookup || !isLowSignalIngest(x.record)),
    );
    if (!broadStatusQuery && exactTitleMatches.length) candidates = exactTitleMatches;
  }
  if (genericQuery || !query) {
    const active = scored.filter(
      (x) => isActiveDetailRecord(x.record) && !isLowSignalIngest(x.record),
    );
    if (active.length) candidates = active;
  }
  if (broadStatusQuery) {
    const queryTerms = searchTerms(query);
    const hasProjectScoExampleCom = queryTerms.some((term) => PROJECT_SCOPE_TERMS.has(term));
    const broadCandidates = rawScored.filter(
      (x) =>
        (!scoringQuery || x.score > 0) &&
        recordHasVoiceQueryClue(x.record, query) &&
        !isNoisyCodexWorkerRecord(x.record, queryTerms),
    );
    const usableBroadCandidates = broadCandidates.filter((x) => !isLowSignalIngest(x.record));
    const lowSignalMatches = broadCandidates.filter((x) => isLowSignalIngest(x.record));
    const freshLive = broadCandidates.filter(
      (x) =>
        isFreshLiveStatusRecord(x.record, nowMs) &&
        !isStaleCodexMirrorRecord(x.record, nowMs) &&
        !isLowSignalIngest(x.record),
    );
    const bestLiveRank = freshLive.reduce(
      (max, x) => Math.max(max, liveStatusRank(x.record, nowMs)),
      0,
    );
    const current = freshLive
      .filter((x) => liveStatusRank(x.record, nowMs) === bestLiveRank)
      .sort((a, b) => compareSpineCandidates(a, b, nowMs))
      .slice(0, maxItems)
      .map((x) => x.record);
    const freshTerminal = usableBroadCandidates
      .filter((x) => isRecentlyCompleteDetailRecord(x.record, nowMs) && !isLowSignalIngest(x.record))
      .sort((a, b) => compareSpineCandidates(a, b, nowMs))
      .slice(0, maxItems)
      .map((x) => x.record);
    const recentStatus = usableBroadCandidates
      .filter(
        (x) =>
          isPlausiblyRecentDetailRecord(x.record, nowMs) &&
          !isLowSignalIngest(x.record) &&
          recordMatchesAnyQueryTerm(x.record, queryTerms),
      )
      .sort((a, b) => compareSpineCandidates(a, b, nowMs))
      .slice(0, maxItems)
      .map((x) => x.record);
    const projectPhraseQuery = isProjectLiveStatusQuery(query) && searchTerms(query).length > 1;
    const terminalProof = projectPhraseQuery
      ? usableBroadCandidates
          .filter(
            (x) => !isLowSignalIngest(x.record) && isRecentProjectTerminalProof(x.record, nowMs),
          )
          .sort((a, b) => compareSpineCandidates(a, b, nowMs))
          .slice(0, maxItems)
          .map((x) => x.record)
      : [];
    const fuzzyRecentAlternatives = hasProjectScoExampleCom
      ? rawScored
          .filter(
            (x) =>
              !isLowSignalIngest(x.record) &&
              !isNoisyCodexWorkerRecord(x.record, queryTerms) &&
              isPlausiblyRecentDetailRecord(x.record, nowMs) &&
              (!wantsSubagentSessions(query) ? !isSubagentSessionRecord(x.record) : true) &&
              recordMatchesAnyQueryTerm(x.record, queryTerms),
          )
          .sort((a, b) => compareSpineCandidates(a, b, nowMs))
          .map((x) => x.record)
      : [];
    if (terminalProof.length)
      candidates = terminalProof.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    else if (current.length) {
      const currentAndRecent = uniqueSpineRecords([...current, ...freshTerminal]).slice(0, maxItems);
      candidates = currentAndRecent.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    }
    else if (recentStatus.length) {
      candidates = recentStatus.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    }
    else {
      if (freshTerminal.length)
        candidates = freshTerminal.map((record) => ({
          record,
          score: 1,
          priority: recordPriority(record),
        }));
      else if (candidates.length) {
        const older = candidates
          .filter((x) => !isLowSignalIngest(x.record))
          .sort((a, b) => compareSpineCandidates(a, b, nowMs))
          .map((x) => x.record);
        const olderUnique = uniqueSpineRecords(older).slice(0, 1);
        const r = olderUnique[0];
        const fuzzyList = formatLikelyMatchesForVoice(fuzzyRecentAlternatives, nowMs, {
          minItems: 2,
          prefix: `I do not see one clearly labeled ${speechSafe(displayQuery || query)}, likely recent Codex sessions`,
        });
        if (fuzzyList) return fuzzyList;
        if (!r && lowSignalMatches.length) {
          return scopedNoLiveStatusMatch(
            displayQuery || query,
            'only found call-log or ingest matches',
          );
        }
        const spokenTitle = r ? voiceTaskTitle(r) : '';
        const titleMatchesQuery =
          spokenTitle && normalizeSearchText(spokenTitle).includes(normalizeSearchText(query));
        const title = titleMatchesQuery ? spokenTitle : '';
        const age = r ? agePhrase(r.updatedAt || r.completedAt || r.createdAt, nowMs) : '';
        const source = r ? voiceSourceLabel(r) : 'older record';
        const staleMirror = r ? staleMirrorVoicePhrase(r, nowMs) : '';
        const recentMatch = r ? isPlausiblyRecentDetailRecord(r, nowMs) : false;
        const recentMatchLabel = r && isTerminalDetailRecord(r) ? 'recently completed' : 'recent';
        const evidenceLabel = staleMirror ? 'stale evidence' : 'older evidence';
        const olderClause = r
          ? recentMatch
            ? `I found a ${recentMatchLabel} ${title ? source + ', ' + title : source + ' match'}${
                age ? ', updated ' + age + ' ago' : ''
              }.`
            : `I found older ${
                title ? source + ', ' + title : 'low-confidence ' + source + ' evidence'
              }${age ? ', updated ' + age + ' ago' : ''}, which is ${evidenceLabel}, not proof of current progress.${staleMirror}`
          : 'I found older matching records only.';
        if (recentMatch) return olderClause;
        return (
          (staleMirror
            ? `I don't have fresh Codex mirror proof for an active or recent ${speechSafe(displayQuery || query)} session. `
            : `I don't see an active or recent ${speechSafe(displayQuery || query)} session. `) + olderClause
        );
      }
    }
  }

  if (statusLookup) {
    const usable = candidates.filter((x) => !isLowSignalIngest(x.record));
    if (!usable.length && candidates.length) {
      return scopedNoLiveStatusMatch(
        displayQuery || query,
        'only found call-log or ingest matches',
      );
    }
    candidates = usable;
  }

  const all = candidates
    .sort((a, b) => compareSpineCandidates(a, b, nowMs))
    .slice(0, maxItems)
    .map((x) => x.record);

  if (!all.length) {
    return displayQuery
      ? `I found no active or recent project or session match for ${speechSafe(displayQuery)} in ${SPINE_DETAIL_SCOPE_VOICE}; that is a scoped no-match, not whole-life proof.`
      : `I found no active spine items in ${SPINE_DETAIL_SCOPE_VOICE}.`;
  }

  const normalizedProbeLevel = normalizeProbeLevel(
    detailLevel !== undefined ? detailLevel : probeLevel,
    0,
  );
  const liveItems = buildLiveStateItems({
    records: all,
    progressByTaskId,
    commandByTaskId,
    nowMs,
  });

  if (normalizedProbeLevel > 0) {
    return sanitizeLiveStatusSpeech(
      formatLiveStateAnswer(liveItems, {
        query: displayQuery,
        probeLevel: normalizedProbeLevel,
        nowMs,
      }),
    );
  }

  const likelyMatches = formatLikelyMatchesForVoice(all, nowMs);
  if (likelyMatches) return likelyMatches;

  const brief = formatBriefSpineStatus(liveItems, { query: displayQuery || query, nowMs });
  if (brief) return brief;

  const lines = [];
  for (const r of all) {
    const liveItem = liveItems.find((item) => item.id && r.id && item.id === r.id) || null;
    const title = voiceTaskTitle(r);
    const status = statusForVoice(r);
    const age = agePhrase(r.updatedAt || r.completedAt || r.createdAt, nowMs);
    const sourceFreshness = staleMirrorVoicePhrase(r, nowMs);
    const latestNote =
      liveItem && liveItem.lastProgress ? liveItem.lastProgress : voiceLatestNote(r);
    const blocker =
      liveItem && liveItem.currentBlocker ? ` Blocker: ${liveItem.currentBlocker}.` : '';
    const next = liveItem && liveItem.nextAction ? ` Next: ${liveItem.nextAction}.` : '';
    const onlyTitleStatus =
      liveItem && liveItem.confidence === 'title-status-only'
        ? ' I only have title/status for this item, not deeper progress yet.'
        : '';
    lines.push(
      `${title || 'That item'} is ${status}${age ? ', updated ' + age + ' ago' : ''} from a ${voiceSourceLabel(r)}.` +
        `${latestNote ? ' Latest note: ' + latestNote + '.' : ''}` +
        blocker +
        next +
        onlyTitleStatus +
        sourceFreshness,
    );
  }
  return lines.join(' ');
}

module.exports = {
  DEFAULT_NO_PROGRESS_MS,
  DEFAULT_CEILING_MS,
  defaultWaitPolicy,
  inferWaitPolicy,
  classifyTaskKind,
  resolveDeadlineMs,
  chooseDeliveryChannel,
  formatResultForChannel,
  summarizeSpineForVoice,
  summarizeSpineDetailForVoice,
};
