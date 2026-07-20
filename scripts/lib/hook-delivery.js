'use strict';
//
// hook-delivery.js -- does a registered hook actually REACH the model?
//
// #gap 2026-07-20. Nine hooks emitted {"systemMessage": "..."} intending to
// govern Amy. Per the Claude Code hook contract that field renders to the
// user's terminal and never enters model context, so the Laws of Amy Gravity,
// the Tier 1 injection, and the #learn/#gap/#otter workflows were inert from
// the day they landed. The declaration layer was perfect: every law row named
// a hook, every hook existed on disk, every hook was registered in
// settings.json. The DELIVERY layer was dead, and nothing looked.
//
// Law g0 was amended to require enforcement AND DELIVERY. This module is how
// the drift lint proves delivery instead of trusting declaration. It works on
// two rungs, because neither alone is sufficient:
//
//   STATIC (screenInjectorSources)  Every hook registered on a context event
//     in either settings file is screened for the systemMessage-only shape.
//     Cheap, total, zero side effects. Codex peer review b81696804b98 caught
//     that the dynamic rung alone missed verify-hook-paths.mjs, which no law
//     row cites, so the auditor built to catch dead hooks was STILL reporting
//     through the dead channel. Coverage must come from what is REGISTERED,
//     not from what happens to be named by a law.
//
//   DYNAMIC (probeInjector)  Spawn the hook in its PRODUCTION form (same
//     interpreter and argv as settings.json registers, hook path repointed at
//     this tree, correct hook_event_name) and read what the model would
//     actually receive. Catches the failures a source scan cannot: a hook
//     that crashes, that misreads its own trigger, or that emits nothing.
//
// modelVisiblePayload() is the contract itself, encoded exactly once:
// additionalContext, or plain non-JSON stdout on UserPromptSubmit and
// SessionStart. A systemMessage-only payload returns null. That one function
// is the whole bug.
//
// Offline and fast by construction: no network, per-hook timeout, probes run
// with AMY_HOOK_DELIVERY_PROBE=1 so hooks with real side effects prove the
// channel without doing the work.
//
// HONEST LIMIT (Codex peer review 996720179425, recorded rather than hidden).
// The static rung covers all context-event registrations but only catches one
// source shape. The dynamic rung is the real proof and covers the law-cited
// subset, because spawning every registered hook on every land would run
// things like cloud-bootstrap-autorun.sh and make the gate flaky, which is
// worse than no gate. Closing the remainder properly means a third hook
// class, `side-effect` (registered for its work, intentionally silent, e.g.
// spine registration), so `inject` hooks can ALL be probed without the silent
// ones being mistaken for dead injectors. That classification is the next
// step, not something to fake here.
//
// Consumers: scripts/verify-gravity-drift.js (run by core.test.js on every
// land). Companion test: scripts/__tests__/hook-delivery.test.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseRegistryBlock } = require('./core-component-registry.js');

// The only two events whose purpose is adding context. A hook registered on
// anything else enforces by decision, not by injection.
const INJECTION_EVENTS = ['UserPromptSubmit', 'SessionStart'];
const PROBE_TIMEOUT_MS = 20000;

/**
 * Read a settings.json into flat entries. Returns null when the file is
 * missing or unparseable so callers can report that as its own failure.
 * @returns {Array<{event: string, matcher: string, command: string}>|null}
 */
function readSettingsEntries(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of group?.hooks || []) {
        if (typeof h?.command === 'string') {
          out.push({ event, matcher: String(group?.matcher ?? ''), command: h.command });
        }
      }
    }
  }
  return out;
}

/**
 * INJECTOR or BLOCKER, decided ONLY by the events a hook is registered on.
 *
 * An earlier version also demoted a hook to BLOCKER when its source contained
 * `process.exit(2)`. Codex peer review b81696804b98 showed that is a bypass:
 * any dead injector could add one unreachable exit(2) and skip the delivery
 * check forever. A hook on a context event is now ALWAYS probed, and a real
 * exit-2 block is recognised at probe time as a legitimate outcome rather
 * than assumed from source text.
 * @returns {{kind: 'injector'|'blocker', events: string[], reason: string}}
 */
function classifyHook({ hookName, entries }) {
  const mine = (entries || []).filter((e) => e.command.includes(hookName));
  const events = [...new Set(mine.map((e) => e.event))];
  const injecting = events.filter((e) => INJECTION_EVENTS.includes(e));
  if (injecting.length === 0) {
    return {
      kind: 'blocker',
      events,
      reason: `registered only on ${events.join(', ') || 'no'} event(s); enforcement is the exit code`,
    };
  }
  return { kind: 'injector', events: injecting, reason: `registered on ${injecting.join(', ')}` };
}

/**
 * THE CONTRACT. What of this stdout would the model actually see?
 * Returns the model-visible text, or null when the output is inert.
 */
function modelVisiblePayload(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON stdout IS appended to context on UserPromptSubmit/SessionStart.
    return raw;
  }
  const ctx = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) return ctx;
  return null; // systemMessage-only, or any shape the model never sees
}

/**
 * STATIC RUNG. Screen every hook registered on a context event for the
 * systemMessage-only shape: it writes the terminal-only channel and never
 * produces additionalContext (directly or through emitToModel).
 * Pure source inspection, so it covers hooks no law cites and costs nothing.
 * @returns {string[]} one failure line per offender
 */
function screenInjectorSources(repoRoot, entries) {
  const failures = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!INJECTION_EVENTS.includes(entry.event)) continue;
    const hookPath = resolveHookPath(repoRoot, entry.command);
    if (!hookPath) {
      // FAIL CLOSED on coverage too (Codex peer review 8aa6a7144387). The
      // first version silently skipped any command it could not resolve,
      // which quietly excluded the Tier 1 SessionStart injector registered
      // through the ~/.claude/hooks junction. A screen that cannot see a hook
      // must SAY so, not imply it passed.
      failures.push(
        `${entry.event} hook command could not be resolved to a tracked script, so its delivery channel is unverified: ${entry.command.slice(0, 160)}`,
      );
      continue;
    }
    if (seen.has(hookPath)) continue;
    seen.add(hookPath);
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, hookPath), 'utf8');
    } catch (err) {
      // Also fail closed (Codex peer review 996720179425): a hook we resolved
      // but cannot read is unscreened, and silence would imply it passed.
      failures.push(
        `${hookPath} (registered on ${entry.event}): resolved but unreadable (${err.code || err.message}), so its delivery channel is unverified`,
      );
      continue;
    }
    if (emitsOnlySystemMessage(source)) {
      failures.push(
        `${hookPath} (registered on ${entry.event}): writes systemMessage and never additionalContext, so everything it says reaches the terminal and NOT the model. Use emitToModel() from scripts/claude-hooks/lib/hook-context.mjs.`,
      );
    }
  }
  return failures;
}

/** Drop line and block comments so a comment cannot vouch for the code. */
function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)(\/\/|#).*$/, '$1'))
    .join('\n');
}

// A real delivery: emitToModel INVOKED, or an additionalContext object KEY
// actually written (covers the JSON that .sh hooks echo by hand).
const DELIVERS_RE = /emitToModel\s*\(|additionalContext["']?\s*:/;
// A real terminal-only emission, by the same standard.
const TERMINAL_ONLY_RE = /emitToUser\s*\(|systemMessage["']?\s*:/;

/**
 * Does this source write the terminal-only channel and never the model one?
 *
 * Evidence must be a CALL or a written KEY, never a mention. Comments are
 * stripped (Codex peer review 8aa6a7144387) and bare identifiers no longer
 * count (Codex peer review 996720179425), so an unused import, a string
 * literal, or a reassuring comment cannot vouch for a hook that in fact emits
 * systemMessage. Every one of the nine originally dead hooks had honest
 * looking prose wrapped around a dead call, which is exactly why prose and
 * imports are not admissible.
 */
function emitsOnlySystemMessage(source) {
  const code = stripComments(source);
  return TERMINAL_ONLY_RE.test(code) && !DELIVERS_RE.test(code);
}

/**
 * The repo-relative tracked script a command runs, or null.
 * Accepts scripts/claude-hooks/<file>, any other scripts/<path>, and the
 * ~/.claude/hooks/<file> junction form, which resolves to the tracked
 * scripts/claude-hooks/<file> (the junction is the same inode).
 */
function resolveHookPath(repoRoot, command) {
  const cmd = String(command || '');
  const candidates = [];
  const junction = cmd.match(
    /[~.]?[/\\]?\.claude[/\\]hooks[/\\]([A-Za-z0-9._-]+\.(?:mjs|js|cjs|sh))/,
  );
  if (junction) candidates.push(`scripts/claude-hooks/${junction[1]}`);
  const hooksDir = cmd.match(/claude-hooks[/\\]([A-Za-z0-9._-]+\.(?:mjs|js|cjs|sh))/);
  if (hooksDir) candidates.push(`scripts/claude-hooks/${hooksDir[1]}`);
  const anyScript = cmd.match(/(?:^|[\s/\\])(scripts[/\\][A-Za-z0-9._/\\-]+\.(?:mjs|js|cjs|sh))/);
  if (anyScript) candidates.push(anyScript[1].replace(/\\/g, '/'));
  for (const rel of candidates) {
    if (fs.existsSync(path.join(repoRoot, rel))) return rel;
  }
  return null;
}

/** Literal alternatives out of a settings matcher regex ("#inbox|#mail"). */
function matcherLiterals(matcher) {
  const raw = String(matcher || '').trim();
  if (!raw) return [];
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s && /^[#a-z0-9_:-]+$/i.test(s));
}

/**
 * Fallback prompt for hooks registered with an EMPTY matcher, which do their
 * own trigger detection in-process. There is no way to derive such a hook's
 * trigger from configuration, so this is a union of every hashtag and every
 * CORE COMPONENTS registry keyword. Derived, not hardcoded: new hashtags and
 * new components stay covered without editing this file.
 *
 * Known and accepted limit (Codex peer review b81696804b98): a union prompt
 * cannot prove WHICH token a hook matched. Hooks with a declared matcher are
 * therefore probed with that matcher's literal ALONE, which is precise; only
 * empty-matcher hooks fall back to the union.
 */
function buildTriggerPrompt(repoRoot, entries) {
  const parts = new Set();
  for (const e of entries || []) {
    if (!INJECTION_EVENTS.includes(e.event)) continue;
    for (const lit of matcherLiterals(e.matcher)) parts.add(lit);
  }
  let memText = '';
  try {
    memText = fs.readFileSync(path.join(repoRoot, 'memory', 'MEMORY.md'), 'utf8');
  } catch {
    /* registry keywords are a bonus, not a precondition */
  }
  for (const row of parseRegistryBlock(memText).rows) {
    const kw = row.keywords[0];
    if (!kw) continue;
    parts.add(kw);
    if (/^[a-z0-9-]+$/.test(kw)) parts.add(`#${kw}`);
  }
  parts.add('#otter');
  return [...parts].join(' ');
}

/**
 * Rebuild the registered command as argv, with the hook path repointed at
 * repoRoot so the probe exercises THIS tree rather than the machine's
 * installed copy. Returns null when the command does not name the hook.
 */
function buildArgv(command, repoRoot, hookName) {
  const tokens = String(command || '').match(/'[^']*'|"[^"]*"|\S+/g) || [];
  const argv = tokens.map((t) => t.replace(/^['"]|['"]$/g, ''));
  const idx = argv.findIndex((t) => t.includes(hookName));
  if (idx === -1) return null;
  const abs = path.join(repoRoot, 'scripts', 'claude-hooks', hookName).replace(/\\/g, '/');
  argv[idx] = abs;
  if (idx === 0) return { exe: process.execPath, args: [abs] };
  const exe = argv[0] === 'node' ? process.execPath : argv[0];
  return { exe, args: argv.slice(1) };
}

/**
 * DYNAMIC RUNG. Spawn one injector in production form and report what
 * reached the model.
 *
 * `blocked` (exit 2) is a legitimate outcome: the hook stopped the prompt,
 * which is enforcement by decision. `skipped` means the probe could not run
 * at all; callers must treat that as a FAILURE (fail closed), never as a
 * pass, or a hook can sit permanently unverified while the lint prints green.
 * @returns {{status:'delivered'|'blocked'|'inert'|'skipped'|'crashed', detail:string}}
 */
function probeInjector({ repoRoot, hookName, command, prompt, event = 'UserPromptSubmit' }) {
  const built = buildArgv(command, repoRoot, hookName);
  if (!built) {
    return { status: 'skipped', detail: `could not resolve argv from command: ${command}` };
  }
  // An interpreter pinned to one machine's absolute path (Git-for-Windows
  // bash) is retried by basename so a different host can still resolve it
  // from PATH. If that also fails, the result is `skipped` and the caller
  // fails closed.
  let exe = built.exe;
  if (/[\\/]/.test(exe) && !fs.existsSync(exe)) {
    exe = path.basename(exe).replace(/\.exe$/i, '');
  }
  const payload = JSON.stringify({
    prompt,
    session_id: 'gravity-delivery-probe',
    cwd: repoRoot,
    hook_event_name: event,
  });
  const res = spawnSync(exe, built.args, {
    input: payload,
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    // PROBE MODE CONTRACT: AMY_HOOK_DELIVERY_PROBE=1 means prove the
    // channel and do NO external work. Hooks with side effects branch on it.
    // Known side-effect flags are also neutralized here so an operator's
    // ambient environment cannot make a land gate write real state (Codex
    // peer review 8aa6a7144387 found the inherited usage-hook flag spawning
    // usage-tracker.js and writing a cache file during the probe).
    env: {
      ...process.env,
      AMY_HOOK_DELIVERY_PROBE: '1',
      SECONDBRAIN_ENABLE_USAGE_HOOK: '0',
    },
  });
  if (res.error && res.error.code === 'ENOENT') {
    return { status: 'skipped', detail: `interpreter "${exe}" not available on this host` };
  }
  if (res.error) {
    return { status: 'crashed', detail: `${res.error.code || res.error.message}` };
  }
  if (res.status === 2) {
    return { status: 'blocked', detail: 'exited 2 (enforcement by decision, not injection)' };
  }
  const ctx = modelVisiblePayload(res.stdout);
  if (ctx) return { status: 'delivered', detail: `${Buffer.byteLength(ctx, 'utf8')} bytes` };
  const stdout = String(res.stdout || '').trim();
  return {
    status: 'inert',
    detail: stdout
      ? `emitted output the model never sees (systemMessage-only or wrong shape): ${stdout.slice(0, 200)}`
      : 'emitted nothing on a trigger-matching prompt',
  };
}

module.exports = {
  readSettingsEntries,
  classifyHook,
  modelVisiblePayload,
  screenInjectorSources,
  emitsOnlySystemMessage,
  stripComments,
  resolveHookPath,
  buildTriggerPrompt,
  buildArgv,
  probeInjector,
  matcherLiterals,
  INJECTION_EVENTS,
  PROBE_TIMEOUT_MS,
};
