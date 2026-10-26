# Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI (commander)  ·  src/cli.ts + src/commands/*                  │
│ init chat doctor provider model workspace plan run session       │
│ history sandbox config backups rollback                          │
└───────────────┬─────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────┐
│ Agent core (src/core)                                            │
│  · planner — plan-only mode, structured JSON when supported      │
│  · agent loop — bounded: iteration/tool-call/time/token limits,  │
│    stall detection, denial circuit breaker, cancellation         │
└──────┬───────────────────┬───────────────────┬──────────────────┘
       │                   │                   │
┌──────▼───────┐  ┌────────▼──────────┐  ┌─────▼────────────────┐
│ Providers    │  │ Tool registry     │  │ Security engine      │
│ (src/        │  │ (src/tools)       │  │ (src/security)       │
│ providers)   │  │  · 10 filesystem  │  │  · policy (4 tiers)  │
│  OpenRouter  │  │  · 8 development  │  │  · approval engine   │
│  OpenAI      │  │  · 6 system       │  │  · workspace boundary│
│  Anthropic   │  │  · 3 process mgmt │  │  · redaction         │
│  Gemini      │  │  Single JSON      │  │  · injection screen  │
│  OpenAI-cmp. │  │  Schema per tool: │  │  · audit log (JSONL) │
│  Ollama      │  │  validation +     │  └──────────┬───────────┘
│              │  │  model definition │             │
└──────┬───────┘  └────────┬──────────┘             │
       │                   │                        │
       │            ┌──────▼───────────────────┐    │
       │            │ Sandbox (src/sandbox)    │◄───┘ (manager owned by
       │            │  · Docker backend        │      runtime, never by AI)
       │            │  · Restricted-process    │
       │            │    backend (opt-in)      │
       │            └──────┬───────────────────┘
       │                   │
       │            ┌──────▼───────────────────┐
       │            │ Managed processes         │
       │            │ argv-only, no shell,      │
       │            │ env allowlist, timeout,   │
       │            │ output caps, tree kill    │
       │            └──────────────────────────┘
       │
┌──────▼────────────────────────────────────────────────┐
│ Support: config (zod, versioned, atomic), credentials │
│ (env-first, chmod-600 store), sessions, recovery,     │
│ platform (paths/system info/process listing), logging │
└───────────────────────────────────────────────────────┘
```

## Data flow for `operator run "<task>"`

1. CLI parses flags, builds the Runtime (config → credentials → services).
2. Workspace boundary is constructed from the authorized path; **no boundary, no filesystem tools**.
3. Provider profile + model resolved; API key resolved from env or protected store (never displayed).
4. Session + audit log created; the sandbox manager evaluates backends and selects (or fails closed).
5. The system prompt records the workspace, sandbox state, limits, and security rules.
6. The bounded agent loop starts (see below).
7. Final report is printed/persisted; session transcript and audit trail complete.

## The agent loop (spec §10)

```
model ──► (text?) ──► done ──► verified final report
   │
   └─► tool_calls ──► per call:
         exists? schema-valid? tier classification ──► policy verdict
         ──► approval (interactive UI / --yes level / deny)
         ──► dry-run? execute ──► output caps ──► redaction
         ──► injection screening ──► audit ──► feed result back
```

Termination: completion, cancellation (Ctrl+C → AbortSignal everywhere), a policy violation circuit breaker (3 denials), stall detection (identical call 3×), or budget limits. Every ending produces a report distinguishing completed work from incomplete work — the loop never claims success for failed actions.

## Provider layer

A single `AIProvider` interface (chat, streaming, tool calling, capability detection, normalized errors, usage) is implemented by:

- **OpenRouter** — first-class: attribution headers, `/models` capability detection via `supported_parameters`, cost reporting via `usage: { include: true }`, `/auth/key` connectivity test.
- **OpenAI / generic OpenAI-compatible / Ollama** — shared chat-completions adapter with per-provider base URL and policy differences. Ollama is treated as an explicitly trusted local endpoint.
- **Anthropic** — Messages API with system-message extraction, `tool_use`/`tool_result` block mapping, SSE streaming.
- **Google Gemini** — `generateContent`/`streamGenerateContent` with `functionDeclarations`; the API key travels in the `x-goog-api-key` **header**, never the URL.

Normalized error taxonomy: `auth`, `rate_limit` (respects `Retry-After`), `insufficient_credits`, `invalid_model`, `invalid_request`, `network`, `timeout`, `provider`, `unsupported`, `aborted`. Retries (bounded, jittered) only on 429/5xx/network — never on auth or 4xx.

There is **no silent provider fallback**: a failing request errors out with a clear message; switching providers is always an explicit user action.

## Testability boundaries

Planner, policy engine, registry, sandbox backends, and managed-process runner are independently injectable: `fetchImpl`/`lookupImpl` for providers, tmp-dir config homes (`OPERATOR_HOME`), scripted mock providers for the loop, and a local mock server for full CLI E2E.
