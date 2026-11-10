// Deep links for chats / messages / users (only what Telegram supports for the given peer type).
const CHANNEL_BASE = 1000000000000;
export const isChannelId = (chatId) => chatId <= -CHANNEL_BASE;
export function telegramLinks({ chatId, kind, username, messageId, senderId, senderUsername }) {
  const out = { chat: null, message: null, sender: null };
  if (isChannelId(chatId)) {
    const cid = -chatId - CHANNEL_BASE;
    out.chat = username ? `https://t.me/${username}` : `https://t.me/c/${cid}/1`;
    out.message = username ? `https://t.me/${username}/${messageId}` : `https://t.me/c/${cid}/${messageId}`;
  } else if (kind === 'private' || kind === 'saved') {
    out.chat = username ? `https://t.me/${username}` : `tg://user?id=${chatId}`;
    out.message = `tg://openmessage?user_id=${chatId}&message_id=${messageId}`;
  }
  out.sender = senderUsername ? `https://t.me/${senderUsername}` : senderId ? `tg://user?id=${senderId}` : null;
  return out;
}
