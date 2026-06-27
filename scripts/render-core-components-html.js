#!/usr/bin/env node
// Render the core-component one-pagers (dev-plans/core/<name>.md) into a single
// dark-theme HTML page (dev-plans/core/core-components.html) for reading in the browser.
// Minimal, dependency-free markdown rendering (headings, lists, bold, inline code,
// [[wikilinks]]). One-off view generator; safe to re-run.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'dev-plans', 'core');
const ORDER = [
  'self-heal',
  'briefing',
  'spine',
  'memory',
  'graphiti',
  'skill-management',
  'llm-fallback-ladder',
  'voice-call-stack',
  'session-isolation',
  'devops-release',
  'video-generation',
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>');
  return s;
}
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^### /.test(line)) {
      closeList();
      html += '<h3>' + inline(line.slice(4)) + '</h3>';
      continue;
    }
    if (/^## /.test(line)) {
      closeList();
      html += '<h2>' + inline(line.slice(3)) + '</h2>';
      continue;
    }
    if (/^# /.test(line)) {
      closeList();
      html += '<h1>' + inline(line.slice(2)) + '</h1>';
      continue;
    }
    if (/^\s*-\s/.test(line)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += '<li>' + inline(line.replace(/^\s*-\s/, '')) + '</li>';
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    html += '<p>' + inline(line) + '</p>';
  }
  closeList();
  return html;
}

const cards = [];
const toc = [];
for (const name of ORDER) {
  const file = path.join(DIR, name + '.md');
  if (!fs.existsSync(file)) {
    cards.push(
      `<section id="${name}"><h1>${name}</h1><p class="missing">MISSING: ${name}.md</p></section>`,
    );
    toc.push({ name, title: name + ' (MISSING)' });
    continue;
  }
  const md = fs.readFileSync(file, 'utf8');
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : name;
  toc.push({ name, title });
  cards.push(
    `<section id="${name}"><div class="src">dev-plans/core/${name}.md</div>${mdToHtml(md)}</section>`,
  );
}

const navHtml = toc
  .map((t, i) => `<a href="#${t.name}"><span class="n">${i + 1}</span>${esc(t.title)}</a>`)
  .join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amy Core Components (${ORDER.length})</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f0f0f; color: #e6e6e6; font: 15px/1.6 -apple-system, Segoe UI, Roboto, sans-serif; }
.wrap { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
nav { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto; background: #111; border-right: 1px solid #222; padding: 20px 14px; }
nav h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #7aa2f7; margin: 0 0 14px; }
nav a { display: flex; gap: 8px; align-items: baseline; color: #cfd3dc; text-decoration: none; padding: 7px 8px; border-radius: 6px; font-size: 13.5px; }
nav a:hover { background: #1a1a1a; color: #fff; }
nav a .n { display: inline-flex; min-width: 20px; height: 20px; align-items: center; justify-content: center; background: #222; border-radius: 5px; font-size: 11px; color: #7aa2f7; flex: none; }
main { padding: 32px 44px 120px; max-width: 920px; }
.lead { color: #9aa0aa; margin: 0 0 28px; }
.lead b { color: #e6e6e6; }
section { border-top: 1px solid #1e1e1e; padding: 30px 0 6px; }
section:first-of-type { border-top: none; }
.src { font: 12px/1 ui-monospace, monospace; color: #6a6f78; background: #141414; display: inline-block; padding: 5px 9px; border-radius: 5px; margin-bottom: 10px; }
h1 { font-size: 26px; margin: 6px 0 4px; color: #fff; }
h2 { font-size: 18px; margin: 26px 0 6px; color: #7aa2f7; }
h3 { font-size: 15px; margin: 18px 0 4px; color: #bb9af7; }
p { margin: 8px 0; }
ul { margin: 8px 0 8px 4px; padding-left: 20px; }
li { margin: 5px 0; }
code { background: #1c2030; color: #9ece6a; padding: 1px 6px; border-radius: 4px; font: 12.5px ui-monospace, monospace; }
strong { color: #fff; }
.wl { color: #e0af68; }
.missing { color: #f7768e; }
</style></head>
<body><div class="wrap">
<nav><h2>Core Components</h2>${navHtml}</nav>
<main>
<p class="lead"><b>Amy core components</b> &mdash; the foundational few, each with its one-page methodology (what it is, the single load-bearing source the code reads, how to extend it, verified current state, LESSONS, key files). Rendered from the ordered core registry in <code>scripts/render-core-components-html.js</code>.</p>
${cards.join('\n')}
</main>
</div></body></html>`;

const out = path.join(DIR, 'core-components.html');
fs.writeFileSync(out, html);
console.log(
  'Wrote ' + out + ' (' + Buffer.byteLength(html) + ' bytes, ' + ORDER.length + ' components)',
);
