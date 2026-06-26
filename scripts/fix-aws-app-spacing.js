'use strict';
// One-off self-heal: the AWS "Per app / cost center" lines lost the 4+ leading
// spaces the dashboard parser (ec2-server parseAwsCostsBody apps-mode) requires,
// so the card showed "0 apps". Reformat them and push.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const f = path.join(__dirname, '..', 'data', 'briefings', 'briefing-2026-06-03.md');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
let mode = false, changed = 0;
for (let i = 0; i < lines.length; i++) {
  if (/Per app \/ cost center/i.test(lines[i])) { mode = true; continue; }
  if (mode) {
    if (/^\s*Top services/i.test(lines[i]) || /^[A-Z].*:\s*$/.test(lines[i])) { mode = false; continue; }
    if (/^\s*$/.test(lines[i])) continue;
    const m = lines[i].match(/^\s*(.+?)\s+\$([\d.]+)\s*$/);
    if (m) { lines[i] = '    ' + m[1].trim() + '  $' + m[2]; changed++; continue; }
    const unk = lines[i].match(/^\s*(.+?)\s+cost ExampleCo\s*(--.*)?$/i);
    if (unk) { lines[i] = '    ' + unk[1].trim() + '  cost ExampleCo ' + (unk[2] || '').trim(); changed++; }
  }
}
fs.writeFileSync(f, lines.join('\n'));
console.log('reformatted', changed, 'Per-app lines');

const KEY = path.join(os.homedir(), '.ssh', 'sb-key.pem');
const HOST = 'ec2-user@ExampleCo';
const RD = '/opt/secondbrain/data/briefings';
cp.execFileSync('scp', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', f, `${HOST}:${RD}/.b.tmp`]);
cp.execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST, `mv -f ${RD}/.b.tmp ${RD}/briefing-2026-06-03.md`]);
console.log('pushed');
