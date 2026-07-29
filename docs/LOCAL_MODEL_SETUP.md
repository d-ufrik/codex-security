# Local and self-hosted model setup

Run scans against any OpenAI-compatible Chat Completions endpoint — Aether
Desktop, llama-server, ollama, vLLM — instead of OpenAI.

Codex CLI 0.144.6 only speaks the Responses API for custom providers, while
OpenAI-compatible servers only serve Chat Completions. `codex-security`
bridges the two: when a custom `model_provider` is selected, it starts an
in-process loopback gateway that accepts Responses API requests and
re-emits them as Chat Completions streams against your endpoint. No external
proxy to run.

## Quick start (Aether Desktop)

```sh
export AETHER_API_KEY="sk-aether-..."
codex-security scan . \
  --provider aether \
  --base-url http://127.0.0.1:8183/v1 \
  --api-key-env AETHER_API_KEY \
  --model local-llama
```

`--provider` names the provider; `--base-url` + `--api-key-env` define it ad
hoc, the same way opencode/pi register named providers. `--api-key-env` is
the _name_ of the environment variable holding the key, not the key itself.

## Using a provider from ~/.codex/config.toml

Provider definitions in your ambient Codex config carry over into scans:

```toml
[model_providers.aether]
name = "Aether Desktop"
base_url = "http://127.0.0.1:8183/v1"
wire_api = "responses"
env_key = "AETHER_API_KEY"
```

Then select it by name — no `--base-url` needed:

```sh
codex-security scan . --provider aether --model local-llama
```

Provider _selection_ is never inherited from the ambient config; rerouting
scans off OpenAI is always explicit (`--provider` or
`--codex model_provider=...`). Explicit `--codex` provider blocks override
ambient definitions of the same name.

## Authentication

With a custom provider selected, no OpenAI credentials are required —
`OPENAI_API_KEY` and ChatGPT sign-in are ignored for that scan. If the
provider declares `env_key`, that variable must be set.

## Debugging the gateway standalone

```sh
codex-security serve-local --upstream http://127.0.0.1:8183/v1 \
  --api-key-env AETHER_API_KEY --port 18080
```

Exposes `http://127.0.0.1:18080/v1/responses` (SSE) in front of the Chat
Completions upstream. Useful for pointing other Responses-only clients at a
Chat-only server.

## Model capability tiers

Completing a scan requires a frontier-class model — Kimi K2.6,
Qwen3.8-Max, GLM-5.x, or comparable. The scan contract (sustained
multi-turn tool use, artifact generation, manifest completion) is beyond
smaller models: they run the agentic loop correctly but typically stop
before writing findings. The gateway exposes everything from 4B GGUF to
1.5TB MoE, and `codex-security` will try whatever model you pass — expect
incomplete scans below frontier class.

## Limitations

- Streaming only (the Codex CLI always streams).
- Responses request fields with no Chat Completions equivalent (`reasoning`,
  `text.format`, built-in web/file tools) are dropped; `instructions` and
  `developer` messages map to system messages.
- Upstream errors are forwarded verbatim when they are JSON, so status-based
  classification (rate limit, unauthorized) keeps working.
