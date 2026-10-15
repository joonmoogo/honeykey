// honeykey init/uninstall — plants decoys, bait files, the bundled hook and the
// per-agent integrations. Pure-ish: returns a report object; cli.mjs renders it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, STATE_DIR, generateDecoys, toDotenv, loadState, saveState } from './core.mjs';
import { INTEGRATIONS, GUARD_FILE, detectAgents } from './integrations.mjs';

const SRC = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BAIT = '.env.production.local';
const FALLBACK_BAITS = ['.env.backup', '.env.production.bak', '.env.prod.local', '.env.old', '.env.live.local'];
const GITIGNORE_HEADER = '# honeykey — decoy secrets & local state (never commit)';

// ---- guard bundle -------------------------------------------------------

/**
 * Builds a self-contained ESM hook script from core.mjs + guard.mjs so the hook
 * never needs npx / node_modules at runtime (it runs on every tool call).
 */
export function buildGuardBundle() {
  const imports = new Set();
  const bodies = [];
  for (const f of ['core.mjs', 'guard.mjs']) {
    const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
    const body = [];
    for (const line of lines) {
      if (/^import .+ from '\.\/[^']+';?\s*$/.test(line)) continue;
      if (/^import .+ from 'node:[^']+';?\s*$/.test(line)) { imports.add(line.trim()); continue; }
      body.push(line.replace(/^export (?=(?:async )?function|const |let |class )/, ''));
    }
    bodies.push(`// ---- ${f} ----\n` + body.join('\n'));
  }
  return [
    '#!/usr/bin/env node',
    `// honeykey ${VERSION} — generated hook. Do not edit; re-run \`npx honeykey init\` to regenerate.`,
    ...imports,
    "import * as __hkurl from 'node:url';",
    ...bodies,
    '// ---- entry ----',
    'const __hkroot = gpath.dirname(gpath.dirname(__hkurl.fileURLToPath(import.meta.url)));',
    'process.exitCode = await runGuard({ argv: process.argv.slice(2), root: __hkroot });',
    '',
  ].join('\n');
}

export function writeGuardBundle(cwd) {
  const file = join(cwd, STATE_DIR, GUARD_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildGuardBundle(), { mode: 0o755 });
  return file;
}

// ---- gitignore ----------------------------------------------------------

function gitignoreHas(lines, entry) {
  const bare = entry.replace(/^\//, '').replace(/\/$/, '');
  return lines.some((l) => { const t = l.trim().replace(/^\//, '').replace(/\/$/, ''); return t === bare; });
}

/** Ensures entries are ignored. Returns entries actually added. */
export function ensureGitignore(cwd, entries) {
  const file = join(cwd, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const missing = entries.filter((e) => !gitignoreHas(lines, e));
  if (!missing.length) return [];
  let out = text;
  if (out && !out.endsWith('\n')) out += '\n';
  if (!lines.includes(GITIGNORE_HEADER)) out += (out ? '\n' : '') + GITIGNORE_HEADER + '\n';
  // insert right after our header so our block stays together
  const idx = out.indexOf(GITIGNORE_HEADER + '\n') + GITIGNORE_HEADER.length + 1;
  out = out.slice(0, idx) + missing.map((e) => e + '\n').join('') + out.slice(idx);
  writeFileSync(file, out);
  return missing;
}

export function cleanGitignore(cwd, entries) {
  const file = join(cwd, '.gitignore');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const start = lines.indexOf(GITIGNORE_HEADER);
  if (start < 0) return [];
  // only remove inside our block (header + following non-blank lines)
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') end++;
  const block = lines.slice(start + 1, end);
  const removed = block.filter((l) => entries.includes(l.trim()));
  const kept = block.filter((l) => !entries.includes(l.trim()));
  const before = lines.slice(0, start);
  if (!kept.length) while (before.length && before[before.length - 1].trim() === '') before.pop();
  const next = [...before, ...(kept.length ? [GITIGNORE_HEADER, ...kept] : []), ...lines.slice(end)];
  while (next.length > 1 && next[next.length - 1] === '' && next[next.length - 2] === '') next.pop();
  const out = next.join('\n');
  if (out.trim()) writeFileSync(file, out.endsWith('\n') ? out : out + '\n');
  else rmSync(file);
  return removed;
}

// ---- init ---------------------------------------------------------------

/** Picks a bait filename that does not clobber anything the user owns. */
export function chooseBait(cwd, wanted, ours = []) {
  if (!existsSync(join(cwd, wanted)) || ours.includes(wanted)) return { file: wanted, renamedFrom: null };
  for (const f of FALLBACK_BAITS) if (!existsSync(join(cwd, f)) || ours.includes(f)) return { file: f, renamedFrom: wanted };
  for (let i = 2; ; i++) { const f = `.env.backup.${i}`; if (!existsSync(join(cwd, f))) return { file: f, renamedFrom: wanted }; }
}

/**
 * @param {{cwd:string, agents?:string[], mode?:'block'|'warn', bait?:string, rotate?:boolean}} opts
 */
export function init({ cwd, agents, mode, bait, rotate = false }) {
  let prev = null;
  let corrupt = false;
  try { prev = loadState(cwd); } catch { corrupt = true; }
  const agentList = agents?.length ? agents : prev?.agents?.length ? prev.agents : detectAgents(cwd);
  for (const a of agentList) if (!INTEGRATIONS[a]) throw new Error(`unknown agent "${a}" (supported: ${Object.keys(INTEGRATIONS).join(', ')})`);

  const reused = !!(prev?.decoys?.length && !rotate);
  const decoys = reused ? prev.decoys : generateDecoys();
  const ours = prev?.baitFiles || [];

  // bait file(s): keep previously planted ones, plus the requested one
  const baitFiles = [];
  let renamed = null;
  const wanted = bait || (ours.length ? null : DEFAULT_BAIT);
  if (wanted) {
    const pick = chooseBait(cwd, wanted, ours);
    if (pick.renamedFrom) renamed = { wanted: pick.renamedFrom, used: pick.file };
    baitFiles.push(pick.file);
  }
  for (const f of ours) if (!baitFiles.includes(f)) baitFiles.push(f);
  for (const f of baitFiles) {
    const p = join(cwd, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, toDotenv(decoys), { mode: 0o600 });
  }

  const state = {
    version: VERSION,
    createdAt: reused ? prev.createdAt : new Date().toISOString(),
    ...(rotate && prev ? { rotatedAt: new Date().toISOString() } : {}),
    decoys,
    baitFiles,
    mode: mode || prev?.mode || 'block',
    agents: agentList,
  };
  saveState(cwd, state);
  const guardFile = writeGuardBundle(cwd);
  const ignored = ensureGitignore(cwd, [`${STATE_DIR}/`, ...baitFiles]);

  const integrations = agentList.map((id) => {
    try { return { id, label: INTEGRATIONS[id].label, file: INTEGRATIONS[id].file(cwd), result: INTEGRATIONS[id].install(cwd) }; }
    catch (e) { return { id, label: INTEGRATIONS[id].label, file: INTEGRATIONS[id].file(cwd), error: e.message }; }
  });

  return { state, reused, rotated: rotate && !!prev, firstRun: !prev, corrupt, renamed, guardFile, ignored, integrations };
}

// ---- uninstall ----------------------------------------------------------

export function uninstall({ cwd, keepBait = false }) {
  let state = null;
  try { state = loadState(cwd); } catch {}
  const report = { hooks: [], baitRemoved: [], baitKept: [], gitignore: [], stateRemoved: false };
  for (const [id, integ] of Object.entries(INTEGRATIONS)) {
    try { if (integ.uninstall(cwd)) report.hooks.push({ id, label: integ.label, file: integ.file(cwd) }); }
    catch (e) { report.hooks.push({ id, label: integ.label, error: e.message }); }
  }
  const baits = state?.baitFiles || [];
  for (const f of baits) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    // only delete if it still contains our decoys (the user may have repurposed it)
    const body = readFileSync(p, 'utf8');
    if (!keepBait && state.decoys?.some((d) => body.includes(d.value))) { rmSync(p); report.baitRemoved.push(f); }
    else report.baitKept.push(f);
  }
  report.gitignore = cleanGitignore(cwd, [`${STATE_DIR}/`, ...report.baitRemoved]);
  if (existsSync(join(cwd, STATE_DIR))) { rmSync(join(cwd, STATE_DIR), { recursive: true, force: true }); report.stateRemoved = true; }
  return report;
}
