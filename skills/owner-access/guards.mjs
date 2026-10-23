// Request guards for the as-owner tools (pure, unit-tested). Every network call goes through one of these first.

// Microsoft 365 web hosts owner-web may open or fetch from.
const M365 = /(^|\.)(sharepoint\.com|office\.com|office365\.com|microsoft365\.com|cloud\.microsoft|teams\.microsoft\.com|outlook\.com)$/i;
export const isM365Host = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && M365.test(u.hostname); } catch { return false; }
};
// Sign-in hosts the browser is redirected through; reaching one means the session is signed out.
export const isLoginUrl = (url) => /(^|\.)login\.(microsoftonline\.com|live\.com)$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());

export const OWNER_WEB_READ = new Set(['check', 'whoami', 'search', 'shared', 'ls', 'get', 'open']);

// Browser requests while a read command runs. Outlook web reads through POSTs, so POST stays open, but known write
// actions (send, mark read, move, delete, create) and every PUT/PATCH/DELETE/MERGE are aborted.
const MUTATE = /\/s(end|endmail)\b|SendItem|action=(UpdateItem|MarkAllItemsAsRead|MarkItemsAsRead|DeleteItem|MoveItem|CreateItem|SetReadFlag|SendItem)|\b(DeleteItem|MoveItem|CreateItem|UpdateItem|SetReadFlag)\b/i;
export function browserRequestAllowed(method, url, body = '') {
  const m = String(method).toUpperCase();
  if (['PUT', 'PATCH', 'DELETE', 'MERGE'].includes(m)) return false;
  if (m !== 'POST') return !MUTATE.test(url);
  return !MUTATE.test(url) && !MUTATE.test(String(body).slice(0, 20000));
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const lc = (s) => String(s).toLowerCase();
const parse = (url) => { const u = new URL(url); return { u, path: decodeURIComponent(u.pathname).replace(/^\/v1\.0/, '').toLowerCase() }; };

// Read-only shared mailbox: GET of the listed folders' message lists (and their paging links) only.
export function inboxReadRoute(mailbox, url, method, folders = ['inbox', 'junkemail']) {
  if (method !== 'GET' || !url.startsWith(GRAPH)) return false;
  const { path } = parse(url), root = `/users/${lc(mailbox)}`;
  return folders.some((f) => path === `${root}/mailfolders/${lc(f)}/messages`);
}

// Shared-mailbox drafts: read the Drafts folder, create a draft, edit or attach to the Being's own draft ids, read Sent
// Items in send mode, and send only the ids of an approved batch. Anything else (delete, move, reply-all) is refused.
export function draftsRoute(mailbox, url, method, { own = new Set(), sendIds = new Set(), sentItems = false } = {}) {
  if (!url.startsWith(GRAPH)) return false;
  const { u, path } = parse(url), root = `/users/${lc(mailbox)}`;
  const ids = (set) => new Set([...set].map(lc));
  const msg = (p) => { const m = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/messages/([^/]+)(/.*)?$`).exec(p); return m ? [m[1], m[2] || ''] : null; };
  const hit = msg(path);
  if (method === 'POST' && hit && hit[1] === '/send' && !u.search) return ids(sendIds).has(hit[0]);
  if (/\/(send|sendmail|reply|replyall|forward|move|copy)$/.test(path)) return false;
  if (method === 'GET') {
    if (path === `${root}/mailfolders/drafts` || path === `${root}/mailfolders/drafts/messages`) return true;
    if (sentItems && path === `${root}/mailfolders/sentitems/messages`) return true;
    return !!hit && ids(own).has(hit[0]) && ['', '/attachments'].includes(hit[1]);
  }
  if (method === 'POST') return (path === `${root}/messages` && !u.search) || (!!hit && ids(own).has(hit[0]) && hit[1] === '/attachments');
  if (method === 'PATCH') return !!hit && ids(own).has(hit[0]) && hit[1] === '' && !u.search;
  return false;
}

// Channel posts: one allowed team/channel; read it, post top-level messages there, and write files in its folder only.
export function channelRoute({ team, channel, driveId, folderId }, url, method) {
  if (!url.startsWith(GRAPH)) return false;
  const { u, path } = parse(url), ch = `/teams/${lc(team)}/channels/${lc(channel)}`;
  if (method === 'GET') {
    if ([ch, `${ch}/filesfolder`, `${ch}/messages`].includes(path)) return true;
    return !!driveId && path.startsWith(`/drives/${lc(driveId)}/items/`);
  }
  if (method === 'POST' && path === `${ch}/messages` && !u.search) return true;
  if (!driveId || !folderId) return false;
  const inFolder = path.startsWith(`/drives/${lc(driveId)}/items/${lc(folderId)}:/`) && !/(^|\/)\.\.(\/|:|$)/.test(path);
  if (method === 'PUT') return inFolder && path.endsWith(':/content');
  if (method === 'POST') return inFolder && path.endsWith(':/createuploadsession');
  return false;
}

// Owner mail forwarding: read the inbox and Sent Items lists, read only mails a rule covers, forward only the chosen one.
export function forwardRoute(url, method, { readIds = new Set(), forwardId = null } = {}) {
  if (!url.startsWith(GRAPH)) return false;
  const { u, path } = parse(url);
  const m = /^\/me\/messages\/([^/]+)(\/forward)?$/.exec(path);
  if (method === 'GET') {
    if (['/me', '/me/mailfolders/inbox/messages', '/me/mailfolders/sentitems/messages'].includes(path)) return true;
    return !!m && !m[2] && new Set([...readIds].map(lc)).has(m[1]);
  }
  return method === 'POST' && !!m && m[2] === '/forward' && !u.search && !!forwardId && lc(forwardId) === m[1];
}

// Graph calls through a route guard; refused routes never reach the network.
export function guardedGraph(token, allow, fetcher = fetch) {
  return async (url, { method = 'GET', body, headers = {}, raw = false, allow404 = false } = {}) => {
    const full = url.startsWith('https://') ? url : `${GRAPH}${url}`;
    if (!allow(full, method)) throw new Error(`refused: ${method} ${full.replace(GRAPH, '').split('?')[0]} is outside this tool's allowlist`);
    const isBuf = Buffer.isBuffer(body);
    const r = await fetcher(full, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json' }), ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
    if (allow404 && r.status === 404) return null;
    if (raw) { if (!r.ok) throw new Error(`${r.status} ${method} ${full.slice(0, 90)}`); return r; }
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${method} ${full.replace(GRAPH, '').slice(0, 90)}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  };
}
