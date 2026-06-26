#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function latestBriefingPath() {
  const dir = path.join(REPO, 'data', 'briefings');
  const files = fs.readdirSync(dir)
    .filter((name) => /^briefing-\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || path.join(dir, `briefing-${todayCt()}.md`);
}

function readJsonMaybe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function buildGraphitiLine(coverage) {
  if (coverage && coverage.status === 'green') {
    const provider = coverage.provider && coverage.provider.active_provider
      ? coverage.provider.active_provider
      : 'provider ExampleCo';
    const rowCount = Array.isArray(coverage.rows) ? coverage.rows.length : 0;
    const lifetime = coverage.lifetime && coverage.lifetime.status === 'green'
      ? coverage.lifetime
      : null;
    const lifetimeText = lifetime && lifetime.totals
      ? ` Lifetime replay: raw archive ${lifetime.totals.archive_lifetime_graphiti_ok || 0}/${lifetime.totals.archive_lifetime_raw || 0}, voice arcs ${lifetime.totals.voice_arc_graphiti_ok || 0}/${lifetime.totals.voice_arc_raw || 0}.`
      : '';
    const gmail = coverage.gmail_s3 && coverage.gmail_s3.detail
      ? ` Gmail S3: ${coverage.gmail_s3.detail}.`
      : '';
    return `  ✓ Graphiti: real-time and lifetime brain coverage are green (${rowCount} real-time source rows; active provider ${provider}).${lifetimeText}${gmail}`;
  }
  const detail = coverage && coverage.detail
    ? coverage.detail
    : 'No Graphiti coverage health proof exists yet.';
  return `  ✗ Graphiti: ${detail}`;
}

function replaceSystemHealthOverall(section) {
  const body = section.split(/\r?\n/);
  const hasRed = body.some((line) => /^\s*✗\s/.test(line));
  const hasYellow = body.some((line) => /^\s*\?\s/.test(line));
  const overall = hasRed
    ? '  Overall: RED — at least one subsystem is not clean; see the repair fields above.'
    : hasYellow
      ? '  Overall: YELLOW — no red failure, but the briefing is not fully clean until each yellow row is resolved or explicitly owner-assigned.'
      : '  Overall: GREEN — every required subsystem produced clean proof in this pass.';
  return section.replace(/^\s*Overall:\s.*$/m, overall);
}

function refreshGraphitiLineInMarkdown(markdown, coverage) {
  const line = buildGraphitiLine(coverage);
  const start = markdown.search(/^SYSTEM HEALTH:\s*$/m);
  if (start < 0) throw new Error('SYSTEM HEALTH section not found');
  const rest = markdown.slice(start);
  const next = rest.slice('SYSTEM HEALTH:'.length).search(/^\S[^\n]*:\s*$/m);
  const end = next >= 0 ? start + 'SYSTEM HEALTH:'.length + next : markdown.length;
  let section = markdown.slice(start, end);
  if (/^\s*[✓✗?]\sGraphiti:/m.test(section)) {
    section = section.replace(/^\s*[✓✗?]\sGraphiti:.*$/m, line);
  } else {
    section = section.replace(/^SYSTEM HEALTH:\s*$/m, `SYSTEM HEALTH:\n\n${line}`);
  }
  section = replaceSystemHealthOverall(section);
  return markdown.slice(0, start) + section + markdown.slice(end);
}

function main() {
  const date = argValue('--date');
  const briefingPath = date
    ? path.join(REPO, 'data', 'briefings', `briefing-${date}.md`)
    : latestBriefingPath();
  const coverage = readJsonMaybe(path.join(REPO, 'data', 'agent', 'graphiti-coverage-health-latest.json'));
  const md = fs.readFileSync(briefingPath, 'utf8');
  const next = refreshGraphitiLineInMarkdown(md, coverage);
  if (next !== md) fs.writeFileSync(briefingPath, next, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    briefingPath,
    graphitiStatus: coverage && coverage.status ? coverage.status : 'missing',
    changed: next !== md,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildGraphitiLine,
  refreshGraphitiLineInMarkdown,
  replaceSystemHealthOverall,
};
