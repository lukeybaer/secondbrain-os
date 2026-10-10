'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PAID_MODEL_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'BEDROCK_MODEL_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

function unavailable(component, reason, details = {}) {
  return Object.assign(new Error(`${component} unavailable: ${reason}`), {
    code: 'TELEGRAM_VOICE_TRANSCRIBER_UNAVAILABLE',
    component,
    details,
  });
}

function scrubPaidModelEnv(env = process.env) {
  const next = { ...env };
  for (const key of PAID_MODEL_ENV_KEYS) delete next[key];
  next.HF_HUB_OFFLINE = next.HF_HUB_OFFLINE || '1';
  next.TRANSFORMERS_OFFLINE = next.TRANSFORMERS_OFFLINE || '1';
  next.HF_HUB_DISABLE_TELEMETRY = next.HF_HUB_DISABLE_TELEMETRY || '1';
  return next;
}

function localVoiceRuntime({ env = process.env, homeDir = os.homedir(), runtimeDir } = {}) {
  const root = path.resolve(
    runtimeDir ||
      env.TELEGRAM_VOICE_RUNTIME_DIR ||
      path.join(homeDir, '.local', 'share', 'secondbrain', 'telegram-voice-runtime'),
  );
  const bundledPython = path.join(
    root,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  return {
    root,
    python:
      env.TELEGRAM_VOICE_PYTHON ||
      (fs.existsSync(bundledPython) ? bundledPython : env.PYTHON || env.PYTHON3 || 'python3'),
    modelRoot: path.resolve(env.TELEGRAM_VOICE_MODEL_ROOT || path.join(root, 'models')),
    component: 'local-faster-whisper',
  };
}

function parseTranscriptOutput(stdout, component) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error) throw unavailable(component, parsed.error);
    return String(parsed.text || '').trim();
  } catch (error) {
    if (error?.code === 'TELEGRAM_VOICE_TRANSCRIBER_UNAVAILABLE') throw error;
    return raw;
  }
}

function runCommand({
  command,
  args,
  audioPath,
  timeoutMs,
  env,
  component = command,
  spawn = spawnSync,
}) {
  const expandedArgs = args.includes('{audio}')
    ? args.map((arg) => (arg === '{audio}' ? audioPath : arg))
    : [...args, audioPath];
  const result = spawn(command, expandedArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    env: scrubPaidModelEnv(env),
  });
  if (result.error) {
    const code = result.error.code || 'spawn-error';
    throw unavailable(component, `${command} ${code}`, { message: result.error.message });
  }
  if (result.status !== 0) {
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      if (parsed?.error) throw unavailable(component, parsed.error);
    } catch (error) {
      if (error?.code === 'TELEGRAM_VOICE_TRANSCRIBER_UNAVAILABLE') throw error;
    }
    const message = String(result.stderr || result.stdout || `exit ${result.status}`).slice(0, 500);
    throw unavailable(component, message);
  }
  return parseTranscriptOutput(result.stdout, component);
}

// Same failure vocabulary as runCommand, but the child runs asynchronously so
// the Node event loop keeps turning while faster-whisper works. spawnSync on the
// Telegram poll path froze the whole EC2 backend for the length of every voice
// note (81 seconds on 2026-08-18), stalling HTTP routes and Vapi webhooks.
function runCommandAsync({
  command,
  args,
  audioPath,
  timeoutMs,
  env,
  component = command,
  spawnAsync = spawn,
}) {
  const expandedArgs = args.includes('{audio}')
    ? args.map((arg) => (arg === '{audio}' ? audioPath : arg))
    : [...args, audioPath];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnAsync(command, expandedArgs, {
        env: scrubPaidModelEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        unavailable(component, `${command} ${error.code || 'spawn-error'}`, {
          message: error.message,
        }),
      );
      return;
    }
    const MAX_OUTPUT = 10 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        unavailable(component, `${command} ${error.code || 'spawn-error'}`, {
          message: error.message,
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(unavailable(component, `timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        try {
          const parsed = JSON.parse(String(stdout || '').trim());
          if (parsed?.error) {
            reject(unavailable(component, parsed.error));
            return;
          }
        } catch {
          // fall through to the raw stderr/stdout message below
        }
        reject(unavailable(component, String(stderr || stdout || `exit ${code}`).slice(0, 500)));
        return;
      }
      try {
        resolve(parseTranscriptOutput(stdout, component));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// The command decision is shared by the sync and async entrypoints so the two
// can never drift on model, device, runtime, or offline-model resolution.
function resolveTranscribeCommand(audioPath, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw unavailable('telegram-local-audio-file', 'audio file missing');
  }

  const timeoutMs = Number(
    opts.timeoutMs || process.env.TELEGRAM_VOICE_TRANSCRIBE_TIMEOUT_MS || 120000,
  );
  if (opts.command) {
    return {
      command: opts.command.cmd,
      args: opts.command.args || [],
      audioPath,
      timeoutMs,
      env: opts.env || process.env,
      component: opts.command.component || opts.command.cmd,
      spawn: opts.spawn,
      spawnAsync: opts.spawnAsync,
    };
  }

  const root = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(root, 'scripts', 'transcribe.py');
  if (!fs.existsSync(scriptPath)) {
    throw unavailable('local-faster-whisper', 'scripts/transcribe.py missing');
  }

  const runtime = localVoiceRuntime({
    env: opts.env || process.env,
    homeDir: opts.homeDir,
    runtimeDir: opts.runtimeDir,
  });
  const python = opts.python || runtime.python;
  const model = opts.model || process.env.TELEGRAM_VOICE_TRANSCRIBE_MODEL || 'small';
  const device = opts.device || process.env.TELEGRAM_VOICE_TRANSCRIBE_DEVICE || 'cpu';
  return {
    command: python,
    args: [
      scriptPath,
      '{audio}',
      '--output-format',
      'json',
      '--model',
      model,
      '--device',
      device,
      '--download-root',
      runtime.modelRoot,
      '--local-files-only',
    ],
    audioPath,
    timeoutMs,
    env: opts.env || process.env,
    component: runtime.component,
    spawn: opts.spawn,
    spawnAsync: opts.spawnAsync,
  };
}

function transcribeTelegramVoiceAudio(audioPath, opts = {}) {
  return runCommand(resolveTranscribeCommand(audioPath, opts));
}

// Preferred entrypoint for anything running inside a live server process.
function transcribeTelegramVoiceAudioAsync(audioPath, opts = {}) {
  return runCommandAsync(resolveTranscribeCommand(audioPath, opts));
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function queueLedgerPath(dataDir) {
  return path.join(dataDir, 'agent', 'telegram-voice-transcription-queue.jsonl');
}

function queueItemKey(row) {
  return `${row.update_id ?? 'unknown-update'}:${row.message_id ?? 'unknown-message'}`;
}

function queueTelegramVoiceTranscription({
  dataDir,
  audioPath,
  update,
  message,
  file,
  component,
  reason,
}) {
  if (!dataDir) throw new Error('queueTelegramVoiceTranscription requires dataDir');
  if (!audioPath || !fs.existsSync(audioPath))
    throw new Error('queueTelegramVoiceTranscription requires audioPath');

  const bytes = fs.readFileSync(audioPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const updateId = update?.update_id ?? 'unknown-update';
  const messageId = message?.message_id ?? 'unknown-message';
  const ext = path.extname(audioPath) || '.audio';
  const queueRoot = path.join(
    dataDir,
    'telegram',
    'voice-transcription-queue',
    `${updateId}-${messageId}`,
  );
  const queuedAudioPath = path.join(queueRoot, `${sha256.slice(0, 16)}${ext}`);
  fs.mkdirSync(queueRoot, { recursive: true });
  if (!fs.existsSync(queuedAudioPath)) fs.writeFileSync(queuedAudioPath, bytes, { mode: 0o600 });

  const row = {
    schema: 'amy.telegram-voice-transcription-queue.v1',
    ts: new Date().toISOString(),
    status: 'queued',
    unavailable_component: component || 'local-faster-whisper',
    reason: String(reason || 'transcriber unavailable').slice(0, 500),
    update_id: updateId,
    message_id: messageId,
    chat_id: message?.chat?.id ?? null,
    chat_type: message?.chat?.type || null,
    user_id: message?.from?.id ?? null,
    telegram_file_id: file?.file_id || null,
    file_name: file?.file_name || null,
    mime_type: file?.mime_type || null,
    audio_path: queuedAudioPath,
    sha256,
    size_bytes: bytes.length,
  };
  appendJsonl(queueLedgerPath(dataDir), row);
  return row;
}

function latestTelegramVoiceQueueRows(dataDir) {
  if (!dataDir) throw new Error('latestTelegramVoiceQueueRows requires dataDir');
  const latest = new Map();
  for (const row of readJsonl(queueLedgerPath(dataDir))) {
    if (!row || row.schema !== 'amy.telegram-voice-transcription-queue.v1') continue;
    latest.set(queueItemKey(row), row);
  }
  return [...latest.values()];
}

function buildTelegramVoiceRetryUpdate(
  row,
  { ownerChatId, ownerUserId = ownerChatId, nowMs = Date.now() } = {},
) {
  const legacyOwnerPrivate =
    String(row?.chat_id ?? '') === String(ownerChatId ?? '') &&
    String(row?.user_id ?? '') === String(ownerUserId ?? '');
  const chatType = row?.chat_type || (legacyOwnerPrivate ? 'private' : 'unknown');
  return {
    update_id: `voice-retry:${row.update_id}`,
    message: {
      message_id: `voice-retry:${row.message_id}`,
      date: Math.floor(Number(nowMs) / 1000),
      chat: { id: row.chat_id, type: chatType },
      from: { id: row.user_id },
    },
  };
}

async function drainTelegramVoiceTranscriptionQueue({
  dataDir,
  limit = 3,
  transcribe = transcribeTelegramVoiceAudioAsync,
  onTranscript,
  now = () => new Date(),
} = {}) {
  if (!dataDir) throw new Error('drainTelegramVoiceTranscriptionQueue requires dataDir');
  if (typeof onTranscript !== 'function') {
    throw new Error('drainTelegramVoiceTranscriptionQueue requires onTranscript');
  }

  const results = [];
  const candidates = latestTelegramVoiceQueueRows(dataDir)
    .filter((row) => ['queued', 'retry_failed'].includes(row.status))
    .slice(0, Math.max(0, Number(limit) || 0));

  for (const row of candidates) {
    const base = {
      schema: 'amy.telegram-voice-transcription-queue.v1',
      update_id: row.update_id,
      message_id: row.message_id,
      chat_id: row.chat_id ?? null,
      chat_type: row.chat_type || null,
      user_id: row.user_id ?? null,
      telegram_file_id: row.telegram_file_id || null,
      file_name: row.file_name || null,
      mime_type: row.mime_type || null,
      audio_path: row.audio_path,
      sha256: row.sha256 || null,
      size_bytes: row.size_bytes ?? null,
    };
    if (!row.audio_path || !fs.existsSync(row.audio_path)) {
      const failed = {
        ...base,
        ts: now().toISOString(),
        status: 'retry_failed',
        unavailable_component: 'telegram-local-audio-file',
        reason: 'queued audio file missing',
      };
      appendJsonl(queueLedgerPath(dataDir), failed);
      results.push(failed);
      continue;
    }

    try {
      const text = String(await Promise.resolve(transcribe(row.audio_path))).trim();
      if (!text) {
        throw unavailable(
          row.unavailable_component || 'local-faster-whisper',
          'transcription returned no text',
        );
      }
      const delivery = await onTranscript({ row, transcript: text });
      if (delivery?.delivered !== true || delivery?.messageId == null) {
        throw unavailable(
          'telegram-owner-session-egress',
          `transcript session did not prove Telegram delivery (state=${delivery?.state || 'unknown'})`,
        );
      }
      const done = {
        ...base,
        ts: now().toISOString(),
        status: 'transcribed',
        transcript_chars: text.length,
      };
      appendJsonl(queueLedgerPath(dataDir), done);
      results.push(done);
    } catch (error) {
      const failed = {
        ...base,
        ts: now().toISOString(),
        status: 'retry_failed',
        unavailable_component:
          error?.component || row.unavailable_component || 'local-faster-whisper',
        reason: String(error?.message || error || 'transcriber unavailable').slice(0, 500),
      };
      appendJsonl(queueLedgerPath(dataDir), failed);
      results.push(failed);
    }
  }

  return results;
}

module.exports = {
  PAID_MODEL_ENV_KEYS,
  localVoiceRuntime,
  scrubPaidModelEnv,
  transcribeTelegramVoiceAudio,
  transcribeTelegramVoiceAudioAsync,
  queueTelegramVoiceTranscription,
  latestTelegramVoiceQueueRows,
  buildTelegramVoiceRetryUpdate,
  drainTelegramVoiceTranscriptionQueue,
};
