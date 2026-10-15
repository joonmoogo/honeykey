// honeykey integrations — per-agent hook install/uninstall. Every installer
// merges into existing config without touching hooks it does not own, and is
// idempotent (our entries are recognised by GUARD_MARK in the command string).
//
// Formats verified against the official docs (2026-10):
//   Claude Code  https://code.claude.com/docs/en/hooks      .claude/settings.json  hooks.PreToolUse[]
//   Cursor       https://cursor.com/docs/hooks              .cursor/hooks.json     hooks.beforeShellExecution[] / beforeMCPExecution[]
//   Gemini CLI   https://geminicli.com/docs/hooks/reference .gemini/settings.json  hooks.BeforeTool[]
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from './core.mjs';

export const GUARD_FILE = 'guard.mjs';
export const GUARD_MARK = `${STATE_DIR}/${GUARD_FILE}`;
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(GUARD_MARK);

function readJson(file) {
  if (!existsSync(file)) return { data: {}, existed: false };
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return { data: {}, existed: true };
  try { return { data: JSON.parse(text), existed: true }; }
  catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix it or remove it, honeykey will not overwrite it`); }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Removes our handlers from a `[{matcher, hooks:[...]}]` group list (Claude/Gemini shape). */
function stripGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
}

/** Generic merge helper: returns 'installed' (new file) | 'merged' (into existing config) | 'updated' | 'unchanged'. */
function upsert(file, mutate) {
  const { data, existed } = readJson(file);
  const before = JSON.stringify(data);
  const hadOurs = before.includes(GUARD_MARK);
  mutate(data);
  if (JSON.stringify(data) === before) return 'unchanged';
  writeJson(file, data);
  return hadOurs ? 'updated' : existed ? 'merged' : 'installed';
}

function removeFrom(file, mutate) {
  if (!existsSync(file)) return false;
  const { data } = readJson(file);
  const before = JSON.stringify(data);
  if (!before.includes(GUARD_MARK)) return false;
  mutate(data);
  if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks;
  if (Object.keys(data).length === 0) {
    rmSync(file);
    try { if (!readdirSync(dirname(file)).length) rmdirSync(dirname(file)); } catch {}
  } else writeJson(file, data);
  return true;
}

// ---- Claude Code --------------------------------------------------------

const claude = {
  id: 'claude',
  label: 'Claude Code',
  file: (cwd) => join(cwd, '.claude', 'settings.json'),
  // The file check keeps teammates who cloned the repo without running `honeykey init` from
  // seeing hook errors (.honeykey/ is git-ignored); node's exit code (2 = block) passes through.
  command: `if [ -f "$CLAUDE_PROJECT_DIR/${GUARD_MARK}" ]; then node "$CLAUDE_PROJECT_DIR/${GUARD_MARK}" --agent claude; fi`,
  hookEntry() { return { matcher: '*', hooks: [{ type: 'command', command: this.command, timeout: 10 }] }; },
  detect: (cwd) => existsSync(join(cwd, '.claude')) || existsSync(join(cwd, 'CLAUDE.md')),
  install(cwd) {
    return upsert(this.file(cwd), (s) => {
      s.hooks ??= {};
      s.hooks.PreToolUse = [...stripGroups(s.hooks.PreToolUse), this.hookEntry()];
    });
  },
  uninstall(cwd) {
    return removeFrom(this.file(cwd), (s) => {
      if (!s.hooks) return;
      const g = stripGroups(s.hooks.PreToolUse);
      if (g.length) s.hooks.PreToolUse = g; else delete s.hooks.PreToolUse;
    });
  },
  isInstalled(cwd) { try { return JSON.stringify(readJson(this.file(cwd)).data.hooks?.PreToolUse ?? []).includes(GUARD_MARK); } catch { return false; } },
};

// ---- Cursor -------------------------------------------------------------
// Project hooks run from the project root, so a relative command path is correct.
// Permission hooks must print JSON; the guard prints {permission:"allow"|"deny"}.

const CURSOR_EVENTS = ['beforeShellExecution', 'beforeMCPExecution'];
const cursor = {
  id: 'cursor',
  label: 'Cursor',
  file: (cwd) => join(cwd, '.cursor', 'hooks.json'),
  command: `if [ -f ${GUARD_MARK} ]; then node ${GUARD_MARK} --agent cursor; else echo '{"continue":true,"permission":"allow"}'; fi`,
  detect: (cwd) => existsSync(join(cwd, '.cursor')) || existsSync(join(cwd, '.cursorrules')),
  install(cwd) {
    return upsert(this.file(cwd), (s) => {
      s.version ??= 1;
      s.hooks ??= {};
      for (const ev of CURSOR_EVENTS) s.hooks[ev] = [...(s.hooks[ev] || []).filter((h) => !isOurs(h)), { command: this.command, timeout: 10 }];
    });
  },
  uninstall(cwd) {
    return removeFrom(this.file(cwd), (s) => {
      for (const ev of CURSOR_EVENTS) {
        if (!s.hooks?.[ev]) continue;
        const rest = s.hooks[ev].filter((h) => !isOurs(h));
        if (rest.length) s.hooks[ev] = rest; else delete s.hooks[ev];
      }
      if (s.hooks && Object.keys(s.hooks).length === 0) { delete s.hooks; if (s.version === 1 && Object.keys(s).length === 1) delete s.version; }
    });
  },
  isInstalled(cwd) { try { return JSON.stringify(readJson(this.file(cwd)).data.hooks ?? {}).includes(GUARD_MARK); } catch { return false; } },
};

// ---- Gemini CLI ---------------------------------------------------------
// Matchers are regexes for tool events; timeout is in milliseconds.

const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  file: (cwd) => join(cwd, '.gemini', 'settings.json'),
  command: `if [ -f "$GEMINI_PROJECT_DIR/${GUARD_MARK}" ]; then node "$GEMINI_PROJECT_DIR/${GUARD_MARK}" --agent gemini; else echo '{}'; fi`,
  hookEntry() { return { matcher: '.*', hooks: [{ name: 'honeykey', type: 'command', command: this.command, timeout: 10000, description: 'Block tool calls that exfiltrate honeykey decoy secrets' }] }; },
  detect: (cwd) => existsSync(join(cwd, '.gemini')) || existsSync(join(cwd, 'GEMINI.md')),
  install(cwd) {
    return upsert(this.file(cwd), (s) => {
      s.hooks ??= {};
      s.hooks.BeforeTool = [...stripGroups(s.hooks.BeforeTool), this.hookEntry()];
    });
  },
  uninstall(cwd) {
    return removeFrom(this.file(cwd), (s) => {
      if (!s.hooks) return;
      const g = stripGroups(s.hooks.BeforeTool);
      if (g.length) s.hooks.BeforeTool = g; else delete s.hooks.BeforeTool;
    });
  },
  isInstalled(cwd) { try { return JSON.stringify(readJson(this.file(cwd)).data.hooks?.BeforeTool ?? []).includes(GUARD_MARK); } catch { return false; } },
};

export const INTEGRATIONS = { claude, cursor, gemini };
export const AGENT_IDS = Object.keys(INTEGRATIONS);

/** Agents to install by default: Claude Code always, others when their config dir exists. */
export function detectAgents(cwd) {
  return AGENT_IDS.filter((id) => id === 'claude' || INTEGRATIONS[id].detect(cwd));
}
