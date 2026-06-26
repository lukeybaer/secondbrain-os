// telegram-intake-gate.js
//
// Channel-origin gate for the Telegram long-poll loop (E0 workstream A,
// 2026-06-11). pollTelegram in ec2-server.js receives updates from ANY chat
// that messages the bot. Before this gate, ExampleCo chats were logged into the
// conversation ledger before being skipped; the hardened contract is: a
// non-owner update is dropped ENTIRELY at intake (no conversation log, no
// classification, no LLM call), with only a security event as the trace.
//
// Pure function so the matrix (message / edited_message / callback_query,
// owner / stranger / malformed) is unit-testable without a Telegram server.

// Returns { allowed, reason, chatId }.
function isAllowedTelegramUpdate(update, ownerChatId) {
  const owner = String(ownerChatId == null ? '' : ownerChatId).trim();
  if (!owner) {
    // No owner configured = nothing is allowed (fail closed).
    return { allowed: false, reason: 'no-owner-configured', chatId: null };
  }
  if (!update || typeof update !== 'object') {
    return { allowed: false, reason: 'malformed-update', chatId: null };
  }
  const msg =
    update.message ||
    update.edited_message ||
    (update.callback_query && update.callback_query.message);
  const chat = msg && msg.chat;
  const chatId = chat && chat.id != null ? String(chat.id) : null;
  if (!chatId) {
    return { allowed: false, reason: 'no-chat-id', chatId: null };
  }
  if (chatId === owner) {
    return { allowed: true, reason: 'owner-chat', chatId };
  }
  return { allowed: false, reason: 'non-owner-chat', chatId };
}

module.exports = { isAllowedTelegramUpdate };
