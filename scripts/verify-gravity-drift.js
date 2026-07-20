#!/usr/bin/env node
'use strict';
//
// verify-gravity-drift.js -- the mechanical heart of the Laws of Amy Gravity.
//
// Law g0 says a rule that is not mechanically enforced AND DELIVERED to the
// actor does not exist. This lint applies g0 to the laws themselves: every row
// in memory/AMY_GRAVITY.md must point at enforcement that EXISTS, is WIRED,
// and (for injector hooks) actually REACHES THE MODEL, so a law physically
// cannot decay to memory-only without this going red. Checks per token type:
//
//   test:<path>       file exists on disk
//   hook:<name>@user     name appears in a command in claude-config/settings.json
//   hook:<name>@project  name appears in a command in .claude/settings.json
//   npm:<script>      script exists in package.json
//   lib:/script:<path> file exists on disk
//   policy:<path>     file exists on disk
//   registry:<id>     row id exists in the CORE COMPONENTS block of memory/MEMORY.md
//   ledger:<path>     file exists on disk
//
// Plus structural rules: unique ids, >=1 keyword, >=1 enforcement token,
// closed status vocabulary, row cap (MAX_LAWS), never-list core present, and
// the g0 teeth: a row whose only tokens are policy: cannot claim SOLID or
// PARTIAL.
//
// DELIVERY (added 2026-07-20, the amendment that gave g0 its second half).
// Declaration is not delivery. Nine hooks were registered, on disk, and named
// by law rows while emitting {"systemMessage": ...}, which renders to ExampleCo's
// terminal and NEVER enters model context, so every rule they ExampleCod was
// inert. Two rungs now prove delivery:
//
//   STATIC   every hook registered on UserPromptSubmit or SessionStart in
//            either settings file is screened for the systemMessage-only
//            shape. Coverage follows REGISTRATION, not law citation, because
//            the first version of this check missed verify-hook-paths.mjs,
//            which no law names (Codex peer review b81696804b98).
//   DYNAMIC  every law-cited injector is spawned in production form, on its
//            registered event, with the minimal prompt that trips its
//            declared matcher, and must produce model-visible output. Exit 2
//            counts as enforcement by decision. A probe that cannot run FAILS
//            CLOSED: unverifiable is not verified.
//
// See scripts/lib/hook-delivery.js for the contract. Offline, no network,
// per-hook timeout, one probe per hook regardless of how many rows cite it,
// and AMY_HOOK_DELIVERY_PROBE=1 so hooks with side effects prove the channel
// without doing the work.
//
// Run: npm run verify:gravity-drift. Runs on every land via
// scripts/__tests__/core.test.js. Companion test:
// scripts/__tests__/verify-gravity-drift.test.js
//
// Exit 0 clean; exit 1 drift (lists every violation).

const fs = require('fs');
const path = require('path');
const {
  parseGravityBlock,
  parseRatifiedCount,
  extractNeverListCore,
  STATUSES,
  TOKEN_TYPES,
  MAX_LAWS,
} = require('./lib/gravity-registry.js');
const { parseRegistryBlock } = require('./lib/core-component-registry.js');
const {
  readSettingsEntries,
  classifyHook,
  buildTriggerPrompt,
  probeInjector,
  screenInjectorSources,
  matcherLiterals,
  INJECTION_EVENTS,
} = require('./lib/hook-delivery.js');

const REPO = path.resolve(__dirname, '..');

/**
 * Lint a repo tree. Returns an array of failure strings (empty = clean).
 * repoRoot is overridable for fixture tests. Delivery probes FAIL CLOSED: a
 * probe that could not run counts as a violation, because unverifiable is not
 * verified (Codex peer review b81696804b98).
 */
function checkGravity(repoRoot = REPO) {
  const failures = [];
  const gravityPath = path.join(repoRoot, 'memory', 'AMY_GRAVITY.md');
  if (!fs.existsSync(gravityPath)) return [`memory/AMY_GRAVITY.md missing`];
  const text = fs.readFileSync(gravityPath, 'utf8');

  if (!extractNeverListCore(text)) {
    failures.push('NEVER-LIST CORE section missing or empty');
  }

  const { rows, found, strayLines } = parseGravityBlock(text);
  if (!found) return [...failures, 'LAWS section missing'];
  if (rows.length === 0) return [...failures, 'LAWS section has zero parseable rows'];
  if (rows.length > MAX_LAWS) {
    failures.push(`row cap exceeded: ${rows.length} laws > ${MAX_LAWS}; retire one to add one`);
  }

  // Codex review 75636d17f4b1: a mangled or vanished row must never land
  // green. Every nonblank line inside the LAWS block parses as a row, and the
  // parsed count matches the machine-read ratified count in the preamble.
  for (const s of strayLines || []) {
    failures.push(
      `LAWS block line ${s.line}: unparseable content (mangled or malformed row): "${s.text}"`,
    );
  }
  const ratified = parseRatifiedCount(text);
  if (ratified === null) {
    failures.push('missing "Ratified rows: N" line in the laws file preamble');
  } else if (rows.length !== ratified) {
    failures.push(
      `parsed ${rows.length} law rows but the preamble ratifies ${ratified}; a law vanished or appeared without an amendment`,
    );
  }

  const seen = new Set();
  const userEntries = readSettingsEntries(path.join(repoRoot, 'claude-config', 'settings.json'));
  const projectEntries = readSettingsEntries(path.join(repoRoot, '.claude', 'settings.json'));

  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  // STATIC RUNG. Screen EVERY hook registered on a context event, not only
  // those a law row happens to cite. Codex peer review b81696804b98: the
  // dynamic rung alone missed verify-hook-paths.mjs, which no law names, so
  // the hook auditor was still reporting through the dead channel after the
  // first sweep. Coverage follows registration.
  for (const f of screenInjectorSources(repoRoot, [
    ...(userEntries || []),
    ...(projectEntries || []),
  ])) {
    failures.push(`delivery screen: ${f}`);
  }

  // DYNAMIC RUNG. One probe per hook however many rows cite it
  // (memory-path-enforce.sh is named by both g8 and g18). Lazily built so a
  // tree with zero hook tokens spawns nothing.
  const deliveryCache = new Map();
  let unionPrompt = null;
  const probeDelivery = (hookName, entries) => {
    if (deliveryCache.has(hookName)) return deliveryCache.get(hookName);
    const registrations = (entries || []).filter(
      (e) => e.command.includes(hookName) && INJECTION_EVENTS.includes(e.event),
    );
    // Probe each registration on its OWN event with the MINIMAL prompt that
    // trips its declared matcher. A union prompt cannot prove which token a
    // hook matched, so it is the fallback for empty matchers only, where the
    // hook does its trigger detection in-process and configuration says
    // nothing about it.
    let result = { status: 'skipped', detail: 'no injection-event registration found' };
    for (const reg of registrations) {
      const literals = matcherLiterals(reg.matcher);
      let prompt;
      if (literals.length > 0) {
        prompt = literals[0];
      } else {
        if (unionPrompt === null) {
          unionPrompt = buildTriggerPrompt(repoRoot, [
            ...(userEntries || []),
            ...(projectEntries || []),
          ]);
        }
        prompt = unionPrompt;
      }
      result = probeInjector({
        repoRoot,
        hookName,
        command: reg.command,
        prompt,
        event: reg.event,
      });
      if (result.status !== 'delivered' && result.status !== 'blocked') break;
    }
    deliveryCache.set(hookName, result);
    return result;
  };

  for (const row of rows) {
    const where = `${row.id} (line ${row.line})`;
    if (seen.has(row.id)) failures.push(`${where}: duplicate id`);
    seen.add(row.id);
    if (!STATUSES.includes(row.status)) {
      failures.push(`${where}: status "${row.status}" not in ${STATUSES.join('|')}`);
    }
    if (row.keywords.length === 0) failures.push(`${where}: no keywords`);
    if (row.enforcement.length === 0) failures.push(`${where}: no enforcement tokens`);
    if (!exists(row.authority)) failures.push(`${where}: authority file missing: ${row.authority}`);

    const mechanical = row.enforcement.filter((t) => t.type !== 'policy');
    if (mechanical.length === 0 && (row.status === 'SOLID' || row.status === 'PARTIAL')) {
      failures.push(
        `${where}: only policy: tokens but claims ${row.status}; law g0 forbids that (POLICY or PROPOSED only)`,
      );
    }

    for (const tok of row.enforcement) {
      const label = `${where} token ${tok.type}:${tok.value}`;
      if (!TOKEN_TYPES.includes(tok.type)) {
        failures.push(`${label}: ExampleCo token type`);
        continue;
      }
      if (tok.type === 'npm') {
        let scripts = {};
        try {
          scripts =
            JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts || {};
        } catch {
          /* package.json unreadable -> counted below */
        }
        if (!scripts[tok.value]) failures.push(`${label}: npm script not in package.json`);
      } else if (tok.type === 'hook') {
        const entries = tok.scope === 'project' ? projectEntries : userEntries;
        const file =
          tok.scope === 'project' ? '.claude/settings.json' : 'claude-config/settings.json';
        let registered = false;
        if (!tok.scope || (tok.scope !== 'user' && tok.scope !== 'project')) {
          failures.push(`${label}: hook token needs @user or @project scope`);
        } else if (!entries) {
          failures.push(`${label}: ${file} missing or unparseable`);
        } else if (!entries.some((e) => e.command.includes(tok.value))) {
          failures.push(`${label}: not registered in any command in ${file}`);
        } else {
          registered = true;
        }
        const hookPath = `scripts/claude-hooks/${tok.value}`;
        const onDisk = exists(hookPath);
        if (!onDisk) failures.push(`${label}: hook script missing on disk: ${hookPath}`);

        // g0's second half: a registered, on-disk INJECTOR that reaches only
        // the terminal enforces nothing. Prove delivery or fail.
        if (registered && onDisk) {
          const kind = classifyHook({ hookName: tok.value, entries });
          if (kind.kind === 'injector') {
            const probe = probeDelivery(tok.value, entries);
            if (probe.status === 'inert') {
              failures.push(
                `${label}: INJECTOR reaches the terminal but NOT the model, so the law it ExampleCos does not exist (g0 delivery). ${probe.detail}. Emit via emitToModel() from scripts/claude-hooks/lib/hook-context.mjs.`,
              );
            } else if (probe.status === 'crashed') {
              failures.push(
                `${label}: INJECTOR failed to run in production form (${probe.detail}); a hook that cannot start delivers nothing`,
              );
            } else if (probe.status === 'skipped') {
              // FAIL CLOSED (Codex peer review b81696804b98). A probe that
              // cannot run proves nothing; treating it as a pass lets a hook
              // sit permanently unverified while the lint prints green.
              failures.push(
                `${label}: INJECTOR delivery could NOT be verified (${probe.detail}); unverifiable is not verified`,
              );
            }
            // `delivered` and `blocked` both pass: injection reached the
            // model, or the hook enforced by stopping the prompt outright.
          }
        }
      } else if (tok.type === 'registry') {
        let memText = '';
        try {
          memText = fs.readFileSync(path.join(repoRoot, 'memory', 'MEMORY.md'), 'utf8');
        } catch {
          /* handled below */
        }
        const registry = parseRegistryBlock(memText);
        if (!registry.rows.some((r) => r.id === tok.value)) {
          failures.push(`${label}: no CORE COMPONENTS registry row with id "${tok.value}"`);
        }
      } else {
        // test / lib / script / policy / ledger: a repo-relative file
        if (!exists(tok.value)) failures.push(`${label}: file missing on disk: ${tok.value}`);
      }
    }
  }
  return failures;
}

function main() {
  const failures = checkGravity(REPO);
  if (failures.length === 0) {
    console.log(
      `[verify-gravity-drift] CLEAN: every law's enforcement exists, is wired, and every injector delivers to the model.`,
    );
    process.exit(0);
  }
  console.error(`[verify-gravity-drift] DRIFT: ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    'A law whose enforcement is missing or unwired has decayed to memory-only (law g0). Fix the wiring or amend the laws file via the gravity-lock protocol.',
  );
  process.exit(1);
}

if (require.main === module) main();
module.exports = { checkGravity };
