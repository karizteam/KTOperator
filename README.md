<div align="center">

# 🜂 ktOperator

[![version](https://img.shields.io/badge/version-0.4.0-8B9A6E?style=flat-square)](https://www.npmjs.com/package/@karizteam/operator)
[![node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-263%20passing-success?style=flat-square)](#-development)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**The AI decides what it wants to do. The security engine decides what it is allowed to do.**

🇮🇷 [راهنمای فارسی](README.fa.md) · [📦 Docs](#-documentation) · [🛡️ Security](#%EF%B8%8F-security-model)

</div>

---

**ktOperator** is a secure, multi-provider AI agent that lives in your terminal. You describe a task in plain language — *“analyze this project”*, *“run the tests and fix what breaks”* — and it plans, reads, writes and executes **inside a workspace you explicitly authorize**, behind a policy engine that is completely independent of the model.

```bash
ktoperator
```

```bash       # interactive console: provider → API key → model → chatbox
operator run "Analyze this project and explain its architecture"
operator plan "Run the tests and summarize the failures"   # plan only, executes nothing
```

## ✨ What you get

- **💬 A real console** — onboarding once, then a chatbox with streamed, formatted answers (headings, lists, code blocks, full Persian/RTL shaping), `↑`/`↓` prompt recall, `/resume` to continue a session, and `Ctrl+C` that stops a task without killing the console.
- **📦 A changes box after every run** — folders, files, apps, links and commands the run touched, in one clean box.
- **🧭 Dynamic access** — point at something outside the workspace (*“check drive C”*, *“open D:\projects\shop”*) and the agent asks for read-only access to that folder once, instead of replying *“no access”*. Writes still stay in the workspace.
- **🖥️ Desktop & web actions** — *“open Chrome and search for…”*, *“open the Store page for Spotify”*, *“show me this page in Edge”* — plus web search and fetch, each URL validated before it is touched.
- **🧰 32 tools** — files, search, diffs, project inspection, git status, test/typecheck/lint/build scripts, sandboxed commands, managed processes, system info, web, desktop.
- **🔐 Security by default** — 4-tier approvals, sandboxed execution, prompt-injection defense, secret redaction, full audit trail, backups and rollback.

## 🚀 Install

```bash
npm i ktOperator        # installs `ktoperator` and `operator`
```

Node.js **22.12+**. Docker (optional) enables the strongest sandbox.

## 🎯 Quickstart

```bash
ktoperator
```

The console walks you through five steps, once:

| # | Step | What happens |
|---|---|---|
| 1️⃣ | **Provider** | OpenRouter · OpenAI · Anthropic · Google · any OpenAI-compatible endpoint · Ollama |
| 2️⃣ | **API key** | typed masked, stored `chmod 600`, connection tested immediately |
| 3️⃣ | **Model** | live model list for your provider — pick one, or type an id |
| 4️⃣ | **Workspace** | authorize the folder the agent may touch |
| 5️⃣ | **Chatbox** | type any task; approvals, diffs and tool output appear inline |

Later runs jump straight to the chatbox. Slash commands:

| Command | Does |
|---|---|
| `/help` `/status` | command list · session dashboard |
| `/provider` `/model` | switch profiles and models |
| `/workspace` `[path]` | show or re-authorize the workspace |
| `/access` `[list\|clear]` | folders you granted outside the workspace |
| `/sandbox` | sandbox backends and availability |
| `/resume` `[id]` | continue a previous session with its context |
| `/doctor` `/clear` `/exit` | diagnostics · reset context · leave |

## 🧰 Tools the agent can call

| Group | Tools |
|---|---|
| 📁 **Files** | `list_directory` `read_file` `search_files` `search_text` `inspect_file_metadata` `generate_diff` |
| ✏️ **Writes** | `create_file` `edit_file` (diff preview) `move_file` `delete_file` (snapshot first) |
| 🔎 **Project** | `inspect_project` `detect_project_type` `inspect_package_json` `inspect_git_status` |
| 🧪 **Quality** | `run_tests` `run_typecheck` `run_linter` `run_build` (existing npm scripts only) |
| ⚙️ **System** | `get_operating_system` `get_runtime_versions` `get_cpu_summary` `get_memory_summary` `get_disk_usage` `get_process_summary` |
| 🖥️ **Processes** | `execute_approved_command` `inspect_command_result` `terminate_managed_process` |
| 🌐 **Web** | `web_search` `web_fetch` — every URL and redirect validated, output capped |
| 🗝️ **Access** | `request_path_access` — read-only grant for a folder outside the workspace |
| 🖼️ **Desktop** | `launch_app` (chrome · edge · firefox · notepad · explorer · calculator · paint · vscode · store) `open_url` |

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
| 🟠 **OpenRouter** | first-class: `/models` discovery, per-model capability detection, token+cost usage |
| 🟢 **OpenAI** | `OPENAI_API_KEY` or the protected local store |
| 🟠 **Anthropic** | `ANTHROPIC_API_KEY` |
| 🔵 **Google Gemini** | `GOOGLE_API_KEY` |
| 🔗 **OpenAI-compatible** | any endpoint you point at |
| 🐳 **Ollama** | local, offline, no key |

Error handling is normalized across all of them: auth, credits, rate limits with `Retry-After`, model availability. Custom endpoints are checked against [SSRF rules](docs/security.md) — HTTPS-only, no credentials in URLs, no redirects, private addresses only with `trustedLocal`.

## 🛡️ Security model

> The model proposes. The policy engine disposes.

- 🧱 **Workspace boundary** — canonical-path (`realpath`) resolution, symlink/junction escape protection, device-file rejection, size caps.
- 📦 **Sandbox or nothing** — commands run in Docker (no network, dropped capabilities, read-only root); without a sandbox, execution is **refused**, never silently downgraded.
- ⚖️ **4-tier approvals** — read → reversible write → destructive → privileged. The AI can never approve its own actions; destructive steps are snapshotted first.
- 🧼 **Injection & secret defense** — tool output is wrapped as untrusted data and screened; keys never appear in logs, output or the workspace.
- 📜 **Auditable & reversible** — JSONL audit log, per-session transcripts, `operator rollback` restores files.

Full details: [architecture](docs/architecture.md) · [security](docs/security.md) · [permissions](docs/permissions.md) · [sandbox](docs/sandbox.md) · [providers](docs/providers.md) · [troubleshooting](docs/troubleshooting.md)

## ⚙️ Configuration

- Config: `~/.config/operator/config.json` · `%APPDATA%\KarizTeam\Operator\config.json` · `~/Library/Application Support/KarizTeam/Operator/config.json` — override with `OPERATOR_HOME`.
- Keys are read from environment variables first (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), then from the protected local store.

## 🧪 Development

```bash
npm run typecheck   # strict TypeScript
npm run lint        # eslint
npm test            # 263 tests: unit + security + integration (no network, no API keys)
npm run build       # emit dist/
npm run audit       # dependency check
```

## ⚠️ Known limitations

- The restricted-process fallback is **not** a container: no filesystem/network isolation, no memory/pid limits — enable it explicitly.
- Windows sandboxing is limited to that fallback until a Windows-container backend ships.
- Recursive directory deletion is intentionally not exposed to the agent.

## 📄 License

MIT — see [LICENSE](LICENSE). Built with ❤️ by **KarizTeam**.