#!/usr/bin/env node
// Posts a reviewed batch in one allowed Teams channel as the owner, after a go: uploads each file to the channel's
// folder, checks it arrived intact, then posts one by one with a ledger. Usage: README.md "Channel posts as owner".
import './oa-env.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fail } from './graph.mjs';
import { loadConfig, KIT } from './oa-config.mjs';
import { openOwnerAccess, requireGo, logAsOwner, reportToOwner, esc } from './owner-session.mjs';
import { channelRoute, guardedGraph, isM365Host } from './guards.mjs';
import { validateChannelManifest, batchFingerprint, channelPlan, messageBody, OFFICE } from './channel-lib.mjs';
import { sha256, withLedger, pendingOps } from './ledger.mjs';

const { positionals: [cmd], values: o } = parseArgs({ allowPositionals: true, options: {
  manifest: { type: 'string' }, out: { type: 'string' }, 'go-chat': { type: 'string' }, 'go-msg': { type: 'string' } } });
if (!['preview', 'apply'].includes(cmd) || !o.manifest) fail('usage: channel-posts.mjs preview --manifest m.json [--out dir] | apply --manifest m.json --go-chat <id> --go-msg <id>', 2);

const cfg = loadConfig();
const m = (() => { try { return validateChannelManifest(JSON.parse(readFileSync(o.manifest, 'utf8')), cfg.channel_posts?.allowed || []); } catch (e) { return fail(`manifest: ${e.message}`, 2); } })();
const bytes = {}, hashes = {};
for (const p of m.posts) for (const f of p.files || []) { bytes[f] = readFileSync(f); hashes[f] = sha256(bytes[f]); }
const fp = batchFingerprint(m, hashes), plan = channelPlan(m, hashes), GO = `go ${m.batch} ${fp}`;

if (cmd === 'preview') {
  // Local only: an HTML page the approver reviews; nothing is sent or uploaded.
  const dir = o.out || path.dirname(path.resolve(o.manifest));
  mkdirSync(dir, { recursive: true });
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(m.batch)}</title><body style="font-family:sans-serif;max-width:52rem;margin:2rem auto">`
    + `<h1>Batch ${esc(m.batch)}</h1><p>Channel ${esc(m.team)} / ${esc(m.channel)}, folder <b>${esc(m.folder)}</b>. Approve by typing <code>${esc(GO)}</code></p>`
    + m.posts.map((p) => `<hr><h2>${esc(p.title)}</h2>${p.body_html || `<p>${esc(p.body_text).replace(/\n/g, '<br>')}</p>`}<ul>`
      + (p.files || []).map((f) => `<li>${esc(path.basename(f))} (${Math.ceil(bytes[f].length / 1024)} KB, sha256 ${hashes[f].slice(0, 12)})</li>`).join('') + '</ul>').join('');
  const out = path.join(dir, `${m.batch}.preview.html`);
  writeFileSync(out, html, { mode: 0o600 });
  console.log(`preview: ${out}\n${m.posts.length} post(s), ${Object.keys(hashes).length} file(s). After review, an approver types in their 1:1 with the Being:\n  ${GO}`);
  process.exit(0);
}

const { s, owner } = await openOwnerAccess('channel_posts', { services: ['teams'],
  ownerScopes: { teams: ['ChannelMessage.Send', 'Channel.ReadBasic.All', 'Files.ReadWrite.All'] } });
await requireGo(s, { area: cfg.channel_posts?.area || 'channel_posts', expect: GO, chatId: o['go-chat'], msgId: o['go-msg'], notBefore: m.created });
const where = { team: m.team, channel: m.channel };
const token = owner.teams.token, ownerId = owner.teams.me.id;
const g = guardedGraph(token, (url, method) => channelRoute(where, url, method));
const CH = `/teams/${encodeURIComponent(m.team)}/channels/${encodeURIComponent(m.channel)}`;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

// Downloads follow the Graph redirect to a Microsoft 365 host only.
async function download(itemId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(where.driveId)}/items/${encodeURIComponent(itemId)}/content`,
    { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
  let res = r;
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location');
    if (!isM365Host(loc)) throw new Error('download redirected outside Microsoft 365');
    res = await fetch(loc, { redirect: 'error' });
  }
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// Same bytes, or (Office files only) the same package apart from metadata SharePoint adds on upload.
function verify(name, src, got) {
  if (sha256(src) === sha256(got)) return;
  if (!OFFICE.test(name)) throw new Error(`${name}: uploaded bytes differ`);
  const t = mkdtempSync(path.join(tmpdir(), 'oa-verify-'));
  try {
    writeFileSync(path.join(t, 'a'), src); writeFileSync(path.join(t, 'b'), got);
    execFileSync('python3', ['-I', path.join(KIT, 'verify-upload.py'), path.join(t, 'a'), path.join(t, 'b')], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error(`${name}: ${String(e.stderr || e.message).trim().split('\n').pop()}`); } finally { rmSync(t, { recursive: true, force: true }); }
}
async function upload(name, data) {
  const at = `/drives/${encodeURIComponent(where.driveId)}/items/${encodeURIComponent(where.folderId)}:/${enc(`${m.folder}/${name}`)}:`;
  if (data.length <= 4e6) return g(`${at}/content?@microsoft.graph.conflictBehavior=fail`, { method: 'PUT', body: data });
  const { uploadUrl } = await g(`${at}/createUploadSession`, { method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } } });
  if (!isM365Host(uploadUrl)) throw new Error('upload session is outside Microsoft 365');
  let item;
  for (let off = 0; off < data.length; off += 5 * 327680) {
    const end = Math.min(off + 5 * 327680, data.length);
    const r = await fetch(uploadUrl, { method: 'PUT', redirect: 'error', body: data.subarray(off, end),
      headers: { 'Content-Range': `bytes ${off}-${end - 1}/${data.length}` } });
    if (!r.ok) throw new Error(`chunk upload failed HTTP ${r.status}`);
    if (end === data.length) item = await r.json();
  }
  return item;
}
const findItem = (name) => g(`/drives/${encodeURIComponent(where.driveId)}/items/${encodeURIComponent(where.folderId)}:/${enc(`${m.folder}/${name}`)}`, { allow404: true });
const findPost = async (title) => (await g(`${CH}/messages?$top=50`)).value?.find((x) => x.subject === title && x.from?.user?.id === ownerId && !x.deletedDateTime) || null;

try {
  await g(CH);
  const ff = await g(`${CH}/filesFolder`);
  Object.assign(where, { driveId: ff.parentReference.driveId, folderId: ff.id });
  const posted = [];
  await withLedger(path.join(s.state, 'owner-access', `channel-${m.batch}.ledger.jsonl`), plan, async (ledger) => {
    // Reconcile actions an earlier run started but never confirmed, from what is actually in the channel and folder.
    const reconciled = new Set();
    for (const op of plan.operations.filter((x) => ledger.records.get(x.id)?.state === 'started')) {
      if (op.kind === 'file') {
        const it = await findItem(op.name);
        if (it) { verify(op.name, bytes[op.source], await download(it.id)); await ledger.put(op, 'done', { itemId: it.id, eTag: it.eTag, webUrl: it.webUrl, reconciled: true }); reconciled.add(op.id); }
      } else if (await findPost(op.title)) { await ledger.put(op, 'done', { reconciled: true }); reconciled.add(op.id); }
    }
    for (const op of pendingOps(plan, ledger.records, { reconciled })) {
      if (op.kind === 'file') {
        if (await findItem(op.name)) throw new Error(`${m.folder}/${op.name} already exists and is not in this batch's ledger; refusing to overwrite`);
        await ledger.put(op, 'started');
        const it = await upload(op.name, bytes[op.source]);
        verify(op.name, bytes[op.source], await download(it.id));
        await ledger.put(op, 'done', { itemId: it.id, eTag: it.eTag, webUrl: it.webUrl });
        logAsOwner('channel_posts', { channel: 'teams', action: 'file-uploaded', batch: m.batch, team: m.team, chan: m.channel, name: op.name, sha256: op.sha256 });
        console.log(`UPLOADED + VERIFIED: ${m.folder}/${op.name}`);
      } else {
        const post = m.posts[op.post];
        if (await findPost(op.title)) throw new Error(`a post titled "${op.title}" already exists and is not in this batch's ledger`);
        const items = plan.operations.filter((x) => x.kind === 'file' && x.post === op.post)
          .map((x) => ({ name: x.name, eTag: ledger.records.get(x.id).eTag, webUrl: ledger.records.get(x.id).webUrl }));
        await ledger.put(op, 'started');
        const msg = await g(`${CH}/messages`, { method: 'POST', body: messageBody(post, items) });
        await ledger.put(op, 'done', { messageId: msg.id, webUrl: msg.webUrl });
        posted.push(op.title);
        logAsOwner('channel_posts', { channel: 'teams', action: 'posted', batch: m.batch, team: m.team, chan: m.channel, subject: op.title, messageId: msg.id });
        console.log(`POSTED: ${op.title}`);
      }
    }
  });
  reportToOwner(s, `Posted batch <b>${esc(m.batch)}</b> in the channel as you: ${posted.length} post(s) now (${esc(posted.join(', ') || 'none new')}); every file checked after upload.`);
} catch (e) {
  reportToOwner(s, `Channel batch <b>${esc(m.batch)}</b> stopped: ${esc(e.message.slice(0, 200))}. Nothing after that step was posted.`);
  fail(`channel-posts: ${e.message}`);
}
