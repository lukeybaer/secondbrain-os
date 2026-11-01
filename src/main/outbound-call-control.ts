import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface OutboundCallControl {
  schema?: string;
  mode?: string;
  reason?: string;
}

interface RemoteControlOptions {
  remoteUrl?: string;
  relaySecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function localOutboundCallPauseReason(dataDir: string): string | null {
  const file = path.join(dataDir, 'agent', 'outbound-call-control.json');
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as OutboundCallControl;
    if (state.schema !== 'amy.outbound-call-control.v1') {
      return 'Outbound-call control state is invalid. Calls fail closed.';
    }
    if (state.mode === 'paused') return state.reason || 'Outbound calls are paused.';
    if (state.mode === 'enabled') return null;
    return 'Outbound-call control mode is invalid. Calls fail closed.';
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    return `Outbound-call control could not be read: ${error?.message || error}. Calls fail closed.`;
  }
}

function desktopRelayConfig(
  dataDir: string,
  options: RemoteControlOptions,
): { secret: string; url: string } {
  const route = '/amy/desktop-capabilities/outbound-call-control';
  const values: Record<string, string> = {};
  try {
    const envFile = path.join(path.dirname(dataDir), 'desktop-capability-worker.env');
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
  } catch {
    /* missing runtime relay config fails closed below */
  }
  const configuredUrl =
    options.remoteUrl ||
    values.AMY_DESKTOP_RELAY_URL ||
    'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod';
  return {
    secret: options.relaySecret || values.AMY_DESKTOP_RELAY_SECRET || '',
    url: configuredUrl.endsWith(route) ? configuredUrl : `${configuredUrl.replace(/\/$/, '')}${route}`,
  };
}

function signedHeaders(bodyText: string, secret: string): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const route = '/amy/desktop-capabilities/outbound-call-control';
  const digest = crypto.createHash('sha256').update(bodyText).digest('hex');
  const canonical = [timestamp, nonce, 'POST', route, digest].join('\n');
  return {
    'Content-Type': 'application/json',
    'X-Amy-Timestamp': timestamp,
    'X-Amy-Nonce': nonce,
    'X-Amy-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex'),
  };
}

export async function outboundCallPauseReason(
  dataDir: string,
  options: RemoteControlOptions = {},
): Promise<string | null> {
  const localReason = localOutboundCallPauseReason(dataDir);
  if (localReason) return localReason;
  const relay = desktopRelayConfig(dataDir, options);
  if (!relay.secret) {
    return 'Canonical EC2 outbound-call stop state cannot be verified because the signed relay credential is unavailable.';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(5000, options.timeoutMs || 3000)));
  try {
    const bodyText = JSON.stringify({ action: 'status' });
    const response = await (options.fetchImpl || fetch)(
      relay.url,
      {
      method: 'POST',
      headers: signedHeaders(bodyText, relay.secret),
      body: bodyText,
      signal: controller.signal,
      },
    );
    if (!response.ok) return `Canonical EC2 outbound-call stop state returned HTTP ${response.status}.`;
    const state = (await response.json()) as OutboundCallControl;
    if (state.schema !== 'amy.outbound-call-control.v1') {
      return 'Canonical EC2 outbound-call stop state is invalid.';
    }
    if (state.mode === 'paused') return state.reason || 'Canonical EC2 outbound calls are paused.';
    if (state.mode === 'enabled') return null;
    return 'Canonical EC2 outbound-call control mode is invalid.';
  } catch (error: any) {
    return `Canonical EC2 outbound-call stop state could not be verified: ${error?.message || error}.`;
  } finally {
    clearTimeout(timer);
  }
}
