#!/usr/bin/env node
// voiceprint-enroll.mjs
//
// Enroll a speaker voiceprint template for Amy's privileged-action gate.
//
// USAGE (run once per person; the account owner and household members are the expected enrollments):
//
//   SB_VOICEPRINT_KEY=<64-char-hex-or-passphrase> \
//   node scripts/voiceprint-enroll.mjs --name ExampleCo --audio path/to/ExampleCo-sample.wav
//
//   Options:
//     --name <Name>        Required. The display name stored on the template
//                          (use the enrolled household member labels; the gate trusts these).
//     --audio <file>       Required. WAV/MP3/OGG sample, ideally 15-30s of
//                          clean solo speech (a phone-quality clip is fine).
//     --store <file>       Optional. Template store path. Default:
//                          data/agent/voiceprint-templates.enc.json
//     --backend <name>     Optional. ecapa (default) or wavlm. Must match
//                          VOICE_SPEAKER_BACKEND used at verification time.
//     --max-seconds <n>    Optional. Embedding window, default 30.
//
// Requirements:
//   - SB_VOICEPRINT_KEY must be set (templates are AES-256-GCM encrypted at
//     rest; there is no plaintext fallback). Use the same key on the host
//     that verifies (EC2: add to /opt/secondbrain/.env and PM2 env).
//   - The voice embedding runtime (.venv-voice python) must be present; this
//     is the exact same backend scripts/otter-wavlm-speaker-resolver.js uses
//     (scripts/voice-embedding-ecapa.js / voice-embedding-wavlm.js).
//
// Verify an enrollment quickly:
//   node scripts/voiceprint-enroll.mjs --verify path/to/another-clip.wav
//   (prints the best-match name + cosine score against the store)

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { enrollTemplate, verifyEmbedding, DEFAULT_STORE_PATH } = require(
  path.join(__dirname, 'lib', 'voiceprint.js'),
);

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const backendName = (
  argValue('--backend', process.env.VOICE_SPEAKER_BACKEND || 'ecapa') || 'ecapa'
).toLowerCase();
// Same backend selection as scripts/otter-wavlm-speaker-resolver.js.
const backend =
  backendName === 'wavlm'
    ? require(path.join(__dirname, 'voice-embedding-wavlm.js'))
    : require(path.join(__dirname, 'voice-embedding-ecapa.js'));

const storePath = path.resolve(argValue('--store', DEFAULT_STORE_PATH));
const maxSeconds = Number(argValue('--max-seconds', '30')) || 30;

async function embeddingVectorFor(audioPath) {
  const abs = path.resolve(audioPath);
  const embedding = backend.embedOne(abs, { maxSeconds });
  const vector = embedding && embedding.vector;
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error('embedding backend returned no vector for ' + abs);
  }
  return vector;
}

async function main() {
  const verifyAudio = argValue('--verify', '');
  if (verifyAudio) {
    const vector = await embeddingVectorFor(verifyAudio);
    const result = verifyEmbedding(vector, storePath);
    console.log(JSON.stringify({ mode: 'verify', storePath, ...result }, null, 2));
    process.exit(result.match ? 0 : 2);
  }

  const name = argValue('--name', '');
  const audio = argValue('--audio', '');
  if (!name || !audio) {
    console.error(
      'usage: SB_VOICEPRINT_KEY=... node scripts/voiceprint-enroll.mjs --name ExampleCo --audio sample.wav [--store file] [--backend ecapa|wavlm]',
    );
    process.exit(1);
  }
  if (!process.env.SB_VOICEPRINT_KEY) {
    console.error(
      'SB_VOICEPRINT_KEY is not set. Templates are encrypted at rest; refusing to enroll without the key.',
    );
    process.exit(1);
  }

  const vector = await embeddingVectorFor(audio);
  const result = enrollTemplate(name, vector, storePath);
  console.log(
    JSON.stringify(
      {
        mode: 'enroll',
        backend: backendName,
        vectorDims: vector.length,
        ...result,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('[voiceprint-enroll] failed:', e.message);
  process.exit(1);
});
