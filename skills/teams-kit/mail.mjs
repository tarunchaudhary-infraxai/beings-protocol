#!/usr/bin/env node
// The Being's own mailbox (owner-mail reuses it read-only for the owner). Mail is never auto-answered.
// Usage: README.md "Script reference".
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connect, need, fail, strip, standby, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { currentScope } from './scope.mjs';
import { findSecrets, findSecretsInFiles } from './secrets.mjs';

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i === -1 ? null : (args[i + 1] ?? ''); };
const has = (f) => args.includes(f);
const UPN = need('BEING_UPN').toLowerCase();
if (has('--send') && standby()) fail('standby host: sending disabled', 3);
if (has('--send') && process.env.BEING_READ_ONLY) fail('read-only mailbox view', 2);
// owner-mail reuses this file read-only with the owner's cache; sending is the Being's only.
if (has('--send')) beingSender();
const { g } = await connect({ upn: UPN, sender: has('--send'), scopes: has('--send') ? ['Mail.ReadWrite', 'Mail.Send', 'User.Read'] : ['Mail.Read', 'User.Read'] });
const addr = (r) => r?.emailAddress?.address || '';
const SEL = '$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments';
const top = parseInt(opt('--top') || '15', 10);

try {
  if (has('--list')) {
    const r = await g(`/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&${SEL}${has('--unread') ? '&$filter=isRead eq false' : ''}`);
    for (const m of r.value) console.log(`${m.receivedDateTime}  ${m.isRead ? ' ' : '●'} ${addr(m.from).padEnd(34)} ${m.subject}\n    ${m.id}`);
  } else if (opt('--search')) {
    const r = await g(`/me/messages?$search=${encodeURIComponent('"' + opt('--search').replace(/"/g, '') + '"')}&$top=${top}&${SEL}`);
    for (const m of r.value) console.log(`${m.receivedDateTime}  ${addr(m.from).padEnd(34)} ${m.subject}\n    ${m.id}`);
  } else if (opt('--read')) {
    const m = await g(`/me/messages/${encodeURIComponent(opt('--read'))}?${SEL},body`);
    console.log(`From: ${addr(m.from)}\nTo: ${m.toRecipients.map(addr).join(', ')}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${strip(m.body?.content)}`);
  } else if (opt('--attachments')) {
    const id = encodeURIComponent(opt('--attachments')), dir = opt('--save');
    for (const a of (await g(`/me/messages/${id}/attachments?$select=id,name,size,contentType`)).value || []) {
      console.log(`${a.name}  ${a.size} B  ${a.contentType || ''}`);
      if (dir && a['@odata.type'] === '#microsoft.graph.fileAttachment') {
        const full = await g(`/me/messages/${id}/attachments/${encodeURIComponent(a.id)}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, path.basename(a.name)), Buffer.from(full.contentBytes, 'base64'));
      }
    }
  } else if (opt('--detect')) {
    const since = opt('--detect');
    const r = await g(`/me/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$filter=receivedDateTime gt ${since}&${SEL},body`);
    const hits = r.value.filter((m) => addr(m.from).toLowerCase() !== UPN).reverse();
    if (!hits.length) process.exit(0);
    for (const m of hits) logComms({ channel: 'mail', dir: 'in', messageId: m.id, from: addr(m.from), at: m.receivedDateTime,
      to: m.toRecipients.map(addr), subject: m.subject, text: strip(m.body?.content), hasAttachments: m.hasAttachments });
    console.log(JSON.stringify({ since, count: hits.length, messages: hits.map((m) => ({ at: m.receivedDateTime, from: addr(m.from), subject: m.subject, preview: m.bodyPreview })) }, null, 2));
    process.exit(10);
  } else if (has('--send')) {
    const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
    const to = list(opt('--to')), cc = list(opt('--cc')), subject = opt('--subject') || '';
    if (!to.length || !subject) fail('--send needs --to and --subject', 2);
    // Only a full-scope grant may mail anyone but the owner.
    const owner = (process.env.OWNER_UPN || '').toLowerCase();
    const { scope, why } = currentScope();
    if (scope === 'none') fail(`blocked: this run's send grant is not valid (${why}); nothing sent`, 3);
    if (scope !== 'full' && [...to, ...cc].some((x) => x.toLowerCase() !== owner)) fail(`blocked: ${scope.split(':')[0]} scope may only mail the owner`, 3);
    const files = list(opt('--attach'));
    for (const f of files) if (!existsSync(f) || statSync(f).size >= 3 * 1024 * 1024) fail(`attachment missing or >= 3 MB: ${f}`, 2);
    const attachments = files.map((f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(f), contentBytes: readFileSync(f).toString('base64') }));
    // --inline path=cid[,path=cid]: images referenced in the HTML as src="cid:<cid>" (signature logo).
    const inline = list(opt('--inline')).map((spec) => {
      const eq = spec.lastIndexOf('='), f = spec.slice(0, eq), cid = spec.slice(eq + 1);
      if (eq < 1 || !cid || !existsSync(f) || statSync(f).size >= 1024 * 1024) fail(`inline image missing, too big or not path=cid: ${spec}`, 2);
      return [f, cid];
    });
    const fileLeaks = findSecretsInFiles([...files, ...inline.map(([f]) => f)]);
    if (fileLeaks.length) fail(`blocked: an attachment looks like it contains secrets (${fileLeaks.join(', ')}); nothing sent`, 3);
    for (const [f, cid] of inline) {
      attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(f), contentId: cid, isInline: true, contentBytes: readFileSync(f).toString('base64') });
    }
    const rcpt = (a) => ({ emailAddress: { address: a } });
    const content = readFileSync(0, 'utf8');
    const leaked = findSecrets(`${subject}\n${content}`);
    if (leaked.length) fail(`blocked: message looks like it contains secrets (${leaked.join(', ')}); nothing sent`, 3);
    await g('/me/sendMail', { body: { message: { subject, body: { contentType: 'html', content }, toRecipients: to.map(rcpt), ccRecipients: cc.map(rcpt),
      ...(attachments.length && { attachments }) }, saveToSentItems: true } });
    logComms({ channel: 'mail', dir: 'out', to, cc, subject, text: strip(content) + (files.length ? ` [attached: ${files.map((f) => path.basename(f)).join(', ')}]` : '') });
    console.log('sent');
  } else {
    fail('usage: mail.mjs --list | --search <t> | --read <id> | --attachments <id> [--save dir] | --detect <iso> | --send --to a,b --subject S [--cc c] [--attach f] < body.html', 2);
  }
} catch (e) { fail(`mail: ${e.message}`); }
