// Outgoing-text filter: refuse anything that quotes the kit's .env or looks like a credential.
// Returns the names of what matched, never the values.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const SENSITIVE_KEY = /(CLIENT_ID|TENANT_ID|_OID|SECRET|TOKEN|PASSWORD|PASSWD|KEY)$/;
const PATTERNS = [
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/],
  ['refresh-token', /\b[01]\.A[\w-]{60,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-key', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/],
  ['env-line', /^\s*(?:export\s+)?(?:BEING|OWNER|M365)_[A-Z0-9_]+=/m],
  ['credential-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S{6,}/i],
];

// .env values worth protecting: tenant/app/object ids and anything named like a secret. Names, UPNs, paths pass.
export function envSecrets(file = path.join(KIT, '.env'), env = process.env) {
  const out = [];
  const add = (k, v) => { v = (v || '').trim(); if (SENSITIVE_KEY.test(k) && v.length >= 8) out.push([k, v]); };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (/^'.*'$|^".*"$/.test(v.split(/\s+#/)[0].trim())) v = v.split(/\s+#/)[0].trim().slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      add(m[1], v);
    }
  }
  for (const [k, v] of Object.entries(env)) if (/^(BEING|OWNER|M365)_/.test(k)) add(k, v);
  return out;
}

// Attachment bytes get the same scan (latin1 keeps every ASCII credential intact). Returns "<file>: <match>" names.
export function findSecretsInFiles(files, { secrets = envSecrets() } = {}) {
  return files.flatMap((f) => findSecrets(readFileSync(f).toString('latin1'), { secrets }).map((n) => `${path.basename(f)}: ${n}`));
}

export function findSecrets(text, { secrets = envSecrets() } = {}) {
  const t = String(text || '');
  const plain = t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
  const hits = [];
  for (const [k, v] of secrets) if (t.includes(v) || plain.includes(v)) hits.push(k);
  for (const [name, re] of PATTERNS) if (re.test(t) || re.test(plain)) hits.push(name);
  return [...new Set(hits)];
}
