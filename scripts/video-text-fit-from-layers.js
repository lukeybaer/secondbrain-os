#!/usr/bin/env node
'use strict';

// Write the SHA-bound text-fit receipt for a final video built by the daily
// Shorts builder (ec2-build-from-queue.py), measured from the exact ASS text
// layers its build dir burned in.
//
//   node scripts/video-text-fit-from-layers.js --video <data/youtube/<id>.mp4> \
//     --build-dir <data/youtube/build/<id>> [--duration-sec N]
//
// The layer list comes from the build dir (burnedLayersFromBuildDir), never
// from the command line, and the build's final.mp4 must be the same bytes as
// --video. The one-frame thumbnail cover at 0 s is the thumbnail's own text
// and is governed by the thumbnail gate.
//
// Exit 0 when the receipt passed; 1 when it failed or could not be measured
// (fail closed: the release gate keeps the video held).

const fs = require('fs');
const { createVideoTextFitReceipt } = require('./lib/video-text-fit-receipt.js');
const {
  TEXT_FIT_VIEWPORT,
  burnedLayersFromBuildDir,
  measureAssLayerSamples,
} = require('./lib/video-text-fit-layers.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--video') out.video = value;
    else if (flag === '--build-dir') out.buildDir = value;
    else if (flag === '--duration-sec') out.durationSec = Number(value);
    else continue;
    i += 1;
  }
  return out;
}

async function run(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (!options.video || !fs.existsSync(options.video)) {
    throw new Error(`final video not found: ${options.video || '(missing --video)'}`);
  }
  if (!options.buildDir) throw new Error('missing --build-dir');
  const { layers, provenance } = burnedLayersFromBuildDir(options.buildDir, options.video);
  const samples = await (deps.measure || measureAssLayerSamples)(layers);
  const { receipt, receiptPath } = createVideoTextFitReceipt({
    videoPath: options.video,
    viewport: TEXT_FIT_VIEWPORT,
    durationMs: Number.isFinite(options.durationSec) ? Math.round(options.durationSec * 1000) : null,
    samples,
  });
  return {
    passed: receipt.passed,
    receiptPath,
    layers: layers.map((file) => require('path').basename(file)),
    layerProvenance: provenance,
    sampleCount: receipt.timeline.sampleCount,
    textElementCount: receipt.textElementCount,
    defects: receipt.defects.slice(0, 5),
  };
}

if (require.main === module) {
  run()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`[text-fit] measurement failed closed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, run };
