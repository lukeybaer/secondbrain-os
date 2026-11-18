#!/usr/bin/env node
'use strict';
// Hit-rate evaluation for the rule full-text search beside the keyword router.
// Router alone = core-component registry match (doc, LESSONS, briefing spec).
// A hit means any acceptable file for the prompt is in the output.
//   node scripts/eval-rule-search.js [fixture.json]
const fs = require('node:fs');
const path = require('node:path');
const registry = require('./lib/core-component-registry.js');
const rs = require('./lib/rule-search.js');

// A core doc and its LESSONS file are one family: the router injects both.
// A skill's LEARNINGS/LESSONS belong with its SKILL.md.
const family = (f) => f.replace(/\.LESSONS\.md$/, '.md').replace(/\/(LEARNINGS|LESSONS)\.md$/, '/SKILL.md');

function evaluate(root, cases) {
  const rows = registry.parseRegistryBlock(fs.readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8')).rows;
  const idx = rs.loadIndex(root);
  let router = 0;
  let search = 0;
  let both = 0;
  const misses = [];
  for (const c of cases) {
    const routed = new Set();
    const want = new Set(c.expected.map(family));
    for (const r of registry.matchComponents(c.prompt, rows)) {
      routed.add(r.docPath);
      if (r.id === 'briefing') routed.add('memory/project_briefing_spec.md');
    }
    const found = new Set(rs.formatMatches(rs.search(idx, c.prompt, rs.CANDIDATES), [...routed]).shown.map(family));
    const r = [...want].some((e) => routed.has(e));
    const s = [...want].some((e) => found.has(e));
    if (r) router++;
    if (s) search++;
    if (r || s) both++;
    else misses.push(c.prompt.slice(0, 80));
  }
  const n = cases.length;
  return { n, router, search, both, routerPct: router / n, searchPct: search / n, bothPct: both / n, misses };
}

module.exports = { evaluate };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const fixture = process.argv[2] || path.join(__dirname, '__tests__', 'fixtures', 'rule-search-eval.json');
  const res = evaluate(root, JSON.parse(fs.readFileSync(fixture, 'utf8')));
  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log(`prompts ${res.n}\nrouter alone ${res.router} (${pct(res.routerPct)})\nsearch alone ${res.search} (${pct(res.searchPct)})\nrouter+search ${res.both} (${pct(res.bothPct)})`);
  if (process.argv.includes('--misses')) console.log(res.misses.join('\n'));
}
