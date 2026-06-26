'use strict';
/**
 * Regenerate the operational card sections of today's briefing from CURRENT
 * (fixed) state using the exported renderers (no Claude QC judge, no hang), then
 * push the single consolidated markdown to EC2 atomically. Operates on the LOCAL
 * briefing copy (which already ExampleCos the System Health + Blockers patches and,
 * after the Codex run, the fresh news), so one push keeps everything consistent.
 *
 * Usage: node scripts/regen-ops-sections-and-push.js [date]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const R = require('./refresh-briefing-generated-sections.js');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const LOCAL = path.join(__dirname, '..', 'data', 'briefings', `briefing-${date}.md`);
const KEY = process.env.SECONDBRAIN_SSH_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
const HOST = 'ec2-user@ExampleCo';
const RD = '/opt/secondbrain/data/briefings';

function tryRegen(md, label, fn) {
  try {
    const section = fn(md);
    if (section && String(section).trim()) {
      const next = R.replaceSection(md, label, String(section));
      console.log(`  regenerated ${label} (${next.length - md.length >= 0 ? '+' : ''}${next.length - md.length})`);
      return next;
    }
    console.log(`  ${label}: renderer returned empty, kept existing`);
  } catch (e) { console.log(`  ${label}: ERROR ${String(e && e.message).slice(0, 100)}, kept existing`); }
  return md;
}

function main() {
  if (!fs.existsSync(LOCAL)) { console.error('local briefing missing:', LOCAL); process.exit(1); }
  let md = fs.readFileSync(LOCAL, 'utf8');

  md = tryRegen(md, 'ACTION ITEMS', () => R.renderActionItemsSection());
  md = tryRegen(md, 'FEATURE BACKLOG', () => R.renderFeatureBacklogSection());
  md = tryRegen(md, 'AMY PROJECTS', () => R.renderAmyProjectsSection());
  if (R.renderVoiceConfirmationSection && R.replaceOrInsertVoiceConfirmationSection) {
    try { md = R.replaceOrInsertVoiceConfirmationSection(md, R.renderVoiceConfirmationSection()); console.log('  regenerated VOICE CONFIRMATION'); } catch (e) { console.log('  VOICE: ERROR', String(e && e.message).slice(0, 80)); }
  }
  // Blockers LAST so it reflects every other section's fixed state.
  md = tryRegen(md, 'BLOCKERS - briefing quality gates', (m) => R.renderBlockersSection(m));

  fs.writeFileSync(LOCAL, md);
  console.log('wrote local', LOCAL, md.length, 'bytes');

  // Atomic push to EC2.
  const rtmp = `${RD}/.briefing-${date}.md.tmp`;
  cp.execFileSync('scp', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', LOCAL, `${HOST}:${rtmp}`]);
  cp.execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST, `mv -f ${rtmp} ${RD}/briefing-${date}.md`]);
  console.log('pushed to EC2 atomically');
}

main();
