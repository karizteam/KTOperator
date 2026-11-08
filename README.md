<div align="center">

# 🜂 ktOperator

[![version](https://img.shields.io/badge/version-0.7.6-8B9A6E?style=flat-square)](https://www.npmjs.com/package/@karizteam/operator)
[![node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-407%20passing-success?style=flat-square)](#-development)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**The AI decides what it wants to do. The security engine decides what it is allowed to do.**

[راهنمای فارسی](README.fa.md) · [🧩 Architecture](docs/architecture.md) · [🛡️ Security](docs/security.md) · [⚖️ Permissions](docs/permissions.md) · [📦 Sandbox](docs/sandbox.md) · [🔌 Providers](docs/providers.md) · [🛠️ Troubleshooting](docs/troubleshooting.md)

</div>

---

## 👋 What is ktOperator?

**ktOperator** is a terminal AI agent you can actually hand your machine to. You describe a task in plain language — *for example: analyze this project*, *what is using port 3000?*, *open Opera GX*, *make a file on D:/docs/notes.txt* — and it plans, reads, writes, runs commands and checks its own work, inside a folder (workspace) you authorize.

The key idea is simple and strict:

> **The model proposes. The policy engine disposes.**

The AI can suggest anything, but it can never approve its own actions, run a command without a sandbox, read outside the workspace, or see your API keys. Every action flows through the same pipeline: schema check → risk tier → policy verdict → your approval (when required) → sandboxed execution → secret redaction → audit log.

### ways to use it

```bash
ktoperator                                  # opens interactive console 

or 

operator
```

### What you can ask it to do

- **Understand code** — explain a project, find where something is implemented, review a file
- **Change code safely** — create, edit, move, delete files and folders (every change is snapshotted first, every edit shows a diff)
- **Run things** — tests, typecheck, lint, build, and real shell commands like `ipconfig`, `df -h`, `git status`
- **Run long jobs** — start a dev server in the background, read its output line by line, stop it when done
- **Work your machine** — open any installed app by name, close an app, open a web page in your browser
- **Reach outside the workspace** — when you point at another folder or drive, it asks once for access instead of saying no
- **Undo anything** — checkpoints before every task, `/undo` to restore, `/diff` to preview exactly what changed

## 🚀 Install

Requirements: **Node.js 22.12 or newer**. Docker is optional but gives the strongest sandbox (it is pulled automatically on first use). Both `ktoperator` and `operator` commands come from the one package — they are the same program.

```bash
npm i -g @karizteam/operator
```



## 🎯 Quickstart — the interactive console

```bash
ktoperator
```

The first time, the console walks you through five steps. After that, later runs jump straight to the chat box.

| # | Step | What happens |
|---|---|---|
| 1 | **Provider** | Pick OpenRouter, OpenAI, Anthropic, Google Gemini, any OpenAI-compatible endpoint, or local Ollama |
| 2 | **API key** | Typed masked, stored with `chmod 600`, connection tested immediately |
| 3 | **Model** | The live model list for your provider — pick one, or type a model id |
| 4 | **Workspace** | Authorize the ONE folder the agent may read and modify |
| 5 | **Sandbox** | Shows which isolation backend is available (Docker preferred) |
| 6 | **Chat box** | Type any task. Approvals, colored diffs and tool output appear inline |

### The chat box

- **Enter** sends, **Ctrl+J** (or Alt+Enter) inserts a newline for long prompts
- **↑ / ↓** recall your previous prompts
- Type **/** (slash) to open the command menu — it is fuzzy (`/tatus` finds `/status`), navigates with ↑↓, and stays open when you type a space so two-word commands like `/provider delete` show their subcommands for you to pick
- The top-right corner shows the live **cost and token count** of this session; context % lives in the `/usage` panel
- **Ctrl+C** has two clear meanings, never three: while a task runs it stops just that task; at an empty prompt it clears the line, and a second press within 2 seconds leaves the console. `/exit` always works

### Leaving and coming back

When you exit, the console prints two lines:

```text
✦ Goodbye
to continue this chat, enter ktoperator <sessionId>
```

Later, `ktoperator <sessionId>` (or `ktoperator chat <sessionId>`) re-opens that exact chat with its compressed history as context. An unknown id gives a friendly error pointing at `ktoperator session list`.

## ⌨️ Console commands (`/...`)

Type `/help` for the grouped list, or `/` for the interactive menu. Commands with a space (`/provider delete`) offer their subcommands in the menu — you never have to type the second word by hand.

### Session

| Command | What it does |
|---|---|
| `/status` | Dashboard: session, provider, model, workspace, sandbox, usage |
| `/usage` | Token, cache and cost breakdown for this session (context vs budget meter, cache hit rate, cost-cap remaining) |
| `/resume [id]` | Continue a previous session — context is compressed automatically |
| `/sessions` | Manage previous sessions: list them, `delete <id>` (picker or id prefix, confirmed), or `clear` them all. The open session is protected |
| `/export [id] [--out file]` | Export a session as a Markdown transcript |
| `/checkpoint [label]` | Mark a restore point (one is taken automatically before every task). `/checkpoint list` shows them |
| `/undo [n]` | Restore the workspace to checkpoint *n* (default: latest). Shows a colored diff preview first and asks for confirmation |
| `/diff [n]` | Preview the changes since checkpoint *n*, line by line — `+` green, `-` red |

### Setup

| Command | What it does |
|---|---|
| `/provider` | List profiles, `use <id>` to switch, `add` a new one, `delete <id>` to remove (with credentials). Deleting the active profile switches you to another one; the last profile is protected |
| `/model` | Show the current model, `use <id>` to switch, `reload` the model list |
| `/workspace [path]` | Show the authorized workspace, or re-authorize a path |
| `/access [list\|clear]` | Show or revoke the folders/drives you granted outside the workspace this session |
| `/skill` | Skills in `.operator/skills`: `list`, `use <name>`, `add <name>` (opens a multi-line editor), `show <name>`, `delete <name>` |
| `/prompt` | Prompt templates in `.operator/prompts`: `list`, `use <name>`, `add <name>`, `delete <name>` |

### System

| Command | What it does |
|---|---|
| `/sandbox` | Sandbox backends, availability, and which one is active |
| `/doctor` | Full environment diagnostics (runtime, config, providers, workspace, sandbox) |
| `/clear` | Clear the conversation view and context |
| `/exit` (alias `/quit`) | Leave the console |

### Checkpoints, undo and diff — in plain words

Every time you send a task, ktOperator quietly records a **checkpoint**: a marker in the list of file snapshots. After the task runs, you see a **diff preview** (green `+` additions, red `-` removals) of exactly what changed. If you don't like it, `/undo` restores the files to how they were before that task — it shows the preview first, asks you to confirm, and then restores only what changed after the checkpoint. `/undo 2` goes back to the second checkpoint. Commands that already ran (installs, network calls) cannot be undone — only file contents are restored, and the console reminds you of that.

### Skills, prompts and the `.operator/` folder

When a console opens on a path, it creates a `.operator/` folder there:

```text
.operator/
  README.md          what this folder is
  .gitignore         sessions/ is ignored (personal); skills/prompts are committable
  skills/*.md        reusable skills
  prompts/*.md       prompt templates
  sessions/<id>.md   a readable mirror of every chat in this path
```

- **Skills** are markdown playbooks. `/skill add review-code` writes one; `/skill use review-code` loads it into the current chat. When a new console opens on the same path, it announces how many previous chats are stored here and asks before loading each skill or prompt (shown in a box first — files in a cloned repo can never silently inject instructions).
- **Prompts** are starter templates: write one with `/prompt add standup`, then `/prompt use standup` to begin a chat from it.
- **Chat mirrors** are written after every task, so your history in that folder is always readable as plain markdown.
- Skills and prompts are yours to commit to git and share with your team; chat mirrors stay local.

### Project rules (`AGENTS.md`)

If the workspace contains `AGENTS.md` (or `.operator/instructions.md`), the console shows you the file and asks before loading it. Your answer is remembered per exact content hash: unchanged files are not asked about again, and if the file is edited you are asked again. Approved instructions shape *how* work is done — they can never grant access, approve an action, or weaken security.

## 🧾 Command line (CLI)

Every console feature also exists as a scriptable command. Global flags: `--json` (machine-readable, non-interactive) · `--no-color` · `-v, --version`.

| Command | Purpose |
|---|---|
| `ktoperator` · `operator chat [sessionId]` | Interactive console (the default). With a session id, resume that chat |
| `operator run <task...>` | Run a task end-to-end and exit. Options: `--provider <id>`, `--model <id>`, `--yes [read\|write\|all]`, `--dry-run`, `--max-steps <n>`, `--token-budget <n>` |
| `operator plan <task...>` | Print an execution plan only — nothing is executed or modified |
| `operator init` | Create the config home and default config (optionally pick a workspace) |
| `operator doctor` | Diagnose the environment: runtime, config, providers, workspace, sandbox |
| `operator provider list` | List provider profiles (keys are never printed) |
| `operator provider add ...` | Add a profile: `--id`, `--type`, `--base-url`, `--model`, `--api-key-env`, `--key`, `--referer`, `--title`, `--trusted-local`, `--default`, `--skip-test` |
| `operator provider test [id]` | Test connectivity + auth of a profile |
| `operator provider remove <id>` (alias `delete`) | Delete a profile and its stored credentials |
| `operator model list [--provider <id>]` | List models and capabilities for a provider |
| `operator workspace select [path]` | Authorize a folder as the workspace (default: current directory) |
| `operator workspace show` | Show the current workspace and whether it is still valid |
| `operator session list [--limit <n>]` | List recent sessions |
| `operator session delete <id>` | Permanently delete a session (id or id prefix) |
| `operator session export <id> [--out <file>]` | Export a session as a Markdown transcript |
| `operator usage [sessionId]` | Token/cache/cost breakdown for one session, or totals across all sessions |
| `operator history [sessionId] [--limit <n>]` | Audit trail, or a full session transcript |
| `operator sandbox status` | Sandbox backends, availability, capabilities, active selection |
| `operator config show` | Effective configuration (secrets redacted) |
| `operator config set <key> <value>` | Schema-validated setting (see Configuration below) |
| `operator config path` | Print the config file location |
| `operator backups [sessionId]` | List recovery snapshots (all sessions, or one) |
| `operator rollback <sessionId> [--yes]` | Restore files changed by a session from its snapshots |

Examples:

```bash
operator run 'Fix the failing tests and summarize what changed' --dry-run
operator run 'Add a README section' --yes write
operator run 'Analyze this project' --token-budget 50000 --json
operator provider add --id openrouter --type openrouter --model anthropic/claude-sonnet-4.5 --default
operator session export 74c48d0d --out chat.md
operator rollback 74c48d0d
```

`--yes` levels: `read` auto-approves tier-0 reads only, `write` tiers 0–1, `all` everything (all audited; destructive work still snapshots first). `--dry-run` simulates the plan without modifying anything. Without `--yes` in non-interactive mode, anything needing approval is denied with a clear explanation.

## 🔌 Providers & models

Six provider types, one normalized interface. Errors are the same everywhere: auth, credits, rate limits (honoring `Retry-After`), model availability, network, timeouts.

| Provider | How to connect | Notes |
|---|---|---|
| 🟠 **OpenRouter** (first-class) | `OPENROUTER_API_KEY` | Live model discovery, per-model tool-calling detection, token + cost usage, cached-token reporting |
| 🟢 **OpenAI** | `OPENAI_API_KEY` | Prompt-cache tokens reported |
| 🟠 **Anthropic** | `ANTHROPIC_API_KEY` | System prompt sent with prompt caching enabled |
| 🔵 **Google Gemini** | `GOOGLE_API_KEY` | Native API; key travels in a header, never the URL; tool schemas filtered to what Gemini accepts |
| 🔗 **OpenAI-compatible** | any endpoint + `--base-url` | SSRF-validated: HTTPS only, no credentials in URLs, no redirects; private addresses only with `--trusted-local` |
| 🐳 **Ollama** | local, no key | Offline local inference (`http://127.0.0.1:11434/v1` by default) |

Keys are resolved in this order: your profile's env var → the provider's default env var → the protected local store (`chmod 600`). Keys are never printed, logged, written into the workspace, or sent anywhere except their provider endpoint.

**Provider fallback (opt-in):** if your main provider rate-limits or runs out of credits, the run can continue on the next configured profile instead of dying — and it always announces the switch. Turn it on with `operator config set fallback.enabled true` (optional `fallback.order openrouter,openai`). It never falls back silently, never after answer text was streamed, and never for auth or bad-request errors.

## 🧰 The 40 tools the agent can call

The agent never touches your machine directly — it can only ask for these tools, and every call passes the security pipeline first.

| Group | Tools | What they do |
|---|---|---|
| 📁 Files (read) | `list_directory`, `read_file`, `search_files`, `search_text`, `inspect_file_metadata`, `generate_diff` | Explore and read the workspace; preview a diff before changing anything |
| ✏️ Writes | `create_file`, `edit_file`, `move_file`, `delete_file`, `delete_directory` | Create, edit (with diff preview and whitespace-tolerant fallback), move, delete. Every write is snapshotted first; directory delete caps at 500 files / 50 MB and never touches the workspace root or `.git` |
| 🔎 Project & git | `inspect_project`, `detect_project_type`, `inspect_package_json`, `inspect_git_status`, `git_commit`, `git_branch`, `git_stash` | Understand the project and do git work (stage-all + commit, branch list/create/switch, stash push/list/pop) — inside the sandbox, behind approval |
| 🧪 Quality | `run_tests`, `run_typecheck`, `run_linter`, `run_build` | Run the project's existing `test` / `typecheck` / `lint` / `build` scripts only |
| ⚙️ System info | `get_operating_system`, `get_runtime_versions`, `get_cpu_summary`, `get_memory_summary`, `get_disk_usage`, `get_process_summary` | Read-only machine facts for questions like 'how much free space is left' |
| ⚙️ Commands | `execute_approved_command`, `run_shell_command`, `start_background_process`, `read_process_output`, `inspect_command_result`, `terminate_managed_process` | Run structured commands in the sandbox, real cmd/bash/PowerShell lines on your machine (exact text approved first), and long-running background jobs with bounded output |
| 🌐 Web | `web_search`, `web_fetch` | Read-only public internet. Every URL and redirect is validated (http(s) only, no private addresses), output is capped, redacted and injection-screened |
| 🗝️ Access | `request_path_access` | Ask you for one folder/drive outside the workspace — read-only by default, read+write only as a separate approval |
| 🖥️ Desktop | `launch_app`, `open_url`, `close_app` | Open any installed app by name (catalog + Start Menu / Applications / PATH lookup), open a URL in your browser, close a running app. Shells and terminals are refused by name; nothing can install, download, or click for you |

After every run, a **changes box** summarizes what actually changed (folders, files, apps, links, commands), and the **diff preview** shows the file changes line by line in color.

### Exact destinations — no duplicate files

When you name an absolute destination ('make notes.txt on D:/docs/notes.txt'), the file is created at **exactly that path, once**. A runtime guard in the agent loop blocks any same-named file that would land in the workspace/terminal folder instead, and the agent is told the exact destination to use.

## 🛡️ Security model

> The model proposes. The policy engine disposes.

| Layer | What it means for you |
|---|---|
| **Workspace boundary** | Every file access is resolved through the real filesystem (`realpath`), so symlink/junction escapes, `..` traversal and TOCTOU swaps fail closed. Only regular files and directories — never devices, sockets or FIFOs |
| **Sandbox or nothing** | Commands run in Docker: no network by default, dropped capabilities, read-only root, memory/CPU/pid limits. The image auto-pulls on first use. Without a sandbox, execution is **refused** — never silently downgraded. A real host shell is a separate, tier-3, per-command decision with the exact text shown |
| **4-tier approvals** | Tier 0 read (allowed) → tier 1 reversible writes (approved) → tier 2 destructive (per-operation approval, never session-wide) → tier 3 privileged/external (per-operation, loudly audited). The AI can never approve itself; three denials stop the run |
| **Per-tool policies** | `security.toolPolicies` can `allow`, `approve` or `deny` any single tool. Instruction-like tool descriptions are flagged in the audit log (tool poisoning defense) |
| **Injection defense** | Everything tools return is wrapped as untrusted data and screened; approved project instructions are hash-remembered and can never grant access |
| **Secret defense** | Pattern-based redaction of keys/tokens on all model-visible output, audit entries, errors and config views; writes that look like live secrets are refused (`security.blockSecretWrites`, on by default) |
| **Audit & recovery** | JSONL audit log of every request, decision, execution, backup and restore. File snapshots before every mutation; `operator rollback` or `/undo` restores them. Commands already executed cannot be undone — and the UI says so |
| **Runaway protection** | Iteration / tool-call / time budgets, stall detection (same call 3×), cancellation that reaches providers, tools and process trees, exact-destination guard |

Details: [security model](docs/security.md) · [permission matrix](docs/permissions.md) · [sandbox](docs/sandbox.md) · [architecture](docs/architecture.md)

## 💰 Tokens & cost control

ktOperator is built to be cheap to run, not just capable:

- **Prompt caching** — Anthropic gets `cache_control` on the stable system prompt; OpenAI/OpenRouter report `cached_tokens`. The cheapest tokens in every request are the cached ones
- **Context budget** — `limits.tokenBudget` (default 30,000). Older turns are compressed to one-line summaries first, then dropped — never the task or the newest work. `/usage` shows the meter; at 80% you get one warning
- **Cost cap** — `limits.costCapUsd` stops a run when provider-reported cost passes the cap, with a clear reason
- **Compressed resume** — `/resume` and `ktoperator <id>` load the first task, summaries of older turns and the last turns verbatim — a fraction of the original context
- **Parallel reads** — consecutive read-only calls run concurrently; anything needing approval stays strictly sequential, in order
- **Compact edition** — a zero-dependency, token-efficient build lives in `compact/` (measured ~84% lower per-turn token floor)

```bash
operator config set limits.tokenBudget 30000
operator config set limits.costCapUsd 2.50
operator run 'Big refactor' --token-budget 50000
```

## ⚙️ Configuration

Config file (schema-validated — invalid values are rejected, never silently upgraded):

| OS | Path |
|---|---|
| Linux | `~/.config/operator/config.json` |
| macOS | `~/Library/Application Support/KarizTeam/Operator/config.json` |
| Windows | `%APPDATA%/KarizTeam/Operator/config.json` |

Set `OPERATOR_HOME` to use a different state directory (config, credentials, sessions, audit, backups). `operator config path` prints the active one.

Settable keys (all range-checked):

| Key | What it controls |
|---|---|
| `defaultProvider`, `defaultModel` | Defaults new sessions start with |
| `fallback.enabled`, `fallback.order` | Opt-in provider fallback chain (announced, never silent) |
| `security.allowRestrictedProcessFallback` | Opt-in non-container fallback for hosts without Docker (read `docs/sandbox.md` first) |
| `security.maxAutoApproveTier` | Hard cap for `--yes` auto-approval (0–2) |
| `security.toolPolicies` | Per-tool `allow` / `approve` / `deny` (edit config JSON directly) |
| `security.blockSecretWrites` | Refuse writes whose content looks like a live secret (default on) |
| `sandbox.backend`, `sandbox.image`, `sandbox.network`, `sandbox.memoryMb`, `sandbox.cpus`, `sandbox.pidsLimit`, `sandbox.writableDefault`, `sandbox.autoPull` | Docker backend selection and limits |
| `network.allowPrivateProviderEndpoints` | Allow private/loopback provider endpoints (advanced) |
| `limits.maxIterations`, `limits.maxToolCalls`, `limits.maxDurationMs`, `limits.maxOutputBytes`, `limits.maxFileBytes`, `limits.maxProcesses`, `limits.maxProviderRetries`, `limits.maxTokens`, `limits.tokenBudget`, `limits.costCapUsd` | Run budgets and caps |
| `backups.enabled`, `backups.maxMb` | File snapshot backup size (default 256 MB) |
| `ui.color` | ANSI colors on/off (or use `--no-color`) |

Environment variables: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` (or your profile's `apiKeyEnv`), `OPERATOR_HOME`, `OPERATOR_DEBUG=1` (stack traces for unexpected errors).

## 🗂️ Where everything lives

| What | Where |
|---|---|
| Config + credentials | Config home above (credentials `chmod 600`); sessions, audit, backups live under the same home |
| Workspace data | `<workspace>/.operator/` — skills, prompts, chat mirrors (gitignored), `instructions.md` |
| Sessions | Stored under the config home; portable via `operator session export`
| Audit log | `operator history` (or `audit/*.jsonl` under the config home), secrets always redacted |

## 📖 Examples of things to ask

```text
Analyze this project and explain its architecture
what is using port 3000?
show my IP in cmd
how much free space is left on drive C?
open Opera GX
close Notepad
make a txt file on D:/docs/notes.txt with today's date in it
start the dev server and tell me the port it bound
run the tests and fix the failures
commit my changes with a good message
check drive C for large files
save a standup summary as a prompt template for tomorrow
```

## 🛠️ Troubleshooting

Run `operator doctor` first — it checks the items below and reports per-check severity. Full guide: [docs/troubleshooting.md](docs/troubleshooting.md).

| Symptom | Fix |
|---|---|
| 'No AI provider is configured' | Just run `ktoperator` — the console walks you through it. Or set the env var and `operator provider add --id openrouter --type openrouter --model <id> --default` |
| Auth failed (401/403) | `operator provider list` shows each profile's key source; re-enter the key via `/provider add`, or set the right env var; `operator provider test` verifies |
| 'No workspace selected' | `operator workspace select .` authorizes the current folder |
| 'No secure sandbox is available' | Install Docker (`docker pull node:22-alpine`), or read `docs/sandbox.md` and opt in to the restricted-process fallback. Read-only tools keep working either way |
| 'Approval requires an interactive terminal' | You used `--json` without `--yes`. Drop `--json`, or pass `--yes write` / `--yes all` deliberately |
| Rate limits / credits (429/402) | Retried with `Retry-After`; 402 means credits are exhausted — top up, switch profile, or opt in to `fallback.enabled` |
| 'Model not found' | `operator model list --provider <id>` prints valid ids; models marked as no-tool-calling cannot act |
| A background process still runs | Jobs keep running on purpose. Stop them with `terminate_managed_process`; leftovers stop when the session ends |
| 'npm script not found' | Only existing `test`/`typecheck`/`lint`/`build` scripts run. The error lists the scripts that exist |
| Unexpected error | Re-run with `OPERATOR_DEBUG=1` for a stack trace |

## ⚠️ Known limitations

- The restricted-process fallback is **not** a container: no filesystem/network isolation, no memory/pid limits — enable it explicitly after reading `docs/sandbox.md`
- Windows sandboxing is Docker Desktop or that fallback until a Windows-container backend ships
- Directory deletion is bounded (≤500 files / 50 MB snapshotted); the workspace root and `.git` are never deleted
- Rollback restores **file contents only** — commands already executed, installs and network effects cannot be undone (the UI says so)
- The agent loop never claims success for a failed action; if something could not be done, it reports what was and was not done (it will fix soon)

## 🧪 Development

```bash
npm run typecheck   # strict TypeScript
npm run lint        # eslint
npm test            # 407 tests: unit + security + integration (no network, no API keys)
npm run build       # emit dist/
npm run audit       # dependency check
node --test compact/test.mjs   # compact edition tests
```

Dev shortcut: `npm run operator -- run '...'`. Architecture: [docs/architecture.md](docs/architecture.md).

## 📄 License

MIT — see [LICENSE](LICENSE). Built with ❤️ by **KarizTeam**.

