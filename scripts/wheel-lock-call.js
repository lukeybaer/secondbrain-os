#!/usr/bin/env node
// One-shot Vapi call dispatcher for wheel lock key inquiry.
// Initiates call, spawns an ffplay listener on the Vapi WSS PCM stream so
// the owner hears it on his default audio device without opening any app,
// polls call to completion, prints transcript + outcome as JSON.
//
// Usage: node wheel-lock-call.js "<Dealer Name>" "<+1phone>"
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AMY_ASSISTANT_ID = 'dba21f77-2da6-45b2-9379-1b575634a337';
const FFPLAY =
  'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build-shared\\bin\\ffplay.exe';
const VAPI_SAMPLE_RATE = 16000; // Hz, stereo S16LE per listenAudio.ts
const dealerName = process.argv[2];
const phone = process.argv[3];
if (!dealerName || !phone) {
  console.error('Usage: wheel-lock-call.js "<Dealer>" "<+1phone>"');
  process.exit(2);
}

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'secondbrain', 'config.json'), 'utf8'),
);
if (!cfg.vapiApiKey || !cfg.vapiPhoneNumberId) {
  console.error('Vapi credentials missing from config.json');
  process.exit(3);
}

const callsDir = path.join(process.env.APPDATA, 'secondbrain', 'data', 'calls');
fs.mkdirSync(callsDir, { recursive: true });

const systemPrompt = `You are Amy, the owner's executive assistant. You are calling ${dealerName} on the owner's behalf about his 2022 Toyota Corolla SE.

## CRITICAL — how to start the call
When the call connects, do NOT speak first. Wait and LISTEN silently. If an automated menu plays, let it finish COMPLETELY — wait for at least 2 seconds of silence before taking any action. Then use the DTMF tool to press the correct digit for PARTS.

ABSOLUTE RULE: Never narrate your DTMF actions. Never say words like "Pressing 3", "Pressing parts", "I'll press", "I'm selecting", "Waiting for connection", "Let me press". Just silently use the DTMF tool. Your microphone is HOT — anything you think, you say. So do not think out loud.

After pressing a key, stay silent for at least 8 more seconds to allow the transfer to complete. Only speak when a HUMAN answers — you can tell because the voice sounds natural, says "Hello" or "Parts department" or similar, and is not a scripted recording.

## Your goal
the owner LOST his wheel lock — the actual locking lug nut itself, not the key. He is NOT trying to replace a key to match an existing lock. He wants to BUY A BRAND NEW WHEEL LOCK SET for a 2022 Toyota Corolla SE. A wheel lock set typically includes 4 locking lug nuts plus 1 key (often McGard brand or Toyota OEM). Find out:
1. Whether the parts department sells a new wheel lock set for a 2022 Toyota Corolla SE
2. The price for the full set
3. Whether it's in stock or needs to be ordered, and if ordered, ETA
4. Parts department hours
5. the owner can just walk in and buy it — he does NOT need to bring the vehicle, because there is nothing to match. If the rep starts talking about matching a key to an existing lock, politely correct them: "No, the owner doesn't have the existing lock — he lost the whole thing. He just needs to buy a new set."

## Opening greeting (use AFTER a human answers, not over a menu)
"Hi, this is Amy calling on behalf of the owner. He has a 2022 Toyota Corolla SE and he needs to buy a brand new wheel lock set — the locking lug nuts plus the key. He lost his old set completely, so he just needs to purchase a fresh one. Can you tell me if you have those in stock and what the price is?"

If you reach a non-parts human (receptionist, sales), politely ask to be transferred to Parts.

## How to handle the conversation
- Speak naturally, warm and professional. Do NOT read the goal as a script.
- If they seem busy, be brief. If they want details, give them year/model/trim only.
- Do NOT reveal that you are an AI unless directly and sincerely asked.
- If you reach voicemail, hang up politely without leaving a message.

## Phone tree / IVR navigation
- When you hear a menu, wait for the full menu to finish BEFORE pressing any digit.
- Use the DTMF tool (not spoken words) to press keys.
- For this call, PARTS is the right department. If the menu offers "parts", press that digit. If the menu only offers service and sales, press service.

## Information you may share if asked
- Car: 2022 Toyota Corolla SE
- Owner: the owner
- Do NOT share the VIN, home address, date of birth, phone number, or any payment info
- If they need to speak with the owner directly, say the owner will call back himself

## Ending
- Once you have clear answers on availability, price, what to bring, and parts hours, thank them and say the owner will follow up to complete the purchase.
- Do not drag the call out once the goal is met.

## Integrity rules
- NEVER fabricate information. If you don't know, say so.
- Only state facts you've been given.`;

const body = {
  phoneNumberId: cfg.vapiPhoneNumberId,
  customer: { number: phone },
  assistantId: AMY_ASSISTANT_ID,
  assistantOverrides: {
    // Clear the assistant's default firstMessage and force wait-for-user
    firstMessage: '',
    firstMessageMode: 'assistant-waits-for-user',
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }],
    },
    silenceTimeoutSeconds: 45,
    maxDurationSeconds: 420,
  },
};

async function initiate() {
  const res = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.vapiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Vapi HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function startListener(listenUrl) {
  // Wait 3 seconds — Vapi's listen websocket isn't accepting connections until
  // the call actually enters in-progress state.
  await new Promise((r) => setTimeout(r, 3000));
  return _startListenerNow(listenUrl);
}

function _startListenerNow(listenUrl) {
  // Spawn ffplay reading raw PCM from stdin
  const ff = spawn(
    FFPLAY,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-f',
      's16le',
      '-ar',
      String(VAPI_SAMPLE_RATE),
      '-ch_layout',
      'stereo',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  ff.on('error', (e) => console.error('[ffplay error]', e.message));

  // Open WSS and pipe binary frames into ffplay stdin
  const ws = new WebSocket(listenUrl);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    console.error('[listen] WSS open, audio piping to speakers');
  });
  let frameCount = 0;
  ws.addEventListener('message', async (ev) => {
    if (typeof ev.data === 'string') return; // skip control JSON
    let buf;
    if (ev.data instanceof ArrayBuffer) {
      buf = Buffer.from(ev.data);
    } else if (ev.data && typeof ev.data.arrayBuffer === 'function') {
      // Blob path (Node global WebSocket default)
      const ab = await ev.data.arrayBuffer();
      buf = Buffer.from(ab);
    } else if (Buffer.isBuffer(ev.data)) {
      buf = ev.data;
    } else {
      return;
    }
    if (++frameCount === 1) console.error('[listen] first audio frame', buf.length, 'bytes');
    if (!ff.killed && ff.stdin.writable) {
      ff.stdin.write(buf);
    }
  });
  ws.addEventListener('close', () => {
    console.error('[listen] WSS closed');
    if (!ff.killed) {
      try {
        ff.stdin.end();
      } catch {}
    }
  });
  ws.addEventListener('error', (e) => {
    console.error('[listen] WSS error');
  });

  return { ws, ff };
}

async function pollUntilEnded(callId) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch('https://api.vapi.ai/call/' + callId, {
      headers: { Authorization: `Bearer ${cfg.vapiApiKey}` },
    });
    const d = await r.json().catch(() => ({}));
    const status = d.status;
    process.stderr.write(
      `${new Date().toISOString().slice(11, 19)} ${status}${d.endedReason ? ' (' + d.endedReason + ')' : ''}\n`,
    );
    if (status === 'ended') return d;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Poll timeout');
}

(async () => {
  let data;
  try {
    data = await initiate();
  } catch (e) {
    console.error('Initiate failed:', e.message);
    process.exit(5);
  }
  const callId = data.id;
  const listenUrl = data?.monitor?.listenUrl;
  const record = {
    id: callId,
    createdAt: new Date().toISOString(),
    phoneNumber: phone,
    instructions: `Wheel lock key replacement inquiry for 2022 Toyota Corolla SE — calling ${dealerName}`,
    personalContext: '',
    status: data.status || 'queued',
    listenUrl,
  };
  fs.writeFileSync(path.join(callsDir, `${callId}.json`), JSON.stringify(record, null, 2));
  console.error(`[call] ${dealerName} → ${phone}  id=${callId}`);

  // Start audio listener (delayed so WSS is accepting connections)
  let listener = null;
  if (listenUrl) {
    startListener(listenUrl)
      .then((l) => {
        listener = l;
      })
      .catch((e) => console.error('[listen] failed:', e.message));
  }

  let final;
  try {
    final = await pollUntilEnded(callId);
  } catch (e) {
    console.error('Poll failed:', e.message);
    if (listener) {
      try {
        listener.ws.close();
        listener.ff.kill();
      } catch {}
    }
    process.exit(6);
  }

  // Give audio a second to flush
  await new Promise((r) => setTimeout(r, 1500));
  if (listener) {
    try {
      listener.ws.close();
      listener.ff.kill();
    } catch {}
  }

  // Write updated record
  const updated = {
    ...record,
    status: 'ended',
    endedReason: final.endedReason,
    transcript: final.transcript,
    summary: final.summary,
    durationSeconds: final.durationSeconds,
  };
  fs.writeFileSync(path.join(callsDir, `${callId}.json`), JSON.stringify(updated, null, 2));

  // Output structured result on stdout
  console.log(
    JSON.stringify(
      {
        callId,
        dealer: dealerName,
        phone,
        endedReason: final.endedReason || '',
        durationSeconds: final.durationSeconds,
        transcript: final.transcript || '',
        summary: final.summary || '',
      },
      null,
      2,
    ),
  );
})();
