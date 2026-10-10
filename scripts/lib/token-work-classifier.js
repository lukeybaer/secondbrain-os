'use strict';

// Deterministic, model-free fallback for sessions the legacy keyword rules in
// token-spend-weekly.js projectTag() leave as "Unclassified work". It only
// runs after those rules miss, so no currently classified session moves.
// Signal order: stable runner markers, repository, opening request, owner
// hashtag command, session title, loaded skill, later owner prompts,
// worktree name, then the parent session for helpers.

const SCHEDULED_PACKET_RE = /=== AMY SCHEDULED JOB PACKET V1 ===\s*Job:\s*([a-z0-9-]+)/i;
const PROBE_RE =
  /^\s*(?:Reply with exactly\b|Say exactly\b|Use the Bash tool to run: echo tool-ok)|amy-canary-[0-9a-f]+|[a-z0-9-]+-probe\.[a-z]+\b|(.{12,80}?\.)\s(?:\1\s){3}/i;
const PROBE_MAX_CHARS = 2000;
const REPO_RULES = [
  [/ExampleCo/i, 'ExampleCo'],
  [/client-?app/i, 'Client App'],
  [/ngcv/i, 'NGCV finder'],
];
const CONTENT_RULES = [
  [/token.*(?:spend|usage)|subscription.*cap/i, 'Token spend controls'],
  [/AMY_CALL_ID|VOICE RESPONSE MODE|\bvapi\b/i, 'Voice / phone calls'],
  [/These are news articles for PRIVATE_NAME/i, 'Briefing pipeline'],
  [/Score each word for emphasis|\bcaptions?\b|\bthumbnails?\b|\bshorts\b|\bvideos?\b/i, 'Video production'],
  [/venture ?app/i, 'Venture App'],
  [/linkedin/i, 'LinkedIn'],
  [/client ?app/i, 'Client App'],
  [/ExampleCo|seat.detection/i, 'ExampleCo'],
  [/\blaws?\b|\bgravity\b|constitution|memory file|MEMORY\.md/i, 'Amy memory and governance'],
  [/people file|\bspeakers?\b|voiceprint|\bvoice\b|recluster|otter|transcript/i, 'Otter transcript pipeline'],
  [/Signal messages|people-memory|\bcontacts?\b/i, 'People and contacts'],
  [/\b(?:opus|sonnet|haiku)\b|model rout|claude cli/i, 'Model routing and runtime'],
];
const COMMAND_RULES = {
  otter: 'Otter transcript pipeline',
  learn: 'Amy memory and governance',
  gap: 'Amy memory and governance',
  ppl: 'People and contacts',
  'ppl-audit': 'People and contacts',
  inbox: 'Email',
  mail: 'Email',
};
// Reply-format commands say how to answer, not what the work is.
const FORMAT_COMMANDS = new Set(['h', 'r']);
const SKILL_RULES = [
  [/linkedin/i, 'LinkedIn'],
  [/video-production/i, 'Video production'],
  [/general-calling/i, 'Voice / phone calls'],
  [/stadium|ExampleCo/i, 'ExampleCo'],
];
const UNCLASSIFIED = 'Unclassified work';

const first = (rules, text) => (text ? rules.find(([re]) => re.test(String(text)))?.[1] : undefined);

// Only known work commands are kept, so a leading hashtag that is a name or
// any other free text never persists in a token receipt.
function ownerCommand(text) {
  const tag = String(text || '').trim().match(/^#([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase();
  return tag && !FORMAT_COMMANDS.has(tag) && Object.hasOwn(COMMAND_RULES, tag) ? tag : '';
}

function skillFromMetaPrompt(text) {
  return (
    String(text || '').match(/^Base directory for this skill:\s*\S*?[\\/]skills[\\/]([a-z0-9-]+)/i)?.[1]?.toLowerCase() || ''
  );
}

// Classify the bounded later-prompt digest at collection time so raw owner
// text beyond the first prompt is never persisted in token receipts.
function classifyText(text) {
  return first(CONTENT_RULES, text) || '';
}

function refineUnclassified(meta = {}, { parentProject = '' } = {}) {
  const prompt = String(meta.prompt || '');
  const lane = meta.parentSessionId ? 'helper' : 'session';
  const job = prompt.match(SCHEDULED_PACKET_RE)?.[1];
  if (job) return { project: `Scheduled: ${job.toLowerCase()}`, lane: 'automation', via: 'scheduled-packet' };
  // Probes are short machine prompts. A long interactive prompt that merely
  // mentions a probe file or pastes a repeated log line is not one, and the
  // bound keeps the repeated-sentence pattern cheap on 64 KB prompts.
  if (prompt.length <= PROBE_MAX_CHARS && PROBE_RE.test(prompt)) {
    return { project: 'Health checks and model probes', lane: 'automation', via: 'probe' };
  }
  const cwd = String(meta.cwd || '');
  const hit = (project, via) => (project ? { project, lane, via } : null);
  const bare = prompt.trim().match(/^#([a-z][a-z0-9-]*)$/i)?.[1]?.toLowerCase();
  const worktree = cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || '';
  return (
    hit(first(REPO_RULES, cwd), 'cwd-repo') ||
    hit(first(CONTENT_RULES, prompt.slice(0, 6000)), 'first-prompt') ||
    hit(COMMAND_RULES[bare], 'owner-command') ||
    hit(meta.titleClass || first(CONTENT_RULES, meta.title), 'session-title') ||
    hit((meta.skills || []).map((s) => first(SKILL_RULES, s)).find(Boolean), 'skill-load') ||
    hit(meta.laterPromptClass, 'later-prompts') ||
    hit((meta.ownerCommands || []).map((c) => COMMAND_RULES[c]).find(Boolean), 'owner-command') ||
    hit(/[\\/]sb-sessions[\\/]/i.test(cwd) ? first(CONTENT_RULES, worktree.replace(/-/g, ' ')) : '', 'worktree-name') ||
    hit(parentProject && parentProject !== UNCLASSIFIED ? parentProject : '', 'parent-session') || {
      project: UNCLASSIFIED,
      lane,
      via: 'none',
    }
  );
}

module.exports = {
  SCHEDULED_PACKET_RE,
  PROBE_RE,
  UNCLASSIFIED,
  classifyText,
  ownerCommand,
  skillFromMetaPrompt,
  refineUnclassified,
};
