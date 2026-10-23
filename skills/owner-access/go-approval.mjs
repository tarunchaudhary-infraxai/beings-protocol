// "go" approvals for as-owner batches: an approver types the exact command in their own 1:1 chat with the Being.
// checkGo is pure (tested); readGo fetches the message with the Being's own session. Each go message works once.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_AGE_H = 24;
const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().toLowerCase();

// Returns { error } or { approver }. expect: the exact command, e.g. "go spring-batch 1a2b3c4d5e6f".
export function checkGo({ msg, chat, members, beingUpn, approvers, expect, used = new Set(), notBefore, now = Date.now() }) {
  const no = (error) => ({ error });
  if (!msg || !chat) return no('go message not found');
  if (used.has(msg.id)) return no('that go was already used');
  if (msg.from?.application || msg.from?.device || !msg.from?.user?.id) return no('go was not typed by a person');
  if (msg.messageType && msg.messageType !== 'message') return no('go is not a chat message');
  if (msg.deletedDateTime || msg.lastEditedDateTime) return no('go message was edited or deleted');
  if (chat.chatType !== 'oneOnOne' || (members || []).length !== 2) return no('go is not in a 1:1 chat');
  const email = new Map((members || []).map((m) => [m.userId, String(m.email || '').toLowerCase()]));
  if (![...email.values()].includes(String(beingUpn).toLowerCase())) return no('go is not in a chat with the Being');
  const who = email.get(msg.from.user.id) || '';
  if (!who || who === String(beingUpn).toLowerCase()) return no('go was posted by the Being');
  if (!approvers.has(who)) return no(`${who} is not an approver for this area`);
  if (text(msg.body?.content) !== text(expect)) return no(`go text must be exactly "${expect}"`);
  const at = Date.parse(msg.createdDateTime);
  if (notBefore && !(at >= Date.parse(notBefore))) return no('go is older than the batch it approves');
  if (!(now - at <= MAX_AGE_H * 3600e3)) return no(`go is older than ${MAX_AGE_H}h`);
  return { approver: who };
}

const usedFile = (state) => path.join(state, 'owner-access', 'used-go.txt');
export const usedGos = (state) => new Set(existsSync(usedFile(state)) ? readFileSync(usedFile(state), 'utf8').split('\n').filter(Boolean) : []);
export function markUsed(state, msgId) {
  mkdirSync(path.dirname(usedFile(state)), { recursive: true, mode: 0o700 });
  appendFileSync(usedFile(state), `${msgId}\n`, { mode: 0o600 });
}

// g: the Being's own Graph client (owner-session.mjs beingGraph). Fails closed on any error.
export async function readGo(g, chatId, msgId) {
  const enc = encodeURIComponent;
  const [chat, members, msg] = await Promise.all([
    g(`/chats/${enc(chatId)}`), g(`/chats/${enc(chatId)}/members`), g(`/chats/${enc(chatId)}/messages/${enc(msgId)}`),
  ]);
  return { chat, members: members.value || [], msg };
}
