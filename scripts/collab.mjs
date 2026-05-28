#!/usr/bin/env node
/**
 * Amy <-> Codex collaboration orchestrator.
 *
 * Amy calls this before every significant design or implementation task.
 * Codex is a peer -- not subordinate. Luke's latest intent is the only authority.
 *
 * Usage:
 *   node scripts/collab.mjs propose  --topic "X" --content "design outline"
 *   node scripts/collab.mjs status
 *   node scripts/collab.mjs read-codex          # Amy reads Codex's latest response
 *   node scripts/collab.mjs counter --content "Amy's counter-challenge"
 *   node scripts/collab.mjs consensus           # Summarise agreed design
 *   node scripts/collab.mjs submit-impl --file path/to/impl.md
 *   node scripts/collab.mjs review-impl         # Amy reviews Codex's impl
 *   node scripts/collab.mjs merge               # Pick best features, write final.md
 *   node scripts/collab.mjs devnote --content "msg"  # Leave a note for peer
 *   node scripts/collab.mjs reset               # Clear current session (idle)
 *
 * Timeout behaviour:
 *   If Codex hasn't responded within TIMEOUT_MULTIPLIER * (Amy's planning time),
 *   Amy proceeds autonomously and writes a takeover-notice. Min timeout: 5 min.
 *
 * No paid-host fallback:
 *   If Codex does not respond, the session records a timeout. It does not
 *   invent a peer review through a paid API path.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const COLLAB_DIR = resolve(import.meta.dirname, '..', 'data', 'agent-collab');
const SESSIONS_DIR = join(COLLAB_DIR, 'sessions');
const AMY_OUTBOX = join(COLLAB_DIR, 'amy-outbox.json');
const CODEX_OUTBOX = join(COLLAB_DIR, 'codex-outbox.json');
const CURRENT_SESSION = join(COLLAB_DIR, 'current-session.json');
const TIMEOUT_MULTIPLIER = 3;
const MIN_TIMEOUT_SECONDS = 300; // 5 minutes

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

function now() { return Math.floor(Date.now() / 1000); }
function isoNow() { return new Date().toISOString(); }
function uid() { return createHash('sha256').update(String(Date.now() + Math.random())).digest('hex').slice(0, 12); }

function readJSON(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJSON(p, obj) {
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

function loadCurrentSession() {
  return readJSON(CURRENT_SESSION) || {
    session_id: null, topic: null, status: 'idle', started: null,
    last_update: null, amy_planning_seconds: null, timeout_seconds: null,
    phase: null, phases_completed: [], consensus: null, final_impl: null,
  };
}

function saveCurrentSession(s) {
  s.last_update = now();
  writeJSON(CURRENT_SESSION, s);
}

function sessionDir(id) {
  const d = join(SESSIONS_DIR, id);
  mkdirSync(d, { recursive: true });
  return d;
}

async function waitForCodexResponse(session, planningSeconds) {
  const timeout = Math.max(MIN_TIMEOUT_SECONDS, planningSeconds * TIMEOUT_MULTIPLIER);
  const deadline = now() + timeout;
  const pollInterval = 5000; // 5s

  console.log(`Waiting for Codex response (timeout: ${Math.round(timeout / 60)}min)...`);

  while (now() < deadline) {
    const codexMsg = readJSON(CODEX_OUTBOX);
    if (codexMsg && codexMsg.session_id === session.session_id && !codexMsg.read_by_amy) {
      return { source: 'codex', message: codexMsg };
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  console.log('Codex timeout. No paid-host substitute review was generated.');
  return { source: 'timeout', message: null };
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdPropose() {
  const topic = args.topic;
  const content = args.content;
  if (!topic || !content) {
    console.error('Usage: collab.mjs propose --topic "X" --content "design outline"');
    process.exit(1);
  }

  const session = loadCurrentSession();
  if (session.status === 'active') {
    console.warn(`Warning: overwriting active session ${session.session_id} on topic: ${session.topic}`);
  }

  const sid = uid();
  const planStart = now();

  const newSession = {
    session_id: sid,
    topic,
    status: 'active',
    started: now(),
    last_update: now(),
    amy_planning_seconds: 0,
    timeout_seconds: null,
    phase: 'awaiting-challenge',
    phases_completed: ['propose'],
    consensus: null,
    final_impl: null,
  };
  saveCurrentSession(newSession);

  const dir = sessionDir(sid);
  writeFileSync(join(dir, 'proposal.md'), `# Proposal: ${topic}\n\n${content}\n\nWritten by: amy\nTimestamp: ${isoNow()}\n`);

  const outbox = {
    from: 'amy',
    to: 'codex',
    session_id: sid,
    type: 'design-proposal',
    timestamp: isoNow(),
    read_by_codex: false,
    content,
    topic,
  };
  writeJSON(AMY_OUTBOX, outbox);

  const planningSeconds = now() - planStart + 1;
  newSession.amy_planning_seconds = planningSeconds;
  newSession.timeout_seconds = Math.max(MIN_TIMEOUT_SECONDS, planningSeconds * TIMEOUT_MULTIPLIER);
  saveCurrentSession(newSession);

  console.log(`Proposal written. Session: ${sid}`);
  console.log(`Topic: ${topic}`);
  console.log(`Codex timeout: ${Math.round(newSession.timeout_seconds / 60)}min`);
  console.log('');
  console.log('--- Waiting for Codex challenge ---');

  const result = await waitForCodexResponse(newSession, planningSeconds);

  if (result.source === 'timeout') {
    console.log('No response and no API key. Amy proceeds autonomously.');
    newSession.phase = 'amy-autonomous';
    newSession.phases_completed.push('codex-timeout');
    saveCurrentSession(newSession);

    // Write takeover notice to codex outbox for when Codex comes back
    writeJSON(CODEX_OUTBOX, {
      from: 'amy',
      to: 'codex',
      session_id: sid,
      type: 'takeover-notice',
      timestamp: isoNow(),
      read_by_amy: true,
      verdict: null,
      content: `Amy proceeded autonomously after ${Math.round(newSession.timeout_seconds / 60)}min timeout. Topic: ${topic}. Check proposal.md and final.md for what was built.`,
      suggested_changes: [],
    });
    return;
  }

  // Mark Codex response as read
  const codexMsg = result.message;
  codexMsg.read_by_amy = true;
  writeJSON(CODEX_OUTBOX, codexMsg);

  const label = result.source === 'timeout' ? '[Codex timeout]' : '[Codex]';
  console.log(`\n${label} Challenge received:\n`);
  console.log(codexMsg.content);
  console.log(`\nVerdict: ${codexMsg.verdict || 'n/a'}`);

  const dir2 = sessionDir(sid);
  writeFileSync(join(dir2, 'codex-challenge.md'), `# Codex Challenge\n\nSource: ${result.source}\nTimestamp: ${codexMsg.timestamp}\n\n${codexMsg.content}\n`);

  newSession.phase = 'awaiting-counter';
  newSession.phases_completed.push('challenge-received');
  saveCurrentSession(newSession);

  console.log('\nNext: node scripts/collab.mjs counter --content "your counter-argument"');
}

function cmdStatus() {
  const session = loadCurrentSession();
  if (session.status === 'idle') {
    console.log('No active collab session.');
    return;
  }

  console.log(`Session: ${session.session_id}`);
  console.log(`Topic: ${session.topic}`);
  console.log(`Phase: ${session.phase}`);
  console.log(`Status: ${session.status}`);
  console.log(`Phases completed: ${session.phases_completed.join(' -> ')}`);
  console.log(`Amy planning time: ${session.amy_planning_seconds}s`);
  console.log(`Codex timeout: ${session.timeout_seconds ? Math.round(session.timeout_seconds / 60) + 'min' : 'n/a'}`);

  const codexMsg = readJSON(CODEX_OUTBOX);
  if (codexMsg && codexMsg.session_id === session.session_id && !codexMsg.read_by_amy) {
    console.log('\nCodex has an UNREAD response waiting.');
  }

  if (session.consensus) {
    console.log(`\nConsensus: ${session.consensus}`);
  }
}

function cmdReadCodex() {
  const session = loadCurrentSession();
  const codexMsg = readJSON(CODEX_OUTBOX);

  if (!codexMsg || !codexMsg.content) {
    console.log('No Codex response available.');
    return;
  }

  if (codexMsg.session_id !== session.session_id) {
    console.log(`Warning: Codex message is for session ${codexMsg.session_id}, current is ${session.session_id}`);
  }

  console.log(`From: ${codexMsg.from} [${codexMsg.type}]`);
  console.log(`Timestamp: ${codexMsg.timestamp}`);
  console.log(`Verdict: ${codexMsg.verdict || 'n/a'}`);
  if (codexMsg.note) console.log(`Note: ${codexMsg.note}`);
  console.log('\n---\n');
  console.log(codexMsg.content);

  if (codexMsg.suggested_changes?.length) {
    console.log('\nSuggested changes:');
    codexMsg.suggested_changes.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  }

  // Mark as read
  codexMsg.read_by_amy = true;
  writeJSON(CODEX_OUTBOX, codexMsg);
}

function cmdCounter() {
  const content = args.content;
  if (!content) {
    console.error('Usage: collab.mjs counter --content "Amy counter-argument"');
    process.exit(1);
  }

  const session = loadCurrentSession();
  if (!session.session_id) { console.error('No active session.'); process.exit(1); }

  const dir = sessionDir(session.session_id);
  writeFileSync(join(dir, 'amy-counter.md'), `# Amy Counter-Response\n\nTimestamp: ${isoNow()}\n\n${content}\n`);

  // Send counter to Codex
  const outbox = {
    from: 'amy',
    to: 'codex',
    session_id: session.session_id,
    type: 'counter',
    timestamp: isoNow(),
    read_by_codex: false,
    content,
    topic: session.topic,
  };
  writeJSON(AMY_OUTBOX, outbox);

  session.phase = 'awaiting-codex-counter';
  session.phases_completed.push('amy-counter');
  saveCurrentSession(session);

  console.log('Counter written and sent to Codex.');
  console.log('Next: node scripts/collab.mjs consensus  -- when ready to lock the design');
}

function cmdConsensus() {
  const session = loadCurrentSession();
  if (!session.session_id) { console.error('No active session.'); process.exit(1); }

  const dir = sessionDir(session.session_id);
  const proposal = existsSync(join(dir, 'proposal.md')) ? readFileSync(join(dir, 'proposal.md'), 'utf-8') : '';
  const challenge = existsSync(join(dir, 'codex-challenge.md')) ? readFileSync(join(dir, 'codex-challenge.md'), 'utf-8') : '';
  const counter = existsSync(join(dir, 'amy-counter.md')) ? readFileSync(join(dir, 'amy-counter.md'), 'utf-8') : '';
  const codexMsg = readJSON(CODEX_OUTBOX);

  const summary = [
    `# Consensus: ${session.topic}`,
    `\nDate: ${isoNow()}`,
    `\n## Exchange summary`,
    proposal ? `\n### Proposal\n${proposal}` : '',
    challenge ? `\n### Codex Challenge\n${challenge}` : '',
    counter ? `\n### Amy Counter\n${counter}` : '',
    codexMsg?.content ? `\n### Codex Final Response\n${codexMsg.content}` : '',
    '\n## Agreed design',
    '\n[Fill in: the merged agreed approach derived from the exchange above]',
    '\n## What was dropped and why',
    '\n[Fill in: rejected ideas and reasons]',
  ].filter(Boolean).join('\n');

  writeFileSync(join(dir, 'consensus.md'), summary);

  session.phase = 'implementing';
  session.phases_completed.push('consensus');
  saveCurrentSession(session);

  console.log(`Consensus file written: data/agent-collab/sessions/${session.session_id}/consensus.md`);
  console.log('Fill in the "Agreed design" and "What was dropped" sections.');
  console.log('Then: node scripts/collab.mjs submit-impl --file path/to/impl.md');
}

function cmdSubmitImpl() {
  const file = args.file;
  if (!file) { console.error('Usage: collab.mjs submit-impl --file path/to/impl.md'); process.exit(1); }

  const session = loadCurrentSession();
  if (!session.session_id) { console.error('No active session.'); process.exit(1); }

  const implContent = readFileSync(resolve(file), 'utf-8');
  const dir = sessionDir(session.session_id);
  const amyImplDir = join(dir, 'amy-impl');
  mkdirSync(amyImplDir, { recursive: true });
  writeFileSync(join(amyImplDir, 'impl.md'), implContent);

  // Send to Codex for review
  writeJSON(AMY_OUTBOX, {
    from: 'amy',
    to: 'codex',
    session_id: session.session_id,
    type: 'implementation',
    timestamp: isoNow(),
    read_by_codex: false,
    content: implContent,
    topic: session.topic,
  });

  session.phase = 'awaiting-codex-review';
  session.phases_completed.push('amy-impl-submitted');
  saveCurrentSession(session);

  console.log(`Implementation submitted to session ${session.session_id} and sent to Codex for review.`);
}

function cmdReviewImpl() {
  const session = loadCurrentSession();
  const codexMsg = readJSON(CODEX_OUTBOX);

  if (!codexMsg?.content) { console.log('No Codex implementation to review yet.'); return; }

  const dir = sessionDir(session.session_id);
  const codexImplDir = join(dir, 'codex-impl');
  mkdirSync(codexImplDir, { recursive: true });
  writeFileSync(join(codexImplDir, 'impl.md'), codexMsg.content);

  console.log("Codex's implementation:\n");
  console.log(codexMsg.content);

  codexMsg.read_by_amy = true;
  writeJSON(CODEX_OUTBOX, codexMsg);

  session.phase = 'merging';
  session.phases_completed.push('codex-impl-reviewed');
  saveCurrentSession(session);

  console.log('\nNext: node scripts/collab.mjs merge  -- to pick best features and write final.md');
}

function cmdMerge() {
  const session = loadCurrentSession();
  if (!session.session_id) { console.error('No active session.'); process.exit(1); }

  const dir = sessionDir(session.session_id);
  const amyImpl = existsSync(join(dir, 'amy-impl', 'impl.md')) ? readFileSync(join(dir, 'amy-impl', 'impl.md'), 'utf-8') : '[not submitted]';
  const codexImpl = existsSync(join(dir, 'codex-impl', 'impl.md')) ? readFileSync(join(dir, 'codex-impl', 'impl.md'), 'utf-8') : '[not submitted]';
  const consensus = existsSync(join(dir, 'consensus.md')) ? readFileSync(join(dir, 'consensus.md'), 'utf-8') : '';

  const final = [
    `# Final: ${session.topic}`,
    `\nDate: ${isoNow()}`,
    '\n## Consensus design\n',
    consensus,
    '\n## Amy implementation\n',
    amyImpl,
    '\n## Codex implementation\n',
    codexImpl,
    '\n## Merged final implementation',
    '\n[Fill in: best features of both, chosen rationale]',
  ].join('\n');

  writeFileSync(join(dir, 'final.md'), final);

  session.phase = 'done';
  session.phases_completed.push('merged');
  session.final_impl = `data/agent-collab/sessions/${session.session_id}/final.md`;
  saveCurrentSession(session);

  console.log(`Final merge file: ${session.final_impl}`);
  console.log('Fill in "Merged final implementation" then commit.');
}

function cmdDevnote() {
  const content = args.content;
  if (!content) { console.error('Usage: collab.mjs devnote --content "msg"'); process.exit(1); }

  const session = loadCurrentSession();
  const sid = session.session_id || 'global';
  const dir = sessionDir(sid);
  const notesFile = join(dir, 'dev-notes.md');
  const existing = existsSync(notesFile) ? readFileSync(notesFile, 'utf-8') : '';
  writeFileSync(notesFile, `${existing}\n---\n${isoNow()} [amy]\n${content}\n`);
  console.log(`Dev note saved to: data/agent-collab/sessions/${sid}/dev-notes.md`);
}

function cmdReset() {
  writeJSON(CURRENT_SESSION, {
    session_id: null, topic: null, status: 'idle', started: null,
    last_update: null, amy_planning_seconds: null, timeout_seconds: null,
    phase: null, phases_completed: [], consensus: null, final_impl: null,
  });
  writeJSON(AMY_OUTBOX, { from: 'amy', to: 'codex', session_id: null, type: null, timestamp: null, read_by_codex: true, content: null });
  writeJSON(CODEX_OUTBOX, { from: 'codex', to: 'amy', session_id: null, type: null, timestamp: null, read_by_amy: true, verdict: null, content: null, suggested_changes: [] });
  console.log('Collab session reset to idle.');
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

switch (cmd) {
  case 'propose':     await cmdPropose(); break;
  case 'status':      cmdStatus(); break;
  case 'read-codex':  cmdReadCodex(); break;
  case 'counter':     cmdCounter(); break;
  case 'consensus':   cmdConsensus(); break;
  case 'submit-impl': cmdSubmitImpl(); break;
  case 'review-impl': cmdReviewImpl(); break;
  case 'merge':       cmdMerge(); break;
  case 'devnote':     cmdDevnote(); break;
  case 'reset':       cmdReset(); break;
  default:
    console.log(`Amy <-> Codex collaboration orchestrator.

Commands:
  propose      --topic "X" --content "design"   Start a collab session with a design proposal
  status                                          Show current session state
  read-codex                                      Print Codex's latest response
  counter      --content "response"               Amy counters Codex's challenge
  consensus                                       Scaffold consensus.md from the exchange
  submit-impl  --file path/to/impl.md             Submit Amy's implementation for peer review
  review-impl                                     Read and file Codex's implementation
  merge                                           Write final.md with best-of-both
  devnote      --content "msg"                    Leave a note for the peer agent
  reset                                           Clear current session (idle)
`);
}
