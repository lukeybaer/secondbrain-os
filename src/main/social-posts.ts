import * as fs from 'fs';
import * as path from 'path';

export type SocialPlatform = 'x' | 'linkedin';
export type SocialPostStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'trashed';

export interface SocialPostVariant {
  id: string;
  content: string;
  created_at: string;
  source: string;
  active: boolean;
}

export interface SocialPostHistoryEntry {
  id: string;
  type: string;
  at: string;
  note?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface SocialMediaValidation {
  path: string;
  exists: boolean;
  kind: 'image' | 'video' | 'file';
  file_name: string;
  warning?: string;
}

export interface SocialLearningRecord {
  id: string;
  post_id: string;
  type: 'rejection' | 'engagement';
  platform: SocialPlatform;
  content_excerpt: string;
  note?: string;
  metrics?: Record<string, unknown>;
  created_at: string;
}

export interface SocialPost {
  id: string;
  platform: SocialPlatform;
  status: SocialPostStatus;
  content: string;
  source_idea?: string;
  media_paths?: string[];
  media_validation?: SocialMediaValidation[];
  variants: SocialPostVariant[];
  active_variant_id: string;
  history: SocialPostHistoryEntry[];
  learnings?: SocialLearningRecord[];
  created_at: string;
  approved_at?: string;
  posted_at?: string;
  post_url?: string;
  rejection_note?: string;
  scheduled_for?: string;
  tweet_id?: string;
  exported_at?: string;
  export_url?: string;
  export_note?: string;
  engagement?: {
    views?: number;
    likes?: number;
    retweets?: number;
    replies?: number;
    last_checked?: string;
  };
}

export interface TweetResult {
  success: boolean;
  tweetId?: string;
  postUrl?: string;
  error?: string;
}

export interface SocialPostPaths {
  socialDir: string;
  queuePath: string;
  learningsPath: string;
  learningsJsonlPath: string;
}

export function getSocialPostPaths(contentRoot: string): SocialPostPaths {
  const socialDir = path.join(contentRoot, 'content-review', 'social-posts');
  return {
    socialDir,
    queuePath: path.join(socialDir, 'queue.json'),
    learningsPath: path.join(socialDir, 'learnings.md'),
    learningsJsonlPath: path.join(socialDir, 'learnings.jsonl'),
  };
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(contentRoot: string): void {
  const { socialDir } = getSocialPostPaths(contentRoot);
  if (!fs.existsSync(socialDir)) fs.mkdirSync(socialDir, { recursive: true });
}

function activeVariant(post: SocialPost): SocialPostVariant | undefined {
  return post.variants.find((v) => v.id === post.active_variant_id) ?? post.variants[0];
}

function appendHistory(
  post: SocialPost,
  type: string,
  note?: string,
  metadata?: Record<string, unknown>,
): void {
  post.history.push({
    id: makeId('hist'),
    type,
    at: nowIso(),
    ...(note ? { note } : {}),
    actor: 'user',
    ...(metadata ? { metadata } : {}),
  });
}

function normalizePlatform(platform: unknown): SocialPlatform {
  return platform === 'linkedin' ? 'linkedin' : 'x';
}

function validateMediaPath(filePath: string): SocialMediaValidation {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
  const videoExts = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
  const exists = fs.existsSync(filePath);
  const kind = imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'file';
  return {
    path: filePath,
    exists,
    kind,
    file_name: path.basename(filePath),
    ...(!exists ? { warning: 'Missing local media file' } : {}),
  };
}

export function validatePostMedia(post: Pick<SocialPost, 'media_paths'>): SocialMediaValidation[] {
  return (post.media_paths ?? []).map(validateMediaPath);
}

export function normalizePost(raw: any): SocialPost {
  const createdAt = raw.created_at || nowIso();
  const content = raw.content || '';
  let variants: SocialPostVariant[] = Array.isArray(raw.variants) ? raw.variants : [];
  const activeVariantId = raw.active_variant_id || variants.find((v) => v.active)?.id;

  if (variants.length === 0) {
    const id = makeId('variant');
    variants = [{ id, content, created_at: createdAt, source: 'initial', active: true }];
  }

  let nextActiveId = activeVariantId || variants[0].id;
  if (!variants.some((v) => v.id === nextActiveId)) nextActiveId = variants[0].id;
  variants = variants.map((variant) => ({ ...variant, active: variant.id === nextActiveId }));
  const active = variants.find((variant) => variant.id === nextActiveId) ?? variants[0];
  const history: SocialPostHistoryEntry[] = Array.isArray(raw.history) ? raw.history : [];
  if (history.length === 0) {
    history.push({
      id: makeId('hist'),
      type: 'create',
      at: createdAt,
      actor: 'system',
    });
  }

  const post: SocialPost = {
    ...raw,
    id: raw.id || makeId('post'),
    platform: normalizePlatform(raw.platform),
    status: raw.status || 'pending_approval',
    content: active.content,
    source_idea: raw.source_idea || '',
    media_paths: Array.isArray(raw.media_paths) ? raw.media_paths : [],
    variants,
    active_variant_id: nextActiveId,
    history,
    created_at: createdAt,
  };
  post.media_validation = validatePostMedia(post);
  return post;
}

function normalizeQueue(queue: any[]): SocialPost[] {
  return queue.map(normalizePost);
}

export function readSocialQueue(contentRoot: string): SocialPost[] {
  const { queuePath } = getSocialPostPaths(contentRoot);
  try {
    if (!fs.existsSync(queuePath)) return [];
    return normalizeQueue(JSON.parse(fs.readFileSync(queuePath, 'utf8')));
  } catch {
    return [];
  }
}

export function writeSocialQueue(contentRoot: string, queue: SocialPost[]): void {
  ensureDir(contentRoot);
  const { queuePath } = getSocialPostPaths(contentRoot);
  fs.writeFileSync(queuePath, JSON.stringify(queue.map(normalizePost), null, 2));
}

function readLearningRecords(contentRoot: string): SocialLearningRecord[] {
  const { learningsJsonlPath } = getSocialPostPaths(contentRoot);
  if (!fs.existsSync(learningsJsonlPath)) return [];
  return fs
    .readFileSync(learningsJsonlPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SocialLearningRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is SocialLearningRecord => Boolean(record));
}

function appendLearning(contentRoot: string, record: SocialLearningRecord): void {
  ensureDir(contentRoot);
  const { learningsJsonlPath } = getSocialPostPaths(contentRoot);
  fs.appendFileSync(learningsJsonlPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function appendRejectionMarkdown(contentRoot: string, post: SocialPost, note: string): void {
  ensureDir(contentRoot);
  const { learningsPath } = getSocialPostPaths(contentRoot);
  const date = new Date().toISOString().split('T')[0];
  const line = `- [${date}] **Rejected** (${post.platform}): ${note}\n`;
  if (!fs.existsSync(learningsPath)) {
    fs.writeFileSync(learningsPath, '# Social Post Learnings\n\n## Rejection Feedback\n\n', 'utf8');
  }
  fs.appendFileSync(learningsPath, line, 'utf8');
}

function learningRecord(
  post: SocialPost,
  type: SocialLearningRecord['type'],
  extra: Partial<SocialLearningRecord>,
): SocialLearningRecord {
  return {
    id: makeId('learning'),
    post_id: post.id,
    type,
    platform: post.platform,
    content_excerpt: post.content.slice(0, 220),
    created_at: nowIso(),
    ...extra,
  };
}

function updatePost(
  contentRoot: string,
  id: string,
  update: (post: SocialPost) => void,
): { success: boolean; post?: SocialPost; error?: string } {
  try {
    const queue = readSocialQueue(contentRoot);
    const post = queue.find((item) => item.id === id);
    if (!post) return { success: false, error: 'Post not found' };
    update(post);
    writeSocialQueue(contentRoot, queue);
    return { success: true, post };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getPosts(contentRoot: string, statusFilter?: string): SocialPost[] {
  const queue = readSocialQueue(contentRoot);
  const learnings = readLearningRecords(contentRoot);
  const posts = queue.map((post) => ({
    ...post,
    learnings: learnings.filter((learning) => learning.post_id === post.id),
  }));
  if (!statusFilter) return posts;
  return posts.filter((post) => post.status === statusFilter);
}

export function createDraft(contentRoot: string, input: Partial<SocialPost>): {
  success: boolean;
  post?: SocialPost;
  error?: string;
} {
  try {
    const queue = readSocialQueue(contentRoot);
    const id = input.id || makeId('post');
    const createdAt = nowIso();
    const variantId = makeId('variant');
    const entry = normalizePost({
      id,
      platform: input.platform || 'x',
      status: input.status || 'pending_approval',
      content: input.content || '',
      source_idea: input.source_idea || '',
      media_paths: input.media_paths || [],
      created_at: createdAt,
      variants: [
        {
          id: variantId,
          content: input.content || '',
          created_at: createdAt,
          source: 'initial',
          active: true,
        },
      ],
      active_variant_id: variantId,
      history: [{ id: makeId('hist'), type: 'create', at: createdAt, actor: 'system' }],
    });
    queue.push(entry);
    writeSocialQueue(contentRoot, queue);
    return { success: true, post: entry };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function approvePost(contentRoot: string, id: string, scheduledFor?: string) {
  return updatePost(contentRoot, id, (post) => {
    post.status = 'approved';
    post.approved_at = nowIso();
    if (scheduledFor) {
      post.scheduled_for = scheduledFor;
      appendHistory(post, 'schedule', undefined, { scheduled_for: scheduledFor });
    } else {
      delete post.scheduled_for;
    }
    appendHistory(post, 'approve');
  });
}

export function schedulePost(contentRoot: string, id: string, scheduledFor: string) {
  return updatePost(contentRoot, id, (post) => {
    const old = post.scheduled_for;
    post.status = 'approved';
    post.scheduled_for = scheduledFor;
    appendHistory(post, old ? 'reschedule' : 'schedule', undefined, {
      old_scheduled_for: old,
      scheduled_for: scheduledFor,
    });
  });
}

export function clearSchedule(contentRoot: string, id: string) {
  return updatePost(contentRoot, id, (post) => {
    const old = post.scheduled_for;
    delete post.scheduled_for;
    appendHistory(post, 'clear_schedule', undefined, { old_scheduled_for: old });
  });
}

export function rejectPost(contentRoot: string, id: string, note: string) {
  const queue = readSocialQueue(contentRoot);
  const post = queue.find((item) => item.id === id);
  if (!post) return { success: false, error: 'Post not found' };

  if (!note) {
    post.status = 'trashed';
    appendHistory(post, 'trash');
  } else {
    post.status = 'rejected';
    post.rejection_note = note;
    appendHistory(post, 'reject', note);
    appendRejectionMarkdown(contentRoot, post, note);
    appendLearning(contentRoot, learningRecord(post, 'rejection', { note }));
  }
  writeSocialQueue(contentRoot, queue);
  return { success: true, post };
}

export function editPost(contentRoot: string, id: string, content: string) {
  return updatePost(contentRoot, id, (post) => {
    const variantId = makeId('variant');
    post.variants = post.variants.map((variant) => ({ ...variant, active: false }));
    post.variants.push({
      id: variantId,
      content,
      created_at: nowIso(),
      source: 'edit',
      active: true,
    });
    post.active_variant_id = variantId;
    post.content = content;
    appendHistory(post, 'edit');
  });
}

export function setActiveVariant(contentRoot: string, id: string, variantId: string) {
  return updatePost(contentRoot, id, (post) => {
    if (!post.variants.some((variant) => variant.id === variantId)) {
      throw new Error('Variant not found');
    }
    post.variants = post.variants.map((variant) => ({
      ...variant,
      active: variant.id === variantId,
    }));
    post.active_variant_id = variantId;
    post.content = activeVariant(post)?.content || post.content;
    appendHistory(post, 'variant_switch', undefined, { active_variant_id: variantId });
  });
}

export async function publishPost(
  contentRoot: string,
  id: string,
  publishTweet: (text: string) => Promise<TweetResult>,
) {
  const queue = readSocialQueue(contentRoot);
  const post = queue.find((item) => item.id === id);
  if (!post) return { success: false, error: 'Post not found' };
  if (post.platform !== 'x') {
    return { success: false, error: `Publishing to ${post.platform} not yet supported` };
  }

  const result = await publishTweet(post.content);
  if (!result.success) return result;

  post.status = 'posted';
  post.posted_at = nowIso();
  post.post_url = result.postUrl;
  post.tweet_id = result.tweetId;
  appendHistory(post, 'publish', undefined, { tweet_id: result.tweetId, post_url: result.postUrl });
  writeSocialQueue(contentRoot, queue);
  return { success: true, post, postUrl: result.postUrl };
}

export function exportPost(contentRoot: string, id: string, exportNote?: string, exportUrl?: string) {
  return updatePost(contentRoot, id, (post) => {
    if (post.platform !== 'linkedin') throw new Error('Export workflow only applies to LinkedIn');
    post.status = 'posted';
    post.exported_at = nowIso();
    post.posted_at = post.exported_at;
    if (exportNote) post.export_note = exportNote;
    if (exportUrl) post.export_url = exportUrl;
    appendHistory(post, 'export', exportNote, { export_url: exportUrl });
  });
}

export function trashPost(contentRoot: string, id: string) {
  return updatePost(contentRoot, id, (post) => {
    post.status = 'trashed';
    appendHistory(post, 'trash');
  });
}

export async function refreshEngagement(
  contentRoot: string,
  id: string,
  getTweetEngagement: (tweetId: string) => Promise<SocialPost['engagement'] | null>,
) {
  const queue = readSocialQueue(contentRoot);
  const post = queue.find((item) => item.id === id);
  if (!post) return { success: false, error: 'Post not found' };
  if (!post.tweet_id) return { success: false, error: 'No tweet ID , post may not have been published' };

  const engagement = await getTweetEngagement(post.tweet_id);
  if (!engagement) return { success: false, error: 'Could not fetch engagement' };

  post.engagement = engagement;
  appendHistory(post, 'engagement_refresh', undefined, { metrics: engagement });
  appendLearning(contentRoot, learningRecord(post, 'engagement', { metrics: engagement }));
  writeSocialQueue(contentRoot, queue);
  return { success: true, post, engagement };
}

export async function publishDueScheduledSocialPosts(
  contentRoot: string,
  publishTweet: (text: string) => Promise<TweetResult>,
): Promise<{ published: number }> {
  const queue = readSocialQueue(contentRoot);
  const now = new Date();
  let published = 0;

  for (const post of queue) {
    if (post.status !== 'approved' || post.platform !== 'x' || !post.scheduled_for) continue;
    const scheduledTime = new Date(post.scheduled_for);
    if (Number.isNaN(scheduledTime.getTime()) || scheduledTime > now) continue;
    const result = await publishTweet(post.content);
    if (result.success) {
      post.status = 'posted';
      post.posted_at = nowIso();
      post.post_url = result.postUrl;
      post.tweet_id = result.tweetId;
      appendHistory(post, 'publish', undefined, {
        tweet_id: result.tweetId,
        post_url: result.postUrl,
        scheduled_for: post.scheduled_for,
      });
      published += 1;
    }
  }

  if (published > 0) writeSocialQueue(contentRoot, queue);
  return { published };
}
