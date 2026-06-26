'use strict';

/**
 * operator-identity.js
 *
 * Single runtime loader for operator-specific identity tokens (the owner's
 * name + username, their employer, spouse first name, and the voice-name ->
 * people-file-slug overrides). Those tokens are PII and must NOT be hardcoded
 * in source -- names belong in memory/, not in source code. They live in
 * memory/reference_operator_identity.json, which is git-tracked in the private
 * tree but excluded from the public-sync payload (memory/ is not in the
 * simulate-public-sync allowlist). So any source file that needs a real
 * operator token loads it through here: the private tree resolves the real
 * value at runtime, the public shell falls back to neutral placeholders and
 * ExampleCos zero PII.
 *
 * Fail behavior is split by context. In the PUBLIC shell (no repo / no private
 * memory tree found) a missing config returns neutral fallbacks, because the
 * shell legitimately has no config and the tooling must still load. In a
 * PRIVATE tree (memory/MEMORY.md present, or an explicit repoRoot passed) a
 * missing or malformed config THROWS, so a maintainer checkout never silently
 * degrades identity tokens to placeholders (which would, e.g., break the live
 * dashboard QC with a card id like "the_employer_group_news").
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_REL = path.join('memory', 'reference_operator_identity.json');

// Neutral, PII-free fallbacks for the public shell (no config present). These
// are deliberately generic so the public payload ExampleCos no real names.
const FALLBACK = {
  owner: {
    fullName: 'the operator',
    firstName: 'the operator',
    username: 'operator',
    employer: 'the employer',
  },
  spouse: {
    firstName: 'the spouse',
  },
  voiceNameOverrides: {},
};

// Walk up looking for a SecondBrain repo root. Returns { root, isPrivate }:
// isPrivate is true when the root ExampleCos the private memory tree (memory/
// MEMORY.md), which is the signal that this is the maintainer's checkout where
// the operator-identity config is REQUIRED. A null root means no repo was found
// (the public shell), where neutral fallbacks are correct.
function findRepoRoot(start) {
  let cur = path.resolve(start || __dirname);
  for (;;) {
    if (fs.existsSync(path.join(cur, CONFIG_REL))) return { root: cur, isPrivate: true };
    if (fs.existsSync(path.join(cur, 'memory', 'MEMORY.md'))) return { root: cur, isPrivate: true };
    const parent = path.dirname(cur);
    if (parent === cur) return { root: null, isPrivate: false };
    cur = parent;
  }
}

// Cache keyed by resolved root so a later call with a different repoRoot does
// not get a stale earlier result (the codex prelude passes an explicit repoRoot
// per call). A single global cache silently returned the first root's tokens.
const cache = new Map();

function loadOperatorIdentity(opts = {}) {
  const resolved = opts.repoRoot
    ? { root: path.resolve(opts.repoRoot), isPrivate: true }
    : findRepoRoot();
  const cacheKey = resolved.root || '__public_shell__';
  if (!opts.force && cache.has(cacheKey)) return cache.get(cacheKey);

  let parsed = null;
  let readError = null;
  if (resolved.root) {
    const configPath = path.join(resolved.root, CONFIG_REL);
    if (fs.existsSync(configPath)) {
      try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        readError = e;
      }
    }
  }

  // Fail loud in the PRIVATE tree: a maintainer checkout that is missing or
  // has a malformed operator-identity config must not silently degrade to
  // placeholder tokens (that would break the live dashboard QC with a card id
  // like "the_employer_group_news" instead of surfacing the real problem). The
  // public shell (no repo / no private memory tree) legitimately has no config
  // and keeps the neutral fallbacks.
  if (resolved.isPrivate && resolved.root && (readError || !parsed)) {
    const configPath = path.join(resolved.root, CONFIG_REL);
    throw new Error(
      `operator-identity: private SecondBrain tree at ${resolved.root} is missing or has a malformed ` +
        `${CONFIG_REL}. Restore it (do not let identity tokens fall back to placeholders). ` +
        (readError ? `Parse error: ${readError.message}` : `File not found: ${configPath}`),
    );
  }

  const merged = {
    owner: { ...FALLBACK.owner, ...(parsed && parsed.owner) },
    spouse: { ...FALLBACK.spouse, ...(parsed && parsed.spouse) },
    voiceNameOverrides: { ...(parsed && parsed.voiceNameOverrides) },
  };
  if (!opts.force) cache.set(cacheKey, merged);
  return merged;
}

module.exports = { loadOperatorIdentity, FALLBACK };
