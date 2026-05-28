#!/usr/bin/env node
// build-amy-snapshot.js
//
// Generates Amy's "right now" context snapshot: active Claude Code sessions,
// recent commits, open todos, today's date/time. Written to
// data/agent/amy-snapshot.md. push-amy-vapi-config.js reads this file and
// appends it to the Vapi system prompt so Amy has fresh state without
// dispatching for trivial questions ("what are we working on right now?",
// "what did I ship today?").
//
// Runs fast (<2s). Designed to be called every 5-10 minutes by a scheduled
// task. The snapshot is small (~1-2k chars) so it doesn't bloat the prompt.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'agent', 'amy-snapshot.md');
// Derive the Claude Code sessions dir from the current repo root. Claude Code
// mangles the absolute path by replacing \:/ with - to produce the project
// folder name, so we do the same transform dynamically instead of hardcoding a
// personal path (which would trip the public-sync PII gate).
const CLAUDE_PROJECT_SLUG = REPO_ROOT.replace(/[\\/:]/g, '-').replace(/^-+/, '');
const SESSIONS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  CLAUDE_PROJECT_SLUG,
);

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function now() {
  // Central Time (McKinney TX) - use America/Chicago offset
  const d = new Date();
  const opts = {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

function recentCommits(n = 5) {
  return safe(() => {
    const out = execSync(`git -C "${REPO_ROOT}" log --oneline -${n} 2>&1`, { encoding: 'utf-8' });
    return out.trim().split('\n').map((l) => '- ' + l.trim()).join('\n');
  }, '(git log unavailable)');
}

function gitStatus() {
  return safe(() => {
    const out = execSync(`git -C "${REPO_ROOT}" status --short 2>&1`, { encoding: 'utf-8' });
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return 'clean working tree';
    return `${lines.length} files modified: ` + lines.slice(0, 5).map((l) => l.trim()).join(', ') +
      (lines.length > 5 ? ', ...' : '');
  }, '(git status unavailable)');
}

function activeSessions(n = 5) {
  return safe(() => {
    if (!fs.existsSync(SESSIONS_DIR)) return '(sessions dir not found)';
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(SESSIONS_DIR, f);
        const stat = fs.statSync(p);
        return { path: p, name: f, mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);

    if (!files.length) return '(no sessions found)';

    return files.map((f) => {
      const topic = safe(() => {
        const raw = fs.readFileSync(f.path, 'utf-8');
        const first = raw.split('\n').slice(0, 5);
        for (const line of first) {
          try {
            const j = JSON.parse(line);
            const msg = j.message && j.message.content;
            if (typeof msg === 'string' && msg.length > 10) return msg.slice(0, 80).replace(/\s+/g, ' ');
            if (Array.isArray(msg)) {
              for (const part of msg) {
                if (part && part.type === 'text' && part.text) return part.text.slice(0, 80).replace(/\s+/g, ' ');
              }
            }
          } catch {}
        }
        return f.name.slice(0, 12);
      }, f.name.slice(0, 12));
      const age = Math.round((Date.now() - f.mtime.getTime()) / 60000);
      return `- ${age} min ago (${Math.round(f.size / 1024)}kb): ${topic}`;
    }).join('\n');
  }, '(session listing failed)');
}

function todosOpen() {
  return safe(() => {
    const todosPath = path.join(
      process.env.APPDATA || '',
      'secondbrain',
      'data',
      'todos.json',
    );
    if (!fs.existsSync(todosPath)) return '(no todos file)';
    const todos = JSON.parse(fs.readFileSync(todosPath, 'utf-8'));
    const open = (Array.isArray(todos) ? todos : (todos.items || [])).filter(
      (t) => t && !t.completed && !t.done,
    );
    if (!open.length) return 'no open todos';
    return open.slice(0, 5).map((t) => {
      const title = t.title || t.content || t.text || '(untitled)';
      const pri = t.priority || '';
      return `- [${pri}] ${title}`;
    }).join('\n');
  }, '(todos unavailable)');
}

const snapshot = `## Right Now (refreshed ${new Date().toISOString()})

Current date/time: ${now()} Central Time

### Active Claude Code sessions (most recent first)
${activeSessions()}

### Recent commits on secondbrain master
${recentCommits()}

### Working tree
${gitStatus()}

### Open todos
${todosOpen()}
`;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, snapshot, 'utf-8');

console.log(`[amy-snapshot] wrote ${snapshot.length} chars to ${OUT_PATH}`);
