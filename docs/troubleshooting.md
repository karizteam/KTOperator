# Troubleshooting

Run `operator doctor --json` first — it checks every item below and reports per-check severity.

## "No AI provider is configured"

Just run `ktoperator` — the console walks you through provider, key and
model. Scriptable equivalent: set `OPENROUTER_API_KEY` (or the provider's env
var) and `operator provider add --id openrouter --type openrouter --model <id> --default`.

## "Authentication failed (HTTP 401/403)"

The key is missing/expired for the selected profile. `operator provider list`
shows each profile's key *source* (never the key itself). Fix by re-entering
the key via `/provider add` in the console, `operator provider remove` + `add`,
or export the right env var. `operator provider test` verifies.

## "No workspace selected" / "workspace is no longer valid"

`operator workspace select .` authorizes the current directory. A workspace
becomes invalid if the directory is moved or replaced — re-select it. Roots
of drives are refused by design; home directories require an extra
interactive confirmation.

## "No secure sandbox is available, so command execution is refused"

Working as intended. Options, in order of strength:

1. Install Docker and `docker pull node:22-alpine` (or set `sandbox.image`
   to your preferred minimal image), then `operator sandbox status`.
2. Read docs/sandbox.md, then opt in to reduced isolation:
   `operator config set security.allowRestrictedProcessFallback true`.

Read-only tools (inspection, search, analysis) keep working without any sandbox.

## "Approval requires an interactive terminal"

You ran with `--json` or in a non-TTY context without `--yes`. Either drop
`--json`, or pass `--yes write` / `--yes all` deliberately (audited).

## Rate limits / credits

429s are retried with `Retry-After` up to 3 attempts; then the run fails with
a `rate_limit` error. 402 means provider credits are exhausted — top up or
switch the profile explicitly; Operator never fails over on its own.

## "Model not found / not available"

`operator model list --provider <id>` prints valid ids. On OpenRouter, models
marked `(no-tools)` cannot make tool calls — pick another model.

## Timeouts & cancellations

Ctrl+C has exactly one meaning per phase:

- **while a task runs** — it stops that task: provider requests abort, running
  sandboxes are killed (process group on POSIX, `taskkill /T` on Windows), the
  terminal is restored and the console returns to a fresh prompt. It never
  ends the session. If a killed process never reports its exit, a watchdog
  settles the call anyway, so a stuck child cannot freeze the console;
- **at the empty prompt** — the first press clears the line and shows a hint;
  a second press within 2 seconds leaves the console (`/exit` always works).

An interrupted stream is closed off before the next prompt, so the answer you
already saw is never redrawn over. The default run budget is 10 minutes —
`limits.maxDurationMs` and `--max-steps` adjust it.

## "npm script not found"

`run_tests`/`run_build`/`run_linter`/`run_typecheck` execute existing
package.json scripts (`test`, `build`, `lint`, `typecheck`/`type-check`/`tsc`).
The error message lists the scripts that do exist. Non-Node projects: use
`execute_approved_command` with a structured argv (with approval).

## Permission problems on the config home

`OPERATOR_HOME` (Linux default `~/.config/operator`) must be user-writable
mode 700. `doctor` flags bad permissions. On Windows the ACLs of `%APPDATA%`
apply.

## Debugging internals

`OPERATOR_DEBUG=1` prints stack traces for unexpected errors. The audit log
(`operator history`, or `audit/*.jsonl` under the config home) records every
tool request, approval decision, sandbox selection, execution, backup and
restore — secrets always redacted.

## Known limitations (v0.1)

- The restricted-process fallback is not a container: no filesystem/network
  isolation, no memory/pid enforcement (see docs/sandbox.md).
- Windows sandboxing currently means Docker Desktop or the reduced fallback.
- Anthropic structured-output mode is not used (planner parses leniently).
- Recursive directory deletion is intentionally not exposed to the agent.
