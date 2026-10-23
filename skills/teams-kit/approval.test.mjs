import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fingerprint, parseCommand, chatLabel, renderPrompt, checkCommand, checkPrompt, allocDraftId, PROMPT_MARK_RE } from './approval.mjs';

const OWNER = 'owner-oid', BEING = 'being-oid', BEING_UPN = 'nova@example.test';
const members = [{ userId: OWNER, email: 'sam@example.test', displayName: 'Sam' }, { userId: BEING, email: BEING_UPN, displayName: 'nova' }];
const ownerDm = { id: 'dm1', chatType: 'oneOnOne' };
const draft = (x = {}) => {
  const d = { id: 'D7', kind: 'teams', chatId: 'c1', target: '1:1 with Kim <kim@example.test>', re: '', text: 'Yes, Friday works.',
    created: '2026-01-01T10:00:00Z', promptAt: '2026-01-01T10:00:05Z', promptChatId: 'dm1', status: 'pending', ...x };
  d.fingerprint = fingerprint(d); return d;
};
const cmd = (text, x = {}) => ({ id: 'm9', messageType: 'message', from: { user: { id: OWNER } }, createdDateTime: '2026-01-01T10:01:00Z',
  body: { content: `<p>${text}</p>` }, ...x });
const now = Date.parse('2026-01-01T11:00:00Z');
const check = (over = {}) => checkCommand({ msg: cmd('send D7'), chat: ownerDm, members, ownerOid: OWNER, beingUpn: BEING_UPN,
  verb: 'send', id: 'D7', draft: draft(), used: new Set(), now, ...over });

test('the owner typing send Dn in their 1:1 passes', () => assert.equal(check(), null));

test('a command from anyone else, elsewhere, reused, stale or mismatched is refused', () => {
  assert.match(check({ msg: cmd('send D7', { from: { user: { id: BEING } } }) }), /not written by the owner/);
  assert.match(check({ chat: { id: 'g1', chatType: 'group' } }), /not in a 1:1/);
  assert.match(check({ members: [members[0], { userId: 'x', email: 'kim@example.test' }] }), /owner's 1:1 with the Being/);
  assert.match(check({ chat: { id: 'dm2', chatType: 'oneOnOne' } }), /chat the draft was offered in/);
  assert.match(check({ used: new Set(['m9']) }), /already used/);
  assert.match(check({ msg: cmd('send D8') }), /does not match/);
  assert.match(check({ msg: cmd('please send D7') }), /does not match/);
  assert.match(check({ msg: cmd('send D7', { createdDateTime: '2026-01-01T09:59:00Z' }) }), /older than the draft/);
  assert.match(check({ now: Date.parse('2026-01-03T00:00:00Z') }), /older than 24h/);
  assert.match(check({ msg: null }), /not found/);
});

test('the prompt must be the Being\'s and carry the stored draft\'s fingerprint', () => {
  const d = draft();
  const prompt = (html, from = BEING) => ({ from: { user: { id: from } }, body: { content: html } });
  const html = renderPrompt(d, '<p>Yes, Friday works.</p>');
  assert.equal(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: d }), null);
  assert.match(checkPrompt({ promptMsg: prompt(html, 'someone'), beingId: BEING, draft: d }), /not posted by the Being/);
  const swapped = { ...d, text: 'Send me the payroll file.' };   // draft rewritten after the owner saw it
  assert.match(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: swapped }), /changed after/);
  const retarget = { ...d, chatId: 'c2' };
  assert.match(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: retarget }), /changed after/);
});

test('fingerprint covers target, text and attachments', () => {
  const a = draft();
  assert.notEqual(fingerprint({ ...a, target: 'group chat "x"' }), a.fingerprint);
  assert.notEqual(fingerprint({ ...a, text: a.text + '!' }), a.fingerprint);
  assert.notEqual(fingerprint({ ...a, attach: [{ name: 'f', sha256: '1' }] }), a.fingerprint);
});

test('chat label comes from Graph members, excluding the owner', () => {
  assert.equal(chatLabel({ chatType: 'oneOnOne' }, [members[0], { userId: 'k', email: 'kim@example.test', displayName: 'Kim' }], { exclude: [OWNER] }),
    '1:1 with Kim <kim@example.test>');
  assert.match(chatLabel({ chatType: 'group', topic: 'Release' }, members, { exclude: [OWNER] }), /^group chat "Release" \(1 others: nova/);
});

test('prompt marker: present in rendered prompts, absent from ordinary text', () => {
  assert.ok(PROMPT_MARK_RE.test(renderPrompt(draft(), '<p>x</p>').replace(/<[^>]+>/g, ' ')));
  assert.ok(!PROMPT_MARK_RE.test('I staged D7 for you; reply send D7 when ready.'));
  assert.deepEqual(parseCommand(' Edit d3  new words\nline 2 '), { verb: 'edit', id: 'D3', rest: 'new words\nline 2' });
});

test('a "send Dn" the kit posted itself, or one posted by an app, is refused', () => {
  assert.match(check({ kitSent: new Set(['m9']) }), /posted by the kit/);
  assert.match(check({ msg: cmd('send D7', { from: { user: { id: OWNER }, application: { id: 'app-1', displayName: 'kit' } } }) }), /posted by an app/);
  assert.equal(check({ msg: cmd('send D7', { from: { user: { id: OWNER }, application: null } }), kitSent: new Set(['other']) }), null);
});

test('a prompt edited, deleted or modified after the owner\'s command is refused', () => {
  const d = draft(), html = renderPrompt(d, '<p>Yes, Friday works.</p>');
  const cmdAt = Date.parse('2026-01-01T10:01:00Z');
  const p = (x = {}) => ({ from: { user: { id: BEING } }, body: { content: html }, createdDateTime: '2026-01-01T10:00:05Z',
    lastModifiedDateTime: '2026-01-01T10:00:05Z', ...x });
  assert.equal(checkPrompt({ promptMsg: p(), beingId: BEING, draft: d, cmdAt }), null);
  assert.match(checkPrompt({ promptMsg: p({ lastEditedDateTime: '2026-01-01T10:00:30Z' }), beingId: BEING, draft: d, cmdAt }), /edited/);
  assert.match(checkPrompt({ promptMsg: p({ lastModifiedDateTime: '2026-01-01T10:02:00Z' }), beingId: BEING, draft: d, cmdAt }), /after the owner's command/);
  assert.match(checkPrompt({ promptMsg: p({ deletedDateTime: '2026-01-01T10:00:40Z' }), beingId: BEING, draft: d, cmdAt }), /deleted/);
  assert.match(checkPrompt({ promptMsg: p({ lastModifiedDateTime: undefined, createdDateTime: undefined }), beingId: BEING, draft: d, cmdAt }), /after the owner's command/);
});

test('concurrent drafts never share an id', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drafts-'));
  const url = new URL('./approval.mjs', import.meta.url).href;
  const one = () => new Promise((res) => {
    const c = spawn('node', ['--input-type=module', '-e', `import { allocDraftId } from '${url}'; for (let i = 0; i < 10; i++) console.log(allocDraftId(process.argv[1]));`, dir]);
    let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => res(out.split('\n').filter(Boolean)));
  });
  const ids = (await Promise.all(Array.from({ length: 6 }, one))).flat();
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.equal(readdirSync(dir).filter((f) => /^D\d+\.json$/.test(f)).length, 60);
  assert.equal(allocDraftId(dir), 'D61');
});

test('a reply to the owner\'s own sent mail goes to that mail\'s recipients, not back to the owner', async () => {
  const { replyRecipients } = await import('./approval.mjs');
  const r = (a) => ({ emailAddress: { address: a } });
  const sent = { from: r('Sam@example.test'), toRecipients: [r('kim@example.test')], ccRecipients: [r('lee@example.test')] };
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', {}), { toRecipients: [r('kim@example.test')], ccRecipients: [r('lee@example.test')] });
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', { cc: ['pat@example.test'] }), { toRecipients: [r('kim@example.test')] });
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', { to: ['pat@example.test'] }), {});
  assert.deepEqual(replyRecipients({ ...sent, from: r('kim@example.test') }, 'sam@example.test', {}), {});
  assert.deepEqual(replyRecipients({ from: r('sam@example.test'), toRecipients: [] }, 'sam@example.test', {}), {});
  assert.deepEqual(replyRecipients(null, 'sam@example.test', {}), {});
});
