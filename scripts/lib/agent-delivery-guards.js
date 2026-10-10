'use strict';

/**
 * agent-delivery-guards.js
 *
 * Agent delivery protocol (ExampleCo, 2026-09-27;
 * dev-plans/agent-delivery-protocol-2026-09-27.html). Pure rules the Codex
 * native hook (scripts/codex-harness-hook.js) applies to every tool call,
 * including calls nested inside the Codex code-mode `exec` wrapper.
 *
 * Measured failure: two Codex threads spent about 425M tokens on 26-27 Sep.
 * Nearly every action ran as `tools.exec_command(...)` / `tools.apply_patch(...)`
 * inside `exec`, which the hook matcher never saw, so an agent patched the
 * shared checkout directly and polled one terminal 681 times.
 */

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STDIN_READS_PER_PROCESS = 10;
const REPEAT_COMMAND_LIMIT = 3; // the fourth identical command in the window is refused
const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const LONG_SLEEP_SECONDS = 20;
const TOOL_CALLS_BEFORE_HANDOFF = 300;

// --- JavaScript source scanning (Codex code-mode `exec` bodies) -------------

function decodeLiteral(raw) {
  return String(raw).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (match, esc) => {
    const c = esc[0];
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === 'u' && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (c === 'x' && esc.length === 3) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return esc;
  });
}

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gs;

function literals(code) {
  const out = [];
  for (const m of String(code || '').matchAll(LITERAL)) out.push(decodeLiteral(m[1] ?? m[2] ?? m[3] ?? ''));
  return out;
}

// `key: "value"` / `"key": 'value'` / `key: 123` / `key: true` pairs inside one tool call segment.
function keyedValues(segment) {
  const out = {};
  const re = /["']?([A-Za-z_]\w*)["']?\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|(-?\d+(?:\.\d+)?|true|false))/gs;
  for (const m of segment.matchAll(re)) {
    const key = m[1];
    if (out[key] !== undefined) continue;
    if (m[5] !== undefined) out[key] = m[5] === 'true' ? true : m[5] === 'false' ? false : Number(m[5]);
    else out[key] = decodeLiteral(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function codeText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  const direct = toolInput.code ?? toolInput.input ?? toolInput.source ?? toolInput.script;
  if (typeof direct === 'string') return direct;
  return JSON.stringify(toolInput);
}

/**
 * Every nested tool call in a code-mode body: { tool, args } where args holds
 * the literal keyed values found in that call's segment.
 */
function nestedCalls(code) {
  const text = String(code || '');
  const starts = [...text.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    return { tool: m[1], args: keyedValues(text.slice(m.index, end)) };
  });
}

function patchTargetsIn(texts) {
  const out = [];
  for (const t of texts) {
    for (const m of String(t).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) out.push(m[1].trim());
  }
  return out;
}

/**
 * Normalize one Codex tool call (top-level or code-mode) into the actions the
 * guards judge: patch targets, commands with workdirs, empty terminal reads,
 * messages to other threads and transcript reads.
 */
function actionsOf(input) {
  const name = String(input.tool_name || '');
  const ti = input.tool_input;
  const cwd = input.cwd || '';
  const actions = { patchTargets: [], commands: [], stdinReads: [], threadMessages: [], threadReads: [] };
  if (name === 'apply_patch' || name === 'ApplyPatch') {
    const body = typeof ti === 'string' ? ti : ti?.input || ti?.patch || ti?.command || '';
    actions.patchTargets.push(...patchTargetsIn([body]).map((p) => ({ path: p, base: ti?.workdir || cwd })));
    return actions;
  }
  if (name === 'Bash' || name === 'exec_command') {
    actions.commands.push({ cmd: String(ti?.command || ti?.cmd || ''), workdir: ti?.workdir || cwd });
    return actions;
  }
  if (name === 'write_stdin') {
    if (!String(ti?.chars || '')) actions.stdinReads.push({ process: String(ti?.session_id ?? '') });
    return actions;
  }
  const code = codeText(ti);
  if (!/\btools\./.test(code) && !/\*\*\* (?:Add|Update|Delete) File:/.test(code)) return actions;
  actions.patchTargets.push(...patchTargetsIn(literals(code)).map((p) => ({ path: p, base: cwd })));
  for (const call of nestedCalls(code)) {
    const a = call.args;
    if (/^(exec_command|shell|bash)$/i.test(call.tool) && (a.cmd || a.command)) {
      actions.commands.push({ cmd: String(a.cmd || a.command), workdir: a.workdir || cwd });
    } else if (call.tool === 'write_stdin' && !a.chars) {
      actions.stdinReads.push({ process: String(a.session_id ?? '') });
    } else if (/send_message|send_input|post_message/i.test(call.tool)) {
      actions.threadMessages.push({ tool: call.tool, text: String(a.prompt || a.message || a.text || '') });
    } else if (/read_thread/i.test(call.tool)) {
      actions.threadReads.push({ includeOutputs: a.includeOutputs === true });
    }
  }
  return actions;
}

// --- shared checkout ---------------------------------------------------------

function isSecondBrainRoot(root) {
  return !!root && ['MEMORY.md', 'AMY.md'].every((name) => fs.existsSync(path.join(root, 'memory', name)));
}

function rootOf(target) {
  if (!target) return null;
  let current = path.resolve(String(target));
  for (;;) {
    if (isSecondBrainRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The shared checkout is the SecondBrain root whose .git is a directory; a
// worktree's .git is a file. The C:\Users\ExampleCo\secondbrain junction resolves
// to the same directory, so both spellings are covered.
function sharedCheckoutOf(target) {
  const root = rootOf(target);
  if (!root) return null;
  try {
    return fs.statSync(path.join(root, '.git')).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

const PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\/[a-z]\/|~[\\/])[^\s"'`;|&<>()]+/g;
const MUTATING = new RegExp(
  [
    String.raw`\bgit\b[^\n|;&]*\b(?:add|commit|checkout|restore|reset|merge|pull|stash|rebase|cherry-pick|apply|am|rm|mv|clean|revert|switch)\b`,
    String.raw`\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item|Rename-Item|Clear-Content)\b`,
    String.raw`\bsed\s+-i\b`,
    String.raw`\bnpm\s+(?:install|ci|i)\b`,
    String.raw`(?:^|[\s;&|])(?:rm|mv|cp|touch|tee)\s`,
  ].join('|'),
  'i',
);

function expandHome(p) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let s = String(p);
  if (s.startsWith('~')) s = path.join(home, s.slice(1));
  const msys = /^\/([a-z])\/(.*)$/.exec(s);
  if (msys) s = `${msys[1].toUpperCase()}:/${msys[2]}`;
  return s;
}

function sharedWriteViolation(actions) {
  for (const t of actions.patchTargets) {
    const target = path.isAbsolute(expandHome(t.path)) ? expandHome(t.path) : path.resolve(t.base || '.', t.path);
    const shared = sharedCheckoutOf(target);
    if (shared) return `patch to ${target}`;
  }
  for (const c of actions.commands) {
    if (!MUTATING.test(c.cmd)) continue;
    const paths = [c.workdir, ...(c.cmd.match(PATH_IN_TEXT) || [])].filter(Boolean).map(expandHome);
    const hit = paths.find((p) => sharedCheckoutOf(p));
    if (hit) return `mutating command in ${sharedCheckoutOf(hit)}: ${c.cmd.slice(0, 160)}`;
  }
  return null;
}

// --- polling and coordination -------------------------------------------------

function normalizeCommand(cmd) {
  return String(cmd).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

function longSleep(cmd) {
  const m =
    /\bStart-Sleep\b(?:\s+-(?:Seconds|s))?\s+(\d+)/i.exec(cmd) ||
    /(?:^|[\s;&|(])sleep\s+(\d+)\b/.exec(cmd) ||
    /\btimeout\s+\/t\s+(\d+)/i.exec(cmd);
  if (m && Number(m[1]) >= LONG_SLEEP_SECONDS) return Number(m[1]);
  const ms = /\bStart-Sleep\s+-(?:Milliseconds|m)\s+(\d+)/i.exec(cmd);
  return ms && Number(ms[1]) >= LONG_SLEEP_SECONDS * 1000 ? Number(ms[1]) / 1000 : 0;
}

// Status probes: the shapes the 26-27 Sep threads repeated hundreds of times.
// Ordinary repeated work (git status, test runs, reads) is not a probe.
const STATUS_PROBE = /\bssh\b|\bcurl\b|\bpm2\s+(?:status|list|logs|jlist)\b|\bpgrep\b|(?:^|[\s;&|])ps\s|\bGet-Process\b|\bGet-CimInstance\b|\baws\s+ecs\s+(?:list|describe)-tasks\b/i;

const CHAT_HOLD_WORDS = /\b(?:HOLD|RELEASED)\b/;
const CHAT_HOLD_PHRASES = /\bdeploy(?:ment)? (?:hold|lock)\b|\bdo not deploy\b|\bhold (?:the |your |any )?(?:deploy|release)\b|\brelease the (?:deploy )?lock\b/i;
const CHAT_HOLD = { test: (text) => CHAT_HOLD_WORDS.test(text) || CHAT_HOLD_PHRASES.test(text) };

const WAIT_GUIDANCE =
  'Launch long work detached and wait on its receipt: Otter cohorts use node scripts/otter-batch-launch.js, then node scripts/wait-for-receipt.js --run-id <id> (returns when a cohort finishes, fails or stalls, up to 25 minutes); any other long command writes a log and uses node scripts/wait-for-receipt.js --file <log>. If nothing changed, checkpoint with node scripts/work-handoff.js write and end the turn.';

/**
 * Judge one tool call against the session's running state. Returns
 * { deny: string|null, state } where state is the updated per-session record.
 */
function evaluateCall(input, prior = {}, now = Date.now()) {
  const state = {
    tool_calls: prior.tool_calls || 0,
    stdin_reads: { ...(prior.stdin_reads || {}) },
    recent_commands: (prior.recent_commands || []).filter((r) => now - r.at <= REPEAT_WINDOW_MS),
    handoff_due: Boolean(prior.handoff_due),
  };
  const actions = actionsOf(input);
  state.tool_calls += 1;

  const shared = sharedWriteViolation(actions);
  if (shared) {
    return {
      state,
      deny: `The shared SecondBrain checkout is read-only for agents (law g10): ${shared}. Make the change in an isolated worktree (bash scripts/new-session.sh <id>) and land it with node scripts/land.js --apply.`,
    };
  }

  const isHandoffWrite = actions.commands.some((c) => /work-handoff\.js\s+write\b/.test(c.cmd));
  if (isHandoffWrite) {
    state.handoff_due = false;
    state.tool_calls = 0;
    return { state, deny: null };
  }
  if (state.handoff_due || state.tool_calls > TOOL_CALLS_BEFORE_HANDOFF) {
    state.handoff_due = true;
    return {
      state,
      deny: `This thread has made ${TOOL_CALLS_BEFORE_HANDOFF}+ tool calls, so every call now resends a very large context. Write a handoff first: node scripts/work-handoff.js write --unit <id> --state <state> --next "<next step>" (2 KB max). Then continue here or in a fresh thread that reads it with work-handoff.js read.`,
    };
  }

  for (const read of actions.stdinReads) {
    const key = read.process || 'unknown';
    state.stdin_reads[key] = (state.stdin_reads[key] || 0) + 1;
    if (state.stdin_reads[key] > EMPTY_STDIN_READS_PER_PROCESS) {
      return { state, deny: `Stop polling process ${key}: ${state.stdin_reads[key] - 1} empty reads already. ${WAIT_GUIDANCE}` };
    }
  }

  for (const c of actions.commands) {
    const seconds = longSleep(c.cmd);
    if (seconds) return { state, deny: `A ${seconds}s sleep is a poll loop. ${WAIT_GUIDANCE}` };
    const key = normalizeCommand(c.cmd);
    if (!key || /wait-for-receipt\.js/.test(key) || !STATUS_PROBE.test(c.cmd)) continue;
    const seen = state.recent_commands.filter((r) => r.key === key).length;
    state.recent_commands.push({ key, at: now });
    if (seen >= REPEAT_COMMAND_LIMIT) {
      return { state, deny: `The same command ran ${seen} times in 30 minutes; a fourth unchanged check is refused. ${WAIT_GUIDANCE}` };
    }
  }
  if (state.recent_commands.length > 200) state.recent_commands = state.recent_commands.slice(-200);

  for (const msg of actions.threadMessages) {
    if (CHAT_HOLD.test(msg.text)) {
      return {
        state,
        deny: 'Chat messages cannot hold or release deploys; only the mechanical lock can. deploy-ec2-server.sh already waits at an Otter stage boundary. If production must stay frozen for a cohort, take a lease: node scripts/deploy-hold.js take --minutes <=90 --reason "<why>" (one renewal, hard expiry), and release it with deploy-hold.js release.',
      };
    }
  }
  for (const read of actions.threadReads) {
    if (read.includeOutputs) {
      return {
        state,
        deny: 'Reading another thread with includeOutputs pulls tens of KB of tool output into this context. Continue work from its handoff (node scripts/work-handoff.js read --unit <id>), or read the thread without outputs.',
      };
    }
  }
  return { state, deny: null };
}

module.exports = {
  CHAT_HOLD,
  EMPTY_STDIN_READS_PER_PROCESS,
  REPEAT_COMMAND_LIMIT,
  TOOL_CALLS_BEFORE_HANDOFF,
  actionsOf,
  decodeLiteral,
  evaluateCall,
  literals,
  longSleep,
  nestedCalls,
  sharedCheckoutOf,
  sharedWriteViolation,
};
