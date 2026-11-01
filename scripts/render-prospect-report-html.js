#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(value) {
  let text = escapeHtml(value);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return text;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;

  function closeList() {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[i + 1])) {
      closeList();
      const rows = [];
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      rows.push(`<thead><tr>${cells(line).map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        body.push(`<tr>${cells(lines[i]).map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
        i += 1;
      }
      i -= 1;
      out.push(`<div class="table-wrap"><table>${rows.join('')}<tbody>${body.join('')}</tbody></table></div>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (ordered || bullet) {
      const nextList = ordered ? 'ol' : 'ul';
      if (list !== nextList) {
        closeList();
        list = nextList;
        out.push(`<${list}>`);
      }
      out.push(`<li>${inline((ordered || bullet)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line.replace(/\s{2}$/, ''))}</p>`);
  }
  closeList();
  return out.join('\n');
}

function renderProspectReport(markdown) {
  const title = (String(markdown).match(/^#\s+(.+)$/m) || [null, 'Prospect report'])[1];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#17211b;--muted:#637066;--paper:#fbfaf6;--panel:#fff;--line:#dce2da;--green:#1f6949;--gold:#a46b2b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto;padding:42px 28px 72px}h1{font-size:clamp(2rem,4vw,3.4rem);line-height:1.06;margin:0 0 24px;letter-spacing:-.035em}h2{margin:52px 0 18px;padding-top:12px;border-top:2px solid var(--ink);font-size:1.55rem}h3{margin:34px 0 8px;font-size:1.2rem;color:var(--green)}p{max-width:82ch;margin:8px 0 14px}a{color:var(--green);text-decoration-thickness:1px;text-underline-offset:3px}strong{font-weight:750}code{font:0.92em ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef1ec;padding:2px 5px;border-radius:4px}ol,ul{max-width:86ch;padding-left:1.45rem}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 8px 28px rgba(20,35,26,.06)}table{width:100%;border-collapse:collapse;min-width:900px}th{background:#edf3ed;text-align:left;color:#304338}th,td{padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fafcf8}h3+ p strong:first-child{color:var(--gold)}@media(max-width:700px){main{padding:28px 18px 56px}h2{margin-top:38px}}
</style></head><body><main>${renderMarkdown(markdown)}</main></body></html>`;
}

function main(argv = process.argv.slice(2)) {
  const input = argv[0];
  const output = argv[1] || (input ? input.replace(/\.md$/i, '.html') : '');
  if (!input || !output) throw new Error('usage: render-prospect-report-html.js input.md [output.html]');
  const html = renderProspectReport(fs.readFileSync(path.resolve(input), 'utf8'));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), html, 'utf8');
  process.stdout.write(`${path.resolve(output)}\n`);
}

if (require.main === module) main();

module.exports = { renderMarkdown, renderProspectReport };
