# Codex Security: Aether Desktop / Custom Provider Integration — Implementation Plan (v2)

> Supersedes v1 (2026-07-28). v1 was written from static analysis and got the
> core assumption wrong. This revision is based on live verification against
> `@openai/codex` 0.144.6 (the exact binary bundled by this package) and
> Aether Desktop at `http://127.0.0.1:8183/v1`.
>
> Prior docs (`ANALYSIS.md`, `LLM_AND_AUTH_ANALYSIS.md`, `LESSONS_LEARNED.md`)
> remain valid as codebase descriptions, except the claim "the API endpoint is
> hardcoded in the SDK" — it is false (see Finding 1).

## Executive Summary

Goal: run codex-security scans against any model behind Aether Desktop — the
self-hosted OpenAI-compatible gateway at `http://127.0.0.1:8183/v1`, which
routes to local inference servers (llama.cpp, MLX) and large hosted models
alike (GLM 5.2, Kimi K2.6/K3, Nemotron Ultra 550B, ~100 models total) — with
ergonomics comparable to opencode/pi (define a provider once, reference it by
name). opencode already uses this exact endpoint via its `aether-desktop`
provider block.

The integration is feasible and much smaller than v1 assumed. The Codex CLI
already implements named custom providers (`model_providers` in config.toml —
the same pattern opencode and pi use). Two real obstacles exist, both verified:

1. **Wire-API mismatch.** Codex 0.144.6 removed `wire_api = "chat"` (hard
   error). It only speaks the OpenAI **Responses API** (`POST /v1/responses`,
   SSE, must end with `response.completed`). Aether Desktop exposes
   **Chat Completions**. A thin translation shim bridges them — prototype
   proven end-to-end, including agentic tool calls.
2. **Credential gate.** `api.ts` throws `AuthenticationRequiredError` before
   every scan unless an OpenAI API key or stored ChatGPT login exists, even
   when a custom provider handles its own auth via `env_key`. This gate must
   be relaxed when a non-default `model_provider` is configured.

Everything else in v1 (new `environment.ts`, `LOCAL_MODEL_ENABLED`,
`--local-model` flag, SSRF validation layer, opencode/pi config edits,
10-week rollout) is unnecessary and dropped.

---

## Verified Feasibility Findings

All tested against `node_modules/@openai/codex/bin/codex.js` (0.144.6, the
version pinned in `package.json`) with an isolated `CODEX_HOME`.

### Finding 1 — The SDK already exposes everything needed

`@openai/codex-sdk` `CodexOptions` (`dist/index.d.ts:216`):

```typescript
type CodexOptions = {
  codexPathOverride?: string;
  baseUrl?: string;      // -> --config openai_base_url=...
  apiKey?: string;       // -> CODEX_API_KEY env
  config?: CodexConfigObject;  // -> flattened to --config dot.path=value
  env?: Record<string, string>;
};
```

The SDK spawns `codex exec --experimental-json` and flattens nested `config`
objects into dotted `--config` overrides (TOML literals). No SDK
modification is required for custom endpoints. `api.ts:656` already passes
`config` and `env` through `createCodex`.

### Finding 2 — Codex CLI supports named providers natively

Verified live. This config, passed exactly as the SDK would pass it:

```
--config model="local-llama"
--config model_provider="aether"
--config model_providers.aether.name="Aether Desktop"     # required field
--config model_providers.aether.base_url="http://127.0.0.1:PORT/v1"
--config model_providers.aether.wire_api="responses"
--config model_providers.aether.env_key="SHIM_KEY"
```

produced `provider: aether` in the run banner and sent
`Authorization: Bearer $SHIM_KEY` to the configured base URL. This is the
same named-provider pattern opencode uses (`provider.aether.options.baseURL`
in `opencode.jsonc`) and pi uses (`pi.registerProvider(id, { baseUrl,
apiKey: "$ENV" })`). We surface an existing mechanism, not a new one.

### Finding 3 — `wire_api = "chat"` is removed (the real problem)

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
```

Omitting `wire_api` defaults to `responses`. Therefore any chat-completions
backend (Aether Desktop, llama-server, ollama, vLLM) needs a
Responses→Chat translation layer. Verified request shape:

- `POST /v1/responses` with `stream: true` (streaming is mandatory;
  non-streaming responses fail with "stream closed before
  response.completed")
- SSE stream must include `response.created` … `response.output_text.delta`
  … `response.completed` events
- Agent turns send the full conversation as `input` items
  (`message`, `function_call`, `function_call_output`) — no
  `previous_response_id` statefulness

### Finding 4 — Shim proven end-to-end against Aether Desktop

Prototype: `/tmp/responses-shim.mjs` (~250 lines, Node, zero dependencies).
Translates `/v1/responses` SSE ↔ `/v1/chat/completions` SSE, including
function-call deltas, tool outputs, and usage mapping. Strips
`reasoning.effort` (chat backends don't accept it; Aether thinking models
reason natively).

Test 1 — text round-trip:

```
codex exec ... "Reply with exactly one word: ok"
→ codex
  ok
  tokens used 9,036
```

Test 2 — agentic tool-call round-trip (the load-bearing case for scans):

```
codex exec --sandbox danger-full-access ...
  "Run this exact shell command and report its output: echo shim-tool-call-works"
→ shell tool call translated, executed locally, output streamed back:
  shim-tool-call-works
  Command exited with code 0.
  tokens used 18,190
```

Aether Desktop side: standard chat-completions, Bearer `sk-aether-*` key,
model ids as served by `GET /v1/models` (e.g. `local-llama`, `qwen3.6-mtp`).

### Finding 5 — The credential gate is the only code blocker in this repo

`api.ts` (~line 411), inside the scan path:

```typescript
if (!runtime.credentialsAvailable) {
  throw new AuthenticationRequiredError(
    "No credentials were found. Run 'codex-security login', ...",
  );
}
```

`credentialsAvailable` is only set by importing stored ChatGPT credentials or
by `persistApiKey` (OPENAI_API_KEY/CODEX_API_KEY). With a custom
`model_provider` + `env_key`, the Codex CLI authenticates itself and needs
neither — verified: the test runs above used an isolated `CODEX_HOME` with no
OpenAI credentials at all. This gate must be skipped when the merged scan
config sets `model_provider` to something other than the default.

### Finding 6 — Existing config plumbing already allows provider keys

`config.ts` validation forbids only `plugins`, `marketplaces`,
`features.plugins`, `agents.max_threads`, and disabling
`features.multi_agent_v2.enabled`. `model_provider` and `model_providers.*`
pass validation today. The `--codex` parser (`cli.ts:2695`) already supports
dotted nested keys with TOML literals. So this already works with zero code
changes (given a responses-capable endpoint and existing OpenAI creds):

```bash
codex-security scan . \
  --model local-llama \
  --codex 'model_provider="aether"' \
  --codex 'model_providers.aether.name="Aether Desktop"' \
  --codex 'model_providers.aether.base_url="http://127.0.0.1:18090/v1"' \
  --codex 'model_providers.aether.wire_api="responses"' \
  --codex 'model_providers.aether.env_key="AETHER_API_KEY"'
```

The work below is about removing the "given" clauses: no OpenAI creds
requirement, no manual shim, no six-flag incantation.

### Finding 7 — Cost tracking degrades gracefully

`cost.ts:323`: `estimateScanCost` returns `null` for models without pricing
entries. Local scans report no cost; `--max-cost` enforcement becomes a
no-op. No change needed; document it.

---

## Revised Architecture

```
codex-security scan . --provider aether --model local-llama
        │
        ▼
┌──────────────────────────────────────────────────┐
│ codex-security (this repo)                       │
│  - merges provider def into isolated config.toml │
│  - skips OpenAI credential gate for custom       │
│    providers                                     │
│  - auto-starts shim (in-process)                 │
└──────────────────────────────────────────────────┘
        │ spawn: codex exec --config model_provider=...
        ▼
┌──────────────────────────────────────────────────┐
│ Codex CLI 0.144.6 (bundled, unmodified)          │
│  POST /v1/responses (SSE)  Bearer $AETHER_API_KEY│
└──────────────────────────────────────────────────┘
        │ 127.0.0.1:<ephemeral>
        ▼
┌──────────────────────────────────────────────────┐
│ Responses→Chat shim (new, ~300 LOC, zero-dep)    │
│  responses SSE ⇄ chat/completions SSE            │
│  function calls ⇄ tool_calls, usage mapping      │
└──────────────────────────────────────────────────┘
        │ http://127.0.0.1:8183/v1
        ▼
┌──────────────────────────────────────────────────┐
│ Aether Desktop (OpenAI-compatible proxy)         │
│  chat/completions → local / remote backends      │
└──────────────────────────────────────────────────┘
```

### Component 1 — Responses→Chat shim

Productionize the proven prototype as
`sdk/typescript/src/responses-shim.ts`:

- Node `http` server, zero runtime dependencies (matches repo style)
- `127.0.0.1`-only bind, ephemeral port, started in-process by the SDK
  before spawning codex, torn down on `close()`
- Translates: `input` items ⇄ chat messages, responses function tools ⇄
  chat tools, `function_call`/`function_call_output` ⇄ `tool_calls`/`role:
  tool`, streaming deltas both directions, `usage` mapping
- Strips unsupported request fields (`reasoning`, `include_reasoning`,
  non-function tools); forwards `max_output_tokens` → `max_tokens`
- Surfaces upstream errors as responses-format error events so codex's
  retry/reconnect logic sees sane classifications
- Also runnable standalone for debugging:
  `codex-security serve-local --upstream http://127.0.0.1:8183/v1 --port 18090`

Out of scope: image inputs (scans don't use them through this path),
`previous_response_id` (codex exec sends full input per turn — verified).

### Component 2 — Credential gate relaxation

In `api.ts`, compute whether the merged scan config selects a custom
provider (`model_provider` present and not `"openai"`). If so, skip the
`credentialsAvailable` requirement and the `persistApiKey`/ambient-import
steps. The provider's `env_key` variable is the credential; validate only
that the referenced env var is set, with a clear error naming it.

`scanAuthentication` reporting should show e.g.
`method: "provider_env_key", source: "AETHER_API_KEY"` so progress output
stays honest.

### Component 3 — Provider ergonomics (the opencode/pi parity layer)

Named providers, defined once, referenced by name — mirroring
`opencode.jsonc`'s `provider` block and pi's `registerProvider`:

1. **Inherit from ambient `~/.codex/config.toml`.** Codex CLI users already
   define `[model_providers.*]` there (ollama etc. recipes from codex docs).
   `runtime.ts` currently builds the isolated `CODEX_HOME` config from
   scratch; merge the ambient file's `model_providers` table (and only that
   table) into the generated config.
2. **`--provider <name>` scan flag.** Selects `model_provider = <name>`;
   errors with the list of known providers if undefined.
3. **Ad-hoc definition without config files:**
   `--provider aether --base-url http://127.0.0.1:8183/v1 --api-key-env AETHER_API_KEY`
   synthesizes the `model_providers.aether` block. `wire_api` stays
   `responses` + shim always (chat is the only thing Aether/llama-server
   speak; responses endpoints can opt out of the shim later via
   `--codex 'model_providers.X.request_max_retries=...'`-style passthrough —
   decide if ever needed).

Resulting UX:

```bash
export AETHER_API_KEY=sk-aether-...
codex-security scan . --provider aether --model local-llama
```

vs. opencode's `"model": "aether-desktop/local-llama"` — same shape:
provider named once, model referenced by id.

### Component 4 — No automatic model tuning

Deliberately dropped from v2 (was in v1-draft form here): the integration
must not infer model capability from provider choice. Aether is a single
provider spanning 4B GGUF quants and 1.5TB-parameter MoE models; any
"custom provider → downgrade defaults" heuristic would penalize
frontier-class models to accommodate small ones. All existing knobs stay
user-controlled and already work:

```bash
# small local model: reduce concurrency/effort
codex-security scan . --provider aether --model local-llama \
  --codex 'model_reasoning_effort="low"' \
  --codex 'features.multi_agent_v2.max_concurrent_threads_per_session=1'

# large hosted model: keep defaults, or push harder
codex-security scan . --provider aether --model nvidia__z-ai_glm-5.2
```

`docs/LOCAL_MODEL_SETUP.md` documents recommended overrides per model tier
instead of applying them silently.

---

## Implementation Phases

### Phase 1 — Shim (2–3 days)

- `src/responses-shim.ts` from the proven prototype; unit tests with a mock
  chat backend (reuse the mock server pattern from verification: Node http,
  SSE chunks); test text, tool calls, multi-turn tool output, upstream
  errors, client aborts
- `serve-local` CLI command for standalone use
- Verification: existing prototype test suite passes against the TS
  implementation with Aether Desktop as upstream

### Phase 2 — Wiring (2–3 days)

- Credential gate relaxation in `api.ts` (+ tests: no OpenAI creds +
  custom provider → scan proceeds; missing `env_key` var → clear error)
- Ambient `model_providers` merge in `runtime.ts` (+ tests)
- `--provider` / `--base-url` / `--api-key-env` flags in `cli.ts`
- Shim lifecycle in `api.ts` scan path (start before `createCodex`, inject
  rewritten `base_url`, tear down in `close()`)

### Phase 3 — End-to-end validation + docs (1–2 days)

- Real `codex-security scan` on a small test repo through Aether Desktop
  across model tiers: a large hosted model (`nvidia__z-ai_glm-5.2` or
  `kimi__kimi-k2.6`) expected to complete the full contract
  (manifest/findings/coverage/report), and a small local model
  (`local-llama`) to record where the floor is. Document per-tier results
  as guidance, not as a limitation of the integration
- `docs/LOCAL_MODEL_SETUP.md`: Aether Desktop recipe (primary), generic
  llama-server/ollama recipes (any chat-completions backend works via the
  same shim), per-model-tier tuning recommendations, troubleshooting
- README quick-start paragraph

No beta program, no npm dist-tags, no agent config file edits (opencode/pi
already talk to Aether Desktop directly — nothing to integrate there).

---

## Risks and Open Questions

1. **Shim fidelity.** Codex may send request shapes not yet exercised
   (image items, unusual tool schemas, `include_reasoning`). The prototype
   covers everything observed in real `exec` runs; production adds strict
   passthrough of unknown fields where safe and explicit tests.
2. **Upstream codex churn.** `wire_api = "chat"` landed without a
   deprecation window in our pin range. If codex changes the responses SSE
   contract, the shim breaks. Mitigation: shim integration test runs
   against the pinned bundled binary in CI, so a codex version bump fails
   loudly.
3. **Docker bulk scans.** The shim binds 127.0.0.1 inside the container;
   Aether Desktop lives on the host. Document `host.docker.internal` base
   URL for that setup; entrypoint needs no change.
4. **`--max-cost` no-op for custom-provider models.** By design
   (Finding 7); documented.

Note (not a risk): scan quality tracks the selected model, as it does with
any provider. The gateway fronts everything from 4B quants to 1.5TB MoE
models; choosing the model is the user's decision, and the existing
`--codex` knobs cover per-model tuning. Phase 3 documents tier-by-tier
results as guidance.

---

## Appendix: Verification Evidence Log

```text
# 1. chat wire_api rejected (0.144.6)
Error loading config.toml: `wire_api = "chat"` is no longer supported.

# 2. responses wire_api + env_key auth, request observed at mock upstream
POST /v1/responses  auth: Bearer mock-secret-key  stream: true

# 3. text round-trip via shim -> Aether Desktop -> local-llama
codex → "ok" (9,036 tokens)

# 4. tool-call round-trip via shim -> Aether Desktop -> local-llama
shell: echo shim-tool-call-works → exit 0, output returned (18,190 tokens)
```

Prototype kept at `/tmp/responses-shim.mjs` until Phase 1 lands it in
`src/responses-shim.ts`.

Note for test scripts and docs: macOS has no `timeout(1)` (this machine has
Homebrew's); use `curl --max-time`, Node timers, or `perl -e alarm` in
anything committed.

*Plan v2 written 2026-07-28 from live verification, replacing v1's
unverified assumptions.*
