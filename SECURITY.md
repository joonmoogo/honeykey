# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a bypass or vulnerability. Report it privately via
[GitHub private vulnerability reporting](https://github.com/joonmoogo/honeykey/security/advisories/new).

Include the honeykey version, the agent (and version) involved, and a minimal reproduction:
the tool-call payload or the text that slipped past `guard` / `scan`.

You can expect an acknowledgement within 3 days and a fix or a documented decision within 30 days.
Credit is given in the release notes unless you prefer otherwise.

## What counts

In scope:

- An encoding or transformation of a decoy that `guard` or `scan` misses and that a real agent
  would plausibly produce (e.g. a common shell pipeline).
- A way for content the agent reads to disable or bypass the hook without the user noticing.
- Anything that makes honeykey leak a **real** secret, execute untrusted input, or write outside
  the project / `$RUNNER_TEMP`.
- Script or command injection in `action.yml`.

Known limitations (see the README) are not vulnerabilities: honeykey only detects decoys, and a
targeted attacker who avoids them is out of scope. Ideas to raise that bar are still welcome as
regular issues.

## Supported versions

Only the latest release receives fixes.
