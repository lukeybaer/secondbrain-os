#!/usr/bin/env node
// One-shot fix for stale CONTENT PIPELINE "N stuck in regen" line.
// 2026-05-23: refresh-briefing-generated-sections does not regenerate the
// CONTENT PIPELINE section, so once the morning briefing wrote "3 stuck"
// the line stayed there even after the manifest cleared. This script
// reads the current manifest, counts truly stuck videos, and patches the
// markdown in place. Idempotent.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const briefingPath = path.join(REPO, 'data', 'briefings', `briefing-${process.argv[2] || new Date().toISOString().slice(0, 10)}.md`);
const m = JSON.parse(fs.readFileSync(path.join(REPO, 'content-review', 'pending', 'manifest.json'), 'utf8'));
const stuck = (m.videos || []).filter((v) =>
  v.video_needs_regen === true ||
  v.thumbnail_needs_regen === true ||
  ['video_rejected', 'thumbnail_rejected', 'rejected'].includes(String(v.status || '')) ||
  ['failed', 'rubric_failed', 'dead-letter', 'hard_blocked'].includes(String(v.regen_status || '')) ||
  v.regen_hard_blocked === true,
).length;
let md = fs.readFileSync(briefingPath, 'utf8');
const before = md;
const stuckLineRe = /  \d+ stuck in regen\n/;
md = md.replace(stuckLineRe, `  ${stuck} stuck in regen\n`);
const longDash = String.fromCharCode(8212);
const enDash = String.fromCharCode(8211);
const rejectedHeader = `Rejected ${longDash} awaiting regen:`;
const rejectedHeaderEn = `Rejected ${enDash} awaiting regen:`;
// Strip the entire "Rejected , awaiting regen:" block when stuck === 0.
if (stuck === 0) {
  const startIdx = md.indexOf(rejectedHeader) >= 0 ? md.indexOf(rejectedHeader) : md.indexOf(rejectedHeaderEn);
  if (startIdx >= 0) {
    // Find the next blank line OR the next ALL-CAPS section header.
    let endIdx = md.length;
    for (let i = startIdx; i < md.length; i++) {
      if (md.slice(i, i + 2) === '\n\n') { endIdx = i + 1; break; }
      if (/^\n[A-Z][A-Z &]+:/.test(md.slice(i, i + 30))) { endIdx = i + 1; break; }
    }
    // Also remove the leading two-space indent line above
    let lineStart = startIdx;
    while (lineStart > 0 && md[lineStart - 1] !== '\n') lineStart--;
    md = md.slice(0, lineStart) + md.slice(endIdx);
  }
}
if (md !== before) {
  fs.writeFileSync(briefingPath, md);
  console.log(`[patch-content-pipeline-stuck] patched ${briefingPath}: stuck=${stuck}`);
} else {
  console.log(`[patch-content-pipeline-stuck] no changes needed (already stuck=${stuck})`);
}
