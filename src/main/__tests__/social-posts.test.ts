import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  approvePost,
  clearSchedule,
  createDraft,
  editPost,
  exportPost,
  getPosts,
  getSocialPostPaths,
  publishDueScheduledSocialPosts,
  publishPost,
  readSocialQueue,
  rejectPost,
  schedulePost,
  setActiveVariant,
} from '../social-posts';

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'));
  fs.mkdirSync(getSocialPostPaths(testRoot).socialDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('Social Posts domain logic', () => {
  it('creates a draft with variants, active variant, and history', () => {
    const result = createDraft(testRoot, {
      content: 'AI is transforming how we work.',
      platform: 'x',
    });

    expect(result.success).toBe(true);
    expect(result.post?.status).toBe('pending_approval');
    expect(result.post?.variants).toHaveLength(1);
    expect(result.post?.active_variant_id).toBe(result.post?.variants[0].id);
    expect(result.post?.history[0].type).toBe('create');
  });

  it('edits by creating a new active variant and preserving the old variant', () => {
    const { post } = createDraft(testRoot, { content: 'Original text' });
    const originalVariantId = post!.active_variant_id;

    const edited = editPost(testRoot, post!.id, 'Edited text with more detail');
    const queue = readSocialQueue(testRoot);

    expect(edited.success).toBe(true);
    expect(queue[0].content).toBe('Edited text with more detail');
    expect(queue[0].variants).toHaveLength(2);
    expect(queue[0].active_variant_id).not.toBe(originalVariantId);
    expect(queue[0].variants.find((variant) => variant.id === originalVariantId)?.content).toBe(
      'Original text',
    );
  });

  it('switches the active variant before approval', () => {
    const { post } = createDraft(testRoot, { content: 'Original text' });
    editPost(testRoot, post!.id, 'Edited text');
    const oldVariantId = readSocialQueue(testRoot)[0].variants[0].id;

    const result = setActiveVariant(testRoot, post!.id, oldVariantId);

    expect(result.success).toBe(true);
    expect(readSocialQueue(testRoot)[0].content).toBe('Original text');
  });

  it('approves immediately and records approval history', () => {
    const { post } = createDraft(testRoot, { content: 'Test post' });

    approvePost(testRoot, post!.id);
    const updated = readSocialQueue(testRoot)[0];

    expect(updated.status).toBe('approved');
    expect(updated.approved_at).toBeDefined();
    expect(updated.history.some((entry) => entry.type === 'approve')).toBe(true);
  });

  it('approves with a schedule and stores scheduled_for', () => {
    const { post } = createDraft(testRoot, { content: 'Scheduled post' });
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();

    approvePost(testRoot, post!.id, scheduledFor);
    const updated = readSocialQueue(testRoot)[0];

    expect(updated.status).toBe('approved');
    expect(updated.scheduled_for).toBe(scheduledFor);
    expect(updated.history.some((entry) => entry.type === 'schedule')).toBe(true);
  });

  it('reschedules and records old/new schedule metadata', () => {
    const { post } = createDraft(testRoot, { content: 'Reschedule post' });
    const first = new Date(Date.now() + 60_000).toISOString();
    const second = new Date(Date.now() + 120_000).toISOString();
    approvePost(testRoot, post!.id, first);

    schedulePost(testRoot, post!.id, second);
    const updated = readSocialQueue(testRoot)[0];
    const history = updated.history.find((entry) => entry.type === 'reschedule');

    expect(updated.scheduled_for).toBe(second);
    expect(history?.metadata?.old_scheduled_for).toBe(first);
    expect(history?.metadata?.scheduled_for).toBe(second);
  });

  it('clears schedule from an approved post', () => {
    const { post } = createDraft(testRoot, { content: 'Clear schedule post' });
    approvePost(testRoot, post!.id, new Date(Date.now() + 60_000).toISOString());

    clearSchedule(testRoot, post!.id);

    expect(readSocialQueue(testRoot)[0].scheduled_for).toBeUndefined();
  });

  it('rejects with note, appends Markdown learning, JSONL learning, and history', () => {
    const { post } = createDraft(testRoot, { content: 'Needs work' });

    rejectPost(testRoot, post!.id, 'Too generic, needs a specific personal anecdote');
    const paths = getSocialPostPaths(testRoot);
    const updated = readSocialQueue(testRoot)[0];

    expect(updated.status).toBe('rejected');
    expect(updated.rejection_note).toContain('Too generic');
    expect(updated.history.some((entry) => entry.type === 'reject')).toBe(true);
    expect(fs.readFileSync(paths.learningsPath, 'utf8')).toContain('Too generic');
    expect(JSON.parse(fs.readFileSync(paths.learningsJsonlPath, 'utf8').trim()).type).toBe(
      'rejection',
    );
  });

  it('trashes without note and records history', () => {
    const { post } = createDraft(testRoot, { content: 'Bad post' });

    rejectPost(testRoot, post!.id, '');
    const updated = readSocialQueue(testRoot)[0];

    expect(updated.status).toBe('trashed');
    expect(updated.history.some((entry) => entry.type === 'trash')).toBe(true);
  });

  it('publishes X posts and records tweet metadata and history', async () => {
    const { post } = createDraft(testRoot, { content: 'Tweet text', platform: 'x' });
    approvePost(testRoot, post!.id);
    const publishTweet = vi.fn(async () => ({
      success: true,
      tweetId: '123',
      postUrl: 'https://x.com/Channel17/status/123',
    }));

    const result = await publishPost(testRoot, post!.id, publishTweet);
    const updated = readSocialQueue(testRoot)[0];

    expect(result.success).toBe(true);
    expect(updated.status).toBe('posted');
    expect(updated.tweet_id).toBe('123');
    expect(updated.post_url).toContain('/123');
    expect(updated.history.some((entry) => entry.type === 'publish')).toBe(true);
  });

  it('exports LinkedIn posts without calling X publishing', () => {
    const { post } = createDraft(testRoot, { content: 'LinkedIn text', platform: 'linkedin' });
    approvePost(testRoot, post!.id);
    const publishTweet = vi.fn();

    const result = exportPost(testRoot, post!.id);
    const updated = readSocialQueue(testRoot)[0];

    expect(result.success).toBe(true);
    expect(updated.status).toBe('posted');
    expect(updated.exported_at).toBeDefined();
    expect(updated.history.some((entry) => entry.type === 'export')).toBe(true);
    expect(publishTweet).not.toHaveBeenCalled();
  });

  it('returns media warnings for missing paths without blocking approval', () => {
    const missingPath = path.join(testRoot, 'missing.png');
    const { post } = createDraft(testRoot, {
      content: 'Post with media',
      media_paths: [missingPath],
    });

    approvePost(testRoot, post!.id);
    const updated = readSocialQueue(testRoot)[0];

    expect(updated.status).toBe('approved');
    expect(updated.media_validation?.[0].warning).toBe('Missing local media file');
  });

  it('scheduler publishes only due approved X posts and ignores LinkedIn posts', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const xDue = createDraft(testRoot, { content: 'Due X', platform: 'x' }).post!;
    const xFuture = createDraft(testRoot, { content: 'Future X', platform: 'x' }).post!;
    const linkedInDue = createDraft(testRoot, {
      content: 'Due LinkedIn',
      platform: 'linkedin',
    }).post!;
    approvePost(testRoot, xDue.id, due);
    approvePost(testRoot, xFuture.id, future);
    approvePost(testRoot, linkedInDue.id, due);
    const publishTweet = vi.fn(async () => ({
      success: true,
      tweetId: 'scheduled',
      postUrl: 'https://x.com/Channel17/status/scheduled',
    }));

    const result = await publishDueScheduledSocialPosts(testRoot, publishTweet);
    const queue = readSocialQueue(testRoot);

    expect(result.published).toBe(1);
    expect(publishTweet).toHaveBeenCalledTimes(1);
    expect(queue.find((post) => post.id === xDue.id)?.status).toBe('posted');
    expect(queue.find((post) => post.id === xFuture.id)?.status).toBe('approved');
    expect(queue.find((post) => post.id === linkedInDue.id)?.status).toBe('approved');
  });

  it('getPosts includes compact learning records for matching posts', () => {
    const { post } = createDraft(testRoot, { content: 'Learning post' });
    rejectPost(testRoot, post!.id, 'Needs a sharper opening');

    const posts = getPosts(testRoot);

    expect(posts[0].learnings?.[0].note).toContain('sharper opening');
  });
});
