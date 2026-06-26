#!/usr/bin/env node
'use strict';

function extractSectionFreshness(body) {
  const m = String(body || '').match(/^\s*Data refreshed:\s*(.+?)\s*$/im);
  return m ? m[1].trim() : '';
}

function stripSectionFreshness(body) {
  return String(body || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*Data refreshed:/i.test(line))
    .join('\n')
    .trim();
}

function parseBriefingMarkdown(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const legacyHeaderRe = /^([A-Z]{2,}[^\n]{0,200}):\s*$/;
  const markdownHeaderRe = /^##\s+(.+?)\s*$/;
  const metadataRe = /^\s*\(source:\s/i;
  const greeting = [];
  const sections = [];
  let cur = null;

  const pushCur = () => {
    if (!cur) return;
    while (cur.body.length && cur.body[cur.body.length - 1].trim() === '') cur.body.pop();
    while (cur.body.length && cur.body[0].trim() === '') cur.body.shift();
    const sectionBody = cur.body.join('\n');
    cur.refreshedAt = extractSectionFreshness(sectionBody);
    cur.body = stripSectionFreshness(sectionBody);
    sections.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const markdown = markdownHeaderRe.exec(line);
    const legacy = legacyHeaderRe.exec(line);
    const title = markdown ? markdown[1].trim() : legacy ? legacy[1].trim() : '';
    if (title) {
      pushCur();
      cur = { title, body: [] };
      continue;
    }
    if (cur) {
      if (!metadataRe.test(line)) cur.body.push(line);
      continue;
    }
    if (line.trim() !== '---') greeting.push(line);
  }
  pushCur();

  let date = null;
  for (const line of greeting) {
    if (/^\s*Generated:/i.test(line)) continue;
    const m = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      date = m[1];
      break;
    }
  }
  const cleanGreeting = greeting
    .join('\n')
    .replace(/^#\s+/m, '')
    .trim();
  const greetLine = (cleanGreeting.split(/\r?\n/).find((line) => line.trim()) || '').trim();
  return { date, greeting: cleanGreeting, greetLine, sections };
}

module.exports = {
  extractSectionFreshness,
  stripSectionFreshness,
  parseBriefingMarkdown,
};
