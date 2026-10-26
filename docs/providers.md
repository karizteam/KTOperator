# Providers

One interface, six adapters. Provider errors are normalized to a shared
taxonomy; usage is reported when the API returns it; capabilities are
declared per provider and, on OpenRouter, detected per model.

## OpenRouter (first-class)

```bash
export OPENROUTER_API_KEY="sk-or-…"            # preferred
operator provider add --id openrouter --type openrouter \
  --model anthropic/claude-sonnet-4.5 \
  --referer "https://yourapp.example" --title "Your App" --default
operator provider test openrouter
operator model list --provider openrouter
```

- Base URL: `https://openrouter.ai/api/v1`
- Auth: `Authorization: Bearer <key>`; attribution headers `HTTP-Referer`
  and `X-Title` are configurable.
- Model discovery: `GET /models`; per-model capability detection from
  `supported_parameters` (`tools`, `response_format`/`structured_outputs`).
  Not every listed model supports tool calling — `model list` annotates
  those that don't, and the request fails with a clear provider error if a
  tool call is attempted on one.
- Usage: `usage: { include: true }` is sent; token counts and USD cost are
  surfaced in the session report.
- Errors: 401/403 → auth, 402 → insufficient credits, 429 → rate limit
  (honors `Retry-After`, bounded retries), 404 → invalid model, 5xx →
  provider error with retry.

## OpenAI

```bash
export OPENAI_API_KEY="sk-…"
operator provider add --id openai --type openai --model gpt-4o --default
```

## Anthropic Claude

```bash
export ANTHROPIC_API_KEY="sk-ant-…"
operator provider add --id claude --type anthropic --model claude-sonnet-4-5 --default
```

Messages API (`anthropic-version: 2023-06-01`), tool_use/tool_result mapping,
SSE streaming. Anthropic has no public model-list endpoint, so `model list`
returns a curated snapshot of current model ids.

## Google Gemini

```bash
export GOOGLE_API_KEY="…"
operator provider add --id gemini --type google --model gemini-2.5-pro --default
```

The key is sent in the `x-goog-api-key` **header** — never in the URL — so
it cannot leak through logs. Model discovery via `GET /v1beta/models`.

## Generic OpenAI-compatible endpoints

```bash
operator provider add --id corp --type openai-compatible \
  --base-url https://llm.corp.example/v1 --model my-model \
  --api-key-env CORP_LLM_KEY           # or --key-store flow of setup/add
```

Base-URL SSRF policy: HTTPS only (unless `trustedLocal`), no credentials in
the URL, no redirects, hostname must resolve to public IPs, non-443 ports
require trust.

## Ollama (local)

```bash
operator provider add --id ollama --type ollama --model llama3.1 --default
# custom address: --base-url http://127.0.0.1:11434/v1
```

Uses Ollama's OpenAI-compatible API. Treated as an explicitly trusted local
endpoint; no API key required. Structured outputs disabled by default.

## Credentials

Resolution order per profile: profile-specific env var → provider default
env var → protected local store (`chmod 600`, written by the interactive
console onboarding or `provider add --key`). Keys are never printed, logged, written into the
workspace, or included in telemetry (there is none).

## Model/per-session selection

`--provider`/`--model` flags override the session; `defaultProvider` /
`defaultModel` are the config fallback. **No silent provider fallback** — a
failing request surfaces its normalized error; switching is your decision.
