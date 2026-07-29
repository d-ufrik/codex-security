# Codex Security: LLM, Authentication, and Model Configuration Analysis

## Executive Summary

This document details how the `codex-security` project handles LLM selection, API endpoint configuration, authentication mechanisms, and user model customization capabilities.

---

## 1. LLM Models Used

### Default Model

**Primary model**: `gpt-5.6-sol` (line 26 in `config.ts`)

```typescript
export const DEFAULT_CODEX_CONFIG: Readonly<JsonObject> = {
  cli_auth_credentials_store: "file",
  model: "gpt-5.6-sol",        // ← Default model
  model_reasoning_effort: "xhigh", // ← Default reasoning effort
  features: {
    plugins: true,
    goals: true,
    multi_agent_v2: {
      enabled: true,
      max_concurrent_threads_per_session: 9,
    },
  },
};
```

### Supported Models

From the cost tracking and pricing tables in `cost.ts`:

| Model | Input Cost | Cached Input | Cache Write | Output Cost |
|-------|------------|--------------|-------------|-------------|
| `gpt-5.6` | $5K | $500 | $6.25K | $30K |
| `gpt-5.6-sol` | $5K | $500 | $6.25K | $30K |
| `gpt-5.6-terra` | $2.5K | $250 | $3.125K | $15K |
| `gpt-5.6-luna` | $1K | $100 | $1.25K | $6K |

**Note**: The system uses OpenAI's standard API pricing. New models require code changes to add pricing entries.

---

## 2. API Endpoint Configuration

### No Explicit Base URL Configuration

The project **does not expose** an environment variable or configuration option to change the API endpoint/base URL.

The Codex SDK (`@openai/codex-sdk`) is imported and used with default options:

```typescript
// api.ts, line 207
const DEFAULT_DEPENDENCIES: ClientDependencies = {
  createCodex: (options) => new Codex(options),
  environment: process.env,
};
```

The SDK itself likely defaults to OpenAI's standard endpoints. There is no `OPENAI_BASE_URL` or similar configuration in the codebase.

### Environment Variables That Affect API Calls

The following environment variables are recognized but do not change the endpoint:

- `CODEX_HOME`: Determines where credentials and state are stored (line 108 in `runtime.ts`)
- `CODEX_SECURITY_STATE_DIR`: Overrides the state directory for the workbench database
- `OPENAI_API_KEY` / `CODEX_API_KEY`: Provide API keys for authentication
- `PYTHON`: Used to locate Python interpreter in Docker

---

## 3. API Key Setup and Authentication

### Three Authentication Methods

The system supports three authentication modes (line 140 in `api.ts`):

```typescript
export type ScanAuthMode = "auto" | "chatgpt" | "api-key";
```

#### 1. API Key via Environment Variable (CI/Noninteractive)

Set one of these environment variables:

- `OPENAI_API_KEY`
- `CODEX_API_KEY`

**Priority**: If both are set, the first found is used (line 1494 in `api.ts`):

```typescript
for (const requested of ["OPENAI_API_KEY", "CODEX_API_KEY"] as const) {
  const canonical = environment[requested]?.trim();
  if (canonical) return { source: requested, value: canonical };
  // ...
}
```

**Usage in CI**:
```bash
# Method 1: Export then scan
export OPENAI_API_KEY="sk-..."
npx codex-security scan .

# Method 2: One-liner
printenv OPENAI_API_KEY | npx codex-security login --with-api-key
```

#### 2. Interactive Login (ChatGPT)

For local development, sign in interactively:

```bash
npx codex-security login
npx codex-security login --device-auth  # For headless machines
```

Credentials are stored file-based in the Codex home directory.

#### 3. Explicit Selection via `--auth`

When both a stored ChatGPT sign-in **and** an environment API key exist, the system can be forced to use one or the other:

- `--auth chatgpt`: Uses stored credentials, ignores API keys
- `--auth api-key`: Requires an environment API key

**Default behavior** (`--auth auto`): Environment API key takes precedence over stored credentials in noninteractive scans.

### Authentication Flow

The `CodexSecurity` class handles authentication (line 213 in `api.ts`):

```typescript
export class CodexSecurity {
  readonly #dependencies: ClientDependencies;
  readonly #runtimeCredentialSource: "api_key" | "stored_credentials" | null = null;
```

The credential source is determined during runtime preparation and reported in progress output.

---

## 4. User Model Configuration

### Can Users Override Models? **Yes.**

Users have multiple ways to override the default model.

#### Method 1: CLI Flag `--model` (Recommended)

The `scan` command accepts a `--model` option (line 889 in `cli.ts`):

```bash
npx codex-security scan . --model gpt-5.6-terra
```

This is the cleanest way to override the model for a single scan.

#### Method 2: `--codex` Override

Users can pass arbitrary Codex configuration overrides via `--codex KEY=VALUE` (line 905 in `cli.ts`):

```bash
# Override both model and reasoning effort
npx codex-security scan . \
  --codex 'model="gpt-5.6-sol"' \
  --codex 'model_reasoning_effort="high"'
```

The `--codex` flag allows any valid TOML value and supports nested keys:

```bash
npx codex-security scan . --codex 'features.multi_agent_v2.enabled=true'
```

#### Method 3: Configuration Files

Advanced users can create a Codex configuration file (TOML) and load it via the SDK. However, the CLI does not expose a direct `--config` flag. Instead, the SDK allows passing a `CodexSecurityConfig` object on construction:

```typescript
import { CodexSecurity } from "@openai/codex-security";

const security = new CodexSecurity({
  codexOverrides: {
    model: "gpt-5.6-luna",
    model_reasoning_effort: "medium"
  }
});
```

### Model Configuration Validation

The `scanModelConfiguration` function validates that the model is a non-empty string (line 40 in `config.ts`):

```typescript
export function scanModelConfiguration(
  config: Readonly<JsonObject>,
): ScanModelConfiguration {
  const model = config["model"];
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ConfigurationError(
      "The configured Codex model must be a nonempty string.",
    );
  }
  // ...
}
```

### Can Users Disable the Multi-Agent V2 Feature? **No.**

The system enforces that `features.multi_agent_v2.enabled` must remain `true` (line 194 in `config.ts`):

```typescript
if ("enabled" in multiAgentV2 && multiAgentV2["enabled"] !== true) {
  throw new ConfigurationError(
    "The selected Codex Security plugin requires native multi-agent v2; " +
      "features.multi_agent_v2.enabled cannot be disabled.",
  );
}
```

This is a **hard lock** to ensure compatibility with the bundled plugin.

---

## 5. How `--codex` Overrides Are Parsed

The `parseCodexOverrides` function (line 2695 in `cli.ts`) transforms CLI arguments into nested configuration objects.

### Syntax

- Format: `KEY=VALUE`
- Keys can be dot-separated for nesting: `model_reasoning_effort="high"` or `features.multi_agent_v2.enabled=true`
- Values are parsed as TOML literals

### Example

```bash
--codex 'model="gpt-5.6-sol"' \
--codex 'features.multi_agent_v2.max_concurrent_threads_per_session=5'
```

Becomes:
```json
{
  "model": "gpt-5.6-sol",
  "features": {
    "multi_agent_v2": {
      "max_concurrent_threads_per_session": 5
    }
  }
}
```

### Security Constraints

The parser enforces several limits (lines 2709-2726):

- **Key length**: Max 1,024 bytes
- **Value length**: Max 64 KB
- **Depth**: Max 64 nested levels
- **Forbidden keys**: `__proto__`, `prototype`, `constructor` (prototype pollution protection)

---

## 6. Configuration Validation and Locks

The system validates user overrides against a set of rules to prevent breaking the plugin:

### Forbidden Overrides

1. **Plugin loading** cannot be overridden (line 124 in `config.ts`)
   ```typescript
   if ("plugins" in overrides || "marketplaces" in overrides) {
     throw new ConfigurationError("Codex Security owns plugin loading configuration.");
   }
   ```

2. **Multi-agent v2** must remain enabled (line 194 in `config.ts`)

3. **Legacy agents.max_threads** is rejected (line 171-176)
   ```typescript
   if (isObject(agents) && "max_threads" in agents) {
     throw new ConfigurationError(
       "The selected Codex Security plugin requires native multi-agent v2; " +
         "agents.max_threads is a legacy v1 setting..."
     );
   }
   ```

### Allowed Overrides

Users can override any other configuration, including:

- `model` and `model_reasoning_effort`
- `features.goals`
- `features.multi_agent_v2.max_concurrent_threads_per_session`
- Any other top-level or nested keys that don't conflict with the plugin's requirements

---

## 7. Key Findings Summary

| Aspect | Configuration Method | Can User Override? |
|--------|---------------------|-------------------|
| **Default Model** | `gpt-5.6-sol` (config.ts:26) | ✅ Yes, via `--model` or `--codex` |
| **Reasoning Effort** | `xhigh` (config.ts:27) | ✅ Yes, via `--codex model_reasoning_effort=...` |
| **API Endpoint** | Hardcoded in SDK | ❌ No |
| **API Key Source** | Env var or login | ✅ Yes, choose between `OPENAI_API_KEY` or `CODEX_API_KEY` |
| **Auth Mode** | `auto` (default) | ✅ Yes, via `--auth chatgpt` or `--auth api-key` |
| **Multi-Agent V2** | Enabled by default | ❌ No, must be `true` |
| **Plugin Loading** | Managed internally | ❌ No, forbidden |
| **Cost Limits** | `--max-cost USD` | ✅ Yes, via CLI flag |

---

## 8. Recommendations for Users

1. **For CI**: Set `OPENAI_API_KEY` and use `--auth api-key` to ensure consistent behavior.
2. **For quick tests**: Use `--model gpt-5.6-terra` to reduce costs.
3. **For custom configurations**: Use `--codex` for any Codex settings beyond model selection.
4. **For advanced use**: Construct the `CodexSecurity` client with a `CodexSecurityConfig` object to set defaults programmatically.

---

## 9. References

- **Default config**: `sdk/typescript/src/config.ts:24-36`
- **CLI model flag**: `sdk/typescript/src/cli.ts:889-891`
- **Authentication modes**: `sdk/typescript/src/api.ts:140-156`
- **API key handling**: `sdk/typescript/src/auth.ts:185-201`
- **Codex overrides parser**: `sdk/typescript/src/cli.ts:2695-2757`
- **Configuration locks**: `sdk/typescript/src/config.ts:169-231`

---

*Document generated from codebase analysis. All line references correspond to the analyzed repository state.*
