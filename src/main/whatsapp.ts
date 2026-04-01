// WhatsApp Cloud API: send messages and ingest from webhook payloads.
import { getConfig } from "./config";
import { saveWhatsAppMessage, listWhatsAppMessages, WhatsAppMessage } from "./storage";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

export async function sendMessage(to: string, body: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const config = getConfig();
  if (!config.whatsappPhoneNumberId || !config.whatsappAccessToken) {
    return { success: false, error: "WhatsApp Phone Number ID and Access Token required. Set in Settings." };
  }
  const normalizedTo = to.replace(/\D/g, "");
  if (!normalizedTo.length) return { success: false, error: "Invalid recipient number." };

  const url = `${GRAPH_API_BASE}/${config.whatsappPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: { body },
    }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.error_user_msg || JSON.stringify(data);
    return { success: false, error: errMsg };
  }

  const messageId = data?.messages?.[0]?.id;
  if (messageId) {
    const msg: WhatsAppMessage = {
      id: `out_${messageId}`,
      messageId,
      source: "outbound",
      from: config.whatsappPhoneNumberId,
      to: normalizedTo,
      body,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      phoneNumberId: config.whatsappPhoneNumberId,
    };
    saveWhatsAppMessage(msg);
  }
  return { success: true, messageId };
}

// Parse Cloud API webhook body and return messages to save (text only for now).
export function parseWebhookPayload(body: unknown): WhatsAppMessage[] {
  const messages: WhatsAppMessage[] = [];
  try {
    const root = body as { entry?: Array<{ id?: string; changes?: Array<{ value?: { metadata?: { phone_number_id: string }; contacts?: Array<{ wa_id: string; profile?: { name?: string } }>; messages?: Array<{ id: string; from: string; timestamp: string; type: string; text?: { body: string } }> } }> }> };
    const entry = root?.entry;
    if (!Array.isArray(entry)) return messages;

    for (const e of entry) {
      const changes = e?.changes;
      if (!Array.isArray(changes)) continue;
      for (const ch of changes) {
        const value = ch?.value;
        if (!value) continue;
        const phoneNumberId = value.metadata?.phone_number_id ?? "";
        const contacts = value.contacts ?? [];
        const contactMap = new Map(contacts.map(c => [c.wa_id, c.profile?.name ?? undefined]));
        const list = value.messages ?? [];
        for (const m of list) {
          if (m.type !== "text" || !m.text?.body) continue;
          const contactName = contactMap.get(m.from);
          messages.push({
            id: `in_${m.id}`,
            messageId: m.id,
            source: "inbound",
            from: m.from,
            to: phoneNumberId,
            body: m.text.body,
            timestamp: new Date(parseInt(m.timestamp, 10) * 1000).toISOString(),
            contactName,
            phoneNumberId,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // ignore malformed
  }
  return messages;
}

export function ingestWebhookPayload(body: unknown): number {
  const toSave = parseWebhookPayload(body);
  for (const msg of toSave) saveWhatsAppMessage(msg);
  return toSave.length;
}

export { listWhatsAppMessages };
