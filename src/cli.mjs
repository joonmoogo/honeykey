// honeykey cli — argument parsing + rendering. Logic lives in init.mjs,
// guard.mjs, integrations.mjs and core.mjs.
import { readFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { VERSION, STATE_DIR, ALERT_LOG, PROVIDERS, generateDecoys, loadState, saveState, findLeaks } from './core.mjs';
import { c, ce, sym, box, table, maskDecoy, banner, timeAgo, width } from './ui.mjs';
import { init, uninstall, DEFAULT_BAIT } from './init.mjs';
import { runGuard, findStateRoot } from './guard.mjs';
import { INTEGRATIONS, AGENT_IDS } from './integrations.mjs';

// ---- args ---------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv, { bool = [], str = [] } = {}) {
  const opts = {}, args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      const key = k.replace(/-([a-z])/g, (_, x) => x.toUpperCase());
      if (bool.includes(k)) { opts[key] = v === undefined ? true : v !== 'false'; continue; }
      if (str.includes(k)) {
        const val = v ?? argv[++i];
        if (val === undefined || (v === undefined && val.startsWith('--'))) throw new UsageError(`--${k} needs a value`);
        opts[key] = val;
        continue;
      }
      throw new UsageError(`unknown option --${k}`);
    }
    args.push(a);
  }
  return { opts, args };
}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');
const rel = (cwd, p) => relative(cwd, p) || '.';
const ok = (s) => `  ${c.green(sym.ok)} ${s}`;
const warnLine = (s) => `  ${c.yellow(sym.warn)} ${s}`;
const failLine = (s) => `  ${c.red(sym.fail)} ${s}`;
const cmd = (s) => c.cyan(s);

// ---- help ---------------------------------------------------------------

const HELP = {
  _: `${banner()}

${c.bold('Usage')}  honeykey <command> [options]

${c.bold('Commands')}
${table([
  [cmd('init'), 'plant decoy secrets + install agent hooks in this project'],
  [cmd('status'), 'show decoys, installed hooks and alert count'],
  [cmd('alerts'), 'list caught exfiltration attempts'],
  [cmd('attack'), 'red-team your agent with simulated prompt injections'],
  [cmd('scan'), 'scan files / stdin for leaked decoys (exit 1 on leak)'],
  [cmd('ci-env'), 'generate decoys for a CI run and print / export them'],
  [cmd('guard'), 'hook entry point (reads hook JSON from stdin)'],
  [cmd('uninstall'), 'remove hooks, bait files and .honeykey/'],
])}

${c.bold('Options')}
${table([['-h, --help', 'help for a command'], ['-v, --version', 'print version']])}

Run ${cmd('honeykey <command> --help')} for details.  Docs: ${c.underline('https://github.com/joonmoogo/honeykey')}`,

  init: `${c.bold('honeykey init')} [options]

Generates fake-but-realistic credentials, writes them to a bait env file your
coding agent can discover, and installs a pre-tool-use hook that blocks any tool
call trying to send them anywhere (raw, base64, hex, reversed, split, ...).

${c.bold('Options')}
${table([
  ['--agents <list>', `comma-separated: ${AGENT_IDS.join(',')}  (default: claude + detected)`],
  ['--mode <mode>', 'block (default) or warn — warn allows the call but logs + notifies'],
  ['--bait <file>', `bait file name (default ${DEFAULT_BAIT}; never overwrites your files)`],
  ['--rotate', 'regenerate all decoys (old values stop being detected)'],
])}

Re-running init is safe: hooks are never duplicated and decoys are kept unless --rotate.`,

  status: `${c.bold('honeykey status')}\n\nShows planted decoys (masked), bait files, installed agent hooks and alerts.`,
  alerts: `${c.bold('honeykey alerts')} [--json] [--limit <n>]\n\nLists exfiltration attempts caught by the guard (from ${STATE_DIR}/${ALERT_LOG}).`,
  attack: `${c.bold('honeykey attack')} [options]\n\nRuns simulated prompt-injection attacks against your agent setup to prove the hook works.\nSee ${cmd('honeykey attack --help')} once the red-team module is installed.`,
  scan: `${c.bold('honeykey scan')} [files...|-] [options]

Scans files (or stdin with "-" or a pipe) for any decoy value, including encoded,
reversed and split forms. Exits 1 if a leak is found — use it in CI on logs,
build artifacts or PR comments.

${c.bold('Options')}
${table([
  ['--state <path>', `state.json or a directory containing ${STATE_DIR}/ (default: nearest ${STATE_DIR}/)`],
  ['--json', 'machine-readable output'],
])}`,
  'ci-env': `${c.bold('honeykey ci-env')} [--github-env] [--providers aws,github,...] [--rotate]

Generates decoys for a CI run, saves ${STATE_DIR}/state.json and prints KEY=value
lines (e.g. ${cmd('eval "$(npx honeykey ci-env)"')}). With --github-env the variables
are appended to $GITHUB_ENV instead and only the names are printed. Later steps
can run ${cmd('honeykey scan')} on logs/artifacts to catch exfiltration.`,
  guard: `${c.bold('honeykey guard')} [--agent claude|cursor|gemini] [--root <dir>]

Hook entry point: reads the agent's hook JSON on stdin and blocks (exit 2) tool
calls that contain a decoy. ${cmd('honeykey init')} installs a bundled copy at
${STATE_DIR}/guard.mjs so hooks never depend on npx; use this for global installs.`,
  uninstall: `${c.bold('honeykey uninstall')} [--keep-bait]\n\nRemoves honeykey hooks from every agent config, deletes bait files that still\ncontain our decoys, cleans .gitignore and deletes ${STATE_DIR}/.`,
};

// ---- commands -----------------------------------------------------------

function cmdInit(argv, cwd) {
  const { opts } = parseArgs(argv, { bool: ['rotate'], str: ['agents', 'mode', 'bait'] });
  if (opts.help) return out(HELP.init), 0;
  if (opts.mode && !['block', 'warn'].includes(opts.mode)) throw new UsageError('--mode must be "block" or "warn"');
  const agents = opts.agents ? opts.agents.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
  if (opts.bait && (opts.bait.includes('..') || resolve(cwd, opts.bait) === resolve(cwd))) throw new UsageError('--bait must be a file inside this project');

  const r = init({ cwd, agents, mode: opts.mode, bait: opts.bait, rotate: !!opts.rotate });
  const { state } = r;
  const W = 30;
  const step = (label, detail) => ok(label.padEnd(W) + c.dim(sym.arrow + ' ' + detail));

  out();
  out(banner());
  out();
  if (r.corrupt) out(warnLine(`existing ${STATE_DIR}/state.json was unreadable — generated a fresh one`));
  const n = state.decoys.length;
  out(step(r.rotated ? `Rotated ${n} decoy secrets` : r.reused ? `${n} decoy secrets in place` : `Planted ${n} decoy secrets`, state.baitFiles.join(', ')));
  if (r.migrated?.length) out(warnLine(`moved decoys out of ${r.migrated.map((f) => c.bold(f)).join(', ')} (frameworks load it in production builds)`));
  if (r.renamed) out(warnLine(`${c.bold(r.renamed.wanted)} already exists — left it untouched, used ${c.bold(r.renamed.used)} instead`));
  const kb = (statSafe(r.guardFile) / 1024).toFixed(1);
  out(step('Bundled hook', `${rel(cwd, r.guardFile)} (${kb} KB, zero deps)`));
  for (const i of r.integrations) {
    if (i.error) { out(failLine(`${i.label}: ${i.error}`)); continue; }
    const what = { installed: 'hook installed', merged: 'hook merged', updated: 'hook updated', unchanged: 'hook up to date' }[i.result];
    out(step(`${i.label} ${what}`, rel(cwd, i.file)));
  }
  out(step(r.ignored.length ? 'Added to .gitignore' : 'Already git-ignored', (r.ignored.length ? r.ignored : [`${STATE_DIR}/`, ...state.baitFiles]).join('  ')));
  out();

  const rows = state.decoys.map((d) => [c.bold(d.env), c.dim(d.label), c.amber(maskDecoy(d, 30))]);
  const tw = rows.map((r) => r.map(width));
  const col = [0, 1].map((i) => Math.max(...tw.map((t) => t[i])));
  out(box(rows.map((r) => r[0] + ' '.repeat(col[0] - width(r[0]) + 2) + r[1] + ' '.repeat(col[1] - width(r[1]) + 2) + r[2]), { title: 'Decoys', color: 'amber' }));
  out();
  const modeLine = state.mode === 'block'
    ? `${c.bold('Mode')} ${c.red('block')}  ${c.dim('— tool calls that leak a decoy are stopped before they run.')}`
    : `${c.bold('Mode')} ${c.yellow('warn')}   ${c.dim('— leaks are allowed but logged + notified.')}`;
  out('  ' + modeLine);
  out(`  ${c.dim('These keys are fake. If one ever leaves this machine, an agent was prompt-injected.')}`);
  out();
  out(`  ${c.bold('Next')}`);
  out(table([
    [cmd('npx honeykey attack'), c.dim('simulate a prompt-injection attack against your agent')],
    [cmd('npx honeykey status'), c.dim('see what is protected')],
    ...(r.integrations.some((i) => i.id === 'claude' && !i.error && i.result !== 'unchanged') ? [[c.yellow('restart Claude Code'), c.dim('or open /hooks so the new hook is picked up')]] : []),
  ], { indent: 4 }));
  out();
  return 0;
}

function statSafe(p) { try { return statSync(p).size; } catch { return 0; } }

function readAlerts(root) {
  const p = join(root, STATE_DIR, ALERT_LOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function cmdStatus(argv, cwd) {
  const { opts } = parseArgs(argv, { bool: ['json'] });
  if (opts.help) return out(HELP.status), 0;
  const root = findStateRoot(cwd);
  let state = null;
  try { state = root && loadState(root); } catch {}
  const hooks = AGENT_IDS.map((id) => ({ id, label: INTEGRATIONS[id].label, installed: INTEGRATIONS[id].isInstalled(root || cwd), file: INTEGRATIONS[id].file(root || cwd) }));
  const alerts = root ? readAlerts(root) : [];
  if (opts.json) {
    out(JSON.stringify({ root, mode: state?.mode ?? null, decoys: (state?.decoys || []).map((d) => ({ provider: d.provider, env: d.env, masked: maskDecoy(d) })), baitFiles: state?.baitFiles || [], hooks, alerts: alerts.length }, null, 2));
    return state ? 0 : 1;
  }
  out();
  out(banner());
  out();
  if (!state) {
    out(failLine(`Not initialised here. Run ${cmd('npx honeykey init')} to plant decoys.`));
    out();
    return 1;
  }
  const base = root;
  out(`  ${c.bold('Project')}  ${base === cwd ? '.' : base}`);
  out(`  ${c.bold('Mode')}     ${state.mode === 'warn' ? c.yellow('warn') : c.red('block')}`);
  out(`  ${c.bold('Created')}  ${state.createdAt ? `${state.createdAt.slice(0, 10)} ${c.dim('(' + timeAgo(state.createdAt) + ')')}` : '?'}`);
  out();
  out(`  ${c.bold('Bait files')}`);
  for (const f of state.baitFiles || []) out(existsSync(join(base, f)) ? ok(f) : failLine(`${f} ${c.dim('(missing — run init to replant)')}`));
  if (!state.baitFiles?.length) out(c.dim('    none (CI mode)'));
  out();
  out(`  ${c.bold('Agent hooks')}`);
  for (const h of hooks) out(h.installed ? ok(`${h.label.padEnd(12)} ${c.dim(rel(cwd, h.file))}`) : `  ${c.dim(sym.dot + ' ' + h.label.padEnd(12) + ' not installed')}`);
  const guardOk = existsSync(join(base, STATE_DIR, 'guard.mjs'));
  if (!guardOk) out(failLine(`${STATE_DIR}/guard.mjs missing — run ${cmd('npx honeykey init')}`));
  out();
  out(`  ${c.bold('Decoys')} ${c.dim(`(${state.decoys.length})`)}`);
  out(table(state.decoys.map((d) => [d.env, c.dim(d.label), c.amber(maskDecoy(d))]), { indent: 4 }));
  out();
  const last = alerts[alerts.length - 1];
  if (alerts.length) out(`  ${c.red(sym.fail)} ${c.bold(c.red(`${alerts.length} alert${alerts.length > 1 ? 's' : ''}`))}  ${c.dim(`last ${timeAgo(last.at)}: ${last.agent} ${last.tool}`)}  ${c.dim(sym.arrow)} ${cmd('honeykey alerts')}`);
  else out(`  ${c.green(sym.ok)} ${c.bold('0 alerts')} ${c.dim('— no decoy has been touched')}`);
  out();
  return 0;
}

function cmdAlerts(argv, cwd) {
  const { opts } = parseArgs(argv, { bool: ['json'], str: ['limit'] });
  if (opts.help) return out(HELP.alerts), 0;
  const root = findStateRoot(cwd) || cwd;
  const alerts = readAlerts(root);
  const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10) || 20) : 20;
  if (opts.json) { out(JSON.stringify(alerts, null, 2)); return 0; }
  out();
  if (!alerts.length) { out(ok(`No alerts. ${c.dim('No agent has tried to send a decoy anywhere.')}`)); out(); return 0; }
  out(`  ${c.bold(c.red(`${alerts.length} exfiltration attempt${alerts.length > 1 ? 's' : ''} caught`))}${alerts.length > limit ? c.dim(`  (showing last ${limit})`) : ''}`);
  out();
  for (const a of alerts.slice(-limit).reverse()) {
    const tag = a.action === 'blocked' ? c.bgRed(c.bold(' BLOCKED ')) : c.bgAmber(c.bold(' WARNED  '));
    const when = new Date(a.at);
    const ts = isNaN(when) ? a.at : `${when.toISOString().slice(0, 10)} ${when.toTimeString().slice(0, 8)}`;
    out(`  ${tag} ${c.bold(a.tool || '?')} ${c.dim('via')} ${a.agent || '?'}  ${c.dim(ts + ' · ' + timeAgo(a.at))}`);
    for (const l of a.leaks || []) out(`      ${c.red(sym.arrow)} ${l.label} ${c.dim(`(${l.encoding})`)}`);
    if (a.preview) out(`      ${c.dim(String(a.preview).replace(/\s+/g, ' ').slice(0, 110))}`);
    out();
  }
  return 0;
}

async function readAllStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const ch of process.stdin) data += ch;
  return data;
}

function resolveState(cwd, statePathOpt) {
  if (statePathOpt) {
    const p = resolve(cwd, statePathOpt);
    if (!existsSync(p)) throw new UsageError(`state not found: ${statePathOpt}`);
    if (statSync(p).isDirectory()) {
      const st = loadState(p) || loadState(dirname(p));
      if (!st) throw new UsageError(`no ${STATE_DIR}/state.json under ${statePathOpt}`);
      return st;
    }
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  const root = findStateRoot(cwd);
  if (!root) throw new UsageError(`no ${STATE_DIR}/state.json found (run honeykey init / ci-env, or pass --state)`);
  return loadState(root);
}

async function cmdScan(argv, cwd) {
  const { opts, args } = parseArgs(argv, { bool: ['json'], str: ['state'] });
  if (opts.help) return out(HELP.scan), 0;
  const state = resolveState(cwd, opts.state);
  const targets = args.length ? args : process.stdin.isTTY ? [] : ['-'];
  if (!targets.length) throw new UsageError('nothing to scan — pass files or pipe input (see honeykey scan --help)');
  const results = [];
  for (const t of targets) {
    let text;
    if (t === '-') text = await readAllStdin();
    else {
      const p = resolve(cwd, t);
      if (!existsSync(p)) { results.push({ file: t, error: 'not found' }); continue; }
      if (statSync(p).isDirectory()) { results.push({ file: t, error: 'is a directory' }); continue; }
      text = readFileSync(p, 'utf8');
    }
    results.push({ file: t === '-' ? '<stdin>' : t, leaks: findLeaks(text, state.decoys || []) });
  }
  const leaked = results.filter((r) => r.leaks?.length);
  if (opts.json) {
    out(JSON.stringify({ clean: !leaked.length, results }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) err(warnLine(`${r.file}: ${r.error}`));
      else if (r.leaks.length) for (const l of r.leaks) out(failLine(`${c.bold(r.file)}  ${l.label} ${c.dim(`(${l.encoding})`)}`));
      else if (results.length > 1 || !c.enabled) out(ok(`${r.file} ${c.dim('clean')}`));
    }
    if (leaked.length) out(`\n  ${c.red(c.bold(`${leaked.reduce((n, r) => n + r.leaks.length, 0)} decoy leak(s) found`))} ${c.dim('— something exfiltrated honeypot credentials')}`);
    else out(ok(`No decoy leaks ${c.dim(`in ${results.filter((r) => !r.error).length} input(s)`)}`));
  }
  return leaked.length ? 1 : results.some((r) => r.error) ? 2 : 0;
}

function cmdCiEnv(argv, cwd) {
  const { opts } = parseArgs(argv, { bool: ['github-env', 'rotate'], str: ['providers'] });
  if (opts.help) return out(HELP['ci-env']), 0;
  let providers;
  if (opts.providers) {
    providers = opts.providers.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = providers.filter((p) => !PROVIDERS.some((x) => x.id === p));
    if (bad.length || !providers.length) throw new UsageError(`unknown provider(s): ${bad.join(', ') || '(none)'} — supported: ${PROVIDERS.map((x) => x.id).join(',')}`);
  }
  let prev = null;
  try { prev = loadState(cwd); } catch {}
  const same = prev?.decoys?.length && (!providers || (providers.length === prev.decoys.length && providers.every((p) => prev.decoys.some((d) => d.provider === p))));
  const decoys = same && !opts.rotate ? prev.decoys : generateDecoys(providers);
  if (decoys !== prev?.decoys) saveState(cwd, { version: VERSION, createdAt: new Date().toISOString(), decoys, baitFiles: prev?.baitFiles || [], mode: prev?.mode || 'block', ci: true });
  const lines = [];
  for (const d of decoys) {
    if (d.extra) for (const [k, v] of Object.entries(d.extra)) lines.push(`${k}=${v}`);
    lines.push(`${d.env}=${d.value}`);
  }
  if (opts.githubEnv) {
    const file = process.env.GITHUB_ENV;
    if (!file) throw new UsageError('--github-env: $GITHUB_ENV is not set (are you running inside GitHub Actions?)');
    appendFileSync(file, lines.join('\n') + '\n');
    err(`honeykey: exported ${lines.length} decoy variables to $GITHUB_ENV: ${lines.map((l) => l.split('=')[0]).join(', ')}`);
  } else out(lines.join('\n'));
  return 0;
}

async function cmdGuard(argv) {
  const { opts } = parseArgs(argv, { str: ['agent', 'root'] });
  if (opts.help) return out(HELP.guard), 0;
  return runGuard({ argv: opts.agent ? ['--agent', opts.agent] : [], root: opts.root ? resolve(opts.root) : null });
}

function cmdUninstall(argv, cwd) {
  const { opts } = parseArgs(argv, { bool: ['keep-bait', 'yes'] });
  if (opts.help) return out(HELP.uninstall), 0;
  const root = findStateRoot(cwd) || cwd;
  const r = uninstall({ cwd: root, keepBait: !!opts.keepBait });
  out();
  for (const h of r.hooks) out(h.error ? failLine(`${h.label}: ${h.error}`) : ok(`Removed ${h.label} hook ${c.dim(sym.arrow + ' ' + rel(cwd, h.file))}`));
  for (const f of r.baitRemoved) out(ok(`Deleted bait file ${c.dim(f)}`));
  for (const f of r.baitKept) out(warnLine(`Kept ${f} ${c.dim('(no longer contains our decoys or --keep-bait)')}`));
  if (r.gitignore.length) out(ok(`Cleaned .gitignore ${c.dim(r.gitignore.join('  '))}`));
  if (r.stateRemoved) out(ok(`Deleted ${STATE_DIR}/`));
  if (!r.hooks.length && !r.baitRemoved.length && !r.stateRemoved) out(`  ${c.dim('Nothing to remove — honeykey is not installed here.')}`);
  out();
  return 0;
}

async function cmdAttack(argv) {
  let mod;
  try {
    mod = await import('./redteam/index.mjs');
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('redteam')) {
      err();
      err(`  ${ce.yellow(sym.warn)} ${ce.bold('honeykey attack')} isn't available in this build (red-team module missing).`);
      err(`    ${ce.dim('Update with')} ${ce.cyan('npx honeykey@latest attack')}`);
      err();
      return 1;
    }
    throw e;
  }
  if (typeof mod.attackCommand !== 'function') throw new Error('redteam module does not export attackCommand()');
  const code = await mod.attackCommand(argv);
  return typeof code === 'number' ? code : 0;
}

// ---- main ---------------------------------------------------------------

const COMMANDS = { init: cmdInit, status: cmdStatus, alerts: cmdAlerts, scan: cmdScan, 'ci-env': cmdCiEnv, guard: cmdGuard, uninstall: cmdUninstall, attack: cmdAttack };

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const [name, ...rest] = argv;
  try {
    if (!name || name === '-h' || name === '--help') { out(HELP._); return 0; }
    if (name === 'help') { out(HELP[rest[0]] || HELP._); return 0; }
    if (name === '-v' || name === '--version' || name === 'version') { out(VERSION); return 0; }
    const fn = COMMANDS[name];
    if (!fn) throw new UsageError(`unknown command "${name}"`);
    return await fn(rest, cwd);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${ce.red(sym.fail)} ${e.message}`);
      err(ce.dim(`  run: honeykey ${COMMANDS[name] ? name + ' ' : ''}--help`));
      return 2;
    }
    err(`${ce.red(sym.fail)} ${e?.message || e}`);
    if (process.env.HONEYKEY_DEBUG) err(e?.stack);
    return 2; // 1 is reserved for "leak found" (scan)
  }
}
