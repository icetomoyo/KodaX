# FEATURE_302 — Independent LLM Provider Parity

Date: 2026-10-30. Status: T01–T05 implemented, contract-tested and reviewed offline;
T06–T12 pending. T05 full-regression evidence is recorded separately below. This is not a claim of complete pi-ai parity or a released feature.
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
| openai | Built-in API-key Completions retained; native Responses explicit custom API contract-tested in T05; OAuth/Decisions and remaining model/history coverage pending | T06,T07,T10 |
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
| openai-responses | T05 explicit native API implemented and offline contract-tested; ordinary function tools/text/images/reasoning/usage/Host recovery. T06/T11 broader history and transport capabilities remain open. |
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

## Phase-zero verification log (T01–T04)

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

## Phase-zero Standards

Final review and incremental re-reviews found no remaining findings in T01–T04.
The cache projection follows the existing serializer condition, and typed Host
deadlines retain their existing recovery path. Changes remain scoped to the
required behavior without introducing a new framework or bypassing build guards.

## Phase-zero Spec

T01–T04 pass the scoped review after correction of retry classification, retry
hints/callbacks, Host delay units, cache-wire parity and cold-deadline handling.
The ledger correctly distinguishes current routes, non-equivalent identities,
pending native/OAuth operations and live-unverified behavior. At this phase-zero review T05–T12 were not
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


## 2026-10-30 — T05 native Responses

The isolated branch incorporates only the other thread's committed shared-Host
baseline `f6a010462` via merge `ba5d18cb`. Its dirty sandbox/external-agent work
remains in the original workspace and is neither overwritten nor claimed tested.
CLI budget preparation is committed separately as `3b7a8f8f`.

Public configuration uses `protocol: "openai", api: "responses"`; omitted API
retains Chat Completions. The built-in OpenAI alias does not migrate. Configuration,
setup persistence, keyless capabilities, standalone LLM and published SDK agree.
See [user configuration](../../public_docs/configuration/custom-providers.md#native-responses-api).

| Boundary | Evidence |
|---|---|
| Actual SDK transport | `openai-responses.test.ts`: /responses, stream true/false, stateless ordered replay, model provenance, final JSON object validation, usage, callbacks, current tools/schema changes, default/ceiling, explicit cache affinity, reasoning defaults and rejected-effort learning. |
| Credential/cancellation | Different scoped credentials on the same provider; instance learning uses connection/API/model/declaration/credential fingerprint. `responses-http-cancel.test.ts` uses a loopback HTTP SSE server for abort, lease revocation and disconnect, with one physical call. |
| Images | `responses-images.test.ts`: decoded user and tool-result image payloads, unsupported/missing-image placeholders, precise rejected-image hash through error wrapping; no local path on wire. |
| History consumers | `runner-responses-content.test.ts`, `llm-adapter.responses.test.ts`, `run-substrate.responses.test.ts`: both execution paths keep ordered text/reasoning/tools, sanitized output cannot re-enter via ordered blocks, tool executes once, encrypted reasoning survives continuation. |
| Recovery | Actual managed adapter repeatedly receives EOF, recovers, and calls Responses with stream:false. Cancelled streams remain AbortError; malformed/completed-invalid tools stay non-executable. Server error, quota and temporary limit preserve code/stage/failure metadata; failed usage is partial observation only. |
| Diagnostics and release | Responses-specific wire projection scopes opaque cache hashing; setup round-trip preserves API; `bundled-responses.test.mjs` imports the built SDK outside source aliases and proves scoped credentials plus replay. |

An explicit incomplete response is an error and returns no executable tool calls;
max-output continuation for incomplete Responses is not claimed. Missing stream
terminal and declared transient upstream failures use the existing Host recovery.
Historical ordering/source absent from old sessions is not invented. New default
reasoning uses declared defaults only; broader effort negotiation/history migration
and persisted Host capability-cache identity changes remain T06/T11.

Review-driven corrections: incremental tool-input callbacks must emit deltas;
EOF must remain recoverable; text suffix sanitation must preserve interleaving;
all error wrapping paths must retain typed upstream metadata. Each reproduced
case has a regression. Standards: 0 remaining findings. Spec: 0 remaining findings
within T05. These are separate offline reviews, not live service certification.

Validation so far: final source/test typechecks and workspace/bundle builds passed.
Core new modules (`openai-responses`, `responses-messages`, `assistant-content`)
coverage: statements 94.31%, branches 86.25%, functions 96.66%, lines 97% in the
28-test selection before the additional temporary-rate-limit metadata regression.
This is scoped coverage, not repository-wide coverage. That final metadata fix
then passed its 69-test Responses/base selection. Built SDK/manual/credential
selection passed 18 tests before the final metadata-only correction; final
release/full-suite results follow below. No live provider keys were used.

Protocol reference checked against installed OpenAI SDK 6.x types and official
[Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[reasoning replay](https://developers.openai.com/api/docs/guides/reasoning) and
[streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).
No pi runtime dependency or implementation copy is introduced.

### Final T05 build and release checks

- `npm run build:packages`, both source/test typechecks, and the bundle build passed
  after the final inline-system normalization correction. No lint script is defined;
  `git diff --check` passed.
- Final CLI: **5,127,818 bytes**, leaving **115,062 bytes** under the unchanged
  5 MiB cap; 114,107 bytes less than the integrated pre-extraction baseline.
- Complete `npm run test:bundle`: **58/58 passed**, including the real npm tarball,
  credentials, Host recovery, images, script worker, manual data and Responses.
- Final scoped coverage: **30 tests / 4 files passed**; statements **94.81%**,
  branches **87.2%**, functions **96.66%**, lines **97.61%** for the three new core
  modules. This does not imply >=80% coverage for the entire monorepo.
- Two preliminary full-suite launches were intentionally stopped before acceptance
  to apply review/self-check corrections. The final full suite runs against fixed
  production source and build outputs; only documentation is edited while it runs.

### Full offline regression and baseline comparison

- Final `npm test -- --reporter=verbose`: **18,094 passed, 4 failed**, with
  97 skipped and 19 todo tests; 1,292 files passed, 4 failed, 6 skipped.
  This is not a green full-suite result.
- Serial rerun of the four failing files: **6 passed, 3 failed**. The
  `sdk-client.exit.test.ts` ordinary-work cancellation case passed on rerun;
  its full-suite polling failure remains a load-sensitive observation, not a
  proven root cause or a claimed fix.
- With all T05 source changes temporarily removed, exact pre-Responses baseline
  `3b7a8f8f2` reproduced the other three failures using the same source-alias
  Vitest configuration and `--maxWorkers=1`: **2 passed, 3 failed**.
  `sdk-classic-plane.test.ts` never reached its provider-release signal within
  30 seconds; `sdk-goal-binding.test.ts` and `sdk-session-commands.test.ts`
  timed out at 90 seconds. Their seed runs had completed; the precise Host
  lifecycle cause remains unconfirmed. They are baseline failures in this
  environment, not evidence of a Responses regression.
- The comparison changed no Host source, test deadlines or skipped-test lists.
  All T05 changes were restored afterward. The main workspace remained at
  `f6a010462` with its concurrent uncommitted work untouched. Fixing these Host
  failures and rerunning combined-branch integration remain outstanding before
  claiming full regression acceptance. T05 is **contract-tested offline**;
  FEATURE_302 is not complete.

Reproduction: `npx vitest run src/sdk-goal-binding.test.ts
src/sdk-classic-plane.test.ts src/sdk-session-commands.test.ts --maxWorkers=1
--reporter=verbose` (one command line). Add `src/sdk-client.exit.test.ts` for the
four-file rerun. Raw logs stay in OS temporary storage.

### T05 Standards review result

No remaining findings after re-review. The tool-input delta contract, recoverable
EOF, quota/temporary-limit metadata retention and shared inline-system normalization
were corrected with failing-before/passing-after tests. Budget changes preserve
existing release guards and package boundaries. Findings: **0**, highest severity: none.

### T05 Spec

No remaining scoped T05 findings. Text suffix sanitation preserves interleaved tools;
wholly synthesized guard text has no original native position to recover. Both
consumers, explicit API/config persistence, scoped reasoning, image transport,
usage and actual nonstreaming recovery match the accepted contracts. T06–T12 and
live verification remain open. Findings: **0**, highest severity: none.
