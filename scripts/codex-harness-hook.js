#!/usr/bin/env node
'use strict';

// Native Codex adapter, not a replacement permission system. Requires the host's
// normal exact-definition hook trust; installation alone does not activate it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function isSecondBrainRoot(root) {
  return !!root && ['MEMORY.md', 'AMY.md'].every((name) => fs.existsSync(path.join(root, 'memory', name)));
}

function rootFromPath(target) {
  if (!target) return null;
  let current = path.resolve(target);
  for (;;) {
    if (isSecondBrainRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function patchTargets(input) {
  if (!['apply_patch', 'ApplyPatch'].includes(input.tool_name)) return [];
  const body = typeof input.tool_input === 'string' ? input.tool_input
    : (input.tool_input?.input || input.tool_input?.patch || input.tool_input?.command || '');
  return [...String(body).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
    .map((match) => path.resolve(input.tool_input?.workdir || input.cwd || process.cwd(), match[1].trim()));
}

function commandScript(input) {
  if (!['Bash', 'exec_command'].includes(input.tool_name)) return null;
  const command = String(input.tool_input?.command || input.tool_input?.cmd || '').trim();
  const match = /^(?:&\s*)?(?:node(?:\.exe)?|bash|sh|powershell(?:\.exe)?|pwsh(?:\.exe)?|"[^"\r\n]*[\\/](?:node|powershell|pwsh)\.exe"|'[^'\r\n]*[\\/](?:node|powershell|pwsh)\.exe')\s+(?:-File\s+)?(?:"([^"\r\n]+\.(?:js|sh|ps1))"|'([^'\r\n]+\.(?:js|sh|ps1))'|([^\s"']+\.(?:js|sh|ps1)))(.*)$/i.exec(command);
  if (!match || /[;|&\r\n]/.test(match[4])) return null;
  return { file: path.resolve(input.tool_input?.workdir || input.cwd || process.cwd(), match[1] || match[2] || match[3]), args: match[4].trim().split(/\s+/) };
}

function scopeFile(input, env) {
  if (!input.session_id) return null;
  const base = env.SECONDBRAIN_HARNESS_STATE_DIR || path.join(env.APPDATA || path.join(os.homedir(), '.local', 'share'), 'secondbrain', 'data', 'agent', 'codex-harness-scopes');
  if (rootFromPath(base)) throw new Error('Native harness scope registry must live outside the source repository');
  const id = crypto.createHash('sha256').update(String(input.session_id)).digest('hex');
  return path.join(base, id + '.json');
}

function rememberScope(input, root, env) {
  const file = scopeFile(input, env);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = JSON.stringify({ schema: 'secondbrain.codex-harness-scope.v1', root });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === next) return;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function recalledScope(input, env) {
  const file = scopeFile(input, env);
  if (!file || !fs.existsSync(file)) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  return saved.schema === 'secondbrain.codex-harness-scope.v1' && isSecondBrainRoot(saved.root) ? saved.root : null;
}

function scopedRoot(input, env = process.env) {
  // Never fall back to __dirname: this script is globally installed but most
  // unrelated repositories must see no SecondBrain policy or injected context.
  if ((env.SECONDBRAIN_HARNESS === '1' || env.SECONDBRAIN_HARNESS_PHASE) && isSecondBrainRoot(env.SECONDBRAIN_ROOT)) {
    return path.resolve(env.SECONDBRAIN_ROOT);
  }
  for (const target of [...patchTargets(input), commandScript(input)?.file, input.tool_input?.workdir, input.cwd]) {
    const root = rootFromPath(target);
    if (root) return root;
  }
  return ['Stop', 'SessionStart'].includes(input.hook_event_name) ? recalledScope(input, env) : null;
}

function isMachineResponse(text, env = process.env) {
  if (env.SECONDBRAIN_RESPONSE_FORMAT === 'machine') return true;
  const value = String(text || '').trim();
  if (!value) return true;
  // Include interrupted JSON prefixes. Do not append prose to machine payloads.
  // A normal Markdown link/list is not a JSON prefix.
  return /^```(?:json|jsonl)\b/i.test(value)
    || /^\{(?:\s*(?:"|\}|$))/.test(value)
    || /^\[(?:\s*(?:[\[\]{"0-9-]|true\b|false\b|null\b|$))/.test(value);
}

function landWithoutApply(input) {
  if (!['Bash', 'exec_command'].includes(input.tool_name)) return false;
  const command = String(input.tool_input?.command || input.tool_input?.cmd || '').trim();
  // Deliberately recognize only a standalone direct node invocation. Quoted
  // examples, rg, Get-Content, arbitrary shell programs and diagnostics remain
  // available. This is a workflow nudge, not a shell parser or security boundary.
  const match = /^(?:&\s*)?(?:node(?:\.exe)?|"[^"\r\n]*[\\/]node\.exe"|'[^'\r\n]*[\\/]node\.exe')\s+(?:"([^"\r\n]*[\\/]land\.js)"|'([^'\r\n]*[\\/]land\.js)'|([^\s"']*[\\/]land\.js))(.*)$/i.exec(command);
  if (!match || /[;|&\r\n]/.test(match[4])) return false;
  const args = match[4].trim().split(/\s+/);
  return !args.some((arg) => ['--apply', '--help', '-h', '--dry-run', '--check'].includes(arg));
}

function phaseActive(env, root) {
  return !!String(env.SECONDBRAIN_HARNESS_PHASE || '').trim()
    && rootFromPath(env.SECONDBRAIN_ROOT) === root;
}

function releaseCommand(input) {
  const script = commandScript(input);
  if (!script || script.args.some((arg) => ['--help', '-h', '--dry-run', '--check', '--status'].includes(arg))) return false;
  const name = path.basename(script.file);
  return name === 'land.js' || /^deploy(?:-[^.]+)?\.(?:js|sh|ps1)$/.test(name)
    || ['update-desktop-runtime.ps1', 'sync-to-public.js'].includes(name);
}

function routeReason(root, input, operation) {
  const packetRoot = rootFromPath(input.cwd)
    ? path.join(os.tmpdir(), 'secondbrain-harness', crypto.createHash('sha256').update(String(input.session_id || root)).digest('hex').slice(0, 16))
    : (input.cwd || os.tmpdir());
  const packet = path.join(packetRoot, 'work', operation ? 'secondbrain-operation.json' : 'secondbrain-plan.json');
  const runner = path.join(__dirname, 'codex-run.js');
  return `SecondBrain ${operation ? 'release sequence' : 'source mutation'} must run through the fresh execution harness. Prepare the ${operation ? 'operation' : 'phase plan'} JSON at ${packet}, then run node "${runner}" ${operation ? '--operation-file' : `--cwd "${root}" --plan-file`} "${packet}". Read that runner's --help for the packet schema. Keep diagnostics and the packet file outside the repository direct. This workflow guard is not a shell security boundary.`;
}

// The prompt of the turn that just ended: Codex writes each user prompt to
// its session transcript as an event_msg of type user_message.
function lastCodexUserPrompt(transcriptPath) {
  let lines = [];
  try { lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return ''; }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') return String(entry.payload.message || '');
    } catch { /* torn line */ }
  }
  return '';
}

// Every Codex turn on the PC is recorded as a model exchange (laws g1/g6/g25)
// and forwarded to EC2. Fail-soft: recording never changes the hook verdict.
function recordCodexExchange(input, options = {}) {
  if (process.env.VITEST && !options.provenanceDataDir) return false;
  try {
    const { recordModelExchange } = options.provenance || require('./lib/model-exchange-provenance.js');
    recordModelExchange({
      surface: 'codex-pc',
      prompt: lastCodexUserPrompt(input.transcript_path || ''),
      response: String(input.last_assistant_message || ''),
      sessionId: String(input.session_id || ''),
      dataDir: options.provenanceDataDir,
    });
    if (!options.provenanceDataDir) {
      const { spawn } = require('node:child_process');
      spawn(process.execPath, [path.join(__dirname, 'forward-evidence-to-ec2.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

// Agent delivery protocol (2026-09-27): shared-checkout writes, poll loops,
// chat deploy holds and transcript re-reads, judged for top-level calls and
// for calls nested inside the code-mode `exec` wrapper. Scoped to calls or
// sessions that touch SecondBrain; other repositories see nothing.
function deliveryGuardFile(input, env) {
  if (!input.session_id) return null;
  const base = env.SECONDBRAIN_HARNESS_STATE_DIR || path.join(env.APPDATA || path.join(os.homedir(), '.local', 'share'), 'secondbrain', 'data', 'agent', 'codex-harness-scopes');
  const id = crypto.createHash('sha256').update(String(input.session_id)).digest('hex');
  return path.join(path.dirname(base), 'codex-delivery-guard', `${id}.json`);
}

function deliveryGuard(input, env, options = {}) {
  const guards = options.guards || require('./lib/agent-delivery-guards.js');
  const actions = guards.actionsOf(input);
  const nestedRoot = [
    ...actions.patchTargets.map((t) => (path.isAbsolute(t.path) ? t.path : path.resolve(t.base || '.', t.path))),
    ...actions.commands.map((c) => c.workdir),
  ].map(rootFromPath).find(Boolean);
  const root = scopedRoot(input, env) || nestedRoot || recalledScope(input, env);
  if (!root) return null;
  if (nestedRoot) rememberScope(input, nestedRoot, env);
  const file = deliveryGuardFile(input, env);
  let prior = {};
  try { if (file && fs.existsSync(file)) prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prior = {}; }
  const verdict = guards.evaluateCall(input, prior, options.now || Date.now());
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(verdict.state));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }
  return verdict.deny;
}

function handleHook(input, options = {}) {
  // Recorded for every Codex turn in every repository, before scoping.
  if (input.hook_event_name === 'Stop' && input.stop_hook_active !== true) recordCodexExchange(input, options);
  const env = options.env || process.env;
  if (input.hook_event_name === 'PreToolUse') {
    const deny = deliveryGuard(input, env, options);
    if (deny) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } };
  }
  const root = scopedRoot(input, env);
  if (!root) return {};
  rememberScope(input, root, env);
  switch (input.hook_event_name) {
    case 'SessionStart': {
      // A fresh runner phase already owns its canonical prelude, so do not
      // inject it twice. Native sessions get it once at startup/compaction.
      if (phaseActive(env, root)) return {};
      const build = options.buildPrelude || require('./lib/codex-amy-prelude').buildCodexAmyPrelude;
      const context = build({ repoRoot: root }) + '\n\nSecondBrain execution: route multi-step development through scripts/codex-run.js --plan-file with same-unit checkpoints; deterministic command sequences use --operation-file. Ordinary diagnostics stay direct. Native hooks cannot reset the model context or change the active task effort; fresh model phases are owned by that runner. Official owner responses end once with a TLDR last; put Impact of adversarial review directly above it only when a peer actually reviewed, and no Graphiti line while Graphiti is off. No automatic Graphiti query.';
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
    }
    case 'PreToolUse':
      if (!phaseActive(env, root) && (patchTargets(input).some((target) => rootFromPath(target)) || releaseCommand(input))) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: routeReason(root, input, releaseCommand(input)) } };
      }
      if (landWithoutApply(input)) return { hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'A land is not delivered without --apply. Use node scripts/land.js --apply for an authorized landing, or --dry-run for an intentional diagnostic. Keep the release sequence in scripts/codex-run.js --operation-file.',
      } };
      return {};
    case 'Stop': {
      if (input.stop_hook_active === true || isMachineResponse(input.last_assistant_message, env)) return {};
      const validate = options.validateOwnerResponse || require('./lib/execution-response-contract').validateOwnerResponse;
      const verdict = validate(input.last_assistant_message);
      if (verdict.valid) return {};
      return { decision: 'block', reason: `Repair the final owner response only; do not restart completed work. ${verdict.errors.join('; ')}. End with exactly one TLDR as the final line. Add Impact of adversarial review directly above it only when a peer actually reviewed; no Graphiti line while Graphiti is off. Report actual review evidence honestly.` };
    }
    default: return {};
  }
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(handleHook(input)) + '\n');
  } catch (error) {
    // A nonzero hook result is a visible hook failure, not a fabricated verdict.
    process.stderr.write(`SecondBrain native harness hook failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { handleHook, isMachineResponse, landWithoutApply, scopedRoot, patchTargets, releaseCommand, lastCodexUserPrompt, recordCodexExchange };
