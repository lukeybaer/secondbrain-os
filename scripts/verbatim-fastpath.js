// verbatim-fastpath.js  (Layer 2 read path for query_knowledge)
//
// ExampleCo 2026-06-14: "searchable too by Amy verbatim." When ExampleCo asks for his or
// Amy's exact words on a call ("what did I say about the dentist xrays", "read
// me back verbatim"), return the literal passage from the session FTS index,
// which Graphiti (extracted facts, not words) cannot do. Mirrors the
// transcript-fastpath module pattern so ec2-server.js only gains a require + a
// call site, not the logic.

const { spawnSync } = require('child_process');

const VERBATIM_INTENT =
  /\b(verbatim|word[\s-]?for[\s-]?word|exact words|my exact words|read (?:me |it |that |back )*back|what did (?:i|you|we) (?:say|said|tell)|exactly what (?:i|you|we) (?:said|told)|read me .*(?:exact|verbatim))\b/i;

// Words that are intent/scaffolding, not the thing being searched for.
const STOP = new Set(
  (
    'what did i you we say said tell told about the a an exactly exact verbatim word words for read back ' +
    'me my it that this to of on show give was were is are please amy here from session over'
  ).split(/\s+/),
);

/**
 * Pure: does the question ask for verbatim recall, and if so what are the
 * content keywords? Returns { keywords } or null. Keeps FTS5 MATCH safe by
 * passing only alphanumeric tokens (no user punctuation reaches the matcher).
 */
function buildVerbatimQuery(question) {
  const q = String(question || '');
  if (!VERBATIM_INTENT.test(q)) return null;
  const tokens = q.toLowerCase().match(/[a-z0-9]+/g) || [];
  const keywords = tokens.filter((t) => t.length > 2 && !STOP.has(t));
  if (keywords.length === 0) return null;
  return { keywords: keywords.join(' ') };
}

/**
 * If the question is a verbatim ask, search the session FTS and format the
 * passages for speech. Returns a string, or null to fall through to the other
 * fast-paths. Best-effort: any failure returns null (never throws into the
 * handler).
 */
function tryVerbatimFastPath(question, opts = {}) {
  const built = buildVerbatimQuery(question);
  if (!built) return null;
  const script = opts.ftsScript || '/opt/secondbrain/scripts/session-fts.py';
  const db = opts.db || process.env.SB_SESSION_FTS_DB || '/opt/secondbrain/data/session-fts.sqlite';
  const py = opts.python || 'python3';
  let out;
  try {
    const r = spawnSync(
      py,
      [script, '--db', db, 'search', built.keywords, '--limit', String(opts.limit || 3)],
      {
        encoding: 'utf8',
        timeout: opts.timeout || 8000,
      },
    );
    out = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
  if (!out || !Array.isArray(out.results) || out.results.length === 0) return null;
  const lines = out.results.map((m) => {
    const when = String(m.ts || '').slice(0, 10);
    const body = String(m.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    return `From a session on ${when}: "${body}"`;
  });
  return 'Here is what I found, word for word:\n\n' + lines.join('\n\n');
}

module.exports = { buildVerbatimQuery, tryVerbatimFastPath };
