#!/usr/bin/env node
// Multi-session coordination for concurrent Claude Code sessions on the same machine.
// Canonical location: secondbrain/scripts/claude-hooks/session-coordination.mjs
// Registered user-level in ~/.claude/settings.json so it fires for every repo automatically.
//
// Dispatched by first arg:
//   session-start -> register this session, prune stale (>2h), show active siblings
//   pre-edit      -> block (exit 2) if another live session has claimed this file
//   post-tool     -> claim the edited file + update heartbeat
//
// State: <os-tmp>/claude-code-sessions/<repo-id>/<session_id>.json
// repo-id is a stable hash of the git common dir, so all worktrees of the
// same repo share state but unrelated repos don't collide. We deliberately
// avoid `.git/…` and `.claude/…` — Claude Code hardcodes both as sensitive
// paths and triggers a permission prompt on every write, regardless of
// settings.permissions.allow. Anywhere outside those two dirs is fine.
// Not tracked. If cwd isn't inside a git repo, the hook exits silently.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const event = process.argv[2];
const STALE_SECONDS = 2 * 60 * 60;

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  input = {};
}

const sessionId = input.session_id || 'unknown';
const cwd = input.cwd || process.cwd();

let gitCommonDir;
try {
  gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!gitCommonDir.startsWith('/') && !/^[A-Za-z]:/.test(gitCommonDir)) {
    gitCommonDir = resolve(cwd, gitCommonDir);
  }
} catch {
  process.exit(0);
}

const repoId = createHash('sha256').update(gitCommonDir.toLowerCase()).digest('hex').slice(0, 12);
const sessionsDir = resolve(tmpdir(), 'claude-code-sessions', repoId);
if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

// Migrate any legacy state that was living in `.git/claude-sessions/`. One-shot
// best-effort copy so running sessions carry over the first time this hook fires
// after the refactor. Once migrated, the old dir can be safely removed.
const legacyDir = resolve(gitCommonDir, 'claude-sessions');
if (existsSync(legacyDir)) {
  try {
    for (const f of readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const src = join(legacyDir, f);
      const dst = join(sessionsDir, f);
      if (existsSync(dst)) continue;
      try { writeFileSync(dst, readFileSync(src)); } catch {}
    }
  } catch {}
}

const now = () => Math.floor(Date.now() / 1000);

function pruneStale() {
  const cutoff = now() - STALE_SECONDS;
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
      if ((s.last_update || 0) < cutoff) unlinkSync(join(sessionsDir, f));
    } catch {
      try { unlinkSync(join(sessionsDir, f)); } catch {}
    }
  }
}

function loadSession(sid) {
  const p = join(sessionsDir, `${sid}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function saveSession(s) {
  writeFileSync(join(sessionsDir, `${s.session_id}.json`), JSON.stringify(s, null, 2));
}

function liveOthers() {
  const cutoff = now() - STALE_SECONDS;
  const out = [];
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = f.replace(/\.json$/, '');
    if (sid === sessionId) continue;
    try {
      const s = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
      if ((s.last_update || 0) >= cutoff) out.push(s);
    } catch {}
  }
  return out;
}

function normPath(p) {
  if (!p) return null;
  const abs = resolve(cwd, p);
  return abs.replace(/\\/g, '/').toLowerCase();
}

function repoName(topLevel) {
  try { return basename(topLevel); } catch { return 'repo'; }
}

if (event === 'session-start') {
  pruneStale();
  let s = loadSession(sessionId);
  const t = now();
  if (!s) {
    let branch = 'unknown', worktree = cwd;
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim(); } catch {}
    try { worktree = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim(); } catch {}
    s = { session_id: sessionId, branch, worktree, topic: null, started: t, last_update: t, files: [] };
  } else {
    s.last_update = t;
  }
  saveSession(s);

  const others = liveOthers();
  const repo = repoName(s.worktree);
  const lines = [];
  lines.push(`=== Claude multi-session coordination (${repo}) ===`);
  lines.push(`Registered session ${sessionId.substring(0, 8)} on branch '${s.branch}'.`);
  lines.push('');
  if (others.length === 0) {
    lines.push('No other active sessions in this repo. You have it to yourself.');
  } else {
    lines.push(`${others.length} other active session(s) in this repo:`);
    for (const o of others) {
      const mins = Math.floor((t - o.last_update) / 60);
      lines.push('');
      lines.push(`  - ${o.session_id.substring(0, 8)}  branch: ${o.branch}`);
      lines.push(`    topic: ${o.topic || '(not declared)'}`);
      lines.push(`    worktree: ${o.worktree}`);
      lines.push(`    files claimed: ${o.files.length}`);
      lines.push(`    last active: ${mins}m ago`);
    }
  }
  lines.push('');
  lines.push('RULES (mechanically enforced by hooks, not advice):');
  lines.push('  1. Never commit to main or dev. Create a claude/<topic> branch in a worktree:');
  lines.push('       git worktree add .claude/worktrees/<topic> -b claude/<topic> dev');
  lines.push('  2. Before your first file edit, declare your topic by writing it to your session file:');
  lines.push(`       ${join(sessionsDir, sessionId + '.json').replace(/\\/g, '/')}`);
  lines.push('     (the post-tool hook will update last_update automatically as you work)');
  lines.push('  3. If the pre-edit hook blocks you because another session claims a file:');
  lines.push('     coordinate with that session, rebase onto their branch, or pick different work.');
  lines.push('     Do NOT bypass the block.');
  lines.push('  4. Push WIP daily and open draft PRs so sessions on other machines can see you.');
  console.log(lines.join('\n'));
  process.exit(0);
}

if (event === 'pre-edit') {
  const filePath = input.tool_input?.file_path;
  if (!filePath) process.exit(0);
  const norm = normPath(filePath);
  for (const o of liveOthers()) {
    if ((o.files || []).some(f => (f || '').toLowerCase() === norm)) {
      const msg = [
        `BLOCKED by multi-session coordination.`,
        ``,
        `Session ${o.session_id.substring(0, 8)} (branch '${o.branch}', topic: ${o.topic || 'undeclared'}) is`,
        `already editing this file: ${filePath}`,
        ``,
        `Last active ${Math.floor((now() - o.last_update) / 60)}m ago.`,
        `Worktree: ${o.worktree}`,
        ``,
        `Coordinate with that session before editing. Options:`,
        `  - pull their branch and rebase your work onto it`,
        `  - pick a different file or a different task`,
        `  - if that session is dead, delete ${join(sessionsDir, o.session_id + '.json')}`,
        `    (only do this if you're sure the session is inactive)`,
      ].join('\n');
      console.error(msg);
      process.exit(2);
    }
  }
  process.exit(0);
}

if (event === 'post-tool') {
  const filePath = input.tool_input?.file_path;
  const s = loadSession(sessionId);
  if (!s) process.exit(0);
  s.last_update = now();
  if (filePath) {
    const norm = normPath(filePath);
    if (!s.files.includes(norm)) s.files.push(norm);
  }
  saveSession(s);
  process.exit(0);
}

process.exit(0);
