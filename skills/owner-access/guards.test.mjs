import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isM365Host, isLoginUrl, browserRequestAllowed, inboxReadRoute, draftsRoute, channelRoute, forwardRoute, guardedGraph } from './guards.mjs';

const G = 'https://graph.microsoft.com/v1.0';
const MB = 'team@example.com', R = `${G}/users/${encodeURIComponent(MB)}`;

test('owner-web hosts: Microsoft 365 over https only', () => {
  assert.ok(isM365Host('https://org-my.sharepoint.com/personal/x'));
  assert.ok(isM365Host('https://outlook.office.com/mail/'));
  assert.ok(!isM365Host('http://org.sharepoint.com/'));
  assert.ok(!isM365Host('https://sharepoint.com.example.com/'));
  assert.ok(!isM365Host('https://user:pw@org.sharepoint.com/'));
  assert.ok(isLoginUrl('https://login.microsoftonline.com/common/oauth2'));
});

test('browser guard: no PUT/PATCH/DELETE, no send, mark-read, move or delete actions', () => {
  assert.ok(browserRequestAllowed('GET', 'https://org.sharepoint.com/_api/web'));
  assert.ok(browserRequestAllowed('POST', 'https://outlook.office.com/owa/service.svc?action=FindItem'));
  for (const [m, u, b] of [['PUT', 'https://org.sharepoint.com/x'], ['DELETE', 'https://org.sharepoint.com/x'], ['PATCH', 'https://x.office.com/y'],
    ['POST', 'https://outlook.office.com/owa/service.svc?action=SendItem'], ['POST', 'https://outlook.office.com/api/v2.0/me/sendmail'],
    ['POST', 'https://outlook.office.com/owa/service.svc', '{"__type":"DeleteItem"}'], ['GET', 'https://outlook.office.com/owa/service.svc?action=MarkItemsAsRead']]) {
    assert.equal(browserRequestAllowed(m, u, b), false, `${m} ${u}`);
  }
});

test('shared inbox monitor: GET of the listed folders only', () => {
  assert.ok(inboxReadRoute(MB, `${R}/mailFolders/inbox/messages?$top=5`, 'GET'));
  assert.ok(!inboxReadRoute(MB, `${R}/mailFolders/inbox/messages`, 'POST'));
  assert.ok(!inboxReadRoute(MB, `${R}/mailFolders/drafts/messages`, 'GET'));
  assert.ok(!inboxReadRoute(MB, `${G}/users/other%40example.com/mailFolders/inbox/messages`, 'GET'));
  assert.ok(!inboxReadRoute(MB, `${R}/messages/abc`, 'GET'));
});

test('drafts: create and edit own drafts; send only approved ids; never delete, move, reply or other mailboxes', () => {
  const own = new Set(['AAA']), sendIds = new Set(['AAA']);
  assert.ok(draftsRoute(MB, `${R}/messages`, 'POST', { own }));
  assert.ok(draftsRoute(MB, `${R}/messages/AAA`, 'PATCH', { own }));
  assert.ok(draftsRoute(MB, `${R}/messages/AAA/attachments`, 'GET', { own }));
  assert.ok(draftsRoute(MB, `${R}/mailFolders/drafts/messages?$top=10`, 'GET', { own }));
  assert.ok(!draftsRoute(MB, `${R}/messages/BBB`, 'PATCH', { own }), 'not our draft');
  assert.ok(!draftsRoute(MB, `${R}/messages/AAA/send`, 'POST', { own }), 'send without an approved batch');
  assert.ok(draftsRoute(MB, `${R}/messages/AAA/send`, 'POST', { own, sendIds }));
  assert.ok(!draftsRoute(MB, `${R}/messages/BBB/send`, 'POST', { own, sendIds }));
  assert.ok(!draftsRoute(MB, `${R}/messages/AAA`, 'DELETE', { own }));
  assert.ok(!draftsRoute(MB, `${R}/messages/AAA/move`, 'POST', { own }));
  assert.ok(!draftsRoute(MB, `${R}/messages/AAA/forward`, 'POST', { own }));
  assert.ok(!draftsRoute(MB, `${R}/sendMail`, 'POST', { own }));
  assert.ok(!draftsRoute(MB, `${G}/me/messages`, 'POST', { own }));
  assert.ok(!draftsRoute(MB, `${R}/mailFolders/sentitems/messages`, 'GET', { own }), 'sent items only in send mode');
  assert.ok(draftsRoute(MB, `${R}/mailFolders/sentitems/messages`, 'GET', { own, sentItems: true }));
});

test('channel posts: one channel, its folder only, no path escapes', () => {
  const w = { team: 'T1', channel: '19:abc@thread.tacv2', driveId: 'D1', folderId: 'F1' };
  const CH = `${G}/teams/T1/channels/${encodeURIComponent(w.channel)}`;
  assert.ok(channelRoute(w, `${CH}/messages`, 'POST'));
  assert.ok(!channelRoute(w, `${CH}/messages/1/replies`, 'POST'));
  assert.ok(!channelRoute(w, `${G}/teams/T2/channels/${encodeURIComponent(w.channel)}/messages`, 'POST'));
  assert.ok(!channelRoute(w, `${G}/chats/x/messages`, 'POST'));
  assert.ok(channelRoute(w, `${G}/drives/D1/items/F1:/batch/a.pdf:/content`, 'PUT'));
  assert.ok(!channelRoute(w, `${G}/drives/D1/items/F1:/../a.pdf:/content`, 'PUT'));
  assert.ok(!channelRoute(w, `${G}/drives/D1/items/OTHER:/a.pdf:/content`, 'PUT'));
  assert.ok(!channelRoute(w, `${G}/drives/D1/items/X1`, 'DELETE'));
  assert.ok(!channelRoute({ team: 'T1', channel: w.channel }, `${G}/drives/D1/items/F1:/a.pdf:/content`, 'PUT'), 'no folder yet');
});

test('forwarding: read lists and covered mails; forward only the chosen mail', () => {
  const opt = { readIds: new Set(['M1']), forwardId: 'M1' };
  assert.ok(forwardRoute(`${G}/me/mailFolders/inbox/messages?$top=5`, 'GET', opt));
  assert.ok(forwardRoute(`${G}/me/messages/M1`, 'GET', opt));
  assert.ok(!forwardRoute(`${G}/me/messages/M2`, 'GET', opt));
  assert.ok(forwardRoute(`${G}/me/messages/M1/forward`, 'POST', opt));
  assert.ok(!forwardRoute(`${G}/me/messages/M2/forward`, 'POST', opt));
  assert.ok(!forwardRoute(`${G}/me/messages/M1/reply`, 'POST', opt));
  assert.ok(!forwardRoute(`${G}/me/sendMail`, 'POST', opt));
  assert.ok(!forwardRoute(`${G}/me/messages/M1/forward`, 'POST', { readIds: new Set(['M1']) }));
});

test('guardedGraph refuses before anything reaches the network', async () => {
  let calls = 0;
  const g = guardedGraph('t', () => false, async () => { calls++; return new Response('{}'); });
  await assert.rejects(g('/me/sendMail', { method: 'POST', body: {} }), /outside this tool's allowlist/);
  assert.equal(calls, 0);
  const ok = guardedGraph('t', () => true, async (url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response('{"a":1}'); });
  assert.deepEqual(await ok('/me'), { a: 1 });
  assert.equal(calls, 1);
});
