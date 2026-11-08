# ktOperator-compact

A zero-dependency, token-efficient edition of ktOperator (v0.6.0). Same jobs,
same security model — rebuilt around one question: *what actually burns tokens?*

## Measured token floor (per model turn, before any history)

Measured with `scripts/measure-tokens.mjs` (chars/4 estimate, system prompt +
tool definitions sent on every iteration):

| | Original | Compact | Saving |
|---|---|---|---|
| Tools sent | 36 | 20 | −44% |
| Tool definitions | 21,087 chars (~5,272 tok) | 3,418 chars (~855 tok) | −84% |
| System prompt | 6,826 chars (~1,707 tok) | 1,138 chars (~285 tok) | −83% |
| **Floor / turn** | **~6,979 tok** | **~1,140 tok** | **−84%** |

Reproduce: `node scripts/measure-tokens.mjs` (original) and
`node scripts/measure-tokens.mjs compact/operator.mjs` (compact).

## How the saving is achieved

1. **Merged tools, terse schemas** — 36 tools → 20 (`search` covers files+text,
   `write` covers create+edit, `inspect` covers project+package+git,
   `run_script` covers test/typecheck/lint/build, `sysinfo` covers 6 system
   tools, `bg` covers background start/read/kill). Schemas carry type+required
   only — no per-property prose.
2. **Compressed system prompt** — same rules, ~1.1k chars instead of ~6.8k.
3. **Token-budgeted context** — `compressContext` shrinks old tool outputs to
   one-line summaries first, then drops oldest turns; budget defaults to
   20k tokens (`--token-budget N`). The original only truncated outputs
   >2,000 chars once and never dropped turns.
4. **Prompt caching (Anthropic)** — stable system prompt sent with
   `cache_control: ephemeral`, so repeat turns pay cached-input prices.
5. **Usage accounting** — every run reports prompt/completion tokens, cost
   (when the provider reports it), and the estimated prompt total.

## What it keeps from the original

- Workspace boundary: realpath + symlink-escape rejection, root refusal
- 4-tier approvals (read → write → destructive → privileged), `--yes`, `--dry-run`
- Secret redaction on all model-visible output; untrusted-output wrapping
- Backups before writes/deletes + `rollback`; JSONL audit; session transcripts
- Docker-only `exec` (refused without Docker, never silently downgraded);
  host `shell` is a separate tier-3 approval
- Providers: OpenRouter/OpenAI/Ollama/custom (OpenAI-compat), Anthropic
  (cached), Google Gemini — normalized errors, retries on 429/5xx

## Usage

```bash
node compact/operator.mjs                 # interactive chat
node compact/operator.mjs run "analyze this project" --token-budget 20000
node compact/operator.mjs plan "run the tests and summarize failures"
node compact/operator.mjs provider add --id or --type openrouter --model anthropic/claude-sonnet-4-5 --default
node compact/operator.mjs workspace select .
node compact/operator.mjs doctor
node --test compact/test.mjs
```

Config: `~/.config/ktcompact/config.json` (override with `OPERATOR_HOME`).
Keys: env vars first (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), then the config file.

## Files

| File | About |
|---|---|
| `lib.mjs` | boundary, redaction, injection wrap, config, audit/backups, token utils, context compression |
| `tools.mjs` | 20 tools + background jobs + app launcher |
| `providers.mjs` | 3 provider adapters (OpenAI-compat, Anthropic cached, Gemini) |
| `loop.mjs` | bounded agent loop with stall/denial breakers + token budget |
| `operator.mjs` | CLI (run/plan/chat/doctor/workspace/provider/model/config/session/history/sandbox/backups/rollback) |
| `test.mjs` | node:test suite (boundary, redaction, compression, loop) |
