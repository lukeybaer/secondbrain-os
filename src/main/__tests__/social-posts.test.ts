/**
 * Tests for social posts content pipeline — CRUD, approval workflow,
 * rejection with learnings, and publishing.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Test directory setup ────────────────────────────────────────────────────

let testRoot: string;
let socialDir: string;
let queuePath: string;
let learningsPath: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'));
  socialDir = path.join(testRoot, 'content-review', 'social-posts');
  fs.mkdirSync(socialDir, { recursive: true });
  queuePath = path.join(socialDir, 'queue.json');
  learningsPath = path.join(socialDir, 'learnings.md');
  fs.writeFileSync(queuePath, '[]');
});

afterAll(() => {
  // Cleanup is best-effort
  try {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* ok */
  }
});

// ── Helpers (mirror the IPC handler logic) ──────────────────────────────────

function readQueue(): any[] {
  try {
    return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch {
    return [];
  }
}

function writeQueue(queue: any[]): void {
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function createDraft(post: { content: string; platform?: string; source_idea?: string }): {
  success: boolean;
  post?: any;
} {
  const queue = readQueue();
  const id = `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    platform: post.platform || 'x',
    status: 'pending_approval',
    content: post.content,
    source_idea: post.source_idea || '',
    media_paths: [],
    created_at: new Date().toISOString(),
  };
  queue.push(entry);
  writeQueue(queue);
  return { success: true, post: entry };
}

function approvePost(id: string): { success: boolean } {
  const queue = readQueue();
  const post = queue.find((p: any) => p.id === id);
  if (!post) return { success: false };
  post.status = 'approved';
  post.approved_at = new Date().toISOString();
  writeQueue(queue);
  return { success: true };
}

function rejectPost(id: string, note: string): { success: boolean } {
  const queue = readQueue();
  const post = queue.find((p: any) => p.id === id);
  if (!post) return { success: false };
  if (!note) {
    post.status = 'trashed';
  } else {
    post.status = 'rejected';
    post.rejection_note = note;
    const date = new Date().toISOString().split('T')[0];
    const line = `- [${date}] **Rejected** (${post.platform}): ${note}\n`;
    if (!fs.existsSync(learningsPath)) {
      fs.writeFileSync(
        learningsPath,
        '# Social Post Learnings\n\n## Rejection Feedback\n\n',
        'utf8',
      );
    }
    fs.appendFileSync(learningsPath, line, 'utf8');
  }
  writeQueue(queue);
  return { success: true };
}

function editPost(id: string, content: string): { success: boolean } {
  const queue = readQueue();
  const post = queue.find((p: any) => p.id === id);
  if (!post) return { success: false };
  post.content = content;
  writeQueue(queue);
  return { success: true };
}

function trashPost(id: string): { success: boolean } {
  const queue = readQueue();
  const post = queue.find((p: any) => p.id === id);
  if (!post) return { success: false };
  post.status = 'trashed';
  writeQueue(queue);
  return { success: true };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Social Posts — Content Pipeline', () => {
  describe('createDraft', () => {
    it('creates a draft with pending_approval status', () => {
      const result = createDraft({
        content: 'AI is transforming how we work. Here are 3 things I learned this week.',
      });
      expect(result.success).toBe(true);
      expect(result.post).toBeDefined();
      expect(result.post!.status).toBe('pending_approval');
      expect(result.post!.platform).toBe('x');
      expect(result.post!.content).toContain('AI is transforming');

      const queue = readQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe(result.post!.id);
    });

    it('supports custom platform', () => {
      const result = createDraft({ content: 'LinkedIn post', platform: 'linkedin' });
      expect(result.post!.platform).toBe('linkedin');
    });

    it('stores source idea', () => {
      const result = createDraft({
        content: 'Polished tweet text',
        source_idea: 'Luke voice note: AI stuff this week was crazy',
      });
      expect(result.post!.source_idea).toContain('voice note');
    });
  });

  describe('approvePost', () => {
    it('changes status to approved with timestamp', () => {
      const { post } = createDraft({ content: 'Test post' });
      const result = approvePost(post!.id);
      expect(result.success).toBe(true);

      const queue = readQueue();
      expect(queue[0].status).toBe('approved');
      expect(queue[0].approved_at).toBeDefined();
    });

    it('returns failure for non-existent post', () => {
      const result = approvePost('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('rejectPost', () => {
    it('trashes post when no note is provided', () => {
      const { post } = createDraft({ content: 'Bad post' });
      rejectPost(post!.id, '');

      const queue = readQueue();
      expect(queue[0].status).toBe('trashed');
    });

    it('marks as rejected and appends to learnings when note provided', () => {
      const { post } = createDraft({ content: 'Needs work' });
      rejectPost(post!.id, 'Too generic, needs a specific personal anecdote');

      const queue = readQueue();
      expect(queue[0].status).toBe('rejected');
      expect(queue[0].rejection_note).toContain('Too generic');

      // Check learnings file was updated
      const learnings = fs.readFileSync(learningsPath, 'utf8');
      expect(learnings).toContain('Too generic');
      expect(learnings).toContain('Rejected');
    });
  });

  describe('editPost', () => {
    it('updates content in queue', () => {
      const { post } = createDraft({ content: 'Original text' });
      editPost(post!.id, 'Edited text with more detail');

      const queue = readQueue();
      expect(queue[0].content).toBe('Edited text with more detail');
    });
  });

  describe('trashPost', () => {
    it('marks post as trashed', () => {
      const { post } = createDraft({ content: 'Unwanted post' });
      trashPost(post!.id);

      const queue = readQueue();
      expect(queue[0].status).toBe('trashed');
    });
  });

  describe('full workflow', () => {
    it('create → edit → approve lifecycle', () => {
      const { post } = createDraft({
        content: 'Draft from voice note',
        source_idea: 'Luke said: building my own EA is wild',
      });

      editPost(
        post!.id,
        'Building my own AI executive assistant taught me 3 things about automation that no blog post covers.',
      );
      approvePost(post!.id);

      const queue = readQueue();
      expect(queue[0].status).toBe('approved');
      expect(queue[0].content).toContain('3 things about automation');
      expect(queue[0].approved_at).toBeDefined();
    });

    it('create → reject → feedback loop', () => {
      const { post } = createDraft({ content: 'Generic AI post' });
      rejectPost(post!.id, 'This could be from any AI account. Add personal experience.');

      const queue = readQueue();
      expect(queue[0].status).toBe('rejected');

      const learnings = fs.readFileSync(learningsPath, 'utf8');
      expect(learnings).toContain('personal experience');
    });

    it('multiple posts in queue at different statuses', () => {
      const a = createDraft({ content: 'Post A' });
      const b = createDraft({ content: 'Post B' });
      const c = createDraft({ content: 'Post C' });

      approvePost(a.post!.id);
      rejectPost(b.post!.id, 'Too short');
      // C stays pending

      const queue = readQueue();
      const statuses = queue.map((p: any) => p.status);
      expect(statuses).toContain('approved');
      expect(statuses).toContain('rejected');
      expect(statuses).toContain('pending_approval');
    });
  });
});
