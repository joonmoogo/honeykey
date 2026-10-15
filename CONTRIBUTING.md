# Contributing

Thanks for helping make agents harder to turn against their users.

## Setup

```sh
git clone https://github.com/joonmoogo/honeykey && cd honeykey
npm test              # node --test, no install step: zero dependencies
bash examples/demo.sh # end-to-end demo in a temp dir
```

Node 18+ only. Please keep it **dependency-free**: that is part of what makes it safe to drop
into any project.

## Most wanted

- **Evasions.** An encoding or tool-call shape that slips a decoy past `findLeaks`
  (`src/core.mjs`). Add a failing case to `test/core.test.mjs` first, then the fix. Every new
  detection also needs a false-positive check against ordinary content.
- **Attack fixtures** for `honeykey attack`: realistic prompt-injection repos (poisoned docs,
  issues, MCP tool descriptions, skills). Fixtures must only exfiltrate to the local listener.
- **Agent integrations**: Cursor, Gemini CLI, Codex CLI hooks.

Found a bypass that works against a real agent? Report it privately first: see
[SECURITY.md](SECURITY.md).

## Pull requests

- One change per PR; include tests.
- `npm test` must pass on Node 18, 20 and 22.
- Keep output and docs plain. No new runtime network calls, ever.
