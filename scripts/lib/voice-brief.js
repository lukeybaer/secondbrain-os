'use strict';

// Per-call voice brief (2026-10-14 redesign, dev-plans/core/voice-call-stack.md).
// Replaces the 1,800-character MEMORY.md slice and the Graphiti advisor block in
// the owner call prompt. MEMORY.md is written for coding agents; on the phone
// it taught the model to end answers with a TLDR. The brief holds only what a
// call needs right now, from bounded local reads, in at most 2 KB:
// active sessions, open tasks and callbacks, today's headlines, and the next
// day of calendar from the briefing's MEETINGS block.

const MAX_BRIEF_BYTES = 2048;
// Agent-surface trailers that must never reach a voice prompt.
const FORBIDDEN_VOICE_PROMPT_RE = /\bTLDR\b|Graphiti impact|adversarial review/i;

function clean(text, max = 110) {
  const value = String(text || '')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trim()}...` : value;
}

function ageLabel(iso, nowMs) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return '';
  const minutes = Math.max(0, Math.round((nowMs - ts) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function centralDayLabel(date) {
  // "Thu, Oct 15", the briefing MEETINGS day header format.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('weekday')}, ${get('month')} ${get('day')}`;
}

// Calendar items for today and tomorrow (Central) from the briefing text.
function nextDayMeetings(briefingText, now = new Date()) {
  const text = String(briefingText || '');
  const start = text.search(/^MEETINGS:\s*$/m);
  if (start < 0) return [];
  const rest = text.slice(start).split(/\r?\n/).slice(1);
  const wanted = new Set([centralDayLabel(now), centralDayLabel(new Date(now.getTime() + 864e5))]);
  const out = [];
  let day = '';
  for (const line of rest) {
    if (/^---/.test(line) || /^[A-Z][A-Z &/-]+:\s*$/.test(line)) break;
    const header = line.match(/^([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}):\s*$/);
    if (header) {
      day = header[1];
      continue;
    }
    const item = line.match(/^\s*\d+\.\s+(.+)$/);
    if (item && wanted.has(day)) out.push(`${day}: ${clean(item[1], 90)}`);
  }
  return out;
}

function headlineList(sections = [], limit = 5) {
  const titles = [];
  // First article of each section, then second articles, until the limit.
  for (let round = 0; titles.length < limit && round < 3; round += 1) {
    for (const section of sections) {
      const article = section && Array.isArray(section.articles) ? section.articles[round] : null;
      if (article && article.title && titles.length < limit) titles.push(clean(article.title, 100));
    }
  }
  return titles;
}

function buildVoiceBrief({
  sessions = [],
  activeTasks = [],
  newsSections = [],
  briefingText = '',
  now = new Date(),
  maxBytes = MAX_BRIEF_BYTES,
} = {}) {
  const nowMs = now.getTime();
  const blocks = [];
  const sessionLines = sessions
    .filter((s) => s && s.title && !/^(?:done|completed|failed|cancel)/i.test(String(s.status || '')))
    .slice(0, 4)
    .map((s) => {
      const meta = [s.liveness || s.status, ageLabel(s.updatedAt || s.lastObservedAt, nowMs)].filter(Boolean).join(', ');
      return `- ${clean(s.title)}${meta ? ` (${meta})` : ''}`;
    });
  if (sessionLines.length) blocks.push(['Active sessions:', ...sessionLines].join('\n'));
  const taskLines = activeTasks
    .filter((t) => t && t.title)
    .slice(0, 4)
    .map((t) => {
      const age = Number.isFinite(Number(t.ageHours)) ? `${Math.round(Number(t.ageHours))}h old` : '';
      const meta = [t.status, age].filter(Boolean).join(', ');
      return `- ${clean(t.title)}${meta ? ` (${meta})` : ''}`;
    });
  if (taskLines.length) blocks.push(['Open tasks and callbacks:', ...taskLines].join('\n'));
  const headlines = headlineList(newsSections);
  if (headlines.length) blocks.push(["Today's briefing headlines:", ...headlines.map((h) => `- ${h}`)].join('\n'));
  const meetings = nextDayMeetings(briefingText, now);
  blocks.push(['Calendar, today and tomorrow:', ...(meetings.length ? meetings.map((m) => `- ${m}`) : ['- Nothing scheduled in the briefing calendar snapshot.'])].join('\n'));

  const lines = ['## Voice Brief', ...blocks.join('\n\n').split('\n')]
    .filter((line) => !FORBIDDEN_VOICE_PROMPT_RE.test(line));
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) break;
    out.push(line);
    bytes += size;
  }
  return out.join('\n').trim();
}

// Last line of defense for any voice prompt: drop lines that carry agent
// trailers (TLDR, Graphiti impact, adversarial review).
function sanitizeVoicePrompt(prompt) {
  return String(prompt || '')
    .split('\n')
    .filter((line) => !FORBIDDEN_VOICE_PROMPT_RE.test(line))
    .join('\n');
}

module.exports = {
  MAX_BRIEF_BYTES,
  FORBIDDEN_VOICE_PROMPT_RE,
  buildVoiceBrief,
  nextDayMeetings,
  sanitizeVoicePrompt,
};
