'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForLine(proc, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`proxy did not emit ${pattern} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-4000);
      if (!pattern.test(buffer)) return;
      cleanup();
      resolve(buffer);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`proxy exited ${code} before ${pattern}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.once('exit', onExit);
  });
}

function postVoice(port, { callId = '019ff413-1b18-7222-ab2f-e4362ac464e2', payload } = {}) {
  const body = JSON.stringify(payload || {
    model: 'amy-codex-subscription-voice',
    stream: true,
    messages: [
      { role: 'system', content: 'Speak briefly and naturally. Return one ordinary spoken reply.' },
      { role: 'user', content: 'Please say: Ready for the call.' },
    ],
    tools: [],
  });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-amy-call-id': callId,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk.toString(); });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      },
    );
    request.setTimeout(12000, () => request.destroy(new Error('proxy request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

function spokenContentFromSse(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content || ''];
      } catch {
        return [];
      }
    })
    .join('');
}

function toolCallsFromSse(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap((line) => {
      try {
        return JSON.parse(line.slice(6))?.choices?.[0]?.delta?.tool_calls || [];
      } catch {
        return [];
      }
    });
}

async function main() {
  const port = await freePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-voice-proxy-test-'));
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'claude-proxy.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CLAUDE_PROXY_PORT: String(port),
      SECONDBRAIN_DATA_DIR: dataRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  proxy.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  try {
    await waitForLine(proxy, /Codex app-server voice lane warmed/);
    const response = await postVoice(port);
    if (response.status !== 200 || !response.text.includes('data: [DONE]')) {
      throw new Error(`proxy app-server response failed: HTTP ${response.status}`);
    }
    const firstSpoken = spokenContentFromSse(response.text);
    if (!firstSpoken) throw new Error('proxy app-server response contained no spoken content');
    const replay = await postVoice(port);
    if (
      replay.status !== 200 ||
      !replay.text.includes('data: [DONE]') ||
      spokenContentFromSse(replay.text) !== firstSpoken
    ) {
      throw new Error('exact provider retry did not replay the completed spoken decision');
    }

    const changedState = await postVoice(port, {
      payload: {
        model: 'amy-codex-subscription-voice',
        stream: true,
        messages: [
          { role: 'system', content: 'Speak briefly and naturally. Return one ordinary spoken reply.' },
          { role: 'user', content: 'Please say: The request state changed.' },
        ],
        tools: [],
      },
    });
    if (changedState.status !== 200 || !spokenContentFromSse(changedState.text)) {
      throw new Error('changed work ID did not launch a fresh spoken decision');
    }

    const dtmfPayload = {
      model: 'amy-codex-subscription-voice',
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'IVR plan: Use the native DTMF tool to press key 1 exactly once.\nEnd condition: stop after the keypress.',
        },
        { role: 'user', content: 'For reservations, please press 1.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'dtmf',
            description: 'Send keypad tones.',
            parameters: {
              type: 'object',
              properties: { keys: { type: 'string' } },
              required: ['keys'],
            },
          },
        },
      ],
    };
    const dtmfCallId = '029ff413-1b18-7222-ab2f-e4362ac464e2';
    const dtmf = await postVoice(port, { callId: dtmfCallId, payload: dtmfPayload });
    if (dtmf.status !== 200 || toolCallsFromSse(dtmf.text).length !== 1) {
      throw new Error('deterministic DTMF request did not emit exactly one tool call');
    }
    const dtmfReplay = await postVoice(port, { callId: dtmfCallId, payload: dtmfPayload });
    if (
      dtmfReplay.status !== 200 ||
      toolCallsFromSse(dtmfReplay.text).length !== 0 ||
      spokenContentFromSse(dtmfReplay.text)
    ) {
      throw new Error('exact DTMF retry replayed a tool action or speech instead of silence');
    }
    const ledger = path.join(dataRoot, 'agent', 'inference-work-events.jsonl');
    const rows = fs
      .readFileSync(ledger, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const attempts = rows.filter((row) => row.process === 'vapi-voice-app-server-attempt');
    const started = attempts.filter((row) => row.event === 'started');
    const settled = attempts.filter((row) => row.event === 'settled');
    const wrapperStarts = rows.filter(
      (row) => row.process === 'vapi-voice' && row.event === 'started',
    );
    if (!started.length || !settled.some((row) => row.outcome === 'completed-valid')) {
      throw new Error('proxy app-server path did not persist executable attempt receipts');
    }
    if (settled.some((row) => !row.voiceSurfaceHash)) {
      throw new Error('proxy app-server attempt receipt omitted the voice surface hash');
    }
    if (wrapperStarts.length !== 3) {
      throw new Error(
        `retry/mismatch inference accounting was wrong; wrapper starts=${wrapperStarts.length}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        httpStatus: response.status,
        attemptStarted: started.length,
        attemptSettled: settled.length,
        exactRetryReplayed: true,
        changedWorkIdReevaluated: true,
        dtmfRetrySilenced: true,
        completedDurationsMs: settled
          .filter((row) => row.outcome === 'completed-valid')
          .map((row) => row.durationMs),
      })}\n`,
    );
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `; stderr=${stderr}` : ''}`);
  } finally {
    proxy.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      proxy.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const resolved = path.resolve(dataRoot);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error(`refusing to remove non-temporary proxy test root: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
