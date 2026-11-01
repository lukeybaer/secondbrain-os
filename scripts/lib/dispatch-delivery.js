// dispatch-delivery.js
//
// Pure logic for the managed-wait redesign: wait-policy defaults, completion
// channel selection, speech-safe result phrasing, and a mid-call spine summary.
// Wired into ec2-server.js (addCommand, deliverCommandResult, check_spine) and
// process-dispatches.js. 2026-06-02.
//
// Channels:
//  - chat        : text with the PR link (default, always safe)
//  - voice_if_live   : speak into the call if it is still active, else chat
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
  spokenTimeWindow,
  stripSpokenTimeWindow,
} = require('./voice-spine-query');

const DEFAULT_NO_PROGRESS_MS = 5 * 60 * 1000;
const DEFAULT_CEILING_MS = 60 * 60 * 1000;
const LIVE_STATUS_FRESH_MS = 2 * 60 * 60 * 1000;
const RECENT_COMPLETE_MS = 24 * 60 * 60 * 1000;
// Same horizon as recent completions, but named for spoken session lookup policy.
const RECENT_SESSION_LOOKUP_MS = RECENT_COMPLETE_MS;
const PROJECT_TERMINAL_PROOF_MS = 24 * 60 * 60 * 1000;
// When a spoken lookup matches something touched this week, a match older than
// this is an archive hit, not the session the owner means. 2026-10-28 owner call: a
// 33-day-old scheduled Codex run titled "Branch cleanliness" was read out twice
// instead of the session that had discussed branch cleanliness that evening.
// "September", "last month", "two weeks ago": the caller asked for history.
const EXPLICIT_HISTORY_RE =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|ago|last\s+(?:week|month|year)|weeks|months)\b/i;
const RECENT_MATCH_PREFERENCE_MS = 7 * 24 * 60 * 60 * 1000;
// The local Codex mirror is expected to sync every few minutes. Older source
// mtimes are usable as historical evidence, not active/recent proof.
const CODEX_MIRROR_FRESH_MS = 10 * 60 * 1000;
// Voice session lookup can still name a recent parent session when the mirror
// sync is lagging, but only within a bounded window. Older snapshots go back to
// stale-proof language so Amy does not imply current progress from old data.
const CODEX_MIRROR_RECENT_EVIDENCE_MS = 4 * 60 * 60 * 1000;

// Default wait policy by origin. Voice commands default to background+notify; the
// result is spoken if the caller is still on the line, otherwise chat.
function defaultWaitPolicy(replyTo) {
  if (replyTo === 'vapi') return { mode: 'background', deliveryChannel: 'voice_if_live' };
  return { mode: 'background', deliveryChannel: 'telegram' };
}

// Capture an explicit "call me back" from the spoken task so the completion
// actually dials the owner (voice_callback), not just the default speak-if-live.
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
// Voice gets a speech-safe one-liner (no URLs/branches). Chat gets the
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
  // chat
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
  'startup',
  'briefing',
  'claude',
  'codex',
  'dashboard',
  'graphiti',
  'venture',
  'ExampleCo',
  'ExampleCo',
  'resilience',
  'secondbrain',
  'client',
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
  // An interactive session that is open between the owner's turns. The session
  // cloud reports it as "open" (observed recently, nothing running this
  // second); without this it was neither active nor finished and every
  // recency check skipped it.
  'open',
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
  // Session-cloud records carry structural liveness derived from whether the
  // plane is still observing the source, which is strictly better evidence than
  // a status string. An interactive session sits at zero running activities
  // between the owner's turns; without this it reads as finished and gets described
  // as "older evidence, not proof of current progress" one minute after it last
  // spoke.
  if (record && record._source === 'session-cloud') {
    return record.liveness === 'active' || record.liveness === 'idle';
  }
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
    // Session-cloud records carry the conversation itself. The owner names a session
    // by what was discussed in it, not by its stored title (which for a Claude
    // session is a workspace slug he has never seen). Matching over the dialogue
    // is what lets "the token spend session" reach the right session.
    record && record.topicText,
    record && record.detail,
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
  if (record && (record._source === 'codex-thread-index' || record.origin === 'codex'))
    return false;
  // A session the owner runs is his work even when its title names a call or an
  // ingest (a session opened by pasting a call transcript, say). Automated
  // sessions stay filtered.
  if (record && record._source === 'session-cloud' && record.initiator !== 'automated')
    return false;
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
  // Structural truth wins wherever the source records it. The session cloud
  // plane stamps every activity with source_kind and parent_session_id, so a
  // record carrying those needs no guessing at all.
  //
  // This is the same protection the Codex branch below already has, extended to
  // every provider. 2026-08-16 owner one call: the daily token-reduction
  // run was dropped from the owner's status answer because its own recommendation
  // read "route read-heavy exploration to Haiku subagents via Agent tool". A
  // parent session that merely TALKS about subagents is not one. Text
  // classification cannot tell those apart, so it is now the last resort, not
  // the default.
  // Identity markers first, and only on producer-generated identity fields, never
  // on prose. A boilerplate Codex preload shell is machinery either way, so it
  // must stay suppressed even when the plane stamps it source_kind: main.
  const identityText = normalizeSearchText(
    [
      record && record.id,
      record && record.title,
      record && record.threadName,
      record && record.thread_name,
    ].join(' '),
  );
  if (/\bcodex amy preload\b|\bcodex companion\b|\brescue rung\b/.test(identityText)) return true;

  const declaredKind = String((record && (record.sourceKind || record.source_kind)) || '')
    .trim()
    .toLowerCase();
  if (declaredKind) return declaredKind !== 'main';
  if (record && record.parentSessionId) return true;

  // Codex exports do not yet carry a structural parent-thread id. For mirror
  // rows, classify only from identity/title markers generated by the worker.
  // Reading arbitrary prompt/result text made a parent session disappear when
  // The owner's own requirement merely discussed "agent-subagent" token spend.
  const text = normalizeSearchText(
    record && (record._source === 'codex-thread-index' || record.origin === 'codex')
      ? [
          record.id,
          record.title,
          record.threadName,
          record.thread_name,
          Array.isArray(record.tags) ? record.tags.join(' ') : '',
        ].join(' ')
      : recordSourceText(record),
  );
  return /\bsubagent\b|\bsub agent\b|\bcompanion task\b|\bcodex companion\b|\brescue rung\b|\bchild session\b|\bcodex amy preload\b/.test(
    text,
  );
}

function wantsSubagentSessions(query) {
  return searchTerms(query).some((term) => SUBAGENT_QUERY_TERMS.has(term));
}

// The owner asks for sessions by subject, in his own words, and rarely with the words
// the producer stored. When nothing matches by name, recency and activity are
// still a real answer: the session he means is almost always one of the few that
// are currently open. This describes those, ranked newest first, without ever
// asserting that one of them is the session he named.
//
// Only session-cloud records qualify. They are the ones carrying structural
// liveness (`active` = an activity is running, `idle` = source still observed
// between turns), so nothing here is guessed from a status string that may be
// mid-archive-checkpoint.
// Status is what the session last said and how long ago, not a status enum.
function latestNarrationForVoice(record, nowMs) {
  const turns = Array.isArray(record && record.dialogue) ? record.dialogue : [];
  const last = turns[turns.length - 1];
  if (!last || !last.text) return '';
  const sentence = speechSafe(String(last.text).split(/(?<=[.!?])\s/)[0]).slice(0, 140).trim();
  if (!sentence) return '';
  const age = agePhrase(last.ts, nowMs);
  return `, last said: ${sentence.replace(/[.!?]+$/, '')}${age ? `, ${age} ago` : ''}`;
}

function openSessionRecords(scoredRecords) {
  return (scoredRecords || [])
    .map((x) => (x && x.record ? x.record : x))
    .filter(
      (r) =>
        r &&
        r._source === 'session-cloud' &&
        (r.liveness === 'active' || r.liveness === 'idle') &&
        !isSubagentSessionRecord(r),
    )
    .sort((a, b) => (b._sortTs || 0) - (a._sortTs || 0));
}

function describeOpenSessionsForVoice(scoredRecords, nowMs, maxItems = 3) {
  const all = openSessionRecords(scoredRecords);
  const open = all.slice(0, maxItems);
  if (!open.length) return '';

  const parts = open.map((r) => {
    const title = speechSafe(voiceTaskTitle(r));
    const age = agePhrase(r.updatedAt || r.lastObservedAt, nowMs);
    const state = r.liveness === 'active' ? 'working now' : 'open';
    const latest = latestNarrationForVoice(r, nowMs);
    return `${title}, ${state}${latest || (age ? `, last active ${age} ago` : '')}`;
  });
  const lead =
    all.length === 1
      ? 'One session is open'
      : all.length > open.length
        ? `${all.length} sessions are open, newest ${open.length}`
        : `${all.length} sessions are open`;
  return `${lead}: ${parts.join('; ')}. Say which one and I can go deeper.`;
}

// Every executive-assistant LinkedIn-draft prompt is an internal worker shape,
// regardless of the configured operator identity. Match that stable normalized
// shape without inserting the operator's identity into code or requiring it at
// runtime.
const EA_LINKEDIN_DRAFT_PHRASE = normalizeSearchText(
  'executive assistant is drafting a linkedin conversation starter',
);
const EA_LINKEDIN_DRAFT_RE = new RegExp(
  '\\b' + EA_LINKEDIN_DRAFT_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
);

function isNoisyCodexWorkerRecord(record, queryTerms = []) {
  if (!record || record._source !== 'codex-thread-index') return false;
  const text = normalizeSearchText(recordSourceText(record));
  const terms = new Set(queryTerms || []);
  if (/\bwrite exactly \d+ paragraphs summarizing this news article/.test(text)) {
    return !['article', 'news', 'summarize', 'summary', 'paragraph'].some((term) =>
      terms.has(term),
    );
  }
  // Executive-assistant LinkedIn-draft worker threads are noise. Match the
  // stable task shape after normalization, without embedding an owner identity.
  if (EA_LINKEDIN_DRAFT_RE.test(text)) {
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
    String((record && record.status) || 'unknown')
      .replace(/_/g, ' ')
      .trim() || 'unknown'
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
  if (!phrase) return '';
  if (/Codex mirror timestamp is missing/i.test(phrase)) return '';
  const inline = phrase.replace(
    /^The Codex mirror itself is (.+?) old, so this may be stale\.$/i,
    'Using a Codex mirror that is $1 old, so this may be stale',
  );
  return `${inline}, `;
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

const CLEAR_WIN_MARGIN = 0.25;

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

// Whole-word version of the exact title match: the asked subject must appear
// in the title as a run of whole words. The substring form above would read
// "voice deploy" inside "invoice deployment".
function isExactTitlePhraseMatch(record, query) {
  const title = normalizeSpineQueryForVoice(taskTitle(record));
  const q = normalizeSpineQueryForVoice(query);
  return Boolean(q && title && ` ${title} `.includes(` ${q} `));
}

// Filler that carries no discriminating power in a spoken session question.
// "how is the watcher going" is a question about the watcher; "going", "the" and
// "how" match every record equally and only dilute the real anchor.
const SPINE_SCORE_FILLER_TERMS = new Set([
  'the',
  'and',
  'for',
  'with',
  'about',
  'from',
  'into',
  'this',
  'these',
  'those',
  'you',
  'your',
  'our',
  'are',
  'was',
  'were',
  'been',
  'have',
  'has',
  'had',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'did',
  'does',
  'doing',
  'get',
  'got',
  'any',
  'all',
  'now',
  'still',
  'just',
  'not',
  // How the owner points at a session rather than what it was about: "the prompt
  // was something about", "the one we were talking about".
  'prompt',
  'prompts',
  'something',
  'talking',
  'remember',
  'called',
  'named',
  // His own name is in every session he started, and "current work" is how
  // he points at whatever is open, not a topic.
  'owner',
  'looking',
  'current',
  'work',
]);

// Whether a session is live is ranked from its liveness, not matched as words:
// "the one still running" must not prefer text that says "running". Only these
// phrases are removed, so "flight booking" or "running shoes" stay topics.
const LIVE_PHRASE_RE =
  /\b(?:still\s+(?:running|going|open|working|active)|in\s+flight|in\s+progress|ongoing|currently\s+(?:running|active|working)|(?:is|are|that\s+s|thats)\s+(?:still\s+)?running|running\s+right\s+now|active\s+sessions?|running\s+sessions?|open\s+sessions?)\b/g;

// "What is still running", "what am I working on": a list of what is open, with
// no topic. 2026-10-28 owner call: the words left after the live phrase ("what
// is") matched weeks-old Codex mirror threads, whose stored status reads as
// active without proving anything runs.
const LIVE_LIST_FILLER = new Set(
  'what whats which is are s anything everything any all every there sessions session tasks task work things thing right now currently still me tell show list up my of the you do i have open running active going on today'.split(' '),
);
const WORKING_ON_RE = /\bwhat\s+(?:am\s+i|are\s+we|are\s+you|is\s+amy)\s+(?:still\s+)?working\s+on\b/;
// "What's running" normalizes to "what s running", which the live phrases miss.
const WHATS_RUNNING_RE = /\b(?:what\s+s|whats)\s+(?:still\s+)?(?:running|open|active)\b/;
// Running means a running status updated lately, not queued or blocked work.
const LIVE_TASK_STATUSES = new Set(['running', 'in progress', 'working', 'active']);
const LIVE_TASK_FRESH_MS = 2 * 60 * 60 * 1000;
const LOST_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

function isLiveListAsk(query) {
  const text = normalizeSearchText(query);
  const workingOn = WORKING_ON_RE.test(text);
  const live = LIVE_PHRASE_RE.test(text) || WHATS_RUNNING_RE.test(text);
  LIVE_PHRASE_RE.lastIndex = 0;
  if (!live && !workingOn) return false;
  const rest = (
    workingOn ? text.replace(WORKING_ON_RE, ' ') : stripLivePhrases(text.replace(WHATS_RUNNING_RE, ' '))
  )
    .split(/\s+/)
    .filter(Boolean);
  return rest.every((t) => LIVE_LIST_FILLER.has(t));
}

function stripLivePhrases(query) {
  return normalizeSearchText(query).replace(LIVE_PHRASE_RE, ' ').replace(/\s+/g, ' ').trim();
}

// Spoken word forms and hyphens. 2026-10-28 owner call: "proposes" missed
// "proposed" and "regrade" missed "re-grade", so a running session lost to
// finished ones on word count. Both match at word boundaries only: a stem must
// start a word, and a joined term must equal two adjacent words, so "hiring"
// never finds "third" and "review" never finds "more views" (Codex review
// 411825061d4a).
function stemSpineTerm(term) {
  if (term.length < 6) return term;
  const stem = term.replace(/(?:ing|ed|es|s)$/, '');
  return stem.length >= 4 ? stem : term;
}

function spineTextHasTerm(text, term) {
  if (text.includes(term)) return true;
  const stem = stemSpineTerm(term);
  const words = text.split(' ');
  if (stem !== term && words.some((word) => word.startsWith(stem))) return true;
  if (term.length < 6) return false;
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] && words[i + 1] && words[i] + words[i + 1] === term) return true;
  }
  return false;
}

function isDistinctiveSpineTerm(term) {
  return term.length > 2 && !GENERIC_SPINE_TERMS.has(term) && !SPINE_SCORE_FILLER_TERMS.has(term);
}

// "#b" or a spoken "hashtag b" names a tag exactly. Normalization would strip
// it to a one-letter term that the scorer then ignores.
function queryHashtags(query) {
  const raw = String(query || '').toLowerCase();
  const tags = new Set();
  for (const m of raw.matchAll(/(?:^|[\s(])#([a-z][\w-]{0,30})\b/g)) tags.add(`#${m[1]}`);
  for (const m of raw.matchAll(/\bhash\s*tag\s+([a-z][\w-]{0,30})\b/g)) tags.add(`#${m[1]}`);
  return [...tags];
}

function scoreSpineRecord(record, query) {
  const askedTags = queryHashtags(query);
  if (askedTags.length && Array.isArray(record && record.tags)) {
    const recordTags = new Set(record.tags.map((t) => String(t).toLowerCase()));
    if (askedTags.some((t) => recordTags.has(t))) return 1;
  }
  if (askedTags.length) {
    // A tag-only query ("#b", "the hashtag b session") must not fall through
    // to substring scoring, where the bare letter matches nearly anything.
    const rest = String(query || '')
      .toLowerCase()
      .replace(/#[a-z][\w-]*|\bhash\s*tag\s+[a-z][\w-]*/g, ' ')
      .replace(/\b(?:the|a|an|session|sessions|thread|chat|one)\b/g, ' ')
      .trim();
    if (!rest) return 0;
  }
  const q = normalizeSpineQueryForVoice(query);
  if (!q) return 1;
  const allTerms = q.split(/\s+/).filter((x) => x.length > 2);
  const text = normalizeSpineQueryForVoice(recordSourceText(record));
  if (!allTerms.length) return text.includes(q) ? 1 : 0;

  // Score on the terms that actually discriminate. Every session record contains
  // "session", most contain "task" and "status", so counting them let a query
  // like "the session about the restaurant" score 0.67 against a session about
  // token spend purely on "session" plus "about". Anchors are what the owner means.
  const anchors = allTerms.filter(isDistinctiveSpineTerm);
  if (!anchors.length) {
    // Nothing but generic words. Fall back to the old behaviour so a broad
    // "any sessions going" style question still reaches the generic handling
    // above rather than silently scoring zero everywhere.
    let hits = 0;
    for (const term of allTerms) if (spineTextHasTerm(text, term)) hits++;
    return hits / allTerms.length;
  }
  let anchorHits = 0;
  for (const term of anchors) if (spineTextHasTerm(text, term)) anchorHits++;
  // No distinctive term present means this record is not what he asked about,
  // however many filler words happen to coincide.
  if (!anchorHits) return 0;
  return anchorHits / anchors.length;
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
  if (!text) return 'unknown';
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
  return clues.some((term) => spineTextHasTerm(text, term));
}

function recordMatchesAnyQueryTerm(record, queryTerms = []) {
  const terms = (queryTerms || []).filter((term) => term && !QUERY_FILLER_TERMS.has(term));
  if (!terms.length) return true;
  const text = normalizeSpineQueryForVoice(recordSourceText(record));
  return terms.some((term) => spineTextHasTerm(text, term));
}

function briefProgressText(value, max = 170) {
  const text = sanitizeLiveStatusSpeech(speechSafe(value || ''))
    .replace(/\bLatest:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!max || text.length <= max) return text;
  const clipped = text.slice(0, max);
  // End on a whole sentence when one fits, instead of a dangling fragment
  // ("... is deployed. What changed since").
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  if (lastStop >= 60) return clipped.slice(0, lastStop).trim();
  return clipped
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
    .replace(/\bvapi\b/gi, 'Voice provider')
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

// A session with no app name is titled from its first worded prompt, which for
// a long-running session can be a stray line ("hold on, don't you remember our
// session from a few days ago"). The owner cannot recognise it by that; he can by
// what it did.
function isUntitledSession(record) {
  return Boolean(record && record._source === 'session-cloud' && !String(record.sessionTitle || '').trim());
}

// What a record last reported, as one short spoken sentence, or '' when it has
// nothing beyond its title. 2026-10-28 owner call: check_spine returned the
// right session twice, but read only its title, so neither Amy nor the owner could
// tell it was the one that deleted the unfinished asks card.
function spokenOutcome(record, max = 90) {
  if (!record) return '';
  const raw = String(record.resultSummary || record.detail || '');
  if (!raw.trim()) return '';
  const plain = raw
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // A sentence ends at . ! or ? before a space or the end, never inside "$1.5".
  const first = (plain.match(/^.+?[.!?](?=\s|$)/) || [plain])[0].trim();
  // Shouted card names ("UNFINISHED ASKS") are words to say, not letters to spell.
  const words = first.replace(/\b[A-Z]{4,}\b/g, (w) => w.toLowerCase());
  const text = briefProgressText(words, max).replace(/[.!?]+$/, '').trim();
  if (text.length < 8) return '';
  const title = normalizeSearchText(taskTitle(record)).replace(/^codex thread /, '');
  const said = normalizeSearchText(text);
  if (title && (title.startsWith(said.slice(0, 40)) || said.startsWith(title.slice(0, 40)))) return '';
  return text;
}

// When a session happened, the way the owner would say it: "20 minutes ago", "this
// morning", "last night", "3 days ago", on the assistant's operating clock.
function centralParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
  return { day: Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000, hour: get('hour') };
}

function spokenWhen(ms, nowMs) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 120) return 'about an hour ago';
  const then = centralParts(ms);
  const now = centralParts(nowMs);
  const days = now.day - then.day;
  if (days <= 0) {
    if (minutes < 6 * 60) return `${Math.round(minutes / 60)} hours ago`;
    return then.hour < 12 ? 'this morning' : then.hour < 17 ? 'this afternoon' : 'this evening';
  }
  if (days === 1) return then.hour >= 17 ? 'last night' : 'yesterday';
  return `${days} days ago`;
}

// One clause of speech: no sentence breaks inside, so the whole pick stays one
// spoken sentence however the cap is counted.
function clauseText(value, max, { keepCase = false } = {}) {
  const text = briefProgressText(
    String(value || '')
      .replace(/\*\*|__|`|["\u201c\u201d]/g, '')
      .replace(/\b[A-Z]{4,}\b/g, (w) => w.toLowerCase())
      .replace(/[.!?;:]+(?=\s|$)/g, ',')
      .replace(/\s+/g, ' ')
      .trim()
      // Mid-sentence now: "The 6 notes" reads "the 6 notes", "NASA" stays.
      .replace(/^([A-Z])(?=[a-z\s])/, (c) => (keepCase ? c : c.toLowerCase())),
    max,
  );
  return text.replace(/[,\s]+$/, '').trim();
}

// What the owner asked the session, said back to him: the app's name for it when it
// has one, else the latest recap of what he wants, else what it last did when
// listing several and its opening line is all it has (that line can be a stray
// "hold on, remember our session..."), else the words he opened it with.
function sessionGist(record, max = 80, { preferOutcome = false } = {}) {
  const name = String(record.sessionTitle || '').trim();
  if (name) return { kind: 'named', text: clauseText(name, 60, { keepCase: true }) };
  const intent = clauseText(titleLabelText(String(record.intent || '').replace(/["\u201c\u201d]/g, ''), max), max);
  if (intent) return { kind: 'asked', text: intent };
  const outcome = preferOutcome && isUntitledSession(record) ? clauseText(spokenOutcome(record, max), max) : '';
  if (outcome) return { kind: 'outcome', text: outcome };
  const asked = titleLabelText(voiceTaskTitle(record, max), max) || record.lastPrompt;
  return { kind: 'asked', text: clauseText(asked, max) };
}

function sessionStateClause(record, nowMs) {
  const when = spokenWhen(recordUpdatedMs(record), nowMs);
  if (isActiveDetailRecord(record)) return when && when !== 'just now' ? `still open, last active ${when}` : 'still open';
  // Only terminal proof says finished. A session last seen running, with no
  // receipt, is not claimed either way.
  // An interactive session never finishes on its own; a quiet one with a
  // receipted last turn has only stopped replying (Owner decision: a quiet
  // briefing session was read out as finished).
  if (isOwnerCloudSession(record)) {
    if (record.liveness === 'terminal') return when ? `last replied ${when}` : 'not replying now';
  } else if (isTerminalDetailRecord(record)) {
    return when ? `finished ${when}` : 'finished';
  }
  return when ? `last active ${when}` : 'not confirmed finished';
}

// The spoken lead and whether it already said what the session last did.
function sessionLead(record, max, options = {}) {
  const gist = sessionGist(record, max, options);
  if (!gist.text) return { text: '', saysOutcome: false };
  if (gist.kind === 'named') return { text: `the ${gist.text} session`, saysOutcome: false };
  if (gist.kind === 'outcome') return { text: `the one that last said, ${gist.text}`, saysOutcome: true };
  return { text: `the one where you asked, ${gist.text}`, saysOutcome: false };
}

const SESSION_PICK_MAX = 340;

function isOwnerCloudSession(record) {
  return Boolean(record && record._source === 'session-cloud');
}

// Owner decision: "She needs to say something like 'you mean the one where
// you wanted to x, I did y right' ... Or 'there's two like that, one has abc,
// the other def, do you mean the second one?'" One spoken sentence that says
// back what he asked the session and what it last did, so he can confirm it
// or pick, instead of a title read off a list.
function formatSessionConfirmForVoice(record, nowMs) {
  if (!isOwnerCloudSession(record)) return '';
  const lead = sessionLead(record, 90);
  if (!lead.text) return '';
  const base = `You mean ${lead.text}, ${sessionStateClause(record, nowMs)}`;
  const outcome = lead.saysOutcome ? '' : clauseText(spokenOutcome(record, 120), 120);
  const withOutcome = outcome ? `${base}, where it last said, ${outcome}, right?` : '';
  return withOutcome && withOutcome.length <= SESSION_PICK_MAX ? withOutcome : `${base}, right?`;
}

function formatSessionChoiceForVoice(records, nowMs) {
  // Only when the two closest are both the owner's sessions; anything else keeps the
  // general list.
  const sessions = uniqueSpineRecords(records).slice(0, 2);
  if (sessions.length < 2 || !sessions.every(isOwnerCloudSession)) return '';
  const states = sessions.map((r) => sessionStateClause(r, nowMs));
  // What each last did is the nuance that tells two sessions apart, so the
  // leads shrink before the outcomes go.
  const build = (leadMax, outcomeMax) => {
    const items = sessions.map((r, i) => {
      const lead = sessionLead(r, leadMax, { preferOutcome: true });
      const outcome = outcomeMax && !lead.saysOutcome ? clauseText(spokenOutcome(r, outcomeMax), outcomeMax) : '';
      return lead.text ? `${lead.text.replace(/^the /, '')}, ${states[i]}${outcome ? `, which last said, ${outcome}` : ''}` : '';
    });
    if (items.some((item) => !item)) return '';
    return `There are two like that, ${items[0]}, and the other, ${items[1]}, which one do you mean?`;
  };
  let answer = '';
  for (const [leadMax, outcomeMax] of [[70, 70], [50, 60], [40, 45], [60, 0]]) {
    answer = build(leadMax, outcomeMax);
    if (!answer || answer.length <= SESSION_PICK_MAX) break;
  }
  return answer;
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
  let anyOutcome = false;
  for (const record of recordList) {
    const outcome = spokenOutcome(record);
    const named = titleLabelText(voiceTaskTitle(record, 58), 58) || 'unnamed session';
    const untitled = isUntitledSession(record) && outcome;
    const label = untitled ? `the session that reported, ${outcome}` : named;
    const key = normalizeSearchText(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    if (outcome) anyOutcome = true;
    items.push(!untitled && outcome ? `${label}, which last reported, ${outcome}` : label);
    if (items.length >= 3) break;
  }
  if (items.length < minItems) return '';
  // Items that carry their own commas need a stronger separator to stay
  // distinguishable when spoken.
  const sep = anyOutcome ? '; ' : ', ';
  const joined =
    items.length === 2
      ? items.join(`${sep}and `)
      : `${items.slice(0, -1).join(sep)}${sep}and ${items[items.length - 1]}`;
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
  const activeLike = /^(active or recent|active|in progress|running|queued|progress|pending)$/i.test(
    baseStatus,
  );
  const recordTs = item.record ? recordUpdatedMs(item.record) : 0;
  // A month-old record whose stored status still says "active or recent" is
  // not recent, whatever its status field claims.
  const structurallyLive = Number(item.record && item.record.activeActivityCount) > 0;
  const oldRecord = !structurallyLive && recordTs > 0 && nowMs - recordTs > RECENT_COMPLETE_MS;
  // Stale-but-under-cap Codex mirrors can identify a likely session, but they
  // must not claim live progress. Terminal statuses stay terminal.
  const status =
    activeLike && oldRecord
      ? 'an older match'
      : sourceFreshness && activeLike
        ? 'a likely recent match'
        : baseStatus;
  const sessionProvider =
    item.record && item.record._source === 'session-cloud' ? String(item.record.provider || '') : '';
  const source = sessionProvider
    ? `a ${sessionProvider === 'codex' ? 'Codex' : 'Claude'} session`
    : briefSourceLabel(item.source);
  const freshness = item.freshness ? ` updated ${item.freshness}` : '';
  const progress = briefProgressText(item.lastProgress || '', 160).replace(/[.!?]+$/, '');
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
  // Filled with the sessions the answer offered, so a follow-up ("the second
  // one", "read me that session") resolves to what the owner just heard.
  pick = null,
} = {}) {
  const genericQuery = isGenericSpineQuery(query);
  const broadStatusQuery =
    !genericQuery && (isBroadStatusQuery(query) || isProjectLiveStatusQuery(query));
  const statusLookup = !isArchiveQueryTerms(searchTerms(query)) && isStatusLikeLookup(query);
  // "Last night", "this morning": when, not what. Scored as words they matched
  // nothing and diluted every real anchor.
  const timeWindow = genericQuery ? null : spokenTimeWindow(query, nowMs);
  const liveAsk = !genericQuery && LIVE_PHRASE_RE.test(normalizeSearchText(query));
  LIVE_PHRASE_RE.lastIndex = 0;
  const topicQuery = stripLivePhrases(timeWindow ? stripSpokenTimeWindow(query) : query);
  const scoringQuery = genericQuery ? '' : normalizeSpineQueryForVoice(topicQuery);
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
  if (isLiveListAsk(query)) {
    const records = rawScored.map((x) => x.record);
    const sessions = openSessionRecords(records);
    // Proven running work outside the session plane. The Codex mirror only
    // stores a status, so it is not proof.
    const running = uniqueSpineRecords(
      records.filter(
        (r) =>
          r._source !== 'session-cloud' &&
          r._source !== 'codex-thread-index' &&
          LIVE_TASK_STATUSES.has(detailStatus(r)) &&
          nowMs - recordUpdatedMs(r) <= LIVE_TASK_FRESH_MS &&
          !isLowSignalIngest(r),
      ),
    ).slice(0, maxItems);
    // "Go deeper" after the list reads the live records in detail.
    const depth = normalizeProbeLevel(detailLevel !== undefined ? detailLevel : probeLevel, 0);
    if (depth > 0 && (sessions.length || running.length)) {
      return summarizeSpineDetailForVoice({
        tasks: [...sessions, ...running],
        query: '',
        nowMs,
        maxItems,
        probeLevel,
        detailLevel,
        progressByTaskId,
        commandByTaskId,
        pick,
      });
    }
    if (pick && typeof pick === 'object' && sessions.length) {
      // Every session read out, so "the third one" resolves.
      pick.sessionIds = sessions.slice(0, maxItems).map((r) => r.id).filter(Boolean);
      pick.confident = sessions.length === 1;
    }
    const parts = [];
    if (sessions.length) parts.push(describeOpenSessionsForVoice(sessions, nowMs, maxItems));
    if (running.length) {
      parts.push(
        `Also running: ${running.map((r) => speechSafe(voiceTaskTitle(r))).join('; ')}.`,
      );
    }
    if (parts.length) return parts.join(' ');
    // A session the plane stopped observing may still be working; say so
    // rather than claim nothing is open.
    const lost = records
      .filter(
        (r) =>
          r._source === 'session-cloud' &&
          r.liveness === 'last_seen' &&
          !isSubagentSessionRecord(r) &&
          nowMs - recordUpdatedMs(r) <= LOST_SESSION_WINDOW_MS,
      )
      .sort((a, b) => recordUpdatedMs(b) - recordUpdatedMs(a))[0];
    if (lost) {
      const age = agePhrase(lost.updatedAt || lost.lastObservedAt, nowMs);
      return `I can't confirm any session is open right now. The newest one I lost sight of is ${speechSafe(voiceTaskTitle(lost))}${age ? `, last seen ${age} ago` : ''}.`;
    }
    return 'None of your sessions is open and no task is running right now.';
  }
  let scored = rawScored.filter((x) => !scoringQuery || x.score >= 0.34);
  // A named time window keeps only records touched since it opened, when any
  // match is. A session still running since last night qualifies.
  if (timeWindow) {
    // Only a known start can rule a session out of a closed window. A record
    // with no start time may have been running since before the end.
    const startedMs = (record) => Date.parse((record && (record.firstActivityAt || record.createdAt)) || '');
    const inWindow = (x) =>
      recordUpdatedMs(x.record) >= timeWindow.startMs &&
      !(timeWindow.endMs && startedMs(x.record) >= timeWindow.endMs);
    if (scored.some(inWindow)) {
      scored = scored.filter(inWindow);
      rawScored = rawScored.filter(inWindow);
    }
  }
  // Something touched this week that matches beats a weeks-old record that
  // matches, so archive hits drop out once a recent match exists.
  if (scoringQuery && !timeWindow && !EXPLICIT_HISTORY_RE.test(topicQuery)) {
    const recentEnough = (x) => nowMs - recordUpdatedMs(x.record) <= RECENT_MATCH_PREFERENCE_MS;
    if (scored.some(recentEnough)) scored = scored.filter(recentEnough);
  }
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
  // One of the owner's own sessions that matches every word he said is what he
  // means, even when a word like "briefing" also makes the question read as a
  // broad project status. 2026-10-28 owner call: "the session about nightly
  // briefing fixes" was answered from the project-status path, which ranks by
  // liveness and finished-task proof and never looked at the session that
  // matched. A task titled with his words keeps the project path, whose
  // exact-title rules settle live versus finished.
  // An open session of his that scores at least as well as anything else is
  // also the one he means. 2026-10-28 owner call: "morning briefing proposed
  // fixes waiting on the card regrade" scored his running session highest, and
  // the project path still answered with two finished ones.
  const openOwnScore = scored
    .filter((x) => isOwnerCloudSession(x.record) && isActiveDetailRecord(x.record))
    .reduce((max, x) => Math.max(max, x.score || 0), 0);
  const otherScore = scored
    .filter((x) => !(isOwnerCloudSession(x.record) && isActiveDetailRecord(x.record)))
    .reduce((max, x) => Math.max(max, x.score || 0), 0);
  const fullOwnMatch = scored.some((x) => isOwnerCloudSession(x.record) && x.score >= 1);
  const namedOwnSession =
    Boolean(scoringQuery) &&
    (fullOwnMatch || (openOwnScore >= 0.5 && openOwnScore >= otherScore)) &&
    !rawScored.some((x) => !isOwnerCloudSession(x.record) && isExactTitleMatch(x.record, scoringQuery));
  // Partial matches stay out of the field, or liveness ranking below would let
  // a running task that shares most of his words outrank the session he named.
  if (namedOwnSession && fullOwnMatch) {
    const full = candidates.filter((x) => x.score >= 1);
    if (full.length) candidates = full;
  }
  if (broadStatusQuery && !namedOwnSession) {
    const queryTerms = searchTerms(query);
    const hasProjectScopeTerm = queryTerms.some((term) => PROJECT_SCOPE_TERMS.has(term));
    // The lists below rank by liveness, so a record that shares one word of
    // the ask must not join one that shares most of them. 2026-10-28 voice
    // self-test: "update blocks per card diagnostics" matched the task on three
    // of four words, and two open sessions that only said "card" were offered
    // because they were more recent.
    // The best is taken over records that could answer: eligible here and not
    // already set aside as old by the recent-match preference above (Codex
    // review df24d41aa1e1). The margin is twice the winner margin, so records
    // that match nearly as well still list together.
    const eligibleBroad = rawScored.filter(
      (x) =>
        (!scoringQuery || x.score > 0) &&
        recordHasVoiceQueryClue(x.record, query) &&
        !isNoisyCodexWorkerRecord(x.record, queryTerms),
    );
    const inScored = new Set(scored.map((x) => x.record));
    const bestBroadScore = scoringQuery
      ? eligibleBroad
          .filter((x) => inScored.has(x.record) && !isLowSignalIngest(x.record))
          .reduce((max, x) => Math.max(max, x.score || 0), 0)
      : 0;
    const broadCandidates = eligibleBroad.filter(
      (x) => !scoringQuery || bestBroadScore - x.score < CLEAR_WIN_MARGIN * 2,
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
      .filter(
        (x) => isRecentlyCompleteDetailRecord(x.record, nowMs) && !isLowSignalIngest(x.record),
      )
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
    const fuzzyRecentAlternatives = hasProjectScopeTerm
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
    // A record that is fresh and live right now under exactly the asked title
    // is the answer. Without this, a project-phrase question ("briefing
    // refresh fixes deploy") preferred an unrelated session that had finished
    // hours earlier over the running task named exactly that.
    // Two limits keep that shortcut honest. The title must match as whole
    // words. And a record with the same title that is NOT live and is newer
    // (the task finished, and a duplicate projection still reads as running)
    // cancels it, so a completed task is never reported as running.
    const liveRecords = new Set(freshLive.map((x) => x.record));
    const newestSettledExactTs = scoringQuery
      ? rawScored
          .filter((x) => !liveRecords.has(x.record) && isExactTitlePhraseMatch(x.record, scoringQuery))
          .reduce((max, x) => Math.max(max, Number(x.record._sortTs) || 0), 0)
      : 0;
    const exactFreshLive = scoringQuery
      ? freshLive
          .filter(
            (x) =>
              isExactTitlePhraseMatch(x.record, scoringQuery) &&
              (Number(x.record._sortTs) || 0) > newestSettledExactTs,
          )
          .sort((a, b) => compareSpineCandidates(a, b, nowMs))
          .slice(0, maxItems)
          .map((x) => x.record)
      : [];
    if (exactFreshLive.length)
      candidates = exactFreshLive.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    else if (terminalProof.length)
      candidates = terminalProof.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    else if (current.length) {
      const currentAndRecent = uniqueSpineRecords([...current, ...freshTerminal]).slice(
        0,
        maxItems,
      );
      candidates = currentAndRecent.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    } else if (recentStatus.length) {
      candidates = recentStatus.map((record) => ({
        record,
        score: 1,
        priority: recordPriority(record),
      }));
    } else {
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
        const age = r ? agePhrase(r.updatedAt || r.completedAt || r.createdAt, nowMs) : '';
        const source = r ? voiceSourceLabel(r) : 'older record';
        const staleMirror = r ? staleMirrorVoicePhrase(r, nowMs) : '';
        const recentMatch = r ? isPlausiblyRecentDetailRecord(r, nowMs) : false;
        // Speak the title when EITHER the stored title actually contains what
        // The owner said, or the record is a plausibly recent match.
        //
        // The verbatim-substring rule alone was too strict: he describes a
        // session rather than quoting its stored title, which produced useless
        // answers like "I found a recent spine task match, updated about 6 hours
        // ago". Recency alone would be too loose: a long-dead record must not
        // read as the answer just because one word coincided, which is why stale
        // evidence with no textual overlap still keeps its title suppressed.
        const titleMatchesQuery = Boolean(
          spokenTitle && normalizeSearchText(spokenTitle).includes(normalizeSearchText(query)),
        );
        const title = titleMatchesQuery || recentMatch ? spokenTitle : '';
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
            : `I don't see an active or recent ${speechSafe(displayQuery || query)} session. `) +
          olderClause
        );
      }
    }
  }

  // "The one still running" keeps the open sessions that match as well as
  // the best match. When nothing open matched and nothing matched fully, it
  // offers what is open as a choice instead of sessions that went quiet days
  // ago (2026-10-28 owner call: "active session still running from my
  // prompt"). A full match that is quiet stays the answer, with its state.
  let openInstead = false;
  if (liveAsk) {
    const isOpen = (x) => isActiveDetailRecord(x.record) && !isLowSignalIngest(x.record);
    const best = candidates.reduce((max, x) => Math.max(max, x.score || 0), 0);
    const open = candidates.filter((x) => isOpen(x) && best - (x.score || 0) < CLEAR_WIN_MARGIN);
    const anyOpen = rawScored.filter(isOpen);
    if (open.length) candidates = open;
    else if (best < 1 && anyOpen.length) {
      candidates = anyOpen.map((x) => ({ ...x, score: 1 }));
      openInstead = true;
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

  // A clearly better match wins before liveness does, by the same margin that
  // makes a lone winner: only the best-scoring cohort is ranked. Filtering
  // against the top score, not comparing pairs, keeps the order the same for
  // any input order (Codex review 64c7759e17d8). 2026-10-28 owner call: "the
  // session where you removed the unfinished work card" matched a finished
  // session on every word, and an open briefing session that shared three of
  // them was read out instead.
  const bestScore = candidates.reduce((max, x) => Math.max(max, x.score || 0), 0);
  const rankedCandidates = candidates
    .filter((x) => bestScore - (x.score || 0) < CLEAR_WIN_MARGIN)
    .sort((a, b) => compareSpineCandidates(a, b, nowMs));
  const all = rankedCandidates.slice(0, maxItems).map((x) => x.record);

  // Winner margin. Listing three titles is the right answer when the field is
  // genuinely close, and the wrong one when the owner named a session clearly enough
  // that one candidate dominates. "How is the watcher going" should get the
  // watcher's status, not a menu that also reads out a Codex preload shell.
  const topScore = rankedCandidates.length ? rankedCandidates[0].score || 0 : 0;
  const runnerUpScore = rankedCandidates.length > 1 ? rankedCandidates[1].score || 0 : 0;
  const topRecord = rankedCandidates.length ? rankedCandidates[0].record : null;
  const runnerUpRecord = rankedCandidates.length > 1 ? rankedCandidates[1].record : null;
  // Lexical margin separates a named session from the field.
  const winsOnScore = topScore >= 0.5 && topScore - runnerUpScore >= CLEAR_WIN_MARGIN;
  // Several sessions can legitimately mention the same anchor word, which ties
  // the lexical score and produces a menu. Recency and activity break that tie
  // the way the owner does: the open session that just spoke is the one he means, not
  // a finished one that happened to use the word.
  const winsOnLiveness =
    topScore > 0 &&
    Boolean(topRecord) &&
    isActiveDetailRecord(topRecord) &&
    (!runnerUpRecord || !isActiveDetailRecord(runnerUpRecord));
  const hasClearWinner = Boolean(scoringQuery) && !openInstead && (winsOnScore || winsOnLiveness);

  if (!all.length) {
    // The owner names sessions by what they are about, not by their stored titles, so
    // a lexical miss is common and is not the same as nothing running. Rather
    // than a bare no-match, say plainly that nothing matched by name and then
    // name what IS open, newest first, so he can recognise the one he meant.
    // The "nothing matched" clause stays: this offers candidates, it never
    // claims one of them is the session he asked for.
    const openNow = describeOpenSessionsForVoice(rawScored, nowMs, maxItems);
    if (openNow) {
      return displayQuery ? `Nothing is labeled ${speechSafe(displayQuery)}. ${openNow}` : openNow;
    }
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

  const offered = hasClearWinner || (all.length === 1 && !openInstead) ? [topRecord || all[0]] : all;
  const sessionPick =
    offered.length === 1
      ? formatSessionConfirmForVoice(offered[0], nowMs)
      : formatSessionChoiceForVoice(offered, nowMs);
  if (sessionPick) {
    if (pick && typeof pick === 'object') {
      const ids = (offered.length === 1 ? offered : uniqueSpineRecords(offered).slice(0, 2))
        .map((r) => r.id)
        .filter(Boolean);
      // Record ids, the same form the call cursor pins.
      pick.sessionIds = ids;
      pick.confident = ids.length === 1;
    }
    return sessionPick;
  }

  const likelyMatches = hasClearWinner ? '' : formatLikelyMatchesForVoice(all, nowMs);
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
  scoreSpineRecord,
  describeOpenSessionsForVoice,
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
  spokenWhen,
};
