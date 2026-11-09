/**
 * Desktop X post queue (content-review/social-posts/queue.json): the state
 * machine and every write to the file.
 *
 * State machine audit finding #3 (owner decision): Publish ignored status, so
 * a trashed, rejected or already-posted row could be tweeted; Approve revived
 * any status; and the scheduler wrote a stale whole-queue copy back after its
 * network call, so a double click or a scheduler tick could post twice and
 * silently erase newer edits.
 *
 * Rules enforced here:
 *  - Only an `approved` post can be published.
 *  - Before the network call the row moves approved -> `posting` under a file
 *    lock (compare-and-set on the file as it is right now), so a second click
 *    or the scheduler sees `posting` and refuses.
 *  - After the call the row becomes `posted`, `failed` (X refused it, safe to
 *    retry by approving again) or `held` (the tweet may have gone out; a person
 *    must check X). Nothing re-posts `posting`, `failed` or `held` on its own.
 *  - A `posting` row nobody is working on (crash, timeout) is swept to `held`.
 *  - A publish call that does not answer within the deadline is parked as
 *    `held` (the tweet may be live) and its local claim is dropped.
 *  - Every publish attempt gets an id, stored on the row (`publish_attempts`)
 *    before the call and kept when a person approves the row again. A late
 *    SUCCESS from any attempt wins, whatever the row's status now: the tweet is
 *    live, so the id is recorded, the row becomes `posted`, and nothing can
 *    publish a row that has a `tweet_id`. A late FAILURE only counts for the
 *    newest attempt, so an old attempt never settles a newer one.
 *  - Every write re-reads the file under the lock and changes only its own
 *    row, so a slow network call never replaces newer data with a stale copy.
 */

import * as fs from 'fs';
import { createRequire } from 'module';
import type { TweetResult } from './x-publisher';

// ledger-state-machine.js is the shared CJS helper (legal moves, locked JSON
// writes). createRequire keeps electron-vite from rebundling it; the relative
// path resolves from src/main in tests and out/main in the build.
const cjsRequire = createRequire(import.meta.url);

interface StateMachine {
  normalize(value: unknown): string;
  canTransition(from: unknown, to: unknown): boolean;
  isExpired(state: unknown, since: string | number | undefined, now?: number): boolean;
}

const ledger = cjsRequire('../../scripts/lib/ledger-state-machine.js') as {
  defineStateMachine(spec: {
    name: string;
    transitions: Record<string, string[]>;
    terminal?: string[];
    aliases?: Record<string, string>;
    inFlight?: Record<string, { ttlMs?: number; maxAttempts?: number }>;
  }): StateMachine;
  updateJsonLocked: {
    (
      file: string,
      mutate: (current: any) => unknown,
      opts?: { fallback?: unknown },
    ): unknown;
    SKIP: symbol;
  };
};

// ── State machine ────────────────────────────────────────────────────────────

/** How long a row may sit in `posting` with nobody working on it. */
export const POSTING_TTL_MS = 2 * 60 * 1000;

/** How long one publish call may take before the row is parked as `held`. */
export const PUBLISH_DEADLINE_MS = 60 * 1000;

export const socialPostMachine = ledger.defineStateMachine({
  name: 'social-post',
  transitions: {
    // A new row is born pending; anything else would skip the approval gate.
    '': ['pending_approval'],
    pending_approval: ['approved', 'rejected', 'trashed'],
    // `posted` from approved or failed is a late success of an older attempt.
    approved: ['posting', 'posted', 'rejected', 'trashed'],
    // In flight: only the publisher that claimed it (or the sweep) moves it.
    posting: ['posted', 'failed', 'held'],
    // X refused the post; approving again is the explicit retry.
    failed: ['approved', 'posted', 'rejected', 'trashed'],
    // The tweet may be live. `posted` records a late success; `approved` is a
    // person's decision after checking X.
    held: ['posted', 'approved', 'rejected', 'trashed'],
    rejected: ['trashed'],
  },
  terminal: ['posted', 'trashed'],
  // Old spellings still in queue.json.
  aliases: { draft: 'pending_approval', pending: 'pending_approval' },
  inFlight: { posting: { ttlMs: POSTING_TTL_MS } },
});

export type SocialFailureCode =
  | 'NOT_FOUND'
  | 'ILLEGAL_STATE'
  | 'UNSUPPORTED'
  | 'NOT_DUE'
  | 'INVALID'
  | 'PUBLISH_FAILED';

export interface SocialFailure {
  success: false;
  error: string;
  code: SocialFailureCode;
}

export type SocialOk = { success: true; post: any };

export function statusOf(post: any): string {
  return socialPostMachine.normalize(post?.status);
}

const ACTION: Record<string, string> = {
  approved: 'approve',
  posting: 'publish',
  rejected: 'reject',
  trashed: 'trash',
  posted: 'mark as posted',
  pending_approval: 'create',
};

const WHY: Record<string, string> = {
  pending_approval: 'it has not been approved yet',
  approved: 'it is already approved',
  posting: 'a publish is already in progress for it',
  posted: 'it is already on X',
  failed: 'the last publish failed, so approve it again to retry',
  held: 'it is held for review and may already be on X, so check X first and then approve it again',
  rejected: 'it was rejected',
  trashed: 'it is in the trash',
};

function refusal(post: any, to: string): SocialFailure {
  const from = statusOf(post);
  const why = WHY[from] ?? `its status is "${String(post?.status ?? '')}"`;
  return {
    success: false,
    code: 'ILLEGAL_STATE',
    error: `Cannot ${ACTION[to] ?? to} this post: ${why}.`,
  };
}

const notFound = (): SocialFailure => ({ success: false, code: 'NOT_FOUND', error: 'Post not found' });

// ── Locked file access ───────────────────────────────────────────────────────

/** Lenient read for display: a missing or unreadable file shows as empty. */
export function readSocialQueue(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Locked read-modify-write. The file is re-read under the lock, so `fn` always
 * sees the current rows. An unreadable file throws instead of being treated as
 * empty, because rewriting it would erase every row. `fn` must be synchronous
 * and return `write: false` when it changed nothing.
 */
function mutateQueue<T>(file: string, fn: (queue: any[]) => { out: T; write: boolean }): T {
  let out!: T;
  ledger.updateJsonLocked(
    file,
    (queue: unknown) => {
      if (!Array.isArray(queue)) throw new Error('social queue is not an array, refusing to rewrite it');
      const r = fn(queue);
      out = r.out;
      return r.write ? queue : ledger.updateJsonLocked.SKIP;
    },
    { fallback: [] },
  );
  return out;
}

const findPost = (queue: any[], id: string) => queue.find((p) => p?.id === id);

/** A recorded external post id: the tweet exists, so nothing may publish this row again. */
const hasPostedId = (post: any): boolean => Boolean(post?.tweet_id);

// ── Publish attempts ─────────────────────────────────────────────────────────

type AttemptOutcome = 'in_flight' | 'posted' | 'failed' | 'unknown';

interface PublishAttempt {
  id: string;
  started_at: string;
  outcome: AttemptOutcome;
  tweet_id?: string;
}

/** Older attempts stay on the row (an unknown one may still land); only the oldest fall off. */
const MAX_ATTEMPT_HISTORY = 20;

const attemptsOf = (post: any): PublishAttempt[] => (Array.isArray(post?.publish_attempts) ? post.publish_attempts : []);

/** The newest attempt: the only one whose failure may settle the row. */
function currentAttemptId(post: any): string | undefined {
  const attempts = attemptsOf(post);
  return attempts[attempts.length - 1]?.id;
}

/** Record how one attempt ended, on its own history entry only. A success is never downgraded. */
function markAttempt(post: any, attemptId: string, outcome: AttemptOutcome, tweetId?: string): void {
  const entry = attemptsOf(post).find((a) => a?.id === attemptId);
  if (!entry || entry.outcome === 'posted') return;
  entry.outcome = outcome;
  if (tweetId) entry.tweet_id = tweetId;
}

// ── Single-row operations ────────────────────────────────────────────────────

export function createSocialDraft(
  file: string,
  input: any,
  now: Date = new Date(),
): SocialOk | SocialFailure {
  const status = socialPostMachine.normalize(input?.status || 'pending_approval');
  if (!socialPostMachine.canTransition('', status)) {
    return {
      success: false,
      code: 'ILLEGAL_STATE',
      error: `A new post must start as pending_approval, not "${String(input?.status)}".`,
    };
  }
  return mutateQueue<SocialOk | SocialFailure>(file, (queue) => {
    const id = input?.id || `post_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    if (findPost(queue, id)) {
      return { out: { success: false, code: 'INVALID', error: `Post id ${id} already exists` }, write: false };
    }
    const entry = {
      id,
      platform: input?.platform || 'x',
      status,
      content: input?.content || '',
      source_idea: input?.source_idea || '',
      media_paths: input?.media_paths || [],
      created_at: now.toISOString(),
    };
    queue.push(entry);
    return { out: { success: true, post: entry }, write: true };
  });
}

function transition(
  file: string,
  id: string,
  to: string,
  apply?: (post: any) => void,
): SocialOk | SocialFailure {
  return mutateQueue<SocialOk | SocialFailure>(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: notFound(), write: false };
    if (!socialPostMachine.canTransition(post.status, to)) {
      return { out: refusal(post, to), write: false };
    }
    post.status = to;
    apply?.(post);
    return { out: { success: true, post }, write: true };
  });
}

export function approveSocialPost(
  file: string,
  id: string,
  scheduledFor?: string,
  now: Date = new Date(),
): SocialOk | SocialFailure {
  if (scheduledFor && !Number.isFinite(Date.parse(scheduledFor))) {
    return { success: false, code: 'INVALID', error: 'scheduledFor is not a valid date' };
  }
  return mutateQueue<SocialOk | SocialFailure>(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: notFound(), write: false };
    const from = statusOf(post);
    // A tweet id means the post is on X, whatever the status says.
    if (hasPostedId(post)) return { out: refusal({ status: 'posted' }, 'approved'), write: false };
    // Approving an approved post again only moves its schedule.
    if (from !== 'approved' && !socialPostMachine.canTransition(from, 'approved')) {
      return { out: refusal(post, 'approved'), write: false };
    }
    post.status = 'approved';
    post.approved_at = now.toISOString();
    if (scheduledFor) post.scheduled_for = scheduledFor;
    delete post.last_error;
    delete post.held_reason;
    delete post.late_result;
    delete post.posting_started_at;
    return { out: { success: true, post }, write: true };
  });
}

/** A blank note trashes the post; a note rejects it and keeps the note. */
export function rejectSocialPost(file: string, id: string, note?: string): SocialOk | SocialFailure {
  return transition(file, id, note ? 'rejected' : 'trashed', (post) => {
    if (note) post.rejection_note = note;
  });
}

export function trashSocialPost(file: string, id: string): SocialOk | SocialFailure {
  return transition(file, id, 'trashed');
}

export function editSocialPost(file: string, id: string, content: string): SocialOk | SocialFailure {
  return mutateQueue<SocialOk | SocialFailure>(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: notFound(), write: false };
    const from = statusOf(post);
    // The text of a post that is going out or is out must stay what was sent.
    if (from === 'posting' || from === 'posted' || from === 'trashed') {
      return {
        out: { success: false, code: 'ILLEGAL_STATE', error: `Cannot edit this post: ${WHY[from]}.` },
        write: false,
      };
    }
    post.content = content;
    return { out: { success: true, post }, write: true };
  });
}

/** Engagement refresh touches only the engagement field of its own row. */
export function recordSocialEngagement(file: string, id: string, engagement: unknown): boolean {
  return mutateQueue(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: false, write: false };
    post.engagement = engagement;
    return { out: true, write: true };
  });
}

// ── Publishing ───────────────────────────────────────────────────────────────

export type PublishFn = (text: string) => Promise<TweetResult>;

export interface PublishDeps {
  publish: PublishFn;
  /** Runs after the cheap status check and before the claim; may throw to stop. */
  beforePublish?: (post: any) => Promise<void>;
  /** Scheduler mode: refuse unless the row's scheduled_for has arrived. */
  requireDue?: boolean;
  /** Longest a publish call may run before the row is held. Defaults to PUBLISH_DEADLINE_MS. */
  publishTimeoutMs?: number;
  now?: () => Date;
}

export type PublishOutcome =
  | { success: true; postUrl?: string; tweetId?: string }
  | SocialFailure;

// Ids this process is publishing right now. The sweep must not touch these
// while the call is inside its deadline; the deadline releases them.
const inFlightIds = new Set<string>();
const TIMED_OUT = Symbol('publish.timedOut');

function isDue(post: any, now: Date): boolean {
  const t = Date.parse(post?.scheduled_for ?? '');
  return Number.isFinite(t) && t <= now.getTime();
}

/** Only an approved X post may be published. Returns the refusal or null. */
function publishRefusal(post: any, requireDue: boolean, now: Date): SocialFailure | null {
  if (post.platform !== 'x') {
    return { success: false, code: 'UNSUPPORTED', error: `Publishing to ${post.platform} not yet supported` };
  }
  // A recorded tweet id wins over the status: the post is live, never publish it twice.
  if (hasPostedId(post)) return refusal({ status: 'posted' }, 'posting');
  if (!socialPostMachine.canTransition(post.status, 'posting')) return refusal(post, 'posting');
  if (requireDue && !isDue(post, now)) {
    return { success: false, code: 'NOT_DUE', error: 'This post is not scheduled for now.' };
  }
  return null;
}

/**
 * Move approved -> posting under the lock. This is the compare-and-set that
 * makes two clicks, or a click and the scheduler, post once: the second caller
 * finds `posting` and is refused. It also re-reads the row for a tweet id, so a
 * late success recorded since the caller last looked blocks this attempt. The
 * attempt gets its id here, on the row, before the call; older attempts stay.
 */
function claimForPublish(
  file: string,
  id: string,
  requireDue: boolean,
  now: Date,
): { success: true; content: string; attemptId: string } | SocialFailure {
  return mutateQueue<{ success: true; content: string; attemptId: string } | SocialFailure>(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: notFound(), write: false };
    const refused = publishRefusal(post, requireDue, now);
    if (refused) return { out: refused, write: false };
    const count = Number(post.posting_attempts || 0) + 1;
    const attemptId = `a${count}-${Math.random().toString(36).slice(2, 8)}`;
    post.status = 'posting';
    post.posting_started_at = now.toISOString();
    post.posting_attempts = count;
    post.publish_attempts = [
      ...attemptsOf(post),
      { id: attemptId, started_at: now.toISOString(), outcome: 'in_flight' as AttemptOutcome },
    ].slice(-MAX_ATTEMPT_HISTORY);
    delete post.last_error;
    delete post.held_reason;
    delete post.late_result;
    return { out: { success: true, content: String(post.content ?? ''), attemptId }, write: true };
  });
}

/**
 * A confirmed success, from any attempt, on a row in any status. The tweet is
 * live, so its id is recorded and the row becomes `posted` wherever the machine
 * allows it. A status a person chose (rejected, trashed) is kept, but the id is
 * still recorded and the row can never publish again. A second success on a row
 * that already has a different id is a duplicate tweet: the first id stays and
 * the extra one is noted.
 */
function applySuccess(post: any, id: string, attemptId: string, result: TweetResult, now: Date): void {
  const from = statusOf(post);
  const tweetId = result.tweetId ? String(result.tweetId) : '';
  markAttempt(post, attemptId, 'posted', tweetId);
  delete post.posting_started_at;
  delete post.last_error;
  delete post.held_reason;
  delete post.late_result;
  if (hasPostedId(post) && tweetId && String(post.tweet_id) !== tweetId) {
    const extra: string[] = Array.isArray(post.duplicate_tweet_ids) ? post.duplicate_tweet_ids : [];
    if (!extra.includes(tweetId)) post.duplicate_tweet_ids = [...extra, tweetId];
    console.error(`[social] a second tweet ${tweetId} went out for ${id}; keeping ${post.tweet_id} as its tweet id`);
    return;
  }
  if (socialPostMachine.canTransition(from, 'posted')) {
    post.status = 'posted';
  } else if (from !== 'posted') {
    console.error(`[social] tweet ${tweetId || 'n/a'} went out but ${id} is ${from}; recording it without a status change`);
  }
  if (!post.posted_at) post.posted_at = now.toISOString();
  if (result.postUrl) post.post_url = result.postUrl;
  if (tweetId) post.tweet_id = tweetId;
}

/**
 * Record how one attempt ended, on this row only. A success always counts. A
 * failure settles the row only for the newest attempt and only while the row is
 * still `posting`; an older attempt just updates its own history entry.
 */
function finishPublish(file: string, id: string, attemptId: string, result: TweetResult, now: Date): void {
  mutateQueue(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) {
      console.error(`[social] publish finished for ${id} but the row is gone (tweet ${result.tweetId ?? 'n/a'})`);
      return { out: undefined, write: false };
    }
    if (result.success) {
      applySuccess(post, id, attemptId, result, now);
      return { out: undefined, write: true };
    }
    markAttempt(post, attemptId, result.ambiguous ? 'unknown' : 'failed');
    // A failed call only settles a row that is still ours to settle.
    if (statusOf(post) !== 'posting' || currentAttemptId(post) !== attemptId) return { out: undefined, write: true };
    delete post.posting_started_at;
    if (result.ambiguous) {
      post.status = 'held';
      post.held_reason = `The call to X did not finish cleanly (${result.error ?? 'unknown error'}); the tweet may be live. Check X before approving again.`;
    } else {
      post.status = 'failed';
      post.last_error = result.error ?? 'Publish failed';
    }
    return { out: undefined, write: true };
  });
}

/** The call outlived its deadline: park the row as held. Only this attempt's own `posting` row is ours to park. */
function holdTimedOutPublish(file: string, id: string, attemptId: string, timeoutMs: number): void {
  mutateQueue(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: undefined, write: false };
    markAttempt(post, attemptId, 'unknown');
    if (statusOf(post) !== 'posting' || currentAttemptId(post) !== attemptId) return { out: undefined, write: true };
    post.status = 'held';
    post.held_reason = `The call to X did not answer within ${Math.round(timeoutMs / 1000)}s; the tweet may be live. Check X before approving again.`;
    delete post.posting_started_at;
    return { out: undefined, write: true };
  });
}

/**
 * An answer that arrived after the deadline. A success is the same fact it
 * always is (the tweet is live), so it is recorded like any other, whichever
 * attempt it belongs to. A failure changes no status: it is only noted on a row
 * that is still held by that same attempt.
 */
function recordLateResult(file: string, id: string, attemptId: string, result: TweetResult, now: Date): void {
  if (result.success) {
    finishPublish(file, id, attemptId, result, now);
    return;
  }
  mutateQueue(file, (queue) => {
    const post = findPost(queue, id);
    if (!post) return { out: undefined, write: false };
    markAttempt(post, attemptId, result.ambiguous ? 'unknown' : 'failed');
    if (statusOf(post) === 'held' && currentAttemptId(post) === attemptId) {
      post.late_result = {
        at: now.toISOString(),
        attempt_id: attemptId,
        error: result.error ?? 'Publish failed',
        ambiguous: result.ambiguous === true,
      };
    }
    return { out: undefined, write: true };
  });
}

/**
 * The one publish path for the Publish button and the scheduler. Refuses any
 * post that is not approved, claims it, calls X once, records the result.
 */
export async function publishSocialPost(
  file: string,
  id: string,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  const clock = deps.now ?? (() => new Date());
  const requireDue = deps.requireDue === true;

  // Cheap early refusal so a bad click gets its reason before any slow work.
  const early = findPost(readSocialQueue(file), id);
  if (!early) return notFound();
  const refused = publishRefusal(early, requireDue, clock());
  if (refused) return refused;

  if (deps.beforePublish) await deps.beforePublish(early);

  // The definitive check: re-read and claim under the lock.
  const claim = claimForPublish(file, id, requireDue, clock());
  if (!claim.success) return claim;

  // The claim above was the last look at the row before the call: it ran under
  // the lock, refused a recorded tweet id, and nothing awaits between it and the call.
  const attemptId = claim.attemptId;
  inFlightIds.add(id);
  const timeoutMs = deps.publishTimeoutMs ?? PUBLISH_DEADLINE_MS;
  // Never rejects: a throw may come after the request left, so it is ambiguous.
  const attempt: Promise<TweetResult> = (async () => {
    try {
      return await deps.publish(claim.content);
    } catch (e: unknown) {
      return { success: false, ambiguous: true, error: e instanceof Error ? e.message : String(e) } as TweetResult;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const raced = await Promise.race([attempt, deadline]);
  clearTimeout(timer);

  if (raced === TIMED_OUT) {
    // Hold first, then drop the local claim, so the row is never `posting` and
    // unprotected. If the hold cannot be written the sweep holds it after its TTL.
    try {
      holdTimedOutPublish(file, id, attemptId, timeoutMs);
    } catch (e: unknown) {
      console.error(`[social] could not hold the timed-out publish for ${id}:`, e instanceof Error ? e.message : e);
    } finally {
      inFlightIds.delete(id);
    }
    void attempt.then((late) => {
      try {
        recordLateResult(file, id, attemptId, late, clock());
      } catch (e: unknown) {
        console.error(`[social] could not record the late publish result for ${id}:`, e instanceof Error ? e.message : e);
      }
    });
    return {
      success: false,
      code: 'PUBLISH_FAILED',
      error: `The call to X did not answer within ${Math.round(timeoutMs / 1000)}s. The post is held for review and may already be live, so check X before trying again.`,
    };
  }
  const result: TweetResult = raced;

  try {
    finishPublish(file, id, attemptId, result, clock());
  } catch (e: unknown) {
    // Row stays `posting`; the sweep will hold it. It is never re-posted.
    console.error(`[social] could not record the publish result for ${id}:`, e instanceof Error ? e.message : e);
  } finally {
    inFlightIds.delete(id);
  }

  if (result.success) return { success: true, postUrl: result.postUrl, tweetId: result.tweetId };
  const detail = result.error ?? 'Publish failed';
  return {
    success: false,
    code: 'PUBLISH_FAILED',
    error: result.ambiguous
      ? `The call to X did not finish cleanly (${detail}). The post is held for review and may already be live, so check X before trying again.`
      : detail,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Hold every `posting` row that nobody is working on and that has outlasted its
 * TTL (the app crashed or the call timed out mid-flight). Held rows are never
 * re-posted; a person checks X and decides. Returns the ids moved.
 */
export function sweepStuckPosting(file: string, now: Date = new Date()): string[] {
  if (!fs.existsSync(file)) return [];
  return mutateQueue(file, (queue) => {
    const moved: string[] = [];
    for (const post of queue) {
      if (statusOf(post) !== 'posting' || inFlightIds.has(post.id)) continue;
      if (!socialPostMachine.isExpired('posting', post.posting_started_at, now.getTime())) continue;
      markAttempt(post, currentAttemptId(post) ?? '', 'unknown');
      post.status = 'held';
      post.held_reason =
        'Stuck in posting (the app stopped or the call timed out); the tweet may be live. Check X before approving again.';
      delete post.posting_started_at;
      moved.push(post.id);
    }
    return { out: moved, write: moved.length > 0 };
  });
}

/**
 * One scheduler pass: sweep stuck rows, then publish each approved X post whose
 * scheduled_for has arrived. Each post goes through publishSocialPost, so the
 * file is never rewritten from a copy read before the network call.
 */
export async function runScheduledSocialPublish(
  file: string,
  deps: { publish: PublishFn; publishTimeoutMs?: number; now?: () => Date },
): Promise<{ swept: string[]; attempted: string[] }> {
  const clock = deps.now ?? (() => new Date());
  const result = { swept: [] as string[], attempted: [] as string[] };
  if (!fs.existsSync(file)) return result;

  result.swept = sweepStuckPosting(file, clock());

  const dueIds = readSocialQueue(file)
    .filter(
      (p) =>
        p?.platform === 'x' && statusOf(p) === 'approved' && !hasPostedId(p) && isDue(p, clock()),
    )
    .map((p) => p.id as string);

  for (const id of dueIds) {
    result.attempted.push(id);
    const outcome = await publishSocialPost(file, id, {
      publish: deps.publish,
      publishTimeoutMs: deps.publishTimeoutMs,
      requireDue: true,
      now: deps.now,
    });
    if (outcome.success) console.log(`[scheduler] Published scheduled social post ${id} to X`);
    else console.error(`[scheduler] Did not publish ${id}: ${outcome.error}`);
  }
  return result;
}
