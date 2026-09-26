# Unified Client history contract review evidence

Reviewed HEAD `6e5d6298`, fixed baseline `c447c0f3`. No production code changed.

Both the embedded runtime and a real Windows named-pipe daemon reached through `connectKodaXClient` reproduce the three findings below. Each suite contains six tests: four expected-behavior assertions fail (two cover the same large-entry defect), and two controls pass. Tests seed canonical Session messages using `FileSessionStorage`; the public-daemon suite performs all evaluated reads through `KodaXProductClient`. No LLM/network provider is required. For the append case, the fixture appends canonical messages directly, then uses public `appendNotice` to trigger the normal history refresh; it does not rewind, compact, or replace the selected message.

## Confirmed findings

### P1: Independently padded base64 chunks cannot be concatenated before decoding

- Requirement: `docs/CLIENT_CONTRACT.md:286`: “这些正文须由 readHistoryEntry 读取，不能静默遗漏或用截断预览冒充”; “每个命中包含不透明 itemId，可直接交给 readHistoryEntry 分页读取原文，包括压缩前长正文.” Also `docs/features/v0.7.97.md:295`: “展开或复制大内容要能取得原内容”.
- Defect: `src/client-history.ts:261-263` appends each `chunk.data` and decodes `encoded.join('')` as one base64 string. Host chunk size is 256 KiB (`src/sdk-runtime.ts:3959`); each chunk is separately base64 encoded (`src/sdk-runtime.ts:20788`, prepared conversation path at `8335`). 262144 is not divisible by three, so an intermediate chunk ends in padding. Decoding the concatenation stops at that padding and leaves truncated JSON.
- Reproducer: one canonical assistant message with outputId `large` and `NEEDLE` plus 300 KiB ASCII text. `sessions.readHistory` rejects with `internal_error` because projection eagerly assembles oversized entries; `searchHistory('NEEDLE')` finds the message but `readHistoryEntry(hit.itemId)` rejects with the same error. No stale revision or concurrent write occurs.
- Public outcome: whole history page unavailable, and an otherwise valid search reference cannot retrieve its full body. Fix direction is decode each base64 chunk to bytes, concatenate bytes, then decode UTF-8/JSON; do not independently decode UTF-8 chunks because code points may straddle boundaries.

### P2: Single-message history projection silently drops blocks above the view window

- Requirement: `docs/features/v0.7.97.md:271`: “消息内容块保序”; `:295`: “分页和内容引用必须承接原有展开历史、搜索、定位、复制正文与复制工具参数的能力.” `docs/CLIENT_CONTRACT.md:286` distinguishes full paginated history from the bounded live view.
- Defect: `src/client-history.ts:198` calls `restoreHistoryItemsFromSession` for one message, assuming a single entry always fits the display window. That helper applies a 150-item window (`packages/repl/src/ui/utils/restore-history.ts:36-39,483`). A single canonical assistant message can itself contain more than 150 alternating thinking/text blocks.
- Reproducer: one identified assistant message with 80 alternating thinking/text pairs. `readHistory` returns 150 items, not 160, and has no `nextCursor`. First ten blocks disappear. The entry is small enough not to be oversized, so there is also no entry-level oversized reference. The ordinal-based reader invokes the same clipped projection (`src/client-history.ts:87-88`), so page-provided references cannot recover the discarded blocks.

### P2: Old selected user items lose their readItem source after ordinary append

- Requirement: `docs/features/v0.7.97.md:287`: “冻结浏览中的展开和复制按稳定项及对应内容读取；普通新增输出不能使原选中内容过时”. `:283`: “完整内容与最终结果仍可按稳定身份读取”. This is narrower than an arbitrary immutable snapshot: the original message remains unchanged.
- Defect: `src/sdk-runtime.ts:4495-4503` only supports assistant/thinking output identities and tool calls for out-of-window reads. A canonical user item with inputId receives a display identity, but when it leaves `SessionViewOwner.history`, the fallback immediately returns null. `src/session-view.ts:391-393` relies on that fallback.
- Reproducer: observe a 9009-character identified user prompt; readItem succeeds. Append 85 user/assistant rounds and trigger normal refresh. The original item leaves the view; `readItem` using the exact previously captured ID returns null. This happens through the real public daemon client as well as embedded runtime.

## Verified boundaries and non-findings

- Passing control: ordered assistant/thinking/assistant blocks preserve leading/trailing whitespace, types and text through each history item reference.
- Passing control: explicit `metadata.cancelled: true` tool output retains `cancelled` status, full output and JSON input; the transcript search result resolves to the tool-result original.
- Thinking search omission is the existing explicit redaction policy in `packages/agent/src/session-lineage/history-retrieval.ts:136-139`. Typed thinking remains readable through history item IDs. Do not report this alone as a new regression.
- `outputId` is not exposed on projected history items. This is not independently treated as a bug: `docs/CLIENT_CONTRACT.md:189` explicitly says identities across reading surfaces/revisions need not be interchangeable, and `:286` gives transcript and conversation separate revision spaces. Identity ownership guarantees for observe/readItem do not imply equality with history item IDs.
- Expired or changed history snapshots may legitimately return `resync_required`; none of the three findings depends on treating that documented boundary as an error.
- A cancelled tool with no canonical tool-result body can yield an explicit unavailable read. Unlike the confirmed explicit-result control, this was not promoted to a finding without a stronger full-original guarantee for an absent result.

## Artifacts and rerun

- `embedded-repro.ts`, `embedded-results.txt`: original embedded tests and complete output.
- `daemon-repro.ts`, `daemon-results.txt`: named-pipe/public-client tests and complete final output.
- Repros deliberately do not use `.test.ts` names in this directory and are not in the default test suite. To rerun, copy either repro to `src/client-history.contract-review.tmp.test.ts`, run `npx vitest run src/client-history.contract-review.tmp.test.ts --maxWorkers=1`, then remove only that temporary file. Relative imports are intentionally written for the temporary `src` location.

The expected failures establish current defects; these are not intended to be committed as passing regression tests without the corresponding implementation fixes.
