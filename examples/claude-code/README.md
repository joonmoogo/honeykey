# Claude Code hook

`npx honeykey init` writes this for you. To wire it up by hand, merge
[`settings.json`](settings.json) into `.claude/settings.json` (project) or
`~/.claude/settings.json` (all projects).

`honeykey guard` runs before **every** tool call (`"matcher": "*"`), so it also
covers MCP tools, `WebFetch`, `Write` and friends, not just `Bash`. It reads
the hook payload on stdin, and blocks the call if it contains a decoy in any
encoding. Calls without a decoy pass through untouched.

For the lowest latency, install once (`npm i -g honeykey`) and use
`"command": "honeykey guard"` instead of `npx`.
