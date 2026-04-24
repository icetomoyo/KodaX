# Migrating to KodaX v0.7.27

> **Status**: DRAFT — rename map committed for review. Concrete examples will land in the codemod execution PR.

v0.7.27 is the **structural hygiene** release at the tail of the SDK-basement arc. It performs two mechanical-but-breaking cleanups:

- **FEATURE_086 子任务 A — Prefix rename**: ~190 generic `KodaX*` types/classes lose the `KodaX` prefix (`KodaXMessage` → `Message`, `KodaXToolExecutionContext` → `ToolExecutionContext`, …). Brand-identity symbols are kept (`KodaXError`, `KodaXClient`, `KodaXOptions`, `KodaXEvents`).
- **FEATURE_086 子任务 B — Legacy delete**: removes `/project` surface, `--team` flag, `compactMessages()`, and the YAML-helper duplication. Covered by commits `e428110..c24128f`.
- **FEATURE_091 — Protocol extraction**: `@kodax/repointel-protocol` becomes its own package. Consumers of the daemon-bridge RPC contract should migrate imports from `@kodax/coding/.../premium-contract` to `@kodax/repointel-protocol`. (Internal shim removed — if you imported a relative path, switch.)

This is a **hard switch**: no `@deprecated` type aliases ship alongside v0.7.27. Either your code runs through the codemod, or you stay on v0.7.26.

---

## 1. Upgrade pathway

1. **Pin v0.7.26** and make sure your test suite is green there.
2. **Run the codemod** (once published):
   ```bash
   npx @kodax/codemod rename-to-0.7.27 ./src
   ```
3. **Bump `@kodax/*` dependencies** to `0.7.27`.
4. `npm run build && npm run test` — must pass first time. Any remaining red is a codemod bug; file an issue with the failing file pair.
5. Spot-check 5-10 diff'd files to confirm only identifiers changed.

---

## 2. Rename decisions (summary)

Full canonical map: [`scripts/codemod/rename-kodax-prefix/rename-map.ts`](../scripts/codemod/rename-kodax-prefix/rename-map.ts).

| Category       | Count | Examples                                                                 |
| -------------- | ----- | ------------------------------------------------------------------------ |
| `KEEP` (brand) |    11 | `KodaXError`, `KodaXClient`, `KodaXOptions`, `KodaXEvents`, 7 error subclasses |
| `DROP` (rename)|   176 | `KodaXMessage` → `Message`, `KodaXProviderConfig` → `ProviderConfig`, …  |
| `INTERNALIZE`  |     1 | `KodaXAmaControllerDecision` — no longer exported                        |
| `MERGE`        |     1 | `KodaXToolDefinition` collapses into `Tool`                              |
| `REMOVE`       |     1 | `KodaXSessionLineage` — compose `Session` + `LineageExtension` instead   |

Two identifiers drop both the `KodaX` **and** `Session` prefix for uniqueness:
- `KodaXSessionCompactionEntry` → `CompactionEntry` (not `SessionCompactionEntry`)

---

## 3. Import path changes (non-rename)

### 3.1 `@kodax/repointel-protocol` extraction

Before (v0.7.26):
```ts
import { RepointelRpcRequest } from '@kodax/coding'; // top-level re-export
// or, from inside the monorepo:
import { REPOINTEL_CONTRACT_VERSION } from './premium-contract.js';
```

After (v0.7.27):
```ts
import type { RepointelRpcRequest } from '@kodax/repointel-protocol';
import { REPOINTEL_CONTRACT_VERSION } from '@kodax/repointel-protocol';
```

`REPOINTEL_DEFAULT_ENDPOINT` remains available from `@kodax/coding` for backwards compatibility with downstream bundles that pull the whole coding package.

### 3.2 `/project` command removed

If you used `--init`, `--auto-continue`, `--append`, `--overwrite`, `--max-sessions`, or `--max-hours`, switch to AMA:
- `--agent-mode ama` for scout-first planning (replaces `/project`)
- `--agent-mode sa` for single-agent mode

### 3.3 `--team` CLI flag removed

Use `--agent-mode ama|sa` (stable since v0.7.10).

### 3.4 `compactMessages()` removed

The unified normalize pipeline from FEATURE_079 replaces the old compaction helper. No direct consumer action needed if you only used the public AMA entry points.

---

## 4. Common upgrade errors

*To be populated after codemod execution; expected categories:*
- Identifier not found (old name retained somewhere the codemod missed)
- Import path still pointing at deleted module
- Type mismatch where `KodaXSessionLineage` was destructured

---

## 5. Getting help

- Issue tracker: https://github.com/icetomoyo/KodaX/issues
- Tag issues with `v0.7.27-migration`
