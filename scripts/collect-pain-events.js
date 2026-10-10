#!/usr/bin/env node
// collect-pain-events.js
//
// Scans 4 sources for pain signals since a given date.
// Used by the nightly enhancement task and health-self-heal to feed
// the feature backlog scoring system.
//
// Sources:
//   1. content-review/rejections.jsonl    -- video rejections
//   2. git log --since=yesterday          -- fix/bug/regression commits
//   3. data/agent/health-heal.jsonl       -- red/yellow health statuses
//   4. memory/feedback_*.md               -- recent feedback files by mtime

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

function collectPainEvents(sinceDate) {
  const since = sinceDate || yesterdayIso();
  const events = [];

  events.push(...collectRejections(since));
  events.push(...collectBugFixCommits(since));
  events.push(...collectHealthIssues(since));
  events.push(...collectFeedbackFiles(since));

  return events;
}

function yesterdayIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Source 1: Video rejections
function collectRejections(since) {
  const events = [];
  const rejectionsPath = path.join(REPO, 'content-review', 'rejections.jsonl');
  try {
    const lines = fs.readFileSync(rejectionsPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const entryDate = (entry.rejectedAt || entry.date || '').slice(0, 10);
        if (entryDate >= since) {
          const isRecurring = entry.rejection_count && entry.rejection_count > 1;
          events.push({
            source: 'rejection',
            severity: isRecurring ? 'recurring_rejection' : 'rejection',
            detail: `${entry.id || entry.video_id}: ${(entry.reason || entry.feedback || '').slice(0, 120)}`,
            date: entryDate,
            category: 'video-pipeline',
            keywords: extractKeywords(entry.reason || entry.feedback || ''),
          });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file doesn't exist yet */ }
  return events;
}

// Source 2: Bug fix commits
function collectBugFixCommits(since) {
  const events = [];
  try {
    const log = execSync(
      `git log --since="${since}" --oneline --all`,
      { cwd: REPO, encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (!log) return events;

    for (const line of log.split('\n')) {
      const lower = line.toLowerCase();
      if (/\b(fix|bug|regression|workaround|broken|hack)\b/.test(lower)) {
        const hash = line.slice(0, 8);
        const msg = line.slice(9);
        events.push({
          source: 'git_commit',
          severity: 'bug_fix_commit',
          detail: msg.slice(0, 120),
          date: since, // approximate
          category: inferCategory(msg),
          keywords: extractKeywords(msg),
        });
      }
    }
  } catch { /* git not available or error */ }
  return events;
}

// Source 3: Health check issues
function collectHealthIssues(since) {
  const events = [];
  const healLog = path.join(REPO, 'data', 'agent', 'health-heal.jsonl');
  try {
    const lines = fs.readFileSync(healLog, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const entryDate = (entry.ts || entry.timestamp || '').slice(0, 10);
        if (entryDate < since) continue;

        const checks = entry.after || entry.before || {};
        for (const [probe, result] of Object.entries(checks)) {
          if (result.status === 'red') {
            events.push({
              source: 'health_check',
              severity: 'health_red',
              detail: `${probe}: ${result.detail || 'red status'}`,
              date: entryDate,
              category: inferCategoryFromProbe(probe),
              keywords: [probe],
            });
          } else if (result.status === 'yellow') {
            events.push({
              source: 'health_check',
              severity: 'health_yellow',
              detail: `${probe}: ${result.detail || 'yellow status'}`,
              date: entryDate,
              category: inferCategoryFromProbe(probe),
              keywords: [probe],
            });
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file doesn't exist */ }
  return events;
}

// Source 4: Recent feedback files
function collectFeedbackFiles(since) {
  const events = [];
  const memoryDir = path.join(REPO, 'memory');
  try {
    const files = fs.readdirSync(memoryDir).filter(f => f.startsWith('feedback_') && f.endsWith('.md'));
    const sinceMs = new Date(since).getTime();

    for (const file of files) {
      const fullPath = path.join(memoryDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= sinceMs) {
        const content = fs.readFileSync(fullPath, 'utf8').slice(0, 500);
        const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+)/m);
        const descMatch = content.match(/^---[\s\S]*?description:\s*(.+)/m);
        events.push({
          source: 'feedback_file',
          severity: 'bug_fix_commit', // feedback files are typically corrections
          detail: (descMatch ? descMatch[1] : nameMatch ? nameMatch[1] : file).slice(0, 120),
          date: stat.mtime.toISOString().slice(0, 10),
          category: 'process',
          keywords: extractKeywords(file.replace('feedback_', '').replace('.md', '')),
        });
      }
    }
  } catch { /* memory dir issue */ }
  return events;
}

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 8);
}

function inferCategory(commitMsg) {
  const lower = (commitMsg || '').toLowerCase();
  if (/video|thumbnail|caption|broll|b-roll|subtitle/.test(lower)) return 'video-pipeline';
  if (/briefing|health|backup|s3/.test(lower)) return 'infrastructure';
  if (/vapi|call|voice|phone/.test(lower)) return 'voice';
  if (/contact|gmail|linkedin|otter/.test(lower)) return 'contacts';
  if (/memory|graphiti|tier/.test(lower)) return 'memory';
  return 'general';
}

function inferCategoryFromProbe(probe) {
  const map = {
    backups: 'infrastructure',
    s3Parity: 'infrastructure',
    ec2: 'infrastructure',
    llm: 'infrastructure',
    schedDispatch: 'infrastructure',
    nightlyEnhancements: 'research',
    videoPipeline: 'video-pipeline',
    videoFeedbackLoop: 'video-pipeline',
    staleUploads: 'video-pipeline',
    apiAudit: 'infrastructure',
  };
  return map[probe] || 'general';
}

module.exports = { collectPainEvents, collectRejections, collectBugFixCommits, collectHealthIssues, collectFeedbackFiles };
