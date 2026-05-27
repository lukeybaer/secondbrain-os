// telegram-context.ts
//
// When Luke sends a Telegram message to Amy, the system must understand what
// context it relates to instead of treating every message as contextless. This
// module is the pure matcher: given an inbound message plus the available
// context sources, it returns the best-guess related context.
//
// Purity contract: matchMessageContext takes ALL sources as arguments and does
// no I/O. The caller (the live dispatch flow) is responsible for loading tasks,
// projects, and recent sessions and passing them in. That keeps this module
// fully unit-testable and free of electron / filesystem coupling.

// -- Inputs --------------------------------------------------------------------

/** The inbound Telegram message, with optional reply context. */
export interface InboundMessage {
  text: string;
  replyToMessageId?: number;
  replyToText?: string;
}

/** A task the message may relate to. Mirrors the Task Spine record shape. */
export interface ContextTask {
  id: string;
  title: string;
  prompt: string;
  status: string;
}

/** A project the message may cite. Mirrors projects.ts Project. */
export interface ContextProject {
  id: string;
  name: string;
}

/** A recent chat/session, summarised, the message may follow up on. */
export interface ContextSession {
  id: string;
  /** A short summary or title for the session. */
  summary: string;
}

/** All context sources, injected so the matcher stays pure. */
export interface ContextSources {
  tasks?: ContextTask[];
  projects?: ContextProject[];
  sessions?: ContextSession[];
}

// -- Output --------------------------------------------------------------------

export type ContextKind = 'task' | 'project' | 'session' | 'none';

export interface MatchedContext {
  kind: ContextKind;
  /** The id of the matched task/project/session, or '' when kind is 'none'. */
  ref: string;
  /** A confidence score in the range 0 to 1. */
  confidence: number;
  /** Human-readable explanation of why this context was chosen. */
  why: string;
}

// -- Helpers -------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'it', 'this',
  'that', 'i', 'you', 'we', 'do', 'did', 'done', 'can', 'will', 'so', 'my',
  'me', 'amy', 'please', 'thanks', 'ok', 'okay', 'yes', 'no', 'how', 'what',
  'when', 'about', 'your', 'just', 'now', 'get', 'got', 'up', 'out',
]);

/** Lowercase word tokens, stopwords and very short words removed. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Fraction of `needle` tokens that appear (partial-word) in `haystack` text. */
function overlap(needle: string[], haystack: string): number {
  if (needle.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let hits = 0;
  for (const t of needle) {
    if (hay.includes(t)) hits++;
  }
  return hits / needle.length;
}

/** True for task statuses that represent in-flight / open work. */
function isInFlight(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'queued' || s === 'running' || s === 'awaiting-review' ||
    s === 'todo' || s === 'in-progress' || s === 'needs-follow-up';
}

// -- Matcher -------------------------------------------------------------------

/**
 * Best-guess the context an inbound Telegram message relates to.
 *
 * Pure: no I/O. Pass the candidate tasks/projects/sessions explicitly.
 *
 * Strategy, highest precedence first:
 *  1. Reply context. If the message is a Telegram reply, match the replied-to
 *     text against tasks/projects/sessions; a reply is a strong signal.
 *  2. Project name citation. Fuzzy, case-insensitive, partial-word.
 *  3. In-flight task title/prompt citation.
 *  4. Recent session keyword overlap.
 * Returns kind:'none' when nothing clears the confidence floor.
 */
export function matchMessageContext(
  message: InboundMessage,
  sources: ContextSources,
): MatchedContext {
  const tasks = sources.tasks ?? [];
  const projects = sources.projects ?? [];
  const sessions = sources.sessions ?? [];

  const none: MatchedContext = {
    kind: 'none',
    ref: '',
    confidence: 0,
    why: 'No task, project, or recent session matched the message.',
  };

  // The text we search with: the message itself, plus the replied-to text when
  // this is a reply (a reply inherits the topic of what it replies to).
  const isReply = typeof message.replyToMessageId === 'number';
  const replyText = message.replyToText ?? '';
  const searchText = isReply ? `${message.text} ${replyText}`.trim() : message.text;
  const searchTokens = tokens(searchText);

  let best: MatchedContext = none;

  const consider = (candidate: MatchedContext): void => {
    if (candidate.confidence > best.confidence) best = candidate;
  };

  // 1. Projects: match the project name against the search text.
  for (const p of projects) {
    const nameTokens = tokens(p.name);
    const score = overlap(nameTokens, searchText);
    if (score > 0) {
      const replyBoost = isReply && replyText && overlap(nameTokens, replyText) > 0 ? 0.15 : 0;
      consider({
        kind: 'project',
        ref: p.id,
        confidence: Math.min(1, score * 0.9 + replyBoost),
        why: `Message references project "${p.name}".`,
      });
    }
  }

  // 2. Tasks: match the title (and prompt) of in-flight tasks.
  for (const t of tasks) {
    const titleTokens = tokens(t.title);
    const titleScore = overlap(titleTokens, searchText);
    const promptScore = overlap(tokens(t.prompt), searchText);
    const score = Math.max(titleScore, promptScore * 0.6);
    if (score > 0) {
      const flightBoost = isInFlight(t.status) ? 0.1 : -0.2;
      const replyBoost = isReply && replyText && overlap(titleTokens, replyText) > 0 ? 0.15 : 0;
      consider({
        kind: 'task',
        ref: t.id,
        confidence: Math.max(0, Math.min(1, score * 0.85 + flightBoost + replyBoost)),
        why: `Message references ${isInFlight(t.status) ? 'in-flight ' : ''}task "${t.title}".`,
      });
    }
  }

  // 3. Sessions: keyword overlap against the session summary.
  for (const s of sessions) {
    const score = overlap(searchTokens, s.summary);
    if (score > 0) {
      const replyBoost = isReply && replyText && overlap(tokens(replyText), s.summary) > 0 ? 0.15 : 0;
      consider({
        kind: 'session',
        ref: s.id,
        confidence: Math.min(1, score * 0.7 + replyBoost),
        why: `Message keywords overlap recent session "${s.summary}".`,
      });
    }
  }

  // Confidence floor: below this the guess is too weak to act on.
  return best.confidence >= 0.34 ? best : none;
}
