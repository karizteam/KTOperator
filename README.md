<div align="center">

# 🜂 ktOperator

[![version](https://img.shields.io/badge/version-0.6.0-8B9A6E?style=flat-square)](https://www.npmjs.com/package/@karizteam/operator)
[![node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-358%20passing-success?style=flat-square)](#-development)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**The AI decides what it wants to do. The security engine decides what it is allowed to do.**

🇮🇷 [راهنمای فارسی](README.fa.md) · [🧩 Architecture](docs/architecture.md) · [🛡️ Security](docs/security.md) · [⚖️ Permissions](docs/permissions.md)

</div>

---

**ktOperator** is a terminal AI agent you can actually hand your machine to. You
describe the task in plain language — *“analyze this project”*, *“what is using
port 3000?”*, *“open Opera GX”* — and it plans, reads, writes and runs commands
inside a workspace you authorize, behind a policy engine that is completely
independent of the model.

```bash
ktoperator                                                    # interactive console
operator run "Analyze this project and explain its architecture"
operator plan "Run the tests and summarize the failures"      # plan only, executes nothing
```

## ✨ What you get

- **💬 A real console** — onboarding once, then a chat box with streamed, formatted answers (headings, lists, code blocks, Persian/RTL shaping), `↑`/`↓` prompt recall, `/resume`, the session's running **cost in the top-right corner of the box**, and `Ctrl+C` that stops a task without killing the console.
- **📦 A changes box after every run** — folders, files, apps, links and commands the run touched, in one clean box.
- **🧭 Dynamic access** — point at anything (*“check drive C”*, *“open D:\projects\shop”*) and the agent asks once for that folder or drive instead of answering *“no access”*. Read-only by default; write access is a separate, explicit grant.
- **⌨️ Natural language → a real command** — *“show my IP in cmd”*, *“how much free space is left”*: the agent writes the actual `cmd`/`bash`/PowerShell line and shows it with the shell, directory and any warning before anything runs.
- **🖥️ Desktop control** — *“open Opera GX”* (any installed app, found by name), *“close Notepad”*, *“open the Store page for Spotify”*, *“show me this page in Edge”*. Shells and terminals are refused by name.
- **🧰 36 tools** — files, search, diffs, project inspection, git status, test/typecheck/lint/build scripts, sandboxed commands, foreground and background managed processes, system info, web, desktop.
- **🚀 Long-running work** — *“start the dev server”*, *“watch the tests”*: the job starts in the background, its output is read line by line, and the whole process tree stops on request or when the session ends.
- **🧭 Your project's rules** — an `AGENTS.md` in the workspace is shown to you and loaded only when you approve that exact content; a changed file is asked about again.
- **🔐 Security by default** — 4-tier approvals, sandboxed execution, prompt-injection defense, secret redaction, audit trail, backups and rollback.

## 🆕 What's new in 0.6.0

| | |
|---|---|
| 🔵 **Gemini tool calling fixed** | Every Gemini function call now carries its `thoughtSignature` back on the next turn, so long tool-calling runs no longer die with `400 … missing a thought_signature`. Other providers ignore the field. |
| 🖥️ **Apps start reliably** | The launcher used to hand Windows a path (`System32\explorer.exe`) that does not exist on modern installs, so Start Menu shortcuts opened nothing. It now resolves the executable that is really there — and finds apps installed under `%LOCALAPPDATA%\Programs` and Program Files even with no shortcut at all. |
| ⌨️ **No more “refusing a shell interpreter”** | A shell request that arrives as `["cmd", "/c", "dir"]` is routed to the same approved host-shell path as the plain-text form, instead of failing. |
| 🔒 **Shells cannot be opened as apps** | Start Menu entries such as *Git Bash*, *Git CMD*, *Node.js command prompt*, *PowerShell ISE* and *Run* are recognised and refused. |
| 🚀 **Servers can actually be started** | `start_background_process` returns an id instead of blocking, `read_process_output` hands out only the output produced since the last read, and the whole process tree is stopped by `terminate_managed_process` — or automatically when the run/session ends. |
| 🧭 **`AGENTS.md` support** | A workspace `AGENTS.md` (or `.operator/instructions.md`) is displayed and, with your approval, becomes project instructions in the system prompt. Trust is bound to the content hash: an edited file is shown and asked about again, and nothing is loaded silently in one-shot `run`. |
| 💵 **Cost in the corner, not a command** | The chat box shows the session's accumulated cost — or its token count when the provider reports no price — right-aligned in its top border. Small amounts keep their precision (`$0.0042`), and the label drops before the box ever overflows on a narrow terminal. |
| 🔁 **Provider fallback (opt-in)** | With `fallback.enabled`, a rate limit, empty credits, timeout or 5xx continues the same run on the next configured profile. Only transient failures move, never after text was streamed, and every switch is announced — off by default. |

## 🚀 Install

```bash
npm i -g @karizteam/operator
```

Node.js **22.12+**. Docker (optional) enables the strongest sandbox.

## 🎯 Quickstart

```bash
ktoperator
```

The console walks you through five steps, once:

| # | Step | What happens |
|---|---|---|
| 1 | **Provider** | OpenRouter · OpenAI · Anthropic · Google Gemini · any OpenAI-compatible endpoint · Ollama |
| 2 | **API key** | typed masked, stored `chmod 600`, connection tested immediately |
| 3 | **Model** | live model list for your provider — pick one, or type an id |
| 4 | **Workspace** | authorize the folder the agent may touch |
| 5 | **Chat box** | type any task; approvals, diffs and tool output appear inline |

Later runs jump straight to the chat box. Slash commands:

| Command | Does |
|---|---|
| `/help` `/status` | command list · session dashboard |
| `/provider` `/model` | switch profiles and models |
| `/workspace [path]` | show or re-authorize the workspace |
| `/access [list\|clear]` | folders you granted outside the workspace |
| `/sandbox` | sandbox backends and availability |
| `/resume [id]` | continue a previous session with its context |
| `/doctor` `/clear` `/exit` | diagnostics · reset context · leave |

## 🧰 Tools the agent can call

| Group | Tools |
|---|---|
| 📁 **Files** | `list_directory` `read_file` `search_files` `search_text` `inspect_file_metadata` `generate_diff` |
| ✏️ **Writes** | `create_file` `edit_file` (diff preview) `move_file` `delete_file` (snapshot first) |
| 🔎 **Project** | `inspect_project` `detect_project_type` `inspect_package_json` `inspect_git_status` |
| 🧪 **Quality** | `run_tests` `run_typecheck` `run_linter` `run_build` (existing npm scripts only) |
| ⚙️ **System** | `get_operating_system` `get_runtime_versions` `get_cpu_summary` `get_memory_summary` `get_disk_usage` `get_process_summary` |
| 🖥️ **Processes** | `execute_approved_command` (sandboxed argv, or an approved host shell) `run_shell_command` (real cmd/bash on your machine) `start_background_process` (dev server, watcher — id, no blocking) `read_process_output` (new output only) `inspect_command_result` `terminate_managed_process` `close_app` |
| 🌐 **Web** | `web_search` `web_fetch` — every URL and redirect validated, output capped |
| 🗝️ **Access** | `request_path_access` — a folder or drive outside the workspace: read-only, or read + write when you approve it |
| 🖼️ **Desktop** | `launch_app` (chrome · edge · firefox · notepad · explorer · calculator · paint · vscode · store · **any installed app by name**) `open_url` |

Every tool is classified in the [4-tier permission matrix](docs/permissions.md).

## 🧾 CLI

| Command | Purpose |
|---|---|
| `ktoperator` · `operator chat` | interactive console (default) |
| `operator run "<task>"` | full agent loop — `--dry-run`, `--yes read\|write\|all`, `--json`, `--max-steps` |
| `operator plan "<task>"` | plan only — nothing executed |
| `operator init` | create config home and defaults |
| `operator doctor` | environment diagnostics |
| `operator provider list/add/test/remove` | provider profiles (keys never printed) |
| `operator model list` | models + capabilities per provider |
| `operator workspace select/show` | authorize and inspect the workspace |
| `operator session list` · `operator history [id]` | recent sessions · audit trail / transcript |
| `operator sandbox status` | backends, availability, active selection |
| `operator config show/set/path` | schema-validated config (secrets redacted) |
| `operator backups [id]` · `operator rollback <id>` | recovery snapshots · restore |

Global flags: `--json` · `--no-color` · `-v/--version`.

## 🔌 Providers

| Provider | Notes |
|---|---|
| 🟠 **OpenRouter** | first-class: `/models` discovery, per-model capability detection, token + cost usage |
| 🟢 **OpenAI** | `OPENAI_API_KEY` or the protected local store |
| 🟠 **Anthropic** | `ANTHROPIC_API_KEY` |
| 🔵 **Google Gemini** | `GOOGLE_API_KEY`; native API, tool schemas filtered to what Gemini accepts, thought signatures preserved |
| 🔗 **OpenAI-compatible** | any endpoint you point at |
| 🐳 **Ollama** | local, offline, no key |

Errors are normalized across all of them: auth, credits, rate limits with
`Retry-After`, model availability. Custom endpoints follow the
[SSRF rules](docs/security.md) — HTTPS only, no credentials in URLs, no
redirects, private addresses only with `trustedLocal`.

## 🛡️ Security model

> The model proposes. The policy engine disposes.

- 🧱 **Workspace boundary** — canonical-path (`realpath`) resolution, symlink/junction escape protection, device-file rejection, size caps.
- 📦 **Sandbox or nothing** — commands run in Docker (no network, dropped capabilities, read-only root); without a sandbox, execution is **refused**, never silently downgraded. A real host shell is a separate, tier-3, per-command decision.
- ⚖️ **4-tier approvals** — read → reversible write → destructive → privileged. The AI can never approve its own actions; destructive steps are snapshotted first.
- 🧼 **Injection & secret defense** — tool output is wrapped as untrusted data and screened; keys never appear in logs, output, or the workspace.
- 📜 **Auditable & reversible** — JSONL audit log, per-session transcripts, `operator rollback` restores files.

Details: [architecture](docs/architecture.md) · [security](docs/security.md) · [permissions](docs/permissions.md) · [sandbox](docs/sandbox.md) · [providers](docs/providers.md) · [troubleshooting](docs/troubleshooting.md)

## ⚙️ Configuration

- Config: `~/.config/operator/config.json` · `%APPDATA%\KarizTeam\Operator\config.json` · `~/Library/Application Support/KarizTeam/Operator/config.json` — override with `OPERATOR_HOME`.
- Keys are read from environment variables first (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), then from the protected local store.
- Provider fallback: `operator config set fallback.enabled true`, and optionally `operator config set fallback.order openrouter,openai` (empty = every other configured profile, in config order).

## 🧪 Development

```bash
npm run typecheck   # strict TypeScript
npm run lint        # eslint
npm test            # 358 tests: unit + security + integration (no network, no API keys)
npm run build       # emit dist/
npm run audit       # dependency check
```

## ⚠️ Known limitations

- The restricted-process fallback is **not** a container: no filesystem/network isolation, no memory/pid limits — enable it explicitly.
- Windows sandboxing is limited to that fallback until a Windows-container backend ships.
- Recursive directory deletion is intentionally not exposed to the agent.

## 📄 License

MIT — see [LICENSE](LICENSE). Built with ❤️ by **KarizTeam**.
