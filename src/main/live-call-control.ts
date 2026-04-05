// live-call-control.ts
// Manages Vapi Live Call Control for injecting context into active calls.
// Uses the controlUrl returned when a call starts to push messages, speech,
// and context updates into a running conversation.

import { getConfig } from "./config";

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
  if (!control) return { success: false, error: "No active control URL for this call" };

  try {
    const res = await fetch(control.controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "add-message",
        message: { role: "system", content },
        triggerResponseEnabled: triggerResponse,
      }),
    });
    return { success: res.ok };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Make Amy say something specific during an active call.
 */
export async function injectSpeech(
  callId: string,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const control = activeControls.get(callId);
  if (!control) return { success: false, error: "No active control URL for this call" };

  try {
    const res = await fetch(control.controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "say", text }),
    });
    return { success: res.ok };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * End an active call programmatically.
 */
export async function endCall(callId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  if (!config.vapiApiKey) return { success: false, error: "Vapi not configured" };

  try {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.vapiApiKey}` },
    });
    unregisterCallControl(callId);
    return { success: res.ok };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Clean up stale entries (calls that ended but weren't unregistered)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
  for (const [id, ctrl] of activeControls) {
    if (new Date(ctrl.startedAt).getTime() < cutoff) {
      activeControls.delete(id);
    }
  }
}, 5 * 60 * 1000);
