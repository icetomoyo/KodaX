# FEATURE_302 — Independent LLM Provider Parity

Date: 2026-10-30. Status: T01–T04 implemented, contract-tested and reviewed;
T05–T12 pending. This is not a claim of complete pi-ai parity or a released feature.
[Accepted scope and tickets](../features/v0.7.99.md#feature_302-independent-llm-provider-parity).

## Baseline and isolation

- KodaX base: `466b874d07699420e2470364c892247577e44580` (`v0.7.97-alpha.11` package version).
- pi source reference: `0d23d53457a6b9a660c4cbbae061ba277e0fad11`; no pi runtime dependency or vendored implementation.
- Implementation branch: `codex/llm-provider-parity`, separate managed worktree and separate dependencies.
  The concurrent runtime/SDK thread's original working tree is untouched.
- Design submodule uses its own checkout/branch, starting at `04cbf80dff4b6f91abc65b3dbb898940e1a55f8e`.
  Phase-zero design commit: `b3a1a5b5816e7dc24f43cb8b33a03413583bf56c`.
  Integrating this branch requires its design submodule commit as well as the parent commit.

## Contracts covered

| Ticket | Public behavior | Evidence |
|---|---|---|
| T01 | Messages signature fragments survive stream completion and next-round replay, including signature-only thinking and multiple blocks. Signature bytes do not enter visible thinking callbacks. | `anthropic-signature-replay.test.ts`: RED reproduced missing deltas/empty thinking, GREEN for stream and complete replay. |
| T02 | `maxOutputTokens` stays the default request budget; new `outputTokenLimit` caps known service capacity. Per-model limits override provider limits. Explicit/env/scoped/legacy budgets remain supported. | `output-token-budget.test.ts`: both native protocols and request forms, invalid limits, existing base/custom/registry tests. |
| T03 | Plan exhaustion is not short-retried by adapter, SDK or Host recovery. Temporary errors retain bounded retries; error type, Retry-After, cancellation and old callbacks remain meaningful. | `resilience/provider-quota.test.ts`: real SDK transport fixtures, 1308/insufficient_quota/admin limits, no-retry hints, HTTP500/429/503/529, network failures and singleAttempt. |
| T04 | MiMo Coding uses `/v1/chat/completions`; old alias/key remain. Both V2.6 models support reasoning/tool replay, images and toggle compatibility. MiniMax and public MiMo keep their respective Messages routes. | `coding-plan-catalog.test.ts`, `mimo-coding-replay.test.ts`: captured wire, fragmented generated reasoning/tools followed by nonstreaming continuation. |

All fixture keys are fake. Transport tests stub fetch; no live MiMo, MiniMax or
other model calls were made. Their authentication acceptance, subscription
entitlement, service behavior and billing remain **not live-tested**. pi's
unhydrated generated model data is not treated as a verified model inventory.

Budget migration is explicit: MiniMax M3.1 default 131072 / ceiling 524288;
Ark large-output routes and direct DeepSeek default 128000, with the existing
384000 / 1024000 service ceilings recorded separately. Remaining legacy budgets
are retained. Unknown hard ceilings are absent, never invented from a default.
The two Host response-reserve paths already call `getEffectiveMaxOutputTokens`,
so catalog hard ceilings no longer directly inflate their reserve.

MiMo Coding selectable effort values are none/high; legacy minimal maps off,
low/medium/xhigh/max map on. Existing saved provider/model names are not renamed.
Messages signatures from old MiMo Coding history are not sent as Completions
fields; readable thinking maps to reasoning_content. MiniMax M Plan endpoint
remains `.minimax.cn/anthropic`; pi's `.minimaxi.com` factory is not evidence of
subscription-key equivalence.

## Coverage ledger

This ledger is pinned to the source revisions above. Provider rows correspond
one-for-one to pi's `packages/ai/src/providers/all.ts` factories; API identifiers
come from `packages/ai/src/types.ts`, and OAuth flows from
`packages/ai/src/auth/oauth/load.ts`. Source declarations do not establish live
availability. A similar vendor name or a configurable compatible endpoint does
not close a row. All new work here is **not live-tested**.

| pi provider ID | Existing KodaX route / current status | Remaining ticket |
|---|---|---|
| amazon-bedrock | Native cloud protocol/auth pending | T08 |
| ant-ling | Built-in route and dialect pending | T09 |
| anthropic | API-key Messages exists; signature replay contract-tested in T01; subscription OAuth pending | T07,T09 |
| azure | Native Responses/deployment/auth pending | T08 |
| baseten | Built-in route and dialect pending | T09 |
| cerebras | Built-in route and dialect pending | T09 |
| cloudflare-ai-gateway | Account/gateway/auth route pending | T09 |
| cloudflare-workers-ai | Account/auth chat and classifier route pending | T09,T10 |
| deepseek | Existing `deepseek` uses Messages; default/ceiling separated in T02; full API matrix pending | T06,T09 |
| fireworks | Built-in route and dialect pending | T09 |
| github-copilot | Native route and OAuth pending | T07 |
| google | Native route pending; `gemini-cli` is a separate restricted bridge | T08 |
| google-vertex | Native cloud protocol/auth pending | T08 |
| groq | Built-in route and dialect pending | T09 |
| huggingface | Built-in route and dialect pending | T09 |
| kimi-coding | `kimi-code` keeps its existing Messages dialect; OAuth/full route coverage pending | T07,T09 |
| meta | Native route and OAuth pending | T09 |
| minimax | Global public route pending; `minimax-coding` is not this identity | T09 |
| minimax-cn | CN public factory is not proven M Plan key-equivalent; preserve existing M Plan endpoint | T09 |
| mistral | Conversations protocol pending | T09 |
| moonshotai | International route pending | T09 |
| moonshotai-cn | `kimi` CN Completions exists; preserve its route-specific reasoning behavior | T06,T09 |
| nvidia | Built-in route and dialect pending | T09 |
| openai | API-key Completions exists; Responses, ChatGPT OAuth and Decisions pending | T05,T07,T10 |
| openai-codex | Native subscription route pending; `codex-cli` remains a separate bridge | T07 |
| opencode | Gateway route/model API selection pending | T09 |
| opencode-go | Gateway subscription route pending | T09 |
| openrouter | Native gateway/auth/image operation pending | T09,T10 |
| qwen-token-plan | International plan route pending; existing same-name KodaX alias is CN Messages | T09 |
| qwen-token-plan-cn | Existing `qwen-token-plan` CN Messages retained; full route equivalence pending | T09 |
| qwen-token-plan-individual | International individual plan identity pending | T09 |
| radius | Dynamic gateway and OAuth pending | T09 |
| together | Built-in route and dialect pending | T09 |
| typesafe | Classifier route pending | T10 |
| vercel-ai-gateway | Gateway protocol/model selection pending | T09 |
| xai | Native route and OAuth pending | T09 |
| xiaomi | Public `mimo` Messages retained; full protocol coverage pending | T09 |
| xiaomi-token-plan-ams | AMS subscription route pending | T09 |
| xiaomi-token-plan-cn | `mimo-coding` Completions migration contract-tested in T04; live authentication unverified | T04,T12 |
| xiaomi-token-plan-sgp | SGP subscription route pending | T09 |
| zai | Existing `zai-coding` Messages retained; full route equivalence pending | T09 |
| zai-coding-cn | Existing `zhipu-coding` Messages retained; full route equivalence pending | T09 |

KodaX's `ark-coding`, public `qwen` and `zhipu`, M Plan-specific
`minimax-coding`, and CLI bridges remain available. Counts alone must not be
used to replace these routes or rename saved selections.

| API / operation | Current implementation status |
|---|---|
| openai-completions | Existing adapter; T03 retry and T04 replay changes contract-tested. Dynamic history/strict/grammar/cache coverage remains T06/T11. |
| anthropic-messages | Existing adapter; T01 signatures and T02/T03 budgets/recovery contract-tested. Full cross-source ordered history remains T06. |
| openai-responses | Pending T05 |
| azure-openai-responses | Pending T08 |
| openai-codex-responses | Pending T07 |
| bedrock-converse-stream | Pending T08 |
| google-generative-ai | Pending T08 |
| google-vertex | Pending T08 |
| mistral-conversations | Pending T09 |
| pi-messages | Pending T09; implement protocol independently, no pi dependency |
| openrouter-images | Pending T10; separate operation and Host media delivery |
| typesafe-system-one | Pending T10 |
| cloudflare-workers-ai-system-one | Pending T10 |
| llama-cpp-classify | Pending T10; not represented by a separate built-in provider factory |
| openai-decisions | Pending T10; native classification, not prompt-based probability inference |
| deferred submit/query/cancel | Pending T10; operation support, durable reference and fresh authority required |

All nine source-declared OAuth flows are pending: Anthropic, OpenAI Codex,
OpenAI ChatGPT, GitHub Copilot, OpenRouter, Kimi Coding, Meta, xAI and Radius.
Existing CLI-managed logins do not count as native KodaX OAuth implementations.
T07 establishes the authorized storage/refresh/broker path; T09 adds the remaining
flows with their protocols. API keys, cloud identities and subscription tokens
must not be treated as interchangeable.

## Verification log

- Signature-focused suite: 70 tests passed after the failing capture/replay tests.
- LLM + resilience + media selection: 77 files / 1240 tests passed before the
  final Host Retry-After and timeout/cache fixes. Final recovery/base checks:
  5 files / 170 tests; cold managed credential recovery + quota/base checks:
  3 files / 76 tests; cache diagnostics versus actual wire: 2 files / 242 tests.
  These overlapping selections are not summed as unique tests.
- New quota classifier and output-limit validator: 53 tests; 100% statements,
  branches, functions and lines for these two new modules. This is not a
  repository-wide coverage claim.
- Final source and test TypeScript checks passed. Final `npm run build` passed,
  including workspace packages, native Windows components, bundles and declarations.
  CLI bundle: 5,242,783 bytes, 97 bytes below the unchanged 5 MiB guard; further
  protocol additions require deliberate bundle work, not raising the guard.
- Built-package credential and image tests: 17 / 17 passed after the final build.
- Final full default offline suite on stationary source/build outputs:
  **1285 files / 18,030 tests passed; 1 file / 1 test failed; 6 files skipped,
  97 tests skipped, 19 todo** (1292 files / 18,147 tests total, 1498.22 seconds).
  This is not a single all-green full-suite run. The sole failure was the
  unchanged Electron probe fixture's two-second wait for aborted cleanup;
  its entire file then passed **10 / 10** without source changes (the failing
  case completed in 298 ms). That fixture writes independent SDK stubs and
  does not execute the modified LLM adapter; its test, main fixture and Vitest
  setup/config match the base commit. Concurrent-load sensitivity is an
  inference from this evidence, not a claim of a repaired Electron issue.
- No lint script exists in the baseline package; `git diff --check` passes.

The initial full build failed the 5 MiB CLI budget by less than 1 KiB. Repeated
optional-field assignment and limit validation were consolidated; no build guard
was bypassed. The initial typecheck on the fresh checkout required workspace
package declarations to be built first; after that prerequisite, it passed.

The first full suite reported 30 failed tests across 8 files (17,880 passed).
It overlapped intermediate edits and rebuilds, so it is not final acceptance
evidence: Host build-identity rejection and temporarily absent native artifacts
were observed during those rebuilds. The eight-file rerun without rebuilding
passed six files; its remaining 8 wire-hash failures and one cold TimeoutError
failure were reproduced separately and fixed. The cache projection now includes
the same empty assistant reasoning field as the wire; typed Host deadlines skip
the new asynchronous SDK connection-error check. The affected 242 / 76 test
selections above passed afterward. The real-corpus timeout passed on rerun.

Two-axis review found and drove regressions for temporary HTTP errors being
misclassified as rate limits, ignored `x-should-retry:false`, loss of the legacy
overload callback, and loss of Retry-After with an explicit true retry hint.
The Host coordinator also now reads normalized Retry-After metadata and keeps
legacy rate-limit delays in milliseconds. Each correction has failing-before /
passing-after evidence. Both reviews also
rechecked the later cache-wire and cold-deadline fixes; the coverage ledger was
independently checked against the pinned pi factories/APIs/OAuth loaders.

## Standards

Final review and incremental re-reviews found no remaining findings in T01–T04.
The cache projection follows the existing serializer condition, and typed Host
deadlines retain their existing recovery path. Changes remain scoped to the
required behavior without introducing a new framework or bypassing build guards.

## Spec

T01–T04 pass the scoped review after correction of retry classification, retry
hints/callbacks, Host delay units, cache-wire parity and cold-deadline handling.
The ledger correctly distinguishes current routes, non-equivalent identities,
pending native/OAuth operations and live-unverified behavior. T05–T12 are not
implemented; this review does not mark the overall parity feature complete.

Final findings: Standards 0 (no remaining severity); scoped T01–T04 Spec 0
(no remaining severity). Full-feature acceptance remains open.

## Reproduction

From the isolated checkout, install its own dependencies with `npm ci` and run:

```powershell
npm run build
npm run typecheck
npx vitest run packages/llm packages/coding/src/resilience packages/agent/src/media/capabilities.test.ts
npm test
node --test tests/bundled-provider-credentials.test.mjs tests/bundled-image-validation.test.mjs
```

Keep production files and compiled/native outputs unchanged during `npm test`:
Host tests deliberately reject a launcher whose loaded build identity changed.
The complete build is a prerequisite for fresh-worktree native/daemon tests.

The default suite excludes integration/eval tests. Do not substitute paid/live
provider tests for these offline checks. Before integration, compare concurrent
changes, bring across the design submodule commit, then rerun affected SDK/Host
tests against the combined branch. Do not mark FEATURE_302 complete until the
remaining protocol/authentication/operation/consumer matrix is implemented and
its verification status is explicit.

### 2026-10-30 — T05 prerequisite: CLI budget

After integrating committed shared-Host baseline `f6a010462` (isolated merge `ba5d18cb`),
the CLI was 5,241,925 bytes, only 955 bytes below the unchanged 5 MiB limit.
Package-owned manual text now ships as `manual-topics.json`; dynamic provider names,
auth hints and defaults are still resolved at runtime. This reduces JavaScript size,
not total installed content. The before/after full manual registry is identical.

- Extracted CLI: 5,116,791 bytes; 126,089 bytes below 5 MiB (before Responses).
- Self-knowledge: 5 files / 90 tests passed. Bundle/manual budget: 3 tests passed,
  including actual npm pack file-list inclusion and standalone/package SDK equality.
- npm whitelist, Bun sidecar copy, Unix/Windows release archive lists, and standalone
  runtime fingerprint include the data. Missing/corrupt data fails visibly.
- Standards review found two distribution omissions; both fixed and re-reviewed.
  Spec review passed. No real binary packaging run is claimed here.
- A 64 KiB minimum CLI headroom regression is wired into `test:bundle`.
