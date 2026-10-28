# Permission & Approval Matrix

Four risk tiers; the policy engine decides from the tier plus hard rules.
Approvals can come only from the interactive user prompt or an explicit
`--yes read|write|all` grant (bounded by `security.maxAutoApproveTier`).

| Tier | Meaning | Default |
|---|---|---|
| 0 — read-only | Inspection within the workspace | Allowed by policy |
| 1 — reversible modification | Creates/edits (snapshotted) | Approval required |
| 2 — destructive/high-impact | Deletes, overwrites, managed-process kill | Per-operation approval; no session "always" grants |
| 3 — privileged/external | Command execution, builds, installs | Per-operation approval in a terminal; `--yes all` required otherwise; audited loudly |

Hard denials (no approval can override): any path outside the workspace and
outside every folder the user granted access to (writes only inside a folder
with a write grant), shell interpreters as executables or desktop apps,
admin/root execution, terminating system-critical or Operator processes,
exposing the container-runtime socket to the sandbox.

## Tool classification

| Tool | Tier | Notes |
|---|---|---|
| list_directory, read_file, search_files, search_text, inspect_file_metadata, generate_diff | 0 | Output-capped, redaction applied; also work in folders granted with `request_path_access` |
| inspect_project, detect_project_type, inspect_package_json, inspect_git_status | 0 | git runs sandboxed, read-only |
| get_operating_system, get_runtime_versions, get_cpu_summary, get_memory_summary, get_disk_usage, get_process_summary | 0 | Read-only system views; process LIST only |
| inspect_command_result | 0 | Operator-managed processes only |
| web_search, web_fetch | 0 | Public internet, read-only; every URL and redirect hop validated (http(s), no credentials, standard ports, never a private/loopback address); output capped |
| create_file | 1 → 2 | Escalates to 2 when overwriting an existing file; also allowed in a folder with a write grant |
| edit_file | 1 | Exact-match edits; atomic; diff returned; also allowed in a folder with a write grant |
| move_file | 1 → 2 | Escalates when overwriting destination; both ends must be in the same writable place |
| delete_file | 2 | Single files only; snapshot first; no recursive deletion by design; also allowed in a folder with a write grant |
| terminate_managed_process | 2 | Only Operator-managed ids |
| close_app | 2 → 3 | Closes a running application/process by name or pid after approval (escalates to 3 with `force`); never system-critical pids or Operator's own process tree |
| run_tests, run_typecheck, run_linter, run_build | 3 | Existing npm scripts only; sandboxed; network per config |
| execute_approved_command | 3 | argv-only and sandboxed for real programs. A shell argv (`["cmd", "/c", "dir"]`, `["bash", "-lc", "df -h"]`) cannot be sandboxed, so it runs on the host with the same per-command approval and a prompt that says so |
| run_shell_command | 3 | A real command line (cmd / bash / PowerShell) on the user's own machine; the exact command, shell, directory and any warning are shown before approval; per-command approval only, never a session grant, impossible without an interactive prompt (or an explicit `--yes all`) |
| start_background_process | 3 | The same host-shell path as `run_shell_command`, except the job keeps running: starts only after the exact command/shell/directory are approved, returns an id immediately, output is a bounded tail, and the whole process tree stops with `terminate_managed_process` or when the run/session ends. The concurrency cap is `limits.maxProcesses` |
| read_process_output | 0 | Reads the captured output of a background job Operator started; each line is handed out once and the job's state/exit code are reported |
| request_path_access | 3 | Grant for one folder or drive outside the workspace; per-path approval, session scope. Read-only by default; `write: true` (a separate user decision) also allows create/edit/move/delete there, each still approved individually |
| launch_app | 3 | Opens any application installed on the machine — the catalog (chrome, edge, firefox, notepad, explorer, calculator, paint, vscode, Microsoft Store) plus anything found in the Start Menu, the Applications folders, .desktop entries, PATH, or the Windows install folders (`%LOCALAPPDATA%\Programs`, Program Files). Shells, script hosts and terminals are refused by name; no installs, no downloads |
| open_url | 3 | http(s) only, no embedded credentials; opens in the user's browser (default, chrome, edge, firefox) |

### Natural language into a real command

When the user asks for something "in cmd" or "in bash" — or describes an
operating-system task in words ("show my IP", "how much free space is left",
"what is using port 3000", "list the biggest files here") — the agent writes the
command that does it and calls `run_shell_command`. The same request expressed
as argv (`["cmd", "/c", "ipconfig"]`) through `execute_approved_command` is
recognised and routed to exactly the same host path. Nothing executes until the
user approves that exact text in the tier-3 prompt, which shows:

- the command, verbatim, and the shell that will run it (`cmd.exe`,
  PowerShell, bash or sh);
- the working directory (the workspace) and the timeout;
- plain warnings when the command looks destructive (recursive delete, disk
  formatting, registry edits, a download piped into a shell, an install, an
  administrator escalation …).

By design a shell only ever runs on the host through this path: standard
project work stays on the sandboxed argv form, and the sandbox itself still
refuses interpreters outright. The command runs with a filtered
environment (no API keys are inherited), capped and redacted output, and a
killable process tree — a still-running command is stopped with
`terminate_managed_process` using the id it returns.

## Approval prompt contents

Every interactive request displays: the exact operation, the tool, the risk
tier with its label, precise target paths (up to 5, then a count), the
requesting provider/model, and a content preview (diff for edits, first
lines for creates, the argv for commands). Choices:

- tier ≤ 1: `y` once / `a` always-this-session (this tool + these targets) / `n`
- tier ≥ 2: `y` once / `n` — always grants do not exist.

Denials are returned to the model as structured tool errors ("do not retry
the same action") and three denials stop the session — by design, Operator
does not push against the security policy.

## Project instructions (`AGENTS.md`)

A workspace file is still untrusted input, so `AGENTS.md` (and
`.operator/instructions.md`) is **never** loaded silently:

- the console shows the path, the first lines and the size, and asks before the
  content enters the system prompt;
- the answer is remembered against the file's **content hash** — editing the
  file means being asked again, because the approval was for what was read;
- declining is remembered too, so the same content is not asked about twice;
- `operator run` never prompts, so it uses only files already approved;
- approved instructions shape *how* work is done and can never grant access,
  approve an action, or weaken the sandbox, the tiers or anything above.

## Dynamic access outside the workspace

Access outside the workspace is dynamic and always user-approved: when the
user points at another location — "check drive C", "look at D:\projects\shop",
"/etc" — the agent calls `request_path_access` with that absolute path, and
the normal tier-3 prompt asks the user to approve it. A bare drive letter is
written as `C` or `C:\` and means that drive's root.

**Read (default).** One approval and `list_directory`, `read_file`,
`search_files`, `search_text`, `inspect_file_metadata`, `generate_diff` and
`get_disk_usage` work there for the rest of the session.

**Write (opt-in).** When the user actually asked for a change there ("fix this
file on drive D"), the agent calls the same tool with `write: true`. That is a
second, separate approval, and only then do `create_file`, `edit_file`,
`move_file` and `delete_file` work inside that root — every single one still
prompting on its own and taking a snapshot first. Read-only grants stay
read-only; a write attempt there is refused with instructions to ask for write
access.

- The prompt shows the canonical path that will be granted, how it is used,
  and whether it is read-only or read + write.
- Grants are session-scoped and in memory: restarting the console drops them.
  `/access` lists them (with each level), `/access clear` revokes them all.
- A grant is a single folder (a drive root is allowed). Paths are resolved
  through `realpath` on every access and re-checked for containment, so a
  symlink inside a granted folder cannot escape it.
- Nothing outside the workspace and its grants is ever read or written.
- Every grant is audited as `access.grant` with the path, the level and the
  stated reason.

## Desktop actions

`launch_app`, `open_url` and `close_app` are the tools that act on the user's
desktop outside the sandbox — they start or stop programs the user can see.
`launch_app`/`open_url` are tier 3 (approval required, no session grants) and
`close_app` is tier 2 → 3, all audited as `desktop.launch` / `process.close`.
What makes them safe is what they cannot do:

- the catalog in `src/platform/desktop.ts` is tried first (exact executables),
  then Start Menu shortcuts, macOS bundles, Linux .desktop entries and PATH are
  searched by name — never by a wildcard, and never through a shell;
- `close_app` lists the exact pids and names it is about to stop in the
  approval prompt, and refuses system-critical pids and Operator's own
  process tree outright;
- the process is started with a structured argv, `shell: false`, detached
  stdio — nothing is piped, echoed or re-parsed;
- URLs must be absolute http(s) with no userinfo; `javascript:`, `file:` and
  friends are refused before a browser ever sees them;
- nothing is installed, downloaded or clicked: for the Microsoft Store the
  tool opens the search page (or the app page) and the user presses Install.

## Non-interactive operation

- `--json` forces non-interactive: approvals then come only from `--yes`.
- No `--yes` → tier ≥ 1 actions are denied with a clear explanation.
- `--yes read` → tier 0 only. `--yes write` → tiers 0–1. `--yes all` → all
  tiers (use deliberately; everything is audited).
- `security.maxAutoApproveTier` (default 1) caps unattended operation.

## Network policy

- Sandbox network: OFF by default (`sandbox.network`).
- Workspace content reaches a provider only through the configured profile's
  endpoint — there is no telemetry and no silent provider switching. The one
  other outbound request is the web tools entry below.
- Web tools (`web_search`, `web_fetch`): read-only public internet access for
  the agent. Only the query or URL leaves the machine — never workspace files
  or credentials. Private/loopback targets are refused outright, redirects are
  re-validated hop by hop, and responses are byte-capped, redacted and
  injection-screened exactly like any other tool output. Tier 0 because
  nothing is written and no secret is sent.
- Custom endpoints: HTTPS-only, no URL credentials, no redirects; private
  targets require `trustedLocal: true` on the profile (or
  `network.allowPrivateProviderEndpoints` for advanced cases).
