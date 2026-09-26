# F01 / F02 history repair evidence

Date: 2026-09-26. Starting HEAD: `6e5d6298`. No paid model or original user Session was used. These tests use isolated storage fixtures and a real named-pipe Host reached through the public `@kodax-ai/kodax/client` entry point.

## Changes and boundaries

- F01: Decode each independently encoded base64 chunk into bytes, concatenate those bytes, then decode UTF-8 and JSON once. Host chunk sizes, read limits, errors and cursors are unchanged.
- F02: The existing REPL restoration helper accepts `historyScope: 'all'` for canonical history projection. Its default still retains the live 150-item / 50-round window, and persisted UI snapshots remain bounded. This is an optional parameter on the existing REPL helper, not a new Product Client method, setting or protocol field.
- Canonical history text/thinking retains the existing `outputId`, `outputState: 'committed'` and `textRevision: 0` fields. History item IDs still use their own revision / entry / ordinal namespace. A source output ID may own multiple blocks and does not make history and observation item IDs interchangeable.

## Red / green sequence

1. The first public IPC test reads a 300 KiB assistant from a history page, the oversized entry reference and a search reference. Before the fix, page projection rejects with `internal_error` (`f01-red.txt`). Byte assembly makes the test pass (`f01-green.txt`).
2. A single canonical assistant message with 80 alternating thinking/text pairs is expected to return 160 ordered items and permit full reads through every item reference. Before the fix it returns 150 (`f02-red.txt`). Complete canonical projection passes along with 36 pre-existing helper tests (`f02-green.txt`).
3. The same block test additionally requires canonical source metadata for all 160 blocks. Missing metadata fails (`source-red.txt`); retaining existing fields passes (`source-green.txt`).

## Final regression

Command:

```powershell
npx vitest run src/sdk-client.history-boundaries.test.ts src/sdk-client.history.test.ts src/sdk-client.observe-history.test.ts packages/repl/src/ui/utils/restore-history.test.ts --maxWorkers=1
```

Result: **4 files, 61 tests passed** (`regression-green.txt`). This combines public IPC behavior and helper unit tests; it is not 61 end-to-end tests.

`npx tsc -p tsconfig.test.json --pretty false` completed without diagnostics. `git diff --check` passed for the changed history production and helper test files.

New cases cover ASCII bodies below / at / above 256 KiB, UTF-8 Chinese and emoji spanning three encoded chunks, bounded page previews with complete item / oversized / search reads, 160 ordered thinking/text blocks and every ordinal, and 80 interleaved tool/text pairs with complete parameters and success/error/cancelled results paired across separate canonical pages. Helper controls preserve both live bounds while full history keeps all canonical items.

Existing tests cover history cursor invalidation, whole-history search, accepted input identity, output ownership, archive / compaction / branch changes and persisted UI recovery. No old snapshot lease, arbitrary cross-revision reads, new public block ordinal, or transport streaming guarantee is introduced. Oversized entries are still assembled under the existing finite chunk budget; a history entry may legitimately project to more than 150 items.
