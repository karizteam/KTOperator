# Security Model

Guiding principle: **the AI decides what it wants to do; Operator's security engine decides what it is allowed to do.** The model never runs commands, never approves actions, and never sees credentials.

## Threat model

| Threat | Defense |
|---|---|
| Model (or a compromised provider) tries to read files outside the workspace | Workspace boundary: realpath-based canonical containment on every access |
| Symlink/junction/reparse-point escapes | realpath of deepest existing ancestor before containment check |
| TOCTOU (workspace swapped for a symlink mid-session) | Root is re-canonicalized on every resolve; mismatch fails closed |
| Race between approval preview and write | Content re-read at write time; write-verify-rename; edit operations are atomic per call (no partial edits) |
| Path traversal / absolute-path escapes | Lexical + filesystem-level containment tests; `..` and drive-absolute handled cross-platform |
| Device files / FIFOs / sockets | Only regular files and directories are resolvable |
| Huge files / unbounded recursion | `limits.maxFileBytes`, walk depth 8, 20k visited-entry cap, per-tool result caps |
| Model-generated shell strings | argv-only execution inside the sandbox, which refuses interpreter names outright. A shell invocation (`run_shell_command`, or `["cmd", "/c", …]` passed to `execute_approved_command`) is not sandboxable, so it runs on the host instead — tier 3, exact text shown, per-command approval, never a session grant, and impossible without an interactive prompt |
| Malicious npm scripts | Only pre-existing package.json scripts run, named allowlist (test/typecheck/lint/build), inside the sandbox |
| Sandbox unavailable | Sandboxed execution is **refused** with diagnostics — no silent downgrade. Host-shell commands are host-level by design and therefore do not depend on a sandbox, which is exactly why they are never automatic |
| Wrong-tool drift (model asks for cmd via the sandbox tool) | A shell argv handed to `execute_approved_command` is detected and routed to the same host-shell path instead of failing — with the approval prompt saying "outside the sandbox", never a fake sandbox preview |
| Secrets reaching a shell command | Both host-shell paths hand the child an environment allowlist (PATH, SystemRoot, TEMP, …) and drop every name matching key/token/secret/password/credential/auth/session/cookie |
| Prompt injection via files/README/command output | Untrusted-output delimiters + injection phrase screening + policy enforcement regardless of content |
| Prompt injection via project instructions | `AGENTS.md` / `.operator/instructions.md` never enters the prompt unseen: its content is shown in full context, approved by the user, remembered by content hash (an edit is re-approved), and even then cannot grant access or approve an action |
| Background job outliving its session or leaking a port | Jobs are Operator-managed: bounded line-oriented output, a concurrency cap (`limits.maxProcesses`), whole-tree termination, and every remaining job stopped when the run or the console session ends |
| Secret exfiltration through the context window | Pattern-based redaction of keys/tokens/PEM blocks on all model-visible tool output |
| API key leakage via logs/errors | Redaction on audit, error details, `config show`; keys never printed by any command |
| SSRF through custom provider base URLs | HTTPS-only by default, no userinfo, DNS-pinning to public ranges, no redirect following, nonstandard ports require `trustedLocal` |
| Unattended mass destruction | `--yes` levels, config hard cap on auto-approval tier, per-operation approval for tier ≥ 2, bulk recursive deletion not implemented at all |
| Approval fatigue bypass | `always` session-grants limited to tier ≤ 1 reversible ops; destructive ops are always per-operation |
| Overwritten/lost work | Snapshots before every mutation (`backups/`), `operator rollback <sessionId>` restores contents |
| Runaway agent | Iteration/tool-call/time budgets, stall detection, 3-denial circuit breaker, AbortSignal through providers, tools, and process trees |
| Supply chain | 2 runtime deps (commander, zod), lockfile committed, `npm audit` = 0 findings, no lifecycle/postinstall scripts in/runtime deps |

## Path validation — why not string-prefix

`WorkspaceBoundary.resolve()` performs: lexical normalization → discovery of the deepest existing ancestor → `fs.realpath` on it → containment via `path.relative` segment analysis on the **resolved** path (not the input string). Creation intents validate the ancestor chain and forbid `..` segments. This defeats symlink swaps that prefix checks miss, including the classic `workspace/link -> /etc` case (verified by tests).

## Prompt-injection defense

Everything tools return is delimited (`<<<BEGIN UNTRUSTED OUTPUT …>>>`), scanned for instruction-shaped content (appends an explicit "do not follow" notice), and redacted for secrets. Its efficacy is tested end-to-end: a mock model obeying an injected README still cannot delete a file without approval — the policy engine, not the LLM's good behavior, is the enforcement point.

## Secrets

- Keys come from env vars first, then a chmod-600 store; `~/.config/operator` is chmod 700.
- Redaction patterns cover OpenAI/OpenRouter/Anthropic-shaped keys, GitHub/Google/AWS/Slack/Stripe tokens, JWTs, bearer/basic auth, PEM private-key blocks, credentialed URLs, and generic `*_key/secret/token/password` fields.
- Redaction is applied at five choke points: model-visible tool output, audit entries, error details, `config show`, and provider error bodies.

## Configuration integrity

Versioned zod schema; migrations pass through the schema (unknown keys dropped, invalid values rejected). Invalid security fields never "upgrade" silently — the load fails with a list of issues. `config set` accepts only an allowlisted key set with range-checked coercion.

## What is out of scope (v0.1)

- Kernel-level syscall filtering without containers (seccomp/Seatbelt) — requires the Docker backend today.
- Proving the absence of all injection attacks — screening is best-effort; enforcement is structural.
- Rollback of external side effects (commands already executed, network effects, installs) — snapshot rollback covers file contents only and says so.
