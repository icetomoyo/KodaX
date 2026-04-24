# KodaX Prefix Rename Codemod (FEATURE_086 子任务 A)

> **Status**: ⚠️ **Design review pending** — rename map checked in but codemod **not yet executed**. Do not run until the `rename-map.ts` decisions below are approved.

## Goal

Remove the `KodaX*` prefix from ~190 generic type/interface/class identifiers across the monorepo to match SDK convention (`Agent`, `Tool`, `Session`, `Message`, etc.), while keeping the prefix on brand-identity symbols (`KodaXError`, `KodaXClient`, `KodaXOptions`, `KodaXEvents`).

## Why "map first, codemod later"

The AST rewrite is mechanical — 95% of the work is *deciding what each identifier should be called*. That decision is **not** recoverable once a codemod ships:
- External consumers depend on the exported names
- v0.7.27 is a hard switch (no `@deprecated` aliases per user decision)
- Getting the map wrong ships a permanent mistake

So this PR commits only the design artifact (`rename-map.ts`). Codemod execution is a separate PR.

## Files in this directory

- `rename-map.ts` — the canonical mapping of all 190 `KodaX*` identifiers to their new names (or explicit `KEEP` / `INTERNALIZE` / `MERGE` decisions)
- `codemod.mjs` *(not yet written — comes in the execution PR)*
- This README

## Rename categories

Drawn from `docs/features/v0.7.27.md` § FEATURE_086 子任务 A:

| Category       | Decision                                      | Examples                                      |
| -------------- | --------------------------------------------- | --------------------------------------------- |
| `KEEP`         | Retain `KodaX` prefix (brand / error chain)   | `KodaXError`, `KodaXClient`, `KodaXOptions`   |
| `DROP`         | Drop prefix (generic primitive)               | `KodaXMessage` → `Message`                    |
| `INTERNALIZE`  | Stop exporting (was accidentally public)      | `KodaXAmaControllerDecision`                  |
| `MERGE`        | Collapse into a different existing type       | `KodaXToolDefinition` → merged into `Tool`    |
| `REMOVE`       | Delete entirely (replaced by new composition) | `KodaXSessionLineage` → `Session` + `LineageExtension` |

## Execution checklist (for the future PR)

1. Read `rename-map.ts`; reject if any decision feels off
2. Write `codemod.mjs` using ts-morph to:
   - Rename identifiers per the map in all `.ts` / `.tsx` files
   - Update all import/export statements
   - Preserve JSDoc
3. Run the codemod on a dedicated branch
4. `npm run build && npm run test` must pass **first time** — any failures mean the codemod is incomplete, not that the map is wrong
5. Spot-check 10+ diff'd files by eye to confirm only identifiers changed (no semantic rewrites)
6. Publish `@kodax/codemod` npm package + `docs/MIGRATION_0.7.27.md` simultaneously with release
