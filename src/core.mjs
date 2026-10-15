// honeykey core — CONTRACT MODULE. Other modules import from here; do not change
// exported signatures without updating every caller.
//
// Decoys are fake-but-realistic credentials. They are worthless to anyone, so the
// only reason one ever shows up in an outbound tool call, a PR comment or a CI log
// is that something (usually a prompt-injected agent) is exfiltrating secrets.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = '0.1.3';
export const STATE_DIR = '.honeykey';
export const STATE_FILE = 'state.json';
export const ALERT_LOG = 'alerts.jsonl';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';

function rand(alphabet, n) {
  const bytes = randomBytes(n * 2);
  let s = '';
  for (let i = 0; s.length < n; i++) s += alphabet[bytes[i % bytes.length] % alphabet.length];
  return s;
}

// Each provider yields { value, core }. `core` is the high-entropy random part
// used for fuzzy/partial matching; it must be a substring of `value`.
export const PROVIDERS = [
  { id: 'aws', label: 'AWS access key', env: 'AWS_SECRET_ACCESS_KEY', make() { const core = rand(ALNUM, 40); return { value: core, core, extra: { AWS_ACCESS_KEY_ID: 'AKIA' + rand(UPPER_NUM, 16) } }; } },
  { id: 'github', label: 'GitHub token', env: 'GITHUB_TOKEN', make() { const core = rand(ALNUM, 36); return { value: 'ghp_' + core, core }; } },
  { id: 'openai', label: 'OpenAI API key', env: 'OPENAI_API_KEY', make() { const core = rand(ALNUM, 48); return { value: 'sk-proj-' + core, core }; } },
  { id: 'anthropic', label: 'Anthropic API key', env: 'ANTHROPIC_API_KEY', make() { const core = rand(ALNUM + '-_', 80).replace(/^[-_]+/, 'A'); return { value: 'sk-ant-api03-' + core, core }; } },
  { id: 'stripe', label: 'Stripe secret key', env: 'STRIPE_SECRET_KEY', make() { const core = rand(ALNUM, 99); return { value: 'sk_live_' + core, core }; } },
  { id: 'slack', label: 'Slack bot token', env: 'SLACK_BOT_TOKEN', make() { const core = rand(ALNUM, 24); return { value: `xoxb-${rand('0123456789', 12)}-${rand('0123456789', 13)}-${core}`, core }; } },
  { id: 'database', label: 'Database URL', env: 'DATABASE_URL', make() { const core = rand(ALNUM, 28); return { value: `postgres://admin:${core}@db.internal:5432/prod`, core }; } },
  { id: 'jwt', label: 'JWT signing secret', env: 'JWT_SECRET', make() { const core = rand(HEX, 64); return { value: core, core }; } },
];

/** @returns {Array<{id:string, provider:string, label:string, env:string, value:string, core:string, extra?:object, createdAt:string}>} */
export function generateDecoys(providerIds = PROVIDERS.map((p) => p.id)) {
  const now = new Date().toISOString();
  return PROVIDERS.filter((p) => providerIds.includes(p.id)).map((p) => {
    const d = p.make();
    return { id: randomUUID().slice(0, 8), provider: p.id, label: p.label, env: p.env, value: d.value, core: d.core, ...(d.extra ? { extra: d.extra } : {}), createdAt: now };
  });
}

/** Renders decoys as a dotenv file body. */
export function toDotenv(decoys) {
  const lines = ['# Production credentials — DO NOT COMMIT', ''];
  for (const d of decoys) {
    if (d.extra) for (const [k, v] of Object.entries(d.extra)) lines.push(`${k}=${v}`);
    lines.push(`${d.env}=${d.value}`);
  }
  return lines.join('\n') + '\n';
}

// ---- state --------------------------------------------------------------

/** State shape: { version, createdAt, decoys: Decoy[], baitFiles: string[], mode: 'block'|'warn' } */
export function statePath(cwd) { return join(cwd, STATE_DIR, STATE_FILE); }
export function loadState(cwd) {
  const p = statePath(cwd);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}
export function saveState(cwd, state) {
  mkdirSync(join(cwd, STATE_DIR), { recursive: true });
  writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + '\n');
}
/** Appends one alert record (one JSON line). */
export function logAlert(cwd, record) {
  mkdirSync(join(cwd, STATE_DIR), { recursive: true });
  writeFileSync(join(cwd, STATE_DIR, ALERT_LOG), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { flag: 'a' });
}

// ---- detection ----------------------------------------------------------

const MIN_GRAM = 12;

/** Flattens any JSON-ish value into one searchable string. */
export function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(flatten).join('\n');
  return Object.entries(v).map(([k, x]) => `${k}: ${flatten(x)}`).join('\n');
}

const squash = (s) => s.replace(/[^A-Za-z0-9]/g, '');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function decodeCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    try {
      const s = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^[\x09\x0a\x0d\x20-\x7e]{8,}$/.test(s)) out.push(['base64', s]);
    } catch {}
  }
  for (const m of text.matchAll(/(?:[0-9a-fA-F]{2}){12,}/g)) {
    const s = Buffer.from(m[0], 'hex').toString('utf8');
    if (/^[\x09\x0a\x0d\x20-\x7e]{8,}$/.test(s)) out.push(['hex', s]);
  }
  if (/%[0-9A-Fa-f]{2}/.test(text)) { try { out.push(['url', decodeURIComponent(text)]); } catch {} }
  for (const m of text.matchAll(/(?:\\u00[0-9a-fA-F]{2}|\\x[0-9a-fA-F]{2}){8,}/g)) {
    out.push(['escape', m[0].replace(/\\(?:u00|x)([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))]);
  }
  return out;
}

function directHits(text, decoy) {
  if (text.includes(decoy.value)) return 'raw';
  if (text.includes(decoy.core)) return 'raw';
  const rev = [...text].reverse().join('');
  if (rev.includes(decoy.core)) return 'reversed';
  // base64 of the secret embedded at any byte alignment
  for (let s = 0; s < 3; s++) {
    const enc = b64(decoy.value.slice(s)).replace(/=+$/, '');
    const needle = enc.slice(0, -3);
    if (needle.length >= 16 && (text.includes(needle) || text.includes(needle.replace(/\+/g, '-').replace(/\//g, '_')))) return 'base64';
  }
  // split / interleaved with punctuation: "ghp_" + "abc..." , "a b c d"
  const flat = squash(text);
  if (flat.includes(squash(decoy.core))) return 'split';
  // partial leak: any MIN_GRAM-long window of the random core
  const core = squash(decoy.core);
  for (let i = 0; i + MIN_GRAM <= core.length; i += 4) {
    if (flat.includes(core.slice(i, i + MIN_GRAM))) return 'partial';
  }
  return null;
}

/**
 * Finds decoy leaks in arbitrary text (or any JSON value).
 * @returns {Array<{decoyId:string, provider:string, label:string, encoding:string}>}
 *   encoding ∈ raw | reversed | base64 | hex | url | escape | split | partial  (layered: e.g. "base64>reversed")
 */
export function findLeaks(input, decoys) {
  const text = flatten(input);
  if (!text || !decoys?.length) return [];
  const hits = [];
  const seen = new Set();
  const scan = (t, via, depth) => {
    for (const d of decoys) {
      if (seen.has(d.id)) continue;
      const how = directHits(t, d);
      if (how) { seen.add(d.id); hits.push({ decoyId: d.id, provider: d.provider, label: d.label, encoding: via ? `${via}>${how}` : how }); }
    }
    if (depth < 2 && seen.size < decoys.length) for (const [kind, s] of decodeCandidates(t)) scan(s, via ? `${via}>${kind}` : kind, depth + 1);
  };
  scan(text, '', 0);
  return hits.map((h) => ({ ...h, encoding: h.encoding.replace(/>raw$/, '') }));
}
