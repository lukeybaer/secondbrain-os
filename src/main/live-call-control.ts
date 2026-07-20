// live-call-control.ts
// Manages Vapi Live Call Control for injecting context into active calls.
// Uses the controlUrl returned when a call starts to push messages, speech,
// and context updates into a running conversation.

import { getConfig } from './config';

// Mirrors scripts/lib/vapi-control-request.js. It is duplicated rather than
// imported because reaching from src/main into scripts/ would pull a CommonJS
// module into the Electron/vite bundle. Keep the deadline in sync with
// DEFAULT_CONTROL_TIMEOUT_MS there; scripts/__tests__/control-url-bounded pins
// both sides.
//
// Why any of this exists: on inbound call 019f77d5 (2026-07-18) an un-timeouted
// POST to a Vapi per-call controlUrl stalled and produced 54 seconds of dead air
// for ExampleCo. Node's fetch waits up to 300 seconds by default. These desktop-side
// calls sit outside Vapi's 20s webhook budget so they could not have caused that
// incident, but an unbounded controlUrl POST is the same defect class and a
// hung Electron IPC call is its own failure.
const CONTROL_TIMEOUT_MS = 2500;

async function boundedControlPost(
  controlUrl: string,
  payload: ExampleCo,
): Promise<{ success: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  try {
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { success: res.ok };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      success: false,
      error: aborted ? `control POST timed out after ${CONTROL_TIMEOUT_MS}ms` : err?.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ActiveCallControl {
  callId: string;
  controlUrl: string;
  listenUrl?: string;
  startedAt: string;
}

// In-memory registry of active calls with their control URLs
const activeControls = new Map<string, ActiveCallControl>();

export function registerCallControl(callId: string, controlUrl: string, listenUrl?: string): void {
  activeControls.set(callId, {
    callId,
    controlUrl,
    listenUrl,
    startedAt: new Date().toISOString(),
  });
  console.log(`[live-control] Registered control for call ${callId}`);
}

export function unregisterCallControl(callId: string): void {
  activeControls.delete(callId);
}

export function getActiveCallControls(): ActiveCallControl[] {
  return Array.from(activeControls.values());
}

/**
 * Inject a system message into an active call's conversation.
 * The AI will see this as context and can use it in its next response.
 */
export async function injectContext(
  callId: string,
  content: string,
  triggerResponse = false,
): Promise<{ success: boolean; error?: string }> {
  const control = activeControls.get(callId);
  if (!control) return { success: false, error: 'No active control URL for this call' };

  return boundedControlPost(control.controlUrl, {
    type: 'add-message',
    message: { role: 'system', content },
    triggerResponseEnabled: triggerResponse,
  });
}

/**
 * Make Amy say something specific during an active call.
 */
export async function injectSpeech(
  callId: string,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const control = activeControls.get(callId);
  if (!control) return { success: false, error: 'No active control URL for this call' };

  // NOTE: this sends {type:'say', text} while ec2-server.js sayIntoCall sends
  // {type:'say', content} for the same Vapi message. Left as-is deliberately,
  // since changing a live payload key is not part of a timeout fix, but the
  // inconsistency is real and one of the two is likely being ignored by Vapi.
  return boundedControlPost(control.controlUrl, { type: 'say', text });
}

/**
 * End an active call programmatically.
 */
export async function endCall(callId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey) return { success: false, error: 'Vapi not configured' };

  try {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    unregisterCallControl(callId);
    return { success: res.ok };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Clean up stale entries (calls that ended but weren't unregistered)
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
    for (const [id, ctrl] of activeControls) {
      if (new Date(ctrl.startedAt).getTime() < cutoff) {
        activeControls.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);
