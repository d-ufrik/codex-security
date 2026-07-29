# Codex Security: Codebase Analysis

This is a **security scanning platform** that integrates with AI code analysis (Codex) to detect and remediate security vulnerabilities. It features a three-layer architecture:

## Core Architecture

| Layer | Technology | Purpose |
|-------|------------|---------|
| **CLI/SDK** | TypeScript 5.7.3, Node 22+ | User interface, scan orchestration, authentication |
| **Plugin** | Python 3.10+ | Workbench database, report generation, finalization |
| **Container** | Docker (node:22-bookworm-slim) | Hardened deployment for bulk scanning |

## Key Components

### TypeScript SDK (`sdk/typescript/src/`)

- `api.ts`: Core scan orchestration with lifecycle management and runtime isolation
- `cli.ts`: Full CLI with 15+ commands (scan, bulk-scan, export, validate, patch)
- `runtime.ts`: Plugin bootstrap, ZIP safety, runtime isolation
- `cost.ts`: Cost tracking per model ($5K-$30K per token tier)

### Python Plugin (`sdk/typescript/_bundled_plugin/scripts/`)

- `workbench_db.py`: SQLite database with file locking (3,730 lines)
- `finalize_scan_contract.py`: Scan finalization and SARIF export (91KB)
- `deep_scan_workbench.py`: Deep scan orchestration (62KB)

### Docker Hardening

- Non-root user (UID 10001)
- Seccomp profile with ~300 allowed syscalls
- Host-scoped Git credentials only
- Bubblewrap for nested namespaces

## Security Features

✅ **Runtime Isolation**: Creates isolated `CODEX_HOME` directories  
✅ **ZIP Validation**: CRC-32, entry limits (4,096), size caps (512MB), symlink rejection  
✅ **Output Safety**: Model-safe path validation, private directory enforcement  
✅ **Auth Import**: Ambient auth copied with temp file + rename pattern  
✅ **Cost Enforcement**: Polling abort on limit exceeded  
✅ **Target Validation**: Paths must be within repo, Git env variables stripped  

## Notable Patterns

- **Dependency Injection**: `CodexSecurity` accepts `ClientDependencies` interface
- **Abort Signal Propagation**: All async operations respect signals
- **Deterministic Disposal**: Implements `Symbol.asyncDispose`
- **Resumable Bulk Scans**: JSONL ledger with per-task receipts
- **Contract Validation**: Requires scan-manifest, findings, coverage, report

## Potential Concerns

1. **Monolithic Python scripts** (3,730-line workbench_db.py) - consider modularization
2. **No explicit rate limiting** - relies on Codex's retry logic
3. **Hardcoded model pricing** - requires code changes for new models
4. **Session file polling** - could use filesystem events instead of 100ms polling
5. **Python plugin security** - executes with full filesystem access, no sandboxing beyond Docker

## Entry Points

- CLI: `sdk/typescript/bin/codex-security.mjs`
- SDK: `sdk/typescript/dist/index.js`
- Docker entrypoint: `docker/entrypoint.sh`
- MCP server: `sdk/typescript/_bundled_plugin/mcp/server.mjs`
