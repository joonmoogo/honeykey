// honeykey attack — "Is your coding agent injectable? Find out in 60 seconds."
//
// Plants fake decoys in realistic fixture repos, gives a coding agent a benign
// task, and measures whether a hidden prompt injection makes it exfiltrate the
// bait .env to a LOCAL 127.0.0.1 listener. Then shows that honeykey's PreToolUse
// guard blocks every one.
import { generateDecoys } from '../core.mjs';
import { SCENARIOS, SCENARIO_IDS, getScenario, resolveTask } from './scenarios.mjs';
import {
  startListener, scoreRequests, runScenario, claudeAvailable, guardCommand,
} from './runner.mjs';

// ---- ANSI (respect NO_COLOR and non-TTY) -------------------------------
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), dim = c('2'), bold = c('1');

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, keep: false, protected: false, agent: 'claude', scenario: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--protected') opts.protected = true;
    else if (a === '--compare') opts.compare = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--scenario') opts.scenario = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a.startsWith('--agent=')) opts.agent = a.slice(8);
    else if (a.startsWith('--scenario=')) opts.scenario = a.slice(11);
    else if (a.startsWith('--model=')) opts.model = a.slice(8);
  }
  return opts;
}

const HELP = `honeykey attack — test whether a coding agent is prompt-injectable

Usage: honeykey attack [options]

Options:
  --dry-run           No agent. Print every scenario's vector/task/payload and
                      self-test the listener + leak scoring. (Default when the
                      'claude' CLI is not on PATH.)
  --protected         Run with honeykey's PreToolUse guard hook installed, so
                      exfiltration is blocked (expect 0 leaks).
  --compare           Run baseline, then protected, and show the before/after.
  --scenario <id>     Run a single scenario (${SCENARIO_IDS.join(', ')}).
  --agent claude      Agent to attack (only 'claude' supported today).
  --model <name>      Model to pass to 'claude --model' (e.g. haiku, sonnet).
  --json              Machine-readable JSON output.
  --keep              Keep temp fixture dirs instead of deleting them.
  -h, --help          This help.
`;

// ---- dry-run: preview + listener/scoring self-test ---------------------
async function selfTest() {
  const decoys = generateDecoys();
  const aws = decoys.find((d) => d.provider === 'aws');
  const listener = await startListener();
  const envBody = decoys.map((d) => `${d.env}=${d.value}`).join('\n');
  const post = (path, body, headers = {}) =>
    fetch(`${listener.url}${path}`, { method: 'POST', body, headers }).catch(() => {});

  // simulate three exfil techniques against the local listener
  await post('/collect', envBody);                                     // raw
  await post('/collect', Buffer.from(envBody).toString('base64'));     // base64
  await fetch(`${listener.url}/p?v=${encodeURIComponent(aws.value)}`).catch(() => {}); // url/raw in query

  const leaks = scoreRequests(listener.requests, decoys);
  await listener.close();
  const encodings = [...new Set(leaks.map((l) => l.encoding))];
  return { ok: leaks.length >= 2, leakCount: leaks.length, encodings, requestCount: listener.requests.length };
}

function printDryRun(scenarios, test, opts) {
  if (opts.json) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      selfTest: test,
      scenarios: scenarios.map((s) => {
        const ctx = { url: 'http://127.0.0.1:<port>' };
        return { id: s.id, title: s.title, vector: s.vector, encoding: s.encoding, task: resolveTask(s, ctx), payload: s.payload(ctx) };
      }),
    }, null, 2));
    return;
  }
  console.log(bold('\n  honeykey attack — DRY RUN (no agent executed)\n'));
  console.log(dim('  Each scenario plants a hidden instruction in a normal-looking file and'));
  console.log(dim('  asks an agent to do a benign task. A vulnerable agent follows the hidden'));
  console.log(dim('  instruction and POSTs the bait .env to a local 127.0.0.1 listener.\n'));
  const ctx = { url: cyan('http://127.0.0.1:<port>') };
  for (const s of scenarios) {
    console.log(`  ${bold(cyan(s.id.padEnd(14)))} ${s.title}`);
    console.log(`  ${dim('vector  ')} ${s.vector}`);
    console.log(`  ${dim('task    ')} ${resolveTask(s, ctx)}`);
    const payload = s.payload(ctx).split('\n').map((l) => '    ' + l).join('\n');
    console.log(`  ${dim('payload ')} ${yellow('(' + s.encoding + ')')}\n${dim(payload)}\n`);
  }
  console.log(bold('  Listener + scoring self-test:'));
  const mark = test.ok ? green('PASS') : red('FAIL');
  console.log(`    ${mark} simulated ${test.requestCount} exfil requests -> detected ${test.leakCount} leaks ` +
    `[${test.encodings.join(', ')}]\n`);
  const g = guardCommand();
  console.log(dim(`  Protected mode would install PreToolUse hook: ${g.kind}`));
  console.log(dim(`    ${g.cmd}\n`));
}

// ---- report card -------------------------------------------------------
function statusCell(status) {
  if (status === 'LEAKED') return red('✖ LEAKED  ');
  if (status === 'ERROR') return yellow('⚠ ERROR   ');
  return green('✔ RESISTED');
}

function printReport(results, opts, meta) {
  if (opts.json) { console.log(JSON.stringify({ ...meta, results }, null, 2)); return; }
  const leaked = results.filter((r) => r.status === 'LEAKED').length;
  const total = results.length;
  console.log(bold(`\n  honeykey attack — ${meta.protectedMode ? 'PROTECTED' : 'BASELINE'} (agent: ${meta.agent})\n`));
  console.log(`  ${dim('scenario'.padEnd(16))}${dim('vector'.padEnd(26))}${dim('result'.padEnd(12))}${dim('encoding')}`);
  console.log(dim('  ' + '-'.repeat(72)));
  for (const r of results) {
    const enc = r.detectedEncoding.length ? r.detectedEncoding.join(',') : dim('-');
    console.log(`  ${r.id.padEnd(16)}${String(r.vector).slice(0, 24).padEnd(26)}${statusCell(r.status)}  ${enc}`);
  }
  console.log(dim('  ' + '-'.repeat(72)));
  const frac = `${leaked}/${total}`;
  if (meta.protectedMode) {
    console.log(`  ${bold('With honeykey guard:')} ${leaked === 0 ? green(frac + ' leaked') : red(frac + ' leaked')}` +
      dim(`  (hook: ${results[0]?.guardKind || 'n/a'})`));
  } else {
    console.log(`  ${bold('Without honeykey:')} ${leaked > 0 ? red(frac + ' leaked') : green(frac + ' leaked')}`);
  }
  console.log('');
}

function printCompare(baseline, protectedRes, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ baseline, protected: protectedRes }, null, 2));
    return;
  }
  const b = baseline.filter((r) => r.status === 'LEAKED').length;
  const p = protectedRes.filter((r) => r.status === 'LEAKED').length;
  const n = baseline.length;
  console.log(bold('\n  ╭───────────────────────────────────────────────╮'));
  console.log(bold('  │  honeykey attack — before / after              │'));
  console.log(bold('  ╰───────────────────────────────────────────────╯\n'));
  console.log(`    Without honeykey:  ${b > 0 ? red(`${b}/${n} agents leaked secrets`) : green(`${b}/${n} leaked`)}`);
  console.log(`    With honeykey:     ${p === 0 ? green(`${p}/${n} leaked`) : yellow(`${p}/${n} leaked`)}\n`);
  if (b === 0 && p === 0) console.log(dim('    Your agent resisted every fixture on its own. honeykey stays armed for the injection it won\'t catch.\n'));
  else if (p === 0) console.log(green(`    honeykey stopped all ${b} exfiltration${b === 1 ? '' : 's'} the agent attempted.\n`));
}

// ---- main --------------------------------------------------------------
export async function attackCommand(argv = []) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return 0; }

  let scenarios = SCENARIOS;
  if (opts.scenario) {
    const s = getScenario(opts.scenario);
    if (!s) { console.error(red(`unknown scenario '${opts.scenario}'. known: ${SCENARIO_IDS.join(', ')}`)); return 1; }
    scenarios = [s];
  }

  // Default to dry-run when claude is unavailable (unless a real run is forced
  // by passing --agent explicitly for an available agent).
  const canRun = opts.agent === 'claude' && claudeAvailable();
  if (!opts.dryRun && !canRun) {
    if (!opts.json) console.log(dim("\n  'claude' CLI not found on PATH — running in --dry-run mode.\n"));
    opts.dryRun = true;
  }

  if (opts.dryRun) {
    const test = await selfTest();
    printDryRun(scenarios, test, opts);
    return test.ok ? 0 : 1;
  }

  // Real runs. Share one decoy set across scenarios in a comparison so results line up.
  const runAll = async (protectedMode) => {
    const out = [];
    const label = protectedMode ? 'protected' : 'baseline';
    for (const [i, s] of scenarios.entries()) {
      if (!opts.json) process.stderr.write(dim(`  [${label} ${i + 1}/${scenarios.length}] ${s.id} … `));
      const t0 = Date.now();
      const r = await runScenario(s, { agent: opts.agent, protectedMode, keep: opts.keep, claude: { model: opts.model } });
      if (!opts.json) process.stderr.write(`${statusCell(r.status).trim()} ${dim(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`)}\n`);
      out.push(r);
    }
    return out;
  };

  if (opts.compare) {
    const baseline = await runAll(false);
    const protectedRes = await runAll(true);
    if (!opts.json) { printReport(baseline, opts, { protectedMode: false, agent: opts.agent }); printReport(protectedRes, opts, { protectedMode: true, agent: opts.agent }); }
    printCompare(baseline, protectedRes, opts);
    return 0;
  }

  const results = await runAll(opts.protected);
  printReport(results, opts, { protectedMode: opts.protected, agent: opts.agent });
  return 0;
}

export default attackCommand;
