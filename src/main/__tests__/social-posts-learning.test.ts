import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createDraft,
  getSocialPostPaths,
  publishPost,
  readSocialQueue,
  refreshEngagement,
  rejectPost,
} from '../social-posts';

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'social-learning-test-'));
  fs.mkdirSync(getSocialPostPaths(testRoot).socialDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function readJsonl(): any[] {
  const file = getSocialPostPaths(testRoot).learningsJsonlPath;
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Social Posts learning loop', () => {
  it('writes structured rejection learning records', () => {
    const { post } = createDraft(testRoot, {
      platform: 'linkedin',
      content: 'Generic leadership advice with no concrete story',
    });

    rejectPost(testRoot, post!.id, 'Needs a specific operator story');
    const records = readJsonl();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      post_id: post!.id,
      type: 'rejection',
      platform: 'linkedin',
      note: 'Needs a specific operator story',
    });
    expect(records[0].content_excerpt).toContain('Generic leadership');
  });

  it('writes engagement learning records when refreshing posted X metrics', async () => {
    const { post } = createDraft(testRoot, {
      platform: 'x',
      content: 'A specific X post with measurable engagement',
    });
    await publishPost(
      testRoot,
      post!.id,
      vi.fn(async () => ({
        success: true,
        tweetId: 'tweet-1',
        postUrl: 'https://x.com/Channel17/status/tweet-1',
      })),
    );

    const engagement = {
      views: 1200,
      likes: 50,
      retweets: 7,
      replies: 3,
      last_checked: new Date().toISOString(),
    };
    const result = await refreshEngagement(
      testRoot,
      post!.id,
      vi.fn(async () => engagement),
    );
    const records = readJsonl();
    const updated = readSocialQueue(testRoot)[0];

    expect(result.success).toBe(true);
    expect(updated.engagement?.views).toBe(1200);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      post_id: post!.id,
      type: 'engagement',
      platform: 'x',
    });
    expect(records[0].metrics.views).toBe(1200);
  });
});
