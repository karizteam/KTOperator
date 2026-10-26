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
outside every folder the user granted read-only access to, shell interpreters
as executables, admin/root execution, exposing the container-runtime socket
to the sandbox.

## Tool classification

| Tool | Tier | Notes |
|---|---|---|
| list_directory, read_file, search_files, search_text, inspect_file_metadata, generate_diff | 0 | Output-capped, redaction applied; also work in folders granted with `request_path_access` |
| inspect_project, detect_project_type, inspect_package_json, inspect_git_status | 0 | git runs sandboxed, read-only |
| get_operating_system, get_runtime_versions, get_cpu_summary, get_memory_summary, get_disk_usage, get_process_summary | 0 | Read-only system views; process LIST only |
| inspect_command_result | 0 | Operator-managed processes only |
| web_search, web_fetch | 0 | Public internet, read-only; every URL and redirect hop validated (http(s), no credentials, standard ports, never a private/loopback address); output capped |
| create_file | 1 → 2 | Escalates to 2 when overwriting an existing file |
| edit_file | 1 | Exact-match edits; atomic; diff returned |
| move_file | 1 → 2 | Escalates when overwriting destination; both ends must be in-workspace |
| delete_file | 2 | Single files only; snapshot first; no recursive deletion by design |
| terminate_managed_process | 2 | Only Operator-managed ids |
| run_tests, run_typecheck, run_linter, run_build | 3 | Existing npm scripts only; sandboxed; network per config |
| execute_approved_command | 3 | argv-only; no shells; sandboxed |
| request_path_access | 3 | Read-only grant for one folder outside the workspace; per-path approval, session scope, never covers writes |
| launch_app | 3 | Fixed app catalog only (chrome, edge, firefox, notepad, explorer, calculator, paint, vscode, Microsoft Store); no shell, no arbitrary executable, no installs |
| open_url | 3 | http(s) only, no embedded credentials; opens in the user's browser (default, chrome, edge, firefox) |

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

## Dynamic access outside the workspace

The workspace is the only place the agent may **write**. Reading is dynamic:
when the user points at another location — "check drive C", "look at
D:\projects\shop", "/etc" — the agent calls `request_path_access` with that
absolute path, and the normal tier-3 prompt asks the user to approve it. One
approval and the read tools (`list_directory`, `read_file`, `search_files`,
`search_text`, `inspect_file_metadata`, `generate_diff`, `get_disk_usage`)
work there for the rest of the session.

- The prompt shows the canonical path that will be granted, how it is used,
  and states that it is read-only.
- Grants are session-scoped and in memory: restarting the console drops them.
  `/access` lists them, `/access clear` revokes them all.
- A grant is a single folder (a drive root is allowed). Paths are resolved
  through `realpath` on every access and re-checked for containment, so a
  symlink inside a granted folder cannot escape it.
- No write, move or delete ever crosses a grant: those tools stay bound to the
  workspace and say so explicitly. To edit another folder, select it as the
  workspace.
- Every grant is audited as `access.grant` with the path and the stated reason.

## Desktop actions

`launch_app` and `open_url` are the only tools that act outside the workspace
and outside the sandbox — they start GUI programs the user can see. Every call
is tier 3 (approval required, no session grants) and audited as
`desktop.launch`. What makes them safe is what they cannot do:

- only ids from the catalog in `src/platform/desktop.ts` can be launched, so
  there is no path, no flag and no shell interpreter to smuggle in;
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
