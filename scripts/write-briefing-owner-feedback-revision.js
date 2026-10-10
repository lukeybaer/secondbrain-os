'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  renderOwnerFeedbackRevisionReport,
  renderOwnerFeedbackV4Report,
} = require('./lib/briefing-round-two-report.js');

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || String(argv[index + 1]).startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return argv[index + 1];
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The successful rename removes the temporary file.
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--packet', '--out']);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index])) throw new Error(`unknown argument: ${argv[index]}`);
    if (!argv[index + 1] || String(argv[index + 1]).startsWith('--')) {
      throw new Error(`${argv[index]} requires a value`);
    }
  }
  const packetFile = path.resolve(valueAfter(argv, '--packet'));
  const outputFile = path.resolve(valueAfter(argv, '--out'));
  const packet = JSON.parse(fs.readFileSync(packetFile, 'utf8'));
  if (packet.format === 'owner-feedback-v4') {
    packet.redDeltas = (packet.redDeltas || []).map((row) => ({
      ...row,
      diagrams: (row.diagrams || []).map((diagram) => ({
        ...diagram,
        svg: diagram.svgFile
          ? fs.readFileSync(path.resolve(path.dirname(packetFile), diagram.svgFile), 'utf8')
          : diagram.svg,
      })),
    }));
  }
  const html = packet.format === 'owner-feedback-v4'
    ? renderOwnerFeedbackV4Report(packet)
    : renderOwnerFeedbackRevisionReport(packet);
  writeAtomic(outputFile, html);
  return {
    packetFile,
    outputFile,
    sizeBytes: Buffer.byteLength(html),
    date: packet.date,
  };
}

if (require.main === module) {
  try {
    const result = main();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[write-briefing-owner-feedback-revision] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, writeAtomic };
