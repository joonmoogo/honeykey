// honeykey ui — tiny ANSI helpers. Zero deps. Colors are disabled when NO_COLOR
// is set or the stream is not a TTY (FORCE_COLOR overrides the TTY check).

const ESC = '\x1b[';
const CODES = { bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39], amber: ['38;5;214', 39], bgRed: [41, 49], bgAmber: ['48;5;214', 49] };

export function colorEnabled(stream = process.stdout) {
  const env = process.env;
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return !!stream?.isTTY;
}

export function makeColors(enabled) {
  const c = {};
  for (const [name, [open, close]] of Object.entries(CODES)) {
    c[name] = enabled ? (s) => `${ESC}${open}m${s}${ESC}${close}m` : (s) => String(s);
  }
  c.enabled = enabled;
  return c;
}

export const c = makeColors(colorEnabled(process.stdout));
export const ce = makeColors(colorEnabled(process.stderr));

const unicode = process.platform !== 'win32' || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
export const sym = unicode
  ? { ok: '✔', fail: '✖', warn: '▲', info: 'ℹ', dot: '•', arrow: '→', hex: '⬢', bar: '│', mask: '•' }
  : { ok: '√', fail: '×', warn: '!', info: 'i', dot: '*', arrow: '->', hex: '#', bar: '|', mask: '*' };

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
/** Display width (counts East-Asian wide chars as 2). */
export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300)) ? 2 : 1;
  }
  return w;
}
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

/** Rounded box around lines. opts: { title, color: 'amber'|'red'|..., colors, padding } */
export function box(lines, { title = '', color = 'amber', colors = c, padding = 1 } = {}) {
  const paint = colors[color] || ((s) => s);
  const sp = ' '.repeat(padding);
  const inner = Math.max(...lines.map(width), title ? width(title) + 2 : 0) + padding * 2;
  const tl = unicode ? '╭' : '+', tr = unicode ? '╮' : '+', bl = unicode ? '╰' : '+', br = unicode ? '╯' : '+', h = unicode ? '─' : '-', v = unicode ? '│' : '|';
  const top = title
    ? paint(tl + h) + ' ' + colors.bold(title) + ' ' + paint(h.repeat(Math.max(0, inner - width(title) - 3)) + tr)
    : paint(tl + h.repeat(inner) + tr);
  const body = lines.map((l) => paint(v) + sp + pad(l, inner - padding * 2) + sp + paint(v));
  return [top, ...body, paint(bl + h.repeat(inner) + br)].join('\n');
}

/** Simple aligned table (no borders). rows: string[][] */
export function table(rows, { indent = 2, gap = 2 } = {}) {
  if (!rows.length) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  return rows.map((r) => ' '.repeat(indent) + r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell ?? '', widths[i] + gap))).join('')).join('\n');
}

/** Masks the random core of a decoy so screenshots never show a full value. */
export function maskDecoy(d, max = 44) {
  const core = d.core || '';
  const at = core ? d.value.indexOf(core) : -1;
  let s;
  if (at < 0) s = d.value.slice(0, 8) + sym.mask.repeat(8);
  else {
    let prefix = d.value.slice(0, at);
    if (prefix.length > 16) prefix = prefix.slice(0, 11) + '…';
    s = prefix + core.slice(0, 4) + sym.mask.repeat(8) + core.slice(-2) + d.value.slice(at + core.length);
  }
  if (width(s) > max) s = s.slice(0, max - 1) + '…';
  return s;
}

export const banner = (colors = c) => `${colors.amber(sym.hex)} ${colors.bold('honeykey')} ${colors.dim('— honeypot secrets for AI coding agents')}`;

export function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
