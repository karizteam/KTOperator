# KarizTeam Operator

> The AI decides what it wants to do. Operator's security engine decides what it is allowed to do.

🇮🇷 [راهنمای فارسی](README.fa.md)

**Operator** is a secure, multi-provider AI operating-system agent CLI. It connects to your choice of AI provider (OpenRouter, OpenAI, Anthropic, Google Gemini, any OpenAI-compatible endpoint, or local Ollama), understands natural-language tasks, inspects a workspace **you explicitly authorize**, plans changes, and executes approved actions inside a real sandbox — with every security decision made by a policy engine that is completely independent of the AI model.

```bash
ktoperator        # interactive console — provider → API key → model → chatbox
operator run "Analyze this project and explain its architecture"
operator run "Run the tests, diagnose failures, and fix them after approval"
```

## Why it exists

Most "AI shell assistants" paste model-generated commands straight into your shell. Operator is different:

- **Workspace-first** — the agent can only see the directory you explicitly select; canonical-path resolution, symlink/junction escape protection, device-file rejection, and size caps are enforced for every single file access.
- **Real sandboxing** — all AI-directed command execution runs in a restricted environment (Docker container with no network, dropped capabilities, read-only root; a documented, opt-in restricted-process fallback exists for containerless hosts). Without a sandbox, execution is **refused**, never downgraded silently.
- **Independent approval engine** — file edits, deletions, builds, and command execution require explicit user approval (interactive prompt or deliberate `--yes` flags). The AI can never approve its own actions. Destructive operations get per-operation approval and are snapshotted first.
- **Prompt-injection defense** — file contents and command output are treated as untrusted data, wrapped in delimiters, screened for injected instructions, and stripped of secrets before the model ever sees them.
- **Full auditability** — structured JSONL audit log, per-session transcripts, and rollback for file changes.

## Requirements

- Node.js **20.18+** (22+ recommended)
- Optional for the strongest sandbox: Docker Engine / Docker Desktop
- An API key for your provider of choice (e.g. `OPENROUTER_API_KEY`)

## Install

```bash
npm i ktOperator        # npm registry names are lowercase; `ktoperator` resolves either way
```

This installs two global commands: `ktoperator` and `operator`.

## Quickstart

Just run it — there is no separate setup step:

```bash
ktoperator
```

The interactive console walks you through everything, once:

1. **Provider** — OpenRouter, OpenAI, Anthropic, Google, any OpenAI-compatible endpoint, or local Ollama.
2. **API key** — typed masked, stored in a `chmod 600` credentials file (or read from the usual env var, e.g. `OPENROUTER_API_KEY`); the connection is tested immediately.
3. **Model** — the live model list loads for your provider; pick one (or type an id manually).
4. **Workspace** — authorize the directory the agent may touch.
5. **Chatbox** — type any task; approvals, diffs and tool output appear inline. Slash commands: `/help /status /provider /model /workspace /sandbox /resume /doctor /clear /exit`.

Later runs skip straight to the chatbox (choose the saved profile, confirm the workspace — done). `↑`/`↓` recall earlier prompts, `/resume` continues a previous session, and `Ctrl+C` stops a running task without ending the session (a second press at the empty prompt exits).

Access is dynamic: when you point at something outside the workspace — *"check drive C"*, *"what is in D:\projects\shop"* — the agent asks for read-only access to that folder, you approve it once, and it inspects it with the normal tools instead of claiming it has no access. Writes still stay inside the workspace (`/access` lists or revokes what you granted).

The agent can also act on your desktop: ask it to *"open Chrome and search for …"*, *"open the Store search page for Spotify"*, or *"open this page in Edge"*. It can only launch the allowlisted apps (Chrome, Edge, Firefox, Notepad, Explorer, Calculator, Paint, VS Code, Microsoft Store) and open http(s) pages — every action is approved by you first, and it never installs or clicks for you.

```bash
# one-shot and scriptable alternatives:
operator run "Analyze this project and explain its architecture"
operator plan "Run the tests and summarize failures"
operator sandbox status
operator doctor
```

## Commands

| Command | Purpose |
|---|---|
| `ktoperator` (bare, or `operator chat`) | Interactive console: onboarding + chatbox in one environment |
| `operator init` | Initialize config home and defaults |
| `operator doctor` | Environment diagnostics (runtime, config, workspace, sandbox) |
| `operator provider list/add/test/remove` | Manage provider profiles (keys never printed) |
| `operator model list` | Discover models + capabilities per provider |
| `operator workspace select/show` | Authorize and inspect the agent workspace |
| `operator plan "<task>"` | Plan only — nothing executed |
| `operator run "<task>"` | Full agent loop (`--dry-run`, `--yes read|write|all`, `--json`, `--max-steps`) |
| `operator session list` | Recent sessions |
| `operator history [id]` | Audit trail or full session transcript |
| `operator sandbox status` | Sandbox backends, availability, active selection |
| `operator config show/set/path` | Schema-validated configuration (secrets redacted) |
| `operator backups [id]` | Recovery snapshots |
| `operator rollback <id>` | Restore file contents from snapshots |

Global flags: `--json` (machine-readable, non-interactive), `--no-color`, `-v/--version`.

## Configuration & credentials

- Config: `~/.config/operator/config.json` (Linux), `%APPDATA%\KarizTeam\Operator\config.json` (Windows), `~/Library/Application Support/KarizTeam/Operator/config.json` (macOS). Override with `OPERATOR_HOME`.
- API keys are read from **environment variables first** (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), falling back to a protected local store created `chmod 600`. Keys are never printed, logged, written to the workspace, or sent anywhere except the matching provider endpoint.
- Custom provider endpoints are validated against SSRF rules: HTTPS-only, no credentials in URLs, private-address resolution requires an explicit `trustedLocal` profile, redirects are never followed.

### OpenRouter

OpenRouter is the mandatory first-class provider: attribution headers (`HTTP-Referer`, `X-Title`) supported, `/models` discovery with per-model capability detection (`supported_parameters` → tool calling / structured outputs), token+cost usage reporting, and full error normalization (auth, credits, rate limits with `Retry-After`, model availability).

## Security model

Read the full docs — this summary is not a substitute:

| Document | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, agent loop Section 10 of the spec |
| [docs/security.md](docs/security.md) | Threat model, path security, injection defense, secrets handling |
| [docs/permissions.md](docs/permissions.md) | The 4-tier permission/approval matrix, every tool classified |
| [docs/sandbox.md](docs/sandbox.md) | Sandbox backends, guarantees, and honest limitations |
| [docs/providers.md](docs/providers.md) | Provider configuration reference |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems and fixes |

**Known limitations (v0.1):** the restricted-process fallback is not a container (no filesystem/network isolation, no memory/pid enforcement); Windows sandboxing is limited to the fallback path until a Windows-container backend ships; recursive directory deletion is intentionally not exposed to the agent.

## Development

```bash
npm run typecheck   # strict TypeScript
npm run lint        # eslint flat config
npm test            # 139 tests: unit + security regression + e2e integration
npm run build       # emit dist/
npm run audit       # dependency vulnerability check (0 findings at release)
```

Tests use hermetic tmp dirs, mocked providers, and a local OpenAI-compatible fixture server — no real network or AI service required.

## License

MIT — see [LICENSE](LICENSE).
