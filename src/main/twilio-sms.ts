// Twilio SMS: send messages and ingest from webhook payloads.
// Uses raw fetch against Twilio REST API (no SDK dependency).
import * as fs from 'fs';
import * as path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { getConfig } from './config';
import { saveSmsMessage, listSmsMessages, searchSmsMessages, SmsMessage } from './storage';
import {
  auditAndAuthorize,
  type ApprovalPolicyContext,
} from './security/approval-policy';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

function basicAuth(): string {
  const { twilioAccountSid, twilioAuthToken } = getConfig();
  return 'Basic ' + Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
}

export async function sendSms(
  to: string,
  body: string,
  mediaUrl?: string,
  options?: { policy?: Partial<ApprovalPolicyContext> },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const normalizedTo = to.replace(/[^\d+]/g, '');
  const target = normalizedTo.startsWith('+') ? normalizedTo : `+${normalizedTo}`;
  const auth = auditAndAuthorize({
    actor: options?.policy?.actor ?? 'renderer',
    actorId: options?.policy?.actorId,
    source: options?.policy?.source ?? 'renderer:sms:send',
    action: 'send_sms',
    summary: `Send SMS to ${target}`,
    targetType: 'phone',
    targetId: target,
    text: body,
    approved: options?.policy?.approved,
    approvalId: options?.policy?.approvalId,
    metadata: {
      bodyChars: body.length,
      hasMedia: !!mediaUrl,
      ...(options?.policy?.metadata ?? {}),
    },
  });
  if (!auth.allowed) {
    return { success: false, error: auth.error ?? 'SMS send requires approval.' };
  }

  const config = getConfig();
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    return {
      success: false,
      error: 'Twilio Account SID, Auth Token, and Phone Number required. Set in Settings.',
    };
  }

  if (!normalizedTo.length) return { success: false, error: 'Invalid recipient number.' };

  const params = new URLSearchParams();
  params.set('To', target);
  params.set('From', config.twilioPhoneNumber);
  params.set('Body', body);
  if (mediaUrl) params.set('MediaUrl', mediaUrl);

  const url = `${TWILIO_API}/Accounts/${config.twilioAccountSid}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMsg = data?.message || data?.error_message || JSON.stringify(data);
    return { success: false, error: errMsg };
  }

  const messageId = data?.sid;
  if (messageId) {
    const msg: SmsMessage = {
      id: `out_${messageId}`,
      messageId,
      source: 'outbound',
      from: config.twilioPhoneNumber,
      to: params.get('To')!,
      body,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    saveSmsMessage(msg);
  }
  return { success: true, messageId };
}

function getHeader(
  headers: Record<string, string | string[] | number | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct === undefined ? undefined : String(direct);
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  fields: Record<string, string>,
): string {
  const payload =
    url +
    Object.keys(fields)
      .sort()
      .map((key) => `${key}${fields[key]}`)
      .join('');
  return createHmac('sha1', authToken).update(payload).digest('base64');
}

export function validateTwilioSignature(
  headers: Record<string, string | string[] | number | undefined>,
  url: string,
  fields: Record<string, string>,
): { valid: boolean; skipped?: boolean; reason?: string } {
  if (process.env.SECONDBRAIN_SKIP_TWILIO_SIGNATURE === '1') {
    return { valid: true, skipped: true };
  }

  const token = getConfig().twilioAuthToken;
  if (!token) return { valid: false, reason: 'Twilio auth token is not configured.' };

  const provided = getHeader(headers, 'x-twilio-signature');
  if (!provided) return { valid: false, reason: 'Missing X-Twilio-Signature header.' };

  const expected = computeTwilioSignature(token, url, fields);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { valid: false, reason: 'Signature length mismatch.' };
  return timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: 'Invalid Twilio signature.' };
}

// Parse Twilio webhook (form-urlencoded fields).
export function parseTwilioWebhook(fields: Record<string, string>): SmsMessage | null {
  const messageSid = fields.MessageSid || fields.SmsSid;
  if (!messageSid) return null;

  const numMedia = parseInt(fields.NumMedia || '0', 10);
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = fields[`MediaUrl${i}`];
    const type = fields[`MediaContentType${i}`];
    if (url) mediaUrls.push(url);
    if (type) mediaTypes.push(type);
  }

  return {
    id: `in_${messageSid}`,
    messageId: messageSid,
    source: 'inbound',
    from: fields.From || '',
    to: fields.To || '',
    body: fields.Body || '',
    timestamp: new Date().toISOString(),
    contactName: fields.FromCity
      ? `${fields.FromCity}, ${fields.FromState || ''}`.trim()
      : undefined,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    createdAt: new Date().toISOString(),
  };
}

// Download an MMS media attachment from Twilio (requires Basic Auth).
export async function downloadMedia(
  mediaUrl: string,
  messageSid: string,
  index: number,
): Promise<string | null> {
  try {
    const config = getConfig();
    const res = await fetch(mediaUrl, {
      headers: { Authorization: basicAuth() },
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const ext =
      contentType.includes('jpeg') || contentType.includes('jpg')
        ? 'jpg'
        : contentType.includes('png')
          ? 'png'
          : contentType.includes('mp4')
            ? 'mp4'
            : contentType.includes('gif')
              ? 'gif'
              : 'bin';

    const mediaDir = path.join(config.dataDir, 'sms', 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    const filePath = path.join(mediaDir, `${messageSid}_${index}.${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (e) {
    console.error('[twilio-sms] downloadMedia failed:', e);
    return null;
  }
}

// Ingest a Twilio webhook: parse, download media, save. Returns 0 or 1.
export async function ingestSmsWebhook(
  fields: Record<string, string>,
): Promise<{ count: number; message: SmsMessage | null }> {
  const msg = parseTwilioWebhook(fields);
  if (!msg) return { count: 0, message: null };

  // Download any MMS attachments
  if (msg.mediaUrls && msg.mediaUrls.length > 0) {
    const localPaths: string[] = [];
    for (let i = 0; i < msg.mediaUrls.length; i++) {
      const local = await downloadMedia(msg.mediaUrls[i], msg.messageId, i);
      if (local) localPaths.push(local);
    }
    if (localPaths.length > 0) msg.mediaUrls = localPaths;
  }

  saveSmsMessage(msg);

  // Post-save: feed Graphiti + working memory
  try {
    const { onDataIngested, smsEvent } = await import('./ingest-hooks');
    onDataIngested(
      smsEvent({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        source: msg.source as 'inbound' | 'outbound',
        timestamp: msg.timestamp,
      }),
    );
  } catch {
    /* non-critical */
  }

  return { count: 1, message: msg };
}

export { listSmsMessages, searchSmsMessages };
