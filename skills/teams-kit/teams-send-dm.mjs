#!/usr/bin/env node
// Send a Teams message as the Being; body from stdin (markdown or HTML).
// Usage and send scopes: README.md "Script reference" and GUARDRAILS.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { connect, need, fail, standby, stateDir, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { replyRef, autoReplyTarget } from './reply-ref.mjs';
import { ensureHtml } from './fmt.mjs';
import { currentScope, allowedChats } from './scope.mjs';
import { findSecrets } from './secrets.mjs';
import { PROMPT_MARK_RE } from './approval.mjs';

const args = process.argv.slice(2);
const take = (f) => { const i = args.indexOf(f); if (i === -1) return null; const v = args[i + 1] || ''; args.splice(i, 2); if (!v) fail(`${f} needs a value`, 2); return v; };
const flag = (f) => { const i = args.indexOf(f); if (i === -1) return false; args.splice(i, 1); return true; };
const CHAT_ID = take('--chat'), REPLY_TO = take('--reply-to'), ATTACH_URL = take('--attach-url'), ATTACH_NAME = take('--attach-name');
const NO_QUOTE = flag('--no-quote'), VERBATIM = flag('--verbatim'), WHOAMI = flag('--whoami');
const SENDER = beingSender();   // before any network call: never the owner's identity
if (standby() && !WHOAMI) fail('standby host: sending disabled', 3);
if (CHAT_ID && args.length) fail(`unexpected argument "${args[0].slice(0, 40)}"; pipe the message on stdin`, 2);
const OWNER = need('OWNER_UPN').toLowerCase();
const RECIPIENT = (args[0] || OWNER).toLowerCase();

const { g, me, tokenFor } = await connect({ ...SENDER, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'Chat.Create', 'User.Read'] });
console.error(`sending as ${me.userPrincipalName} → ${CHAT_ID ? `chat ${CHAT_ID}` : RECIPIENT}`);
if (WHOAMI) { console.log(`verified sender: ${me.userPrincipalName}`); process.exit(0); }

// Scope comes from the handler's grant (BEING_SEND_TOKEN), never from a plain env var; no grant means owner-only, a bad one none.
const { scope: SCOPE, why: WHY } = currentScope();
if (SCOPE === 'none') fail(`blocked: this run's send grant is not valid (${WHY}); nothing sent`, 3);
const LIMITED = SCOPE !== 'full', ALLOWED = allowedChats(SCOPE);
if (LIMITED && !CHAT_ID && RECIPIENT !== OWNER) fail(`blocked: ${SCOPE.split(':')[0]} scope (recipient ${RECIPIENT})`, 3);

let chat;
try {
  if (CHAT_ID) {
    chat = await g(`/chats/${CHAT_ID}`);   // fail loudly on a stale id before anything is posted
  } else {
    const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
    chat = cs.value.find((c) => c.members?.some((m) => (m.email || '').toLowerCase() === RECIPIENT));
    chat ??= await g('/chats', { body: { chatType: 'oneOnOne', members: [me.userPrincipalName, RECIPIENT].map((upn) => ({
      '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${upn}')` })) } });
  }
  // Scoped runs may post only to their listed chats or to the owner's 1:1 with the Being.
  if (LIMITED && !ALLOWED.includes(chat.id)) {
    const members = (await g(`/chats/${chat.id}/members`)).value || [];
    const ownerDm = chat.chatType === 'oneOnOne' && members.some((x) => (x.email || '').toLowerCase() === OWNER)
      && members.some((x) => x.userId === me.id);
    if (!ownerDm) fail(`blocked: ${SCOPE.split(':')[0]} scope (target ${chat.id})`, 3);
  }
} catch (e) { fail(`cannot resolve chat: ${e.message}`); }

let content = readFileSync(0, 'utf8');
if (!content.trim() && !ATTACH_URL) fail('empty message body on stdin; nothing sent', 2);
if (content.trim()) content = ensureHtml(content);
// Approval prompts come only from draft-for-owner.mjs; nothing that reads like .env or a credential goes out.
if (PROMPT_MARK_RE.test(content.replace(/<[^>]+>/g, ' '))) fail('blocked: only draft-for-owner.mjs may post draft approval prompts', 3);
const leaked = findSecrets(content);
if (leaked.length) fail(`blocked: message looks like it contains secrets (${leaked.join(', ')}); nothing sent`, 3);
const payload = { body: { contentType: 'html', content } };
if (ATTACH_URL) {
  // Teams resolves a file card by the item's eTag GUID and its WebDAV URL.
  const share = 'u!' + Buffer.from(ATTACH_URL).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const r = await fetch(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem?$select=name,eTag,webDavUrl`,
    { headers: { Authorization: `Bearer ${await tokenFor(['Files.ReadWrite'])}` } });
  if (!r.ok) fail(`cannot resolve attachment: ${r.status}; nothing sent`);
  const item = await r.json();
  const attId = (/\{?([0-9A-Fa-f-]{36})/.exec(item.eTag || '') || [])[1];
  if (!attId || !item.webDavUrl) fail('attachment has no eTag/webDavUrl; nothing sent');
  payload.attachments = [{ id: attId, contentType: 'reference', contentUrl: item.webDavUrl, name: ATTACH_NAME || item.name }];
  payload.body.content += `<attachment id="${attId}"></attachment>`;
}
const quoteId = NO_QUOTE ? null : (REPLY_TO || (CHAT_ID ? autoReplyTarget(chat.id) : null));

// Work runs queue their messages; the handler's voice pass words them and sends them back through here with --verbatim.
if (process.env.BEING_VOICE === 'fast' && !VERBATIM) {
  const dir = path.join(stateDir(), 'outbox'); mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, chatId: chat.id, html: content, quoteId,
    attachUrl: ATTACH_URL, attachName: ATTACH_NAME, scope: SCOPE, session: process.env.BEING_SESSION_NAME || "", created: new Date().toISOString() }));
  console.log(`queued ${id} for chat ${chat.id}; sent after the voice pass`);
  process.exit(0);
}
if (quoteId) {
  try {   // a quote that cannot be built must not block the reply
    const ref = await replyRef(g, chat.id, quoteId);
    payload.attachments = [...(payload.attachments || []), ref.attachment];
    payload.body.content = ref.tag + payload.body.content;
  } catch (e) { console.error(`quote ${quoteId} unavailable (${e.message}); sending without it`); }
}
let msg;
try { msg = await g(`/chats/${chat.id}/messages`, { body: payload }); } catch (e) {
  if (!quoteId) fail(`send failed: ${e.message}`);
  console.error(`quoted send rejected (${e.message}); sending without quote`);
  payload.body.content = payload.body.content.replace(`<attachment id="${quoteId}"></attachment>`, '');
  payload.attachments = (payload.attachments || []).filter((a) => a.contentType !== 'messageReference');
  if (!payload.attachments.length) delete payload.attachments;
  msg = await g(`/chats/${chat.id}/messages`, { body: payload }).catch((e2) => fail(`send failed: ${e2.message}`));
}
logComms({ dir: 'out', kind: 'message', session: process.env.BEING_SESSION_NAME || undefined, chatId: chat.id, messageId: msg.id, replyTo: quoteId || undefined,
  to: CHAT_ID ? (chat.topic || chat.chatType) : RECIPIENT, text: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
console.log(`sent to ${chat.id} as message ${msg.id}`);
