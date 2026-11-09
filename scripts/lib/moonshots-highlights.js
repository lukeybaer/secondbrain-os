'use strict';
// Moonshots long-form highlights (The owner): "Every time there's a new
// Moonshots podcast (PRIVATE_NAME), do a three-minute highlights of it: the
// best moments, the most material, important and interesting things said. Use
// the video clips to capture all the key points of the entire podcast. These
// are not shorts; make it long format. In long format you can make your
// animations, drawings and clips a little longer, one to five seconds, even
// seven depending on how important the animation is. I always want a Moonshots
// one to be one of the three video approval queue ones, if it's new."
//
// Pure decisions for scripts/build-moonshots-highlights.js and the daily
// auto-build cap (auto-build-viral-clip-proposals.js):
// - which upload is a new full episode (not a channel short, not seen before);
// - the approved long-form proposal and its build directive;
// - the reservation ledger: on the CT day a new episode is queued, one of the
//   three daily approval-queue builds belongs to it. Other days are unchanged.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { applyBuildDirective } = require('./viral-clip-build-directive.js');

const MOONSHOTS_CHANNEL_ID = 'UCvxm0qTrGN_1LMYgUaftWyQ';
// The channel's uploads playlist (UC -> UU).
const MOONSHOTS_UPLOADS_PLAYLIST = 'UU' + MOONSHOTS_CHANNEL_ID.slice(2);
// Full episodes run an hour or more; the channel's own shorts run about a
// minute. Anything under 20 minutes is not an episode.
const MIN_EPISODE_SECONDS = 20 * 60;
// Only an episode published in the last few days counts as new, so the first
// run after deploy never builds a back catalog.
const MAX_EPISODE_AGE_DAYS = 4;
const LEDGER_FILE = 'moonshots-highlights-ledger.jsonl';
const RESERVED_SLOTS_PER_NEW_EPISODE = 1;
const THEME = 'narrator-not-in-a-box';

const OWNER_WORDS =
  "Every time there's a new Moonshots podcast (PRIVATE_NAME), do a three-minute highlights of it: the best moments, the most material, important and interesting things said. Use the video clips to capture all the key points of the entire podcast. These are not shorts; make it long format. In long format you can make your animations, drawings and clips a little longer, one to five seconds, even seven depending on how important the animation is.";

// Kept short: the build directive is capped at BUILD_DIRECTIVE_MAX_CHARS.
const LONGFORM_CONTRACT =
  'Contract: format longform, 16:9 1920x1080, 2:45 to 3:15, authentic source clips in episode order across the whole episode, landscape Examplechannel branding, low captions, chapter cards, HD accents held 1 to 7 s, effects receipt format longform, no #Shorts, description cites the full episode.';

function sha12(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

function highlightsProposalId(videoId) {
  return `vtc-${sha12(`moonshots-highlights:${videoId}`)}`;
}

function ctDate(ms = Date.now()) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function parseIsoDuration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function readLedger(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ledgerPathFor(outDir) {
  return path.join(outDir, LEDGER_FILE);
}

// Normalize a YouTube Data API videos.list item.
function episodeFromApiItem(item) {
  if (!item || !item.id || !item.snippet) return null;
  return {
    videoId: String(item.id),
    title: String(item.snippet.title || ''),
    publishedAt: String(item.snippet.publishedAt || ''),
    channelId: String(item.snippet.channelId || ''),
    durationSeconds: parseIsoDuration(item.contentDetails && item.contentDetails.duration),
    audioLanguage: String(item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || ''),
    liveBroadcastContent: String(item.snippet.liveBroadcastContent || 'none'),
  };
}

// Ledger statuses that finish an episode. A lone `reserved` row is not one:
// it means a run died between reserving the slot and creating the build Task,
// so the next run re-queues it (proposal and Task creation are idempotent).
const TERMINAL_LEDGER_STATUSES = new Set(['queued', 'refused_language']);

// The newest fresh full episode the ledger has not finished, or null. Older
// fresh episodes stay eligible when the newest one is already handled.
function pickNewEpisode(episodes, { ledger = [], nowMs = Date.now() } = {}) {
  const seen = new Set(
    ledger
      .filter((r) => r && r.episode_id && TERMINAL_LEDGER_STATUSES.has(String(r.status || '')))
      .map((r) => r.episode_id),
  );
  const fresh = (episodes || [])
    .filter(Boolean)
    .filter((e) => e.channelId === MOONSHOTS_CHANNEL_ID)
    .filter((e) => e.liveBroadcastContent === 'none')
    .filter((e) => Number(e.durationSeconds) >= MIN_EPISODE_SECONDS)
    .filter((e) => {
      const at = Date.parse(e.publishedAt);
      return Number.isFinite(at) && at <= nowMs && nowMs - at <= MAX_EPISODE_AGE_DAYS * 86400000;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return fresh.find((e) => !seen.has(e.videoId)) || null;
}

function isEnglishTag(tag) {
  return /^en(?:-|$)/i.test(String(tag || ''));
}

// Missing YouTube language metadata is unknown, not non-English. The episode
// comes from the pinned Moonshots channel, an English-language show, so it
// passes on that basis and the build session confirms the speech with ASR.
// Only an explicit non-English tag refuses it.
function episodeLanguage(episode) {
  const tag = String((episode && episode.audioLanguage) || '').trim();
  if (!tag) return { english: true, tag: null, source: 'known_channel_default (no YouTube language metadata)' };
  return { english: isEnglishTag(tag), tag, source: 'youtube_data_api.defaultAudioLanguage' };
}

// The approved long-form proposal the dashboard approval queue builds.
function buildHighlightsProposal(episode, { nowMs = Date.now() } = {}) {
  if (!episode || !episode.videoId) throw new Error('buildHighlightsProposal needs an episode');
  const at = new Date(nowMs).toISOString();
  const lang = episodeLanguage(episode);
  const english = lang.english;
  const sourceUrl = `https://www.youtube.com/watch?v=${episode.videoId}`;
  const proposal = {
    id: highlightsProposalId(episode.videoId),
    origin: 'moonshots_highlights',
    kind: 'longform_highlights',
    format: 'longform',
    youtube_format: 'longform',
    source: 'Moonshots with PRIVATE_NAME',
    source_title: episode.title,
    source_url: sourceUrl,
    source_published_at: episode.publishedAt,
    source_duration_seconds: episode.durationSeconds,
    approx_timestamp: `0:00:00-${formatHms(episode.durationSeconds)}`,
    insight: `Moonshots highlights: ${episode.title}`.slice(0, 140),
    short_description: `Three-minute long-form highlights of ${episode.title}`.slice(0, 200),
    target_seconds: 180,
    audio_language: english ? 'en' : lang.tag,
    language_gate: {
      ok: english,
      audio_language: english ? 'en' : lang.tag,
      audio_language_source: lang.source,
      spoken_language: english ? 'en' : null,
      spoken_language_source: 'Moonshots is an English-language show; the build session confirms the speech with ASR',
      rule: 'English-only channel (The owner)',
      checked_at: at,
    },
    status: 'approved',
    approved_at: at,
    approved_by: 'moonshots-highlights-standing-rule (The owner)',
    video_theme: THEME,
    video_theme_selected_at: at,
    video_theme_selected_by: 'moonshots-highlights',
  };
  applyBuildDirective(proposal, `${OWNER_WORDS} ${LONGFORM_CONTRACT}`, { at, source: 'moonshots-highlights' });
  return proposal;
}

function formatHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Slots held for Moonshots on this CT day: one when a new episode's build was
// queued (or is being queued) today, else zero. A queued build keeps its slot
// even if its task later fails: it spent proxy bytes, like any other build.
function moonshotsReservedSlots({ ledger = [], today }) {
  const held = ledger.some(
    (r) => r && r.reserved_day === today && ['reserved', 'queued'].includes(String(r.status || '')),
  );
  return held ? RESERVED_SLOTS_PER_NEW_EPISODE : 0;
}

function reservedSlotsFor(outDir, nowMs = Date.now()) {
  return moonshotsReservedSlots({ ledger: readLedger(ledgerPathFor(outDir)), today: ctDate(nowMs) });
}

module.exports = {
  MOONSHOTS_CHANNEL_ID,
  MOONSHOTS_UPLOADS_PLAYLIST,
  MIN_EPISODE_SECONDS,
  MAX_EPISODE_AGE_DAYS,
  LEDGER_FILE,
  RESERVED_SLOTS_PER_NEW_EPISODE,
  OWNER_WORDS,
  LONGFORM_CONTRACT,
  buildHighlightsProposal,
  ctDate,
  episodeFromApiItem,
  episodeLanguage,
  formatHms,
  highlightsProposalId,
  ledgerPathFor,
  moonshotsReservedSlots,
  parseIsoDuration,
  pickNewEpisode,
  readLedger,
  reservedSlotsFor,
};
