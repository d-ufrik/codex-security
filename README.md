# Codex Security

`@openai/codex-security` is a CLI and TypeScript SDK for finding, validating, and fixing security vulnerabilities in your code. Scan repositories, review changes, track findings over time, and run security checks in CI.

**[Documentation](http://learn.chatgpt.com/docs/security/cli)**

## Local and self-hosted models

This fork can run scans against any OpenAI-compatible Chat Completions
endpoint — Aether Desktop, llama-server, ollama, vLLM — instead of OpenAI.
No OpenAI account or API key is needed for such scans.

### Usage

Prerequisite: a running OpenAI-compatible server. If it requires an API
key, export it under a name of your choice — the CLI only ever reads the
variable you point it at:

```bash
export AETHER_API_KEY="sk-aether-..."
```

**Option 1 — define the provider on the command line.** `--provider` names
it; `--base-url` and `--api-key-env` (the _name_ of the env var holding the
key) define it:

```bash
npx codex-security scan . \
  --provider aether \
  --base-url http://127.0.0.1:8183/v1 \
  --api-key-env AETHER_API_KEY \
  --model local-llama
```

**Option 2 — define it once in `~/.codex/config.toml`** (same pattern
opencode and pi use), then select it by name:

```toml
[model_providers.aether]
name = "Aether Desktop"
base_url = "http://127.0.0.1:8183/v1"
wire_api = "responses"
env_key = "AETHER_API_KEY"
```

```bash
npx codex-security scan . --provider aether --model local-llama
```

Ambient provider definitions carry over into scans; command-line
definitions override ambient ones with the same name. Provider _selection_
is always explicit — without `--provider` (or
`--codex model_provider=...`), scans use OpenAI exactly as before.

**Verify first.** Add `--dry-run` to check wiring without spending a scan —
it should report the provider authentication and never ask for OpenAI
credentials:

```bash
npx codex-security scan . --provider aether --dry-run
# authentication:
#   method: model_provider
#   provider: aether
#   source: AETHER_API_KEY
```

**Choosing a model.** Completing a scan requires a frontier-class model —
Kimi K2.6, Qwen3.8-Max, GLM-5.x, or comparable. The multi-phase contract
(sustained multi-turn tool use, artifact generation, manifest completion)
is beyond smaller models: they will run the agentic loop correctly but
typically stop before writing findings. `--model` accepts any model id the
endpoint serves and `codex-security` will try whatever you pass — expect
incomplete scans below frontier class.

### Standalone gateway

`serve-local` runs just the Responses-to-Chat translation gateway, for
pointing other Responses-only clients at a Chat-only server:

```bash
npx codex-security serve-local \
  --upstream http://127.0.0.1:8183/v1 \
  --api-key-env AETHER_API_KEY \
  --port 18080
# serves Responses API (SSE) on http://127.0.0.1:18080/v1/responses
```

### How it differs from the OpenAI flow

- **Authentication.** With a custom provider selected, `OPENAI_API_KEY`
  and ChatGPT sign-in are ignored for that scan; the provider's `env_key`
  variable supplies the key instead.
- **Built-in protocol gateway.** Codex CLI 0.144.6 requires the Responses
  API, which local servers do not serve. `codex-security` starts an
  in-process loopback gateway that translates Responses requests into Chat
  Completions streams — including multi-turn tool-call round-trips — so no
  external proxy is needed. The gateway lives and dies with the scan
  process.
- **Error fidelity.** Upstream errors (rate limit, unauthorized, model not
  found) are forwarded with their original status, so the CLI's usual
  diagnostics still apply.

See [docs/LOCAL_MODEL_SETUP.md](docs/LOCAL_MODEL_SETUP.md) for translation
limitations and per-tier model notes.

## Quick start

Requires Node.js 22 or later, Python 3.10 or later, and access to Codex Security.

```bash
npm install @openai/codex-security
npx codex-security login
npx codex-security scan .
```

For CI, set `OPENAI_API_KEY` instead of signing in.

If both a ChatGPT sign-in and an API key are available, interactive scans ask
which credential to use. CI and other noninteractive scans keep the existing
API-key precedence. Select a credential explicitly when needed:

```bash
npx codex-security scan . --auth chatgpt
npx codex-security scan . --auth api-key
```

To make your ChatGPT sign-in the automatic default, unset any configured API
keys:

```bash
unset OPENAI_API_KEY CODEX_API_KEY
```

Scan history is stored in the Codex Security workbench state directory. If that
directory cannot be written, set `CODEX_SECURITY_STATE_DIR` to a writable
directory outside the repository.

## TypeScript SDK

```ts
import { CodexSecurity } from "@openai/codex-security";

const security = new CodexSecurity();
const result = await security.run(".");

console.log(result.reportPath);
await security.close();
```

For installation, authentication, scan options, and CI setup, see the [official documentation](http://learn.chatgpt.com/docs/security/cli).
