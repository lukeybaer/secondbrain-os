/**
 * Git does not track runtime or generated records (live check, not wording).
 * Moved out of tests/completeness-guard.spec.ts when T-1 (The owner)
 * deleted that file with the switched-off completeness hook it tested; this
 * was the one check in it that inspects the repository rather than the
 * wording of a document.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(__dirname, '..');

describe('git storage policy', () => {
  it('git does not track runtime/generated storage classes', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    const forbidden = [
      /^content-review\/pending\/.*\.(ass|json|jpg|mp3|mp4|png|srt)$/i,
      /^content-review\/published\/(manifest\.json|.*\.(jpg|mp4))$/i,
      /^content-review\/(rejections\.jsonl|upload-queue\.json)$/i,
      /^content-review\/social-posts\/queue\.json$/i,
      /^data\/agent\/(amy-dispatch-log|briefing-actions|dispatch-queue|dispatch-processed|dispatch-resolutions|graphiti-health|heal-tests-runs|health-heal|memory-cleanup-log|nightly-enhancements|otter-ingest-heartbeat|rubric-feedback-loop|rubric-expansion-queue)\.jsonl$/i,
      /^data\/agent\/(briefing-dismissed|gmail-scan-watermark|known-people|memory-delta-snapshot|news-summarizer-health|otter-ingest-seen|people-files-snapshot|rejection-processed|tests-blocked|youtube-oauth-alert)\.json$/i,
      /^data\/agent\/(aws-costs|pre-briefing-diagnostic|token-reduction-suggestion|token-usage)-\d{4}-\d{2}-\d{2}\.(json|md)$/i,
      /^data\/agent\/(linkedin-viral-scripts)-\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/agent\/finance-rates\/(history\.jsonl|\d{4}-\d{2}-\d{2}\.json)$/i,
      /^data\/agent\/shorts-proposals\/\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/agent\/viral-tech-clips\/\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/briefings\/briefing-\d{4}-\d{2}-\d{2}\.(md|docx)$/i,
      /^data\/briefing-action-items\.json$/i,
      /^data\/(gmail|otter|vapi|whatsapp)\/raw\/.+\.json$/i,
      /^data\/outbound\/.*\/\.sent\/.+\.json$/i,
    ];
    const offenders = tracked.filter((file) => forbidden.some((pattern) => pattern.test(file)));
    expect(offenders).toEqual([]);
  });
});
