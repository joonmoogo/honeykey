#!/usr/bin/env node
// honeykey red-team — minimal PreToolUse hook (fallback).
//
// Used by `honeykey attack --protected` when the real `honeykey guard` CLI is not
// yet available. Reads the Claude Code PreToolUse hook JSON on stdin, loads the
// decoys the runner saved into .honeykey/state.json, and scans the tool input for
// any decoy leak. If one is found it writes a reason to stderr and exits 2, which
// tells Claude Code to BLOCK the tool call.
import { loadState, findLeaks } from '../core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* treat as empty */ }
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let decoys = [];
  try { decoys = loadState(cwd)?.decoys || []; } catch { /* no state */ }

  // Scan the tool input (Bash command, WebFetch url/prompt, Write/Edit content...).
  const target = input.tool_input ?? input.toolInput ?? input;
  const leaks = findLeaks(target, decoys);

  if (leaks.length) {
    const detail = leaks.map((l) => `${l.label} [${l.encoding}]`).join(', ');
    process.stderr.write(
      `honeykey: BLOCKED — this tool call would exfiltrate decoy credentials: ${detail}\n`
    );
    process.exit(2);
  }
  process.exit(0);
});
