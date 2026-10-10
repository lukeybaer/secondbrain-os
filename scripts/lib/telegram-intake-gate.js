// telegram-intake-gate.js
//
// Channel-origin gate for the Telegram long-poll loop (E0 workstream A,
// 2026-06-11). pollTelegram in ec2-server.js receives updates from ANY chat
// that messages the bot. Before this gate, unknown chats were logged into the
// conversation ledger before being skipped; the hardened contract is: a
// non-owner update is dropped ENTIRELY at intake (no conversation log, no
// classification, no LLM call), with only a security event as the trace.
//
// Pure function so the matrix (message / edited_message / callback_query,
// owner / stranger / malformed) is unit-testable without a Telegram server.

// Returns { allowed, reason, chatId, userId }.
// Telegram private chats currently use the user's id as the chat id, but the
// two coordinates are deliberately checked independently.
function isAllowedTelegramUpdate(update, ownerChatId, ownerUserId = ownerChatId) {
  const owner = String(ownerChatId == null ? '' : ownerChatId).trim();
  const ownerUser = String(ownerUserId == null ? '' : ownerUserId).trim();
  if (!owner || !ownerUser) {
    // No owner configured = nothing is allowed (fail closed).
    return { allowed: false, reason: 'no-owner-configured', chatId: null, userId: null };
  }
  if (!update || typeof update !== 'object') {
    return { allowed: false, reason: 'malformed-update', chatId: null, userId: null };
  }
  const msg =
    update.message ||
    update.edited_message ||
    (update.callback_query && update.callback_query.message);
  const actor = (update.callback_query && update.callback_query.from) || (msg && msg.from);
  const chat = msg && msg.chat;
  const chatId = chat && chat.id != null ? String(chat.id) : null;
  const userId = actor && actor.id != null ? String(actor.id) : null;
  if (!chatId) {
    return { allowed: false, reason: 'no-chat-id', chatId: null, userId };
  }
  if (chat.type !== 'private') {
    return { allowed: false, reason: 'non-private-chat', chatId, userId };
  }
  if (chatId !== owner) {
    return { allowed: false, reason: 'non-owner-chat', chatId, userId };
  }
  if (!userId) {
    return { allowed: false, reason: 'no-user-id', chatId, userId: null };
  }
  if (userId !== ownerUser) {
    return { allowed: false, reason: 'non-owner-user', chatId, userId };
  }
  return { allowed: true, reason: 'owner-private-chat', chatId, userId };
}

module.exports = { isAllowedTelegramUpdate };
