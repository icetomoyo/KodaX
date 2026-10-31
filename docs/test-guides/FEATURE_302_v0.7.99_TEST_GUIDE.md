# FEATURE_302 — Independent LLM Provider Parity

Date: 2026-10-31. Status: T01–T12 implemented, contract-tested and reviewed offline,
including actual Space migration. Complete Root, published SDK/CLI and Space regression
passed. Historical intermediate failures and their corrections remain below. This is
implementation acceptance in isolated branches, not live account certification or a release.
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
| T05 | Explicit native Responses, ordered stateless history, images/tools/usage and actual stream/nonstream recovery. | Native SDK, loopback HTTP, both history consumers and bundled SDK regressions; see T05 evidence below. |
| T06 | Current dynamic schemas, safe imported history, model-scoped signed reasoning and identity-scoped effort/cache compatibility. | `responses-compat.test.ts`, managed/fallback/REPL regressions; final full offline suite 18,111 passed, 0 failed. |
| T07 | Host-owned OAuth storage/refresh, account switching, revocation and fresh Host binding for Codex/OpenAI/Copilot. | Session/driver/provider/binding tests and real broker lifecycle; final full offline suite 18,149 passed, 0 failed. |
| T08 | Native Gemini/Vertex, Bedrock and Azure protocols with provider-bound cloud credentials over the existing broker. | Captured native wire, real SDK/EventStream decoding, per-request refresh/revoke/new-Host regressions; final acceptance below. |
| T09 | Native Mistral/Pi Messages, explicit 42-identity presets and all nine host-owned OAuth service dialects. | 55 request/auth inventory fixtures, strict stream/history and OAuth lifecycle fixtures; 1,390 LLM/binding tests and 66 published tests passed. |
| T10 | Dedicated image/classifier/background operations and scoped Host media publication. | Native wire, strict terminal/partial usage, bytes/artifact rollback and published operation regressions; final complete regression below. |
| T11 | Explicit strict/grammar/WS/cache/catalog/pricing, identity and native diagnostics. | Actual localhost WS, conditional catalog/cache/quote, dynamic history and all-entry regressions; final evidence below. |
| T12 | Native Main/CLI/Host and Space credentials, immutable client recovery identity, whole-file transactions and final compatibility. | Real multi-process refresh/storage/Host, hidden CLI input and Electron IPC; complete suites and dual review below. |

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

## Coverage ledger — historical initial plan

The pending columns below are the historical starting inventory, superseded by the final T12 ledger at the end of this guide. This initial inventory is pinned to the source revisions above; later
ticket sections record updated source revisions and acceptance. Provider rows correspond
one-for-one to pi's `packages/ai/src/providers/all.ts` factories; API identifiers
come from `packages/ai/src/types.ts`, and OAuth flows from
`packages/ai/src/auth/oauth/load.ts`. Source declarations do not establish live
availability. A similar vendor name or a configurable compatible endpoint does
not close a row. All new work here is **not live-tested**.

| pi provider ID | Existing KodaX route / current status | Remaining ticket |
|---|---|---|
| amazon-bedrock | Native Converse/ConverseStream, explicit AWS identity/bearer and broker lifecycle contract-tested in T08; other model dialects/cache matrix and live policies remain open | T09,T11,T12 |
| ant-ling | Built-in route and dialect pending | T09 |
| anthropic | API-key Messages exists; signature replay contract-tested in T01; subscription OAuth pending | T07,T09 |
| azure | Native v1 Responses/deployment, API-key/Entra bearer and broker lifecycle contract-tested in T08; live deployment/identity entitlement unverified | T11,T12 |
| baseten | Built-in route and dialect pending | T09 |
| cerebras | Built-in route and dialect pending | T09 |
| cloudflare-ai-gateway | Account/gateway/auth route pending | T09 |
| cloudflare-workers-ai | Account/auth chat and classifier route pending | T09,T10 |
| deepseek | Existing `deepseek` uses Messages; default/ceiling separated in T02; full API matrix pending | T06,T09 |
| fireworks | Built-in route and dialect pending | T09 |
| github-copilot | T07 host-owned OAuth refresh/broker and native route contract-tested; login UI, enterprise/model discovery and live entitlement remain open | T09,T11,T12 |
| google | Native GenerateContent/SSE, API key and broker lifecycle contract-tested in T08; `gemini-cli` remains a separate restricted bridge | T11,T12 |
| google-vertex | Native regional/global/Express routes, explicit bearer/API key and broker lifecycle contract-tested in T08; host resolves ADC/workload identity | T11,T12 |
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
| openai | Built-in API-key Completions retained; native Responses T05/T06 and host-owned ChatGPT session/broker T07 contract-tested; Decisions and remaining capability matrix open | T10,T11,T12 |
| openai-codex | Native subscription route and host-owned OAuth refresh/broker contract-tested in T07; `codex-cli` remains a separate bridge; live login/entitlement unverified | T11,T12 |
| opencode | Gateway route/model API selection pending | T09 |
| opencode-go | Gateway subscription route pending | T09 |
| openrouter | Native gateway/auth/image operation pending | T09,T10 |
| qwen-token-plan | International plan route pending; existing same-name KodaX alias is CN Messages | T09 |
| qwen-token-plan-cn | Existing `qwen-token-plan` CN Messages retained; full route equivalence pending | T09 |
| qwen-token-plan-individual | International individual plan identity pending | T09 |
| radius | Dynamic gateway and OAuth pending | T09 |
| together | Built-in route and dialect pending | T09 |
| typesafe | T10 native classifier and separate operation factory contract-tested offline | T11,T12 |
| vercel-ai-gateway | Gateway protocol/model selection pending | T09 |
| xai | Native route and OAuth pending | T09 |
| xiaomi | Public `mimo` Messages retained; full protocol coverage pending | T09 |
| xiaomi-token-plan-ams | AMS subscription route pending | T09 |
| xiaomi-token-plan-cn | `mimo-coding` Completions migration contract-tested in T04; live authentication unverified | T04,T12 |
| xiaomi-token-plan-sgp | SGP subscription route pending | T09 |
| zai | Existing `zai-coding` Messages retained; full route equivalence pending | T09 |
| zai-coding-cn | Existing `zhipu-coding` Messages retained; full route equivalence pending | T09 |

T09 supersedes the initial provider rows marked pending above: all **41 chat identities**
now have an explicit connection factory and each declared API has an independent
URL/auth request fixture (54 chat cases). TypeSafe is the 42nd, classifier-only
identity and remains T10. This is implemented/contract-tested route coverage;
model-specific strict/cache/grammar/discovery/pricing remains T11, complete entry
integration remains T12, and every row remains not live-tested. Legacy aliases
and route-specific optimizations are retained.

KodaX's `ark-coding`, public `qwen` and `zhipu`, M Plan-specific
`minimax-coding`, and CLI bridges remain available. Counts alone must not be
used to replace these routes or rename saved selections.

| API / operation | Current implementation status |
|---|---|
| openai-completions | Existing adapter; T03 retry and T04 replay changes contract-tested. Dynamic history/strict/grammar/cache coverage remains T06/T11. |
| anthropic-messages | Existing adapter; T01 signatures and T02/T03 budgets/recovery contract-tested. Full cross-source ordered history remains T06. |
| openai-responses | T05 explicit native API implemented and offline contract-tested; ordinary function tools/text/images/reasoning/usage/Host recovery. T06/T11 broader history and transport capabilities remain open. |
| azure-openai-responses | T08 native v1 streaming/nonstreaming, deployment and explicit key/Entra bearer contract-tested offline. |
| openai-codex-responses | T07 native SSE subscription and host-owned session/broker contract-tested; complete() buffers SSE, not native stream:false. |
| bedrock-converse-stream | T08 Converse/ConverseStream, official binary EventStream/CRC, SigV4 or bearer contract-tested offline; other model dialects remain T09/T11. |
| google-generative-ai | T08 GenerateContent/SSE, ordered signed Parts, tools/images/usage and explicit API key contract-tested offline. |
| google-vertex | T08 regional/global/Express GenerateContent/SSE and explicit credentials contract-tested offline; host owns ADC/workload provider. |
| mistral-conversations | T09 native /chat/completions JSON/SSE, typed thinking, tool-ID mapping and strict terminals contract-tested offline. |
| pi-messages | T09 independently implemented SSE protocol, authoritative end snapshots and safe same-source/legacy history contract-tested offline; no pi dependency. |
| openrouter-images | T10 explicit dedicated/Chat dialects, admitted final bytes and Host artifact publication contract-tested offline. |
| typesafe-system-one | T10 native bool/choice/score, image assets/OpenRouter state-image variants and factory routes contract-tested offline. |
| cloudflare-workers-ai-system-one | T10 explicit Jev/Clef envelopes, media limits and completed hosted results contract-tested offline. |
| llama-cpp-classify | T10 distinct contextual label tokens and bounded native probability readout contract-tested offline; independent explicit connection. |
| openai-decisions | T10 native predicate/choice/score, criteria/distributions/refusals contract-tested offline. |
| deferred submit/query/cancel | T10 real background Responses and durable scoped restore, cumulative usage and fresh authority contract-tested offline. |

Of nine source-declared OAuth flows, T07 contract-tests the host-owned session,
refresh and broker path for OpenAI Codex, OpenAI ChatGPT and GitHub Copilot;
browser/device login and secure storage are supplied by trusted Host adapters.
T09 adds Anthropic, OpenRouter, Kimi Coding, Meta, xAI and Radius, with PKCE or device primitives as appropriate and shared broker-only inference. Concrete login UI/storage integration remains T12. Existing
CLI-managed logins do not count as native KodaX OAuth implementations. No flow is
live-tested here. API keys, cloud identities and subscription tokens must not be
treated as interchangeable.

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

## 2026-10-30 — T06 compatibility and Host baseline follow-up

Implementation base: isolated `5b58266fc`; the original workspace remains at
`f6a010462` with the other thread's uncommitted work untouched. No Host production
implementation is changed in this slice.

| Boundary | Regression evidence |
|---|---|
| Dynamic tools | `responses-compat.test.ts`: remove/add/redefine schemas, stale forced-tool rejection before dispatch, preserved historical names/results, no request-state carryover. |
| Cross-model history | Responses wire projection settles interrupted calls before new turns, discards orphan receipts, preserves readable foreign reasoning, and retains valid call arguments without execution. New Anthropic signed/redacted blocks carry their generation source; known foreign signatures/ciphertext never replay. Missing legacy provenance is not invented. |
| Reasoning and cache | Declared effort ladder, off/default handling, single-attempt constraints, acceptance remains unverified; response status and reasoning-item terminal validation. Identity-scoped persisted evidence is resolved only after credential acquisition, separated by connection/API/wire model/declaration/credential fingerprint. |
| Actual consumers | `llm-adapter.responses.test.ts`: new adapter per turn, persisted learning and identity switch through real SDK SSE. `reasoning-fallback.test.ts`: both Responses and Completions use genuine nonstreaming recovery and preserve intent. REPL public parsing does not inherit legacy alias/model rejections into Responses. |
| Cache controls/diagnostics | Per-call schema/model/cache changes, scoped cache-disable/re-enable, foreign opaque signature changes omitted from the provider-visible hash. |

The scoped-cache contract currently applies to Responses. Other protocols' complete
persisted identity migration remains T11; existing Completions behavior is retained.
REPL does not narrow Responses choices before obtaining an identity, nor persist a
single identity's downgrade into the user's effort configuration. Scoped records
contain fingerprints and rejected values, not credentials. No live service test
or capability-strength verification is claimed.

### Host baseline disposition

The three stable T05 failures were reproduced again. Targeted probes showed the
goal test completed its commands and then waited for repository-intelligence
maintenance during Runtime close; the classic test did not reach provider entry.
Their fixtures omitted `projectPath`, letting Host initialization/settings and
maintenance depend on the live worktree. Setting each Session's project to its
existing temporary fixture directory made **all four previously failing files /
9 tests pass** in the same isolated checkout. No production Host logic, cancellation
deadline, close deadline, assertions or skipped-test list was weakened.

The exit test's `inputs.submit` acknowledges admission before the provider starts.
Its default one-second polling window was a separate full-suite load assumption;
the fixture now allows a bounded ten-second provider-start window, while retaining
the original stop/exit settlement deadlines. The concurrent thread edits this
same test file; reconcile this small hunk during integration.

Temporary diagnostic probes and shortened diagnostic deadlines were removed. The
unchanged production source and final build outputs are frozen for final regression.
This section supersedes the unresolved T05 baseline disposition above only to the
extent supported by the final verification results below.

### T06 Standards

Initial review requested indentation cleanup; fixed. Final review: **0 remaining
findings**, highest severity none. Package boundaries and credential acquisition
remain consistent with ADR-068.

### T06 Spec

Review found a REPL path that still narrowed Responses via the legacy unscoped
cache and persisted a downgrade into user configuration. Public parsing reproduced
the failure before the fix; parsing, scoped-event storage and config preservation
were corrected. Final review: **0 remaining findings**, highest severity none.

### T06 verification

- Source/test typechecks, workspace package build and standalone bundle build passed.
- Focused related run: **81 files / 1,137 tests passed** before the additional
  REPL/managed recovery regressions; the latter passed their focused selections.
- Scoped coverage: **48 tests / 6 files passed**; statements **95.48%**, branches
  **87.59%**, functions **97.77%**, lines **97.77%** for Responses transport/projection
  and LLM/agent capability-cache modules. This is not whole-monorepo coverage.
- Final CLI: **5,130,280 bytes**, **112,600 bytes** below 5 MiB; the 64 KiB minimum
  headroom guard remains enabled.
- Complete `npm run test:bundle`: **58/58 passed**.
- First frozen-source full run: **18,106 passed, 4 failed**, 97 skipped, 19 todo;
  1,295 files passed, 2 failed, 6 skipped. All four previously failing Host files
  passed in this run. The new failures were three MCP OAuth discovery assertions
  and one Windows temporary-directory cleanup failure, not the old Host failures.
- OAuth diagnostic repetition reproduced a real Fetch `bad port` refusal: the OS
  assigned a port disallowed by Fetch, so discovery never received metadata. The
  test server now checks URL reachability and reallocates only on that exact
  refusal, with ten attempts; other errors propagate. Real HTTP, discovery order
  and metadata assertions remain. A deterministic regression exercises this
  refusal without binding/contacting the blocked port. A temporary 50-repeat
  probe passed **800/800** after the fixture fix and was removed.
- The closure failure was `ENOTEMPTY` while deleting a lock-queue directory after
  the helper had awaited Runtime close. Its original file passed **2/2** alone;
  fixture removal now has bounded Windows retries after the existing absolute
  temporary-path check. Functional assertions, call budgets and Runtime shutdown
  logic are unchanged; this does not establish a production shutdown defect.
- Combined post-fix regression: **6 files / 27 tests passed**. The subsequent
  deterministic bad-port case passed in the **17/17** OAuth file; final test
  typecheck passed. Both reviewers accepted the additional fixture fixes with
  **0 findings**. Production/build outputs remained unchanged; the full suite is
  rerun with these test-only corrections before final acceptance.

- **Final frozen-source full run:** `npm test -- --reporter=verbose` completed
  successfully: **1,297 files / 18,111 tests passed, 0 failed**, with the existing
  6 skipped files, 97 skipped tests and 19 todo tests unchanged (1,303 files /
  18,227 tests total). Duration: **1,231.78 seconds**. No production or build
  changes occurred between the two full runs; only the diagnosed test fixtures
  were corrected. The original Host baseline failures are closed for this
  isolated baseline, and the new fixture failures no longer reproduce.
- T06 is **contract-tested offline**, full offline regression and both reviews
  passed. T07–T12, live service verification and integration with the concurrent
  thread's uncommitted work remain open; FEATURE_302 remains InProgress.

## T07 — Host-owned OAuth credentials (2026-10-30)

Reference snapshot: local pi `e7a0df27c09d11bf4161d3605246cbf57a129cb2`.
Implementation is independent. Protocol references are OpenAI's
[SIWC sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[sessions and refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference),
[inference restrictions](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[function namespaces](https://developers.openai.com/api/docs/guides/function-calling),
GitHub's [OAuth protocol](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[Copilot OAuth ownership](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth),
and the first-party [VS Code token entitlement endpoint](https://github.com/microsoft/vscode/blob/main/product.json).
The legacy Codex backend and direct Copilot route are source-declared compatibility
paths, not a claim that every third-party OAuth client has access to them.

Public seams: `@kodax-ai/kodax/llm` (also standalone `@kodax-ai/llm`) exports
`OAuthSessionStore`, `openOAuthSession`, `createOAuthRefreshDriver`,
`createOAuthProviderConfig`; `@kodax-ai/kodax/runtime` exports
`bindOAuthCredentials`. Existing `customProviders` registration/config is reused.

```ts
// secureStore is provided by trusted Main, backed by its keychain/secret store.
// Login must already have verified identity and saved the unique registration.
const connection = createOAuthProviderConfig({
  service: 'openai-chatgpt', name: 'my-chatgpt', model: selectedModel,
});
const session = await openOAuthSession({
  id: selectedRegistrationId, store: secureStore,
  driver: createOAuthRefreshDriver('openai-chatgpt'),
});
let binding = await bindOAuthCredentials({
  credentials: runtime.credentials, provider: connection, session,
});
// Pass binding.credential through the existing trusted execution authorization.
// Switch only after nextSession has completed validated login/selection:
binding = await binding.switchAccount(nextSession);
// On Host restart, reacquire the user's selected session and call bind again
// using the new runtime.credentials; never treat a saved lease ID as authority.
const logout = await nextSession.revoke();
// Surface remote='failed'/'unsupported' and leaseRevocationFailures to the host UI.
```

The host implements `store.transact` with an account registration lock held over
refresh and atomic durable commit. Shared stores require cross-process locking;
an in-memory lock or a read-then-write JSON adapter is insufficient. Store updates
must not return a result before durable commit. Registration IDs cannot be reused
for a different service/client/verified identity. Non-expiring GitHub grants omit
`expiresAt`; all inference tokens and OpenAI grants require expiry in Unix
milliseconds. The host supplies its own issued/registered OAuth client, not pi's
or another application's ID. Tokens and raw upstream errors must stay outside
ordinary configuration, logs and history. `apiKeyEnv` remains as legacy metadata;
OAuth providers never read it. CLI readiness explicitly requires a host broker.

Login UI, browser/device flows, PKCE/state/nonce and ID-token signature validation
remain the trusted host's responsibility in this port-based ticket. No default
plaintext token store or ambient CLI-credential import is supplied. The same store
object shares local revocation across handles; multiple host processes must
coordinate logout notifications through their own session ownership. A storage
lock alone does not revoke another process's already admitted request. Await
logout before replacing the same registration's credentials after re-login.

| Path | Implemented contract | Verification scope |
|---|---|---|
| `openai-chatgpt` | Issued client/resource refresh, replacement refresh token, scopes/earliest refresh, discovered revocation; public Responses, stateless forced SSE, namespace tools | Offline wire/session/Host tests; live unverified |
| `openai-codex` | Separate legacy refresh endpoint, account routing header, Codex backend Responses, forced SSE, omit unsupported output limit | Offline wire/refresh; live unverified; registration/access supplied by host |
| `github-copilot` | GitHub grant refresh plus separate short-lived inference token; retain completed rotation if exchange fails; Responses initiator headers | Offline wire/session tests; live unverified; entitlement depends on authorized OAuth app |

Local logout fences all attached leases and removes credentials while retaining
registration metadata. OpenAI remote revocation is attempted separately and its
failure is returned. GitHub's public client has no app secret: its default remote
revocation is explicitly unsupported; a privileged host driver or GitHub account
settings must revoke the upstream grant. No secret is borrowed to conceal this.
Copilot enterprise routing, automatic model discovery and additional API dialects
remain T09/T11. SIWC/Codex `complete()` buffers SSE; it is not native stream:false.
Opaque reasoning is scoped by credential fingerprint, so refresh/account changes
conservatively retain readable context without replaying foreign ciphertext.

Executable acceptance: OAuth session/driver/provider tests, scoped binding tests,
setup metadata/readiness and `runtime-daemon/server.test.ts` T07 scenario. They
cover serialized rotation, durable commit failure, cancellation, invalid_grant,
late refresh after logout, shared local revocation, account switch, old lease
rejection and fresh Host authority. Final regression/review evidence is recorded
below after completion.

## T07 Standards

Final independent review: **0 findings**, highest severity none. The additional
race/failure and published SDK tests were reviewed separately, with the same
result. Public driver revocation now sanitizes transport/URL exceptions too.

## T07 Spec

Review found that a Copilot exchange 401 cleared an already rotated GitHub grant.
The regression first failed; the exchange stage now preserves the completed grant
rotation while dropping the inference token and reporting the exchange error.
Both generic exchange failure and reauthentication failure are covered. An
independent memory probe confirmed one refresh followed by a successful retry of
the exchange. Final independent review: **0 remaining findings**, highest severity
none; no additional scope findings.

## T07 verification

- TDD red/green evidence is executable in the new session/driver/provider/binding
  tests and setup readiness regression; temporary raw logs remain in OS temp.
- Scoped coverage: **36 tests / 4 files passed**. OAuth session/driver,
  subscription transport and Runtime binding: **91.69% statements, 89.83%
  branches, 92.98% functions, 97.36% lines**. This is not whole-repository coverage.
- Workspace packages, JS bundles and self-contained SDK declarations built;
  source/test typechecks passed. The declaration build also checked the Product
  Client without Node ambient types.
- CLI: **5,141,561 bytes**, **101,319 bytes** below the unchanged 5 MiB budget;
  the existing 64 KiB minimum headroom remains enforced.
- Published OAuth smoke test passed outside Vitest aliases: host refresh → scoped
  broker → bearer-only inference, using the actual public SDK exports/chunks.
- The final refresh-window regression first failed: an expired access token with
  a future `earliestRefreshAt` caused local grant deletion. It now reports a
  temporary refresh failure, preserves the grant, and succeeds once refresh is
  allowed. Both reviewers accepted the small correction with zero findings.
- A recovery-capability check reproduced inherited native non-streaming support
  on the two stream-only subscriptions. Those providers now veto non-streaming
  recovery while retaining their buffered `complete()` API. Copilot and ordinary
  Responses retain actual stream:false. The in-progress full run was interrupted
  before applying this production correction; final acceptance uses a fresh run.
- Complete published bundle regression: **59/59 passed**, zero skipped/failures,
  including CLI budget/headroom, native Responses, public OAuth exports, existing
  credential scopes, Host recovery and clean-package Script checks. Duration:
  **89.44 seconds** on the final build.
- Final frozen-source full run: **1,301 files / 18,149 tests passed, zero failures**;
  existing **6 skipped files, 97 skipped tests and 19 todo tests** remain
  (1,307 files / 18,265 tests total). Duration: **1,250.94 seconds**. The T07
  broker/refresh/account-switch/new-Host scenario passed within this run. The
  Host baseline failures closed in T06 did not recur.
- The full suite touched a golden snapshot's line-ending metadata without a
  content diff; that generated change was restored and no snapshot expectation
  was updated. No production/test source changed during the accepted full run.
- No live tokens were used. Browser login, OAuth client entitlement, remote
  revocation against a real account and secure-store durability of a specific
  host adapter remain unverified online. T07 is contract-tested offline; the
  full FEATURE_302 remains InProgress with T08–T12 open.
- Integration baseline remains the isolated `codex/llm-provider-parity` branch
  above committed shared-Host baseline `f6a010462`; the other chat's working tree
  is not imported or edited. New authorization composes `registerScoped` rather
  than changing daemon credential schema, client transport or production Host
  execution. Small public SDK/config/readiness additions still need ordinary
  merge review when that chat's uncommitted changes are integrated.

## T08 — Native cloud protocols and scoped authentication (2026-10-30)

Reference pi revision remains `e7a0df27c09d11bf4161d3605246cbf57a129cb2`.
No pi runtime/code is imported. Primary protocol references:
[Google GenerateContent](https://ai.google.dev/api/generate-content),
[Google signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures),
[Vertex locations](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations),
[Vertex Express](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview),
[AWS Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
[AWS ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html),
[AWS credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html),
[Azure Responses](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses),
and [Azure v1 lifecycle](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle).
These references describe service contracts; they do not establish live account,
regional, model or OAuth-client entitlement for this implementation.

The LLM SDK exports `createCloudProviderConfig`, `KodaXCloudCredential` and
`serializeCloudCredential`; Runtime exports `bindCloudCredentials`. Public
configuration still uses `customProviders`, with optional non-secret `cloud`
metadata and native `protocol: 'google' | 'bedrock'`; Azure uses explicit
`protocol:'openai', api:'responses', cloud:{service:'azure'}`. Existing aliases,
CLI bridges and compatibility gateways keep their original paths.

| Service | Native path | Explicit credential kinds |
|---|---|---|
| Gemini | `/v1beta/models/{model}:generateContent` and `:streamGenerateContent?alt=sse` | API key header |
| Vertex | regional/global project/location publisher route, or Express publisher route | Bearer for project routes; Express API key; no ADC in daemon |
| Bedrock | `/model/{modelId}/converse` and `/converse-stream` | AWS access/secret/session identity, or Bedrock bearer |
| Azure | resource `/openai/v1/responses`, deployment name as wire model | Azure API key header or Entra bearer |

Example trusted host integration (the application owns the credential providers):

```ts
const connection = createCloudProviderConfig({
  service: 'vertex', name: 'my-vertex', model: selectedModel,
  project: selectedProject, location: 'global',
});
const binding = await bindCloudCredentials({
  credentials: runtime.credentials, provider: connection,
  async resolve(request, signal) {
    // hostGoogleAuth is an explicitly selected ADC/workload/service-account
    // provider owned by trusted Main, not created from daemon ambient state.
    const token = await resolveHostGoogleToken(signal);
    signal.throwIfAborted();
    return { type: 'bearer', token: token.token, expiresAt: token.expiresAt };
  },
});
// Supply binding.credential to existing trusted execution authorization.
// Account switch: await binding.close(), then explicitly bind the new source.
// Host restart: bind again against the new runtime.credentials authority.
```

For AWS, `resolve` may await a host-owned official AWS credential provider
(profile, SSO/STS, web identity, ECS/EC2 or supplied IAM identity) and return
`{type:'aws', accessKeyId, secretAccessKey, sessionToken, expiresAt}`; convert its
optional `expiration:Date` to Unix milliseconds. For Azure, the host may call its
own `TokenCredential.getToken(explicitScopes)` and return its token and expiry.
The current Azure v1 how-to uses `https://ai.azure.com/.default`, whereas the REST
reference still lists `https://cognitiveservices.azure.com/.default`; the host
must choose its resource's scope explicitly. No 401 retry swaps scope/account or
starts DefaultAzureCredential. API-key grants use `{type:'api-key',key}`, Bedrock
API keys use `{type:'bearer',token}`. Expiry is checked locally when present.

The structured credential carrier is private request material over the existing
v2 string broker, not a new configuration format or a persisted session record.
It is bound to one provider name; only the cloud request accessor unwraps it.
Legacy API-key accessors cannot forward it as a key. Redaction covers both the
whole carrier and every contained secret, including nested errors and overlapping
secret values. `apiKeyEnv` remains legacy metadata and is never an ambient fallback
for native cloud connections. CLI readiness reports a required Host broker.

The native transports reuse KodaX's bounded retries, per-request budget/ceiling,
physical fetch observations, cancellation and failed-stream usage. AWS SDK
`3.1127.0` and an explicitly injected `@smithy/signature-v4@5.6.12` signer load only
on Bedrock requests. The injected signer and cache-clear function come from the
same module instance, even when the SDK transitively uses another Smithy version.
Signing cache is cleared after signing and again on request/stream settlement;
the client is destroyed. Only the declared auth scheme is offered. No SDK default
credential chain is used, and `maxAttempts:1` leaves retry ownership with KodaX.
The HTTP handler keeps the official binary EventStream/CRC and SigV4 implementation
while exposing the same physical request boundary as the other providers.

Google preserves each returned Part, including signatures on empty/non-thought
text and function calls. Replay requires matching connection/API/wire model/
credential fingerprint and an unchanged signed payload. Foreign or edited tool
turns become readable historical calls/receipts; no placeholder signature is
invented. Bedrock preserves ordered thinking/signature/redacted bytes and tool
receipts, with same-source replay. Orphan receipts are dropped and interrupted
calls receive an explicit non-execution receipt. Tool declarations and forced
choices are rebuilt from the current request. Incomplete/blocked/unknown terminal
states, malformed tool arguments, missing stops or CRC failures cannot return
executable partial tools. Google partialArgs/continuation responses are rejected
rather than treated as completed calls; the adapter does not opt into incremental
function-argument mode or deferred continuation.

Images use the existing admitted/validated bytes and require explicit
`imageInput:true` or an equivalent declared capability; no route assumes every
deployment/model supports vision. Unknown models send no speculative thinking
configuration. Google level/budget profiles and Bedrock's explicitly declared
Anthropic effort/budget dialect are separate; other Bedrock model dialects and
provider/model catalog refresh remain T09/T11. Bedrock cache boundaries require
the existing explicit `promptCacheAffinity` opt-in and honor cache-off; this is
not a request affinity key. Google explicit cache creation/resource reuse and
the complete native diagnostic/cache-identity matrix remain T11. Native sources
without a protocol-specific diagnostic projector retain the existing generic
context estimate; it must not be read as proof of service cache reuse.
Existing OpenAI/Anthropic hard-rejection learning is unchanged. Native Google/
Bedrock use declared profiles and surface rejected controls rather than silently
consuming legacy unscoped effort caches or claiming newly learned native rungs.
Their protocol-specific persisted learning/identity matrix remains T11.

Acceptance evidence, final regression statistics and independent review results
are recorded after the implementation freeze below. No real cloud account has
been used for this ticket; live region/model/identity policies remain unverified.

## T08 Standards

Final independent review: **0 remaining findings**, highest severity none. The
review found that an open Bedrock response stream could outlive SDK client
destruction; the fetch-backed handler now tracks and destroys that stream. A
RED/GREEN cancellation probe covers the actual fetch body. Deeply nested message
conversion was flattened to the repository's four-level limit. The final small
legacy-thinking guard was reviewed separately with the same result.

## T08 Spec

Final independent review: **0 remaining findings**, highest severity none. Failing
regressions drove fixes for SDK environment headers overriding Azure auth, secret
redaction in exact request scopes, Bedrock nonstreaming results after cancellation,
the REPL protocol whitelist, declared thinking budget caps and default-off effort
selection. Native Google/Bedrock no longer inherit legacy unsupported-thinking
fallbacks that could silently delete rejected controls. The reviewer independently
confirmed a native 400 now surfaces after one request instead of changing semantics.

## T08 verification

- TDD regressions cover cloud credential validation/expiry/provider binding,
  overlapping-secret redaction, per-request rotation/cancellation/revocation,
  native stream/nonstream wire, strict terminal/tool boundaries, signed history,
  image admission, retry metadata, reasoning defaults/caps and the review fixes.
  Raw logs and research drafts remain untracked in OS temp / ignored research.
- Scoped coverage: **82 tests / 7 files passed**, including the existing OAuth
  binding contract after extracting the shared lease helper. **89.33% statements
  (628/703), 81.74% branches (636/778), 94.54% functions (104/110), 96.95% lines
  (477/492)**. This is scoped coverage, not whole-repository coverage.
- Host protocol selection: **5 tests passed**, comprising the existing OAuth
  lifecycle and four native cloud services over the real dispatcher/reverse
  broker. Refreshed credentials reach only the selected route; revocation and
  old Host lease rejection require explicit fresh-authority binding.
- Workspace packages, JS bundles, self-contained SDK declarations and source/test
  typechecks passed. Product Client declaration checks require no Node ambient
  types. Configuration template consistency passed.
- CLI: **5,172,615 bytes**, **70,265 bytes** below the unchanged 5 MiB budget;
  the existing **64 KiB** minimum headroom remains enforced.
- Complete published bundle regression: **63/63 passed**, zero failures/skips,
  including all four native cloud public SDK paths, existing Responses/OAuth,
  credential scopes, Host recovery, CLI budget/headroom and clean-package Script
  checks. Duration: **80.09 seconds** on the frozen build.
- Final frozen-source full run: **1,307 files / 18,234 tests passed, zero failures**;
  existing **6 skipped files, 97 skipped tests and 19 todo tests** remain
  (1,313 files / 18,350 tests total). Duration: **967.16 seconds**. All four T08
  per-request refresh/revocation/fresh-Host cases passed inside the full run.
  The Host baseline failures closed in T06 did not recur.
- Two generated golden snapshots acquired line-ending metadata changes with no
  content diff; those changes were restored without changing expectations.
  No production/test source changed during the accepted full run.
- No real cloud keys/tokens were used. Host-selected ADC/workload identity,
  AWS profile/SSO/STS and Azure credential-provider integration are explicit
  callback seams, not automatic daemon discovery or live-tested identity flows.
  Regional/model entitlement, actual refresh policies and the complete native
  cache/diagnostic/learning matrix remain unverified or scheduled in T09/T11/T12.
- Source is isolated above T07 `16e6e19bb`; the concurrent working tree remains
  untouched at `f6a010462`. No production daemon credential schema/client/server
  changes are included. Merge review must still reconcile the public SDK and
  setup/readiness additions with the other chat's uncommitted work. A read-only
  tracked-path comparison during final regression found only
  `src/runtime-daemon/server.test.ts` in common: our new cloud lifecycle tests are
  inserted after baseline line 1157; the concurrent additions are after baseline
  lines 3371 and 3819. These hunks are distinct; no concurrent edits were imported.

## T09 implementation and scoped acceptance

Implementation baseline: `c91152b18`; pi reference remains `e7a0df27c`.
The 42-row connection inventory is source-declared metadata, not model/account
entitlement. New presets use an explicit custom name and never replace the
existing 16 aliases. Multi-protocol routes require an explicit API selection;
per-model/deployment endpoints remain explicit where no generated catalog exists.

- pi's `mistral-conversations` actually uses native Mistral Chat Completions,
  not the beta Conversations endpoint. KodaX implements typed thinking chunks,
  9-character tool IDs with paired historical mappings, strict completed tool
  arguments and native JSON nonstreaming. Sources:
  [Chat API](https://docs.mistral.ai/api/endpoint/chat#post-v1chatcompletions),
  [reasoning](https://docs.mistral.ai/studio/conversations/reasoning),
  [prompt caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching).
- Pi Messages is an independent wire projection (`/messages`, transcript system
  tools, SSE start/block/done). `complete()` buffers SSE and does not advertise a
  native nonstreaming recovery channel. The pinned source is
  `packages/ai/src/api/pi-messages.ts:56–101,374–443` and
  `packages/ai/src/types.ts:561–659,786–804`. No backend validator for missing
  historical usage was available. Legacy/foreign assistants and receipts become
  readable user context; complete same-source native metadata enables structured
  replay. Usage/cost, signatures and historical timestamps are not invented.
- OAuth additions distinguish OpenRouter's issued API key without a refresh grant
  from ordinary expiring grants and Meta identity-to-resource exchange. An unknown
  Meta resource lifetime is not replaced by a guessed 24-hour expiry: re-mint on
  the next request and do not persist that unbounded resource key. Sources:
  [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth),
  [xAI discovery](https://auth.x.ai/.well-known/openid-configuration), pinned pi
  `packages/ai/src/auth/oauth/meta.ts`. Non-public client entitlement is unverified;
  callers supply their own authorized registration and validate login identity.
- Cloudflare unified billing uses `cf-aig-authorization` and removes ordinary
  Authorization/x-api-key. Other connection authentication remains explicit;
  existing API-key routes keep their environment path. Azure Completions adds the
  same explicit key/Entra binding and deployment endpoint normalization as Responses.
- The CLI budget first failed at **5,197,769 bytes** after the initial native
  additions; lazy SDK transport loading alone cannot shrink the single-file CLI.
  Static text was therefore moved to the package-owned `static-text.json` asset,
  alongside the existing manual asset distribution. A before/after serialization
  of 78 public tool definitions, worker exports and default stable instructions
  was byte-identical, SHA256
  `050bcc8681de1e98ba710fc846e48d2c51b8324ae540196acd24c60d52aa3277`.
  The subsequent build measured **5,153,757 bytes** and passed the unchanged
  5 MiB / 64 KiB-headroom guard. These are intermediate measurements, not final
  T09–T12 release acceptance.

T09 now includes host-owned PKCE callback and device-polling primitives; callers
still own browser/consent UI, registered client entitlement, verified identity and
secure atomic session storage. Device codes are held in a cancellable closure;
pending/slow_down/denial/expiry and one-use code/state checks have offline fixtures.
The source-declared client identity is never borrowed from pi or another app.

The provider/API request matrix passes **55 cases**: 41 chat-provider identities
with every declared chat API, plus the classifier-only TypeSafe inventory row.
These tests capture actual request URLs and authentication using offline transport
rejection fixtures; successful stream/history semantics are covered separately by
the protocol regressions. They do not establish live entitlement or service-wide
model compatibility. The final combined LLM/binding run passed **94 files / 1,390 tests**;
scoped new-code coverage was **89.37% statements / 82.55% branches**,
94.39% functions and 96.40% lines. This is not repository-wide coverage.

A combined run caught an over-broad raw-fetch connection retry replaying a
Responses HTTP disconnect. Retry marking is now limited to failures before fetch
returns response headers; streamed-body failures retain Host recovery ownership.
The existing disconnect/cancellation contract and native socket-reset/HTTP retry
regressions pass together. Pi end snapshots are authoritative completed text and
tool objects; partial deltas are display-only and missing/invalid ends cannot
return executable tools.

T09 frozen-patch acceptance:

- Workspace builds, source/test typechecks, JS bundles and self-contained declarations passed.
- Published-package regression: **66/66 passed**, zero failures/skips, **80.06 seconds**.
- CLI **5,165,603 bytes**, **77,277 bytes** below 5 MiB; the unchanged 64 KiB minimum headroom passes.
- Standards review: two findings corrected (five-level Pi metadata nesting and duplicated OAuth endpoint profiles); re-review **0 findings**, no remaining severity.
- Spec review: OpenCode/Go Messages must send Bearer and device slow_down must honor the server interval; both reproduced by RED fixtures, corrected and independently re-tested; re-review **0 findings**, no remaining severity.
- OAuth endpoint profiles are shared by authorization, device, refresh, resource exchange and revocation. OpenRouter keys and Meta unknown expiry remain explicit rather than assigned synthetic lifetimes.
- Full monorepo acceptance will run after T10–T12 source freezes; T09 does not replace the T08 full-run evidence.
- Concurrent checkout remains untouched at `f6a010462`. Build asset-copy hunks are distinct from its CLI-budget edits; integration still requires a final review of both branches.

T10–T12 remain open, including Host/CLI wiring, media/deferred lifecycle,
cache/strict/WS, catalog/pricing/identity and final published-package/full regression.


## T10 native operations — scoped acceptance

Baseline: T09 `e6247c3a`; pi reference `e7a0df27c`. Public SDK contracts and examples
are in [LLM operations](../LLM_OPERATIONS.md). The standalone LLM package exports
separate typed image, classification and deferred functions; chat result types
and Auto permission classification remain unchanged.

- OpenRouter images support explicit legacy Chat Completions and dedicated Image
  API dialects. Current reference images use `input_references`; no cross-dialect
  retry or output URL download. Dedicated SSE previews are temporary; a completed
  image and terminal marker are required before returning final output. Unknown
  SVG decoding remains explicitly unverified and the image publisher refuses it.
  Source: [OpenRouter Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
- Four classifiers use native probabilities: TypeSafe System One, Cloudflare
  Jev/Clef (explicit distinct envelopes), OpenAI Decisions and llama.cpp native
  token readout. Labels/answer names/distributions must be complete and finite;
  score distributions and per-question Decisions refusals survive normalization.
  llama.cpp verifies distinct single tokens at the actual newline boundary and
  bounds deeper readouts; it never asks chat generation to invent confidence.
  Sources: [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json),
  [Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/),
  [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
  [Decisions reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
  [llama-server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#api-endpoints).
- OpenAI background Responses implements real submit/retrieve/cancel. Default
  `store:false` follows the current documented temporary polling retention;
  longer storage is explicit. Pending/failed/cancelled/incomplete snapshots have
  no executable result. Foreground and background share strict final parsing.
  References contain only version/id/connection-account scope hash; each action
  reacquires current authority. Host/account/model changes require an exact
  match and fresh binding, never replay of a serialized lease.
  Sources: [background retention](https://developers.openai.com/api/docs/guides/background),
  [retrieve](https://developers.openai.com/api/reference/resources/responses/methods/retrieve),
  [cancel](https://developers.openai.com/api/reference/resources/responses/methods/cancel).
- Retrieval/cancellation reports cumulative job usage with a stable usage ID;
  its HTTP observation is not another inference charge. Submit can report usage
  when immediately completed. Classification retries only bounded temporary
  HTTP errors with Retry-After; quota errors remain non-retryable. Mutating image
  generation and background submission have no automatic replay after ambiguous
  delivery. Caller abort does not imply remote cancellation.
  Failed/cancelled/incomplete terminal snapshots preserve reported cumulative
  `partialUsage` under that same ID, without executable output or another poll charge.
- New operation factories expose TypeSafe (the classifier-only 42nd provider),
  OpenRouter image/classifier and declared OpenAI/Cloudflare/OpenCode operations.
  Local llama.cpp remains a separate explicit operation connection. Sparse
  factory metadata is not a generated or entitlement-verified model catalog.
- Host publication revalidates saved bytes, uses an existing explicitly selected
  absolute output directory and Host-generated exclusive filenames, then calls
  the existing artifact service. Failure rolls back newly created files and
  registrations; cleanup failures are visible. No secret/media/deferred daemon
  protocol or provider-wide grant is added. Real Host artifact registration and
  rollback have executable tests.

Intermediate wide run: **101 files / 1,455 tests passed**. Scoped coverage:
**86.72% statements / 83.27% branches / 95.41% functions / 96.06% lines**.
Subsequent environment-key error redaction has its own RED/GREEN fixture;
final review/build/published evidence will supersede this snapshot. No service
credentials or local llama-server were used; model access, calibration, retention
timing and actual billing remain not live-tested. Concrete product entry wiring
and final all-entry acceptance continue in T12.


T10 final scoped acceptance supersedes the intermediate snapshot:

- Frozen LLM/binding/Host-media/attachment/managed-Responses selection:
  **104 files / 1,465 tests passed**, zero failures.
- Scoped new/changed modules: **87.05% statements / 83.05% branches /
  95.49% functions / 96.16% lines**; not repository-wide coverage.
- Workspace build, source/test typechecks, JS bundle and self-contained SDK
  declarations passed. Published regression **68/68**, zero failures/skips,
  **83.13 seconds**, including separate operations and standalone package exports.
- CLI headroom regression first failed at **5,189,996 bytes**. Whole-LLM dynamic
  imports retained unrelated public operation exports. Error-only lazy imports
  now use the existing module through the new `/errors` export; attachment
  validation uses a named import of the same already-used helper. CLI is
  **5,135,723 bytes**, **107,157 bytes** below the unchanged 5 MiB limit; the
  original 64 KiB headroom guard passes without changing its threshold.
- Standards: **0 findings** on initial and corrected staged patches. Spec:
  two P2 findings reproduced and corrected (unsuccessful/malformed background
  cumulative usage preservation; Decisions bool criteria preservation);
  independent re-review **0 remaining findings**.
- `KodaXDeferredOutputError` keeps the durable reference and cumulative partial
  usage when a completed response fails strict parsing, without tools. Submit
  records received usage before parsing; query/cancel remains a status read,
  not another inference charge. Restored/reference data never grants authority.
- No release version bump, push, merge or live call. Full monorepo acceptance
  remains scheduled after T11/T12. The concurrent original checkout is untouched;
  its three `llm-adapter.ts` hunks are baseline lines 100/595/616, while this
  ticket only narrows the lazy error import at baseline line 1088. Final
  integration still requires review of all concurrent work.


## T11 frozen offline acceptance (2026-10-30)

T11 adds explicit strict/grammar, trusted request extensions/native hashes, identity-scoped reasoning and opaque replay, declared cache TTL/usage, explicit Google cache CRUD, authenticated catalog overlays/conditional quotes, and Responses/Codex/Azure WebSocket. Contracts and migration are in [LLM_INTEGRATION](../LLM_INTEGRATION.md) and [SDK_MIGRATION](../SDK_MIGRATION.md). The default HTTP path and existing aliases/config/env keys remain valid.

- Wide deterministic selection: **124 files / 1,700 tests passed**. Includes LLM, capability cache, native prompt diagnostics, REPL probe/effort compatibility, extracted prompt regressions.
- Scoped T11 modules: **86.25% statements / 83.99% branches / 94.47% functions / 96.19% lines**. This is not repository-wide coverage.
- Workspace build, source/test typecheck, explicit new public fixture typecheck and self-contained SDK declarations passed. Root test tsconfig excludes most package unit fixtures; the explicit fixture check supplements it.
- Real localhost Node WebSocket upgrade exercises auth, response.create and strict terminal parsing. Offline tests cover handshake-only auto fallback, no replay after generation, missing previous_response recovery, custom grammar receipts, cache/history edits, cancel/revoke/account/lifetime isolation, partial usage, Azure key/Entra and subscription headers. No external WebSocket/account was used.
- CLI first exceeded the unchanged 64 KiB headroom guard (5,181,611 bytes). Another **37** plain static literals (**36,700 UTF-8 bytes**) moved into the existing versioned static-text asset. AST-decoded text, all 78 built-in tool definitions, prompt/unit regressions and published resource layout remain equal. CLI becomes **5,146,215 bytes**, below 5 MiB with more than 64 KiB reserved; no budget threshold changed.
- Fresh utility broker/cancel/account source tests cover catalog refresh races, conditional GET, unavailable snapshots and Google cache lifecycle. Directory advertisements/quotes are not entitlement or invoice proof. TTL/cache hits, OAuth registrations and service behavior remain not live-tested.
- Final full monorepo, all-entry and concurrent work integration acceptance remains T12. T11 dual review and final published results are recorded below after review.


T11 review closure: Standards initially one P3 duplicate Google tool projection, now shared pure projector; re-review **0 findings**. Spec found and reproduced SDK-wrapped hook replay, Mistral cache-off header, incomplete TTL partition pricing, deferred/foreground fingerprint mismatch, and stale SDK env-key identity. Each has a RED/GREEN regression; independent final re-review **0 remaining findings** (39 focused tests). Post-fix LLM selection **110 files / 1,536 tests passed**. Earlier wide 124/1,700 and coverage numbers remain dated pre-review snapshots. Published selection **29/29 passed**, including real localhost WS in root SDK and standalone package. Full all-entry acceptance follows in T12; no release/push/merge/live entitlement claim.


## T12-A current reviewable slice (2026-10-30)

- Wide LLM/auth/setup/managed/native diagnostic selection: **123 files / 1,620 tests passed** before supplemental negative fixtures.
- Scoped Main/binding modules after storage/registration/state negatives: **87.74% statements / 83.27% branches / 87.67% functions / 94.73% lines**. Not repository-wide coverage.
- Real current-user Windows DPAPI, three separate Main processes, rotating transactions, corrupt/failed commit, direct CLI device login/status/logout over fixture issuer, exact loopback callback and local cancellation passed. No external browser/account login or cloud identity was used.
- Real daemon dispatcher/client/Product/Main probe chain uses a fresh v2 lease, utility purpose and Host-owned provider.reasoning.probe operation; forbidden provider is rejected. Existing source fixture typechecks supplement the root test config. Public browser-free Client consumer now narrows provider_probe before sessionId.
- Root/source/explicit package fixture types, workspace build and self-contained declarations passed. Published selection **34/34**, no failure/skip, **40.62 seconds**; includes native Responses/operations/credentials, real local WS, compaction and CLI/SDK shared-Host recovery.
- CLI initially grew to **5,187,063 bytes**, exceeding the unchanged headroom guard. **81** further static literals (**26,806 UTF-8 bytes**) moved to the existing resource; AST text equality is checked and the frozen published CLI is **5,163,932 bytes**. 5 MiB and 64 KiB headroom thresholds remain unchanged.
- User follow-up explicitly changes the intended final credential UX: hidden Key input, default protected file backend and actual Space migration. Those are tracked as T12-B–G, not accepted by this slice. Full merged acceptance is still pending; no release/push/merge/live entitlement claim.


T12-A review fixes (pending independent re-review): reuse the existing atomic config writer with a partial-write failure regression; cancelled login after durable commit cannot publish or link its registration and clears the unpublished grant; all four remaining user-memory/blob/judge/non-streaming bridge call sites pass the actual provider, with public extractor/summarizer regressions. The old provider fixture without scoped-learning metadata also keeps the existing fallback contract. Focused **5 files / 35 tests passed**. Supplementary Host/setup/workflow/prompt/goal selection **48 files / 611 tests passed**.

Direct Azure Identity 4.14.1 / Google Auth 11.3.2 and Azure transitives initially violated the supported Node 20 floor. Current exact direct versions are 4.11.1 / 10.5.0; the Azure subtree is pinned to compatible transitive releases. Comparing new/changed runtime lock entries against T11 finds no Node 20.16 incompatibility. Actual **Node v20.20.2** loaded all three auth SDKs and the published Runtime without obtaining credentials or starting a network identity request. No runtime engine floor was raised.


T12-A final slice evidence supersedes review-pending wording: final wide **126 files / 1,649 tests passed**; source/root and owned package fixture types plus self-contained declarations passed. Independent Standards re-review **0 findings** (55 new/changed runtime dependency entries checked for Node 20.16); Spec re-review **0 findings**, **65** independently executed targeted tests. Actual Node v20.20.2 published selection **29/29 passed**. Frozen CLI **5,164,033 bytes**, below the unchanged 5 MiB minus 64 KiB guard. This local slice is committed before T12-B–G; full feature and Space acceptance remain open.


### T12-B 共享文件基础层验收（2026-10-30）

- 新测试 auth-file / file-credential-access / credential-connection：无 env 保存后重新创建 store/provider 并经真正 adapter 发请求；状态无 Key，profile/alias/API/实际地址隔离，删除不回退，CAS、坏文件与失败 OAuth 事务保留旧数据。
- 三个独立 Node Main 同时改不同 Key 与同一 OAuth counter，最终保留全部记录、counter 为 3；实际 Windows ACL 检查继承关闭，仅 current-user 与 SYSTEM。POSIX 模式与 namespace 分支有实现，不把 Windows 运行当成其他平台实测。
- Host reverse bridge/client 传递连接指纹，Main 在读取 secret 前拒绝缺失或错误证明；同名嵌套 adapter 不得继承另一地址的 exact scope。
- SDK OpenAI 地址 env 变化且 Key 不变时更新实际路由/指纹，org/project 改变更新 headers 与 reasoning identity；明确配置地址优先。
- 测试日志位于执行机 OS 临时目录 kodax-t12b-*.log；隐藏输入和默认产品存储仍由 C/D 验收，Space 由 E/F，最终全量由 G。

- T12-B 冻结结果：120 文件 / 1813 测试通过，40 个既有条件测试跳过；源码与本阶段拥有的 fixture 类型、workspace 构建、自包含 dts/无 Node ambient 的 product Client consumer 通过；实际发布 JS 26/26。CLI 5,167,565 bytes，低于 5MiB-64KiB 预算 5,177,344。专项覆盖语句84.79%、分支82.15%；Standards 硬违反0/判断题0，Spec剩余0。全仓合并回归仍留 T12-G，并不以此替代。


### T12-C Key 产品入口验收（2026-10-30）

- setup / Classic+Ink / SDK manager 共享保存/删除语义；Key 不进入 config、argv、UI默认值、普通历史或原始画面。secret-input 的 TTY 模拟检查回显、readline history、两种 write 回调、取消、重试与关闭后读取；DialogSurface 检查掩码。
- manager 覆盖 config/key revisions、显式配置根与两 profile 隔离、保存/env 优先与删除、坏文件不回退、OAuth/external 不误走 Key。Key resolver 在后续请求读取最新记录；活动 broker 不回退 daemon ambient。
- store v1 只读原样、下一写升级 v2；删除 tombstone 覆盖 set→delete→旧回滚冲突。向导配置 CAS 冲突只回滚本次版本；取消/存储失败不改变有效选择，显式 env 选择删除旧保存值。
- 实际构建 CLI 进程：7/7，含 setup 隐藏保存、第二进程 status、remove-key 与 set-key，输出无原值；发布文件/预算测试19/19。配置模板资源与源文件逐字相同，独立 REPL 构建、根 dist 与 binary copy 清单都覆盖；CLI 最终5,173,069 bytes，低于预算5,177,344。
- 初轮12文件88测试通过；补充原生云/订阅向导后专项覆盖语句83.73%、分支80.52%。源码与拥有 fixture 的类型检查、dts/无Node ambient consumer通过。冻结后仍须双轴评审及合并全量 G；真实账号/跨平台实测范围不扩张。

- 2026-10-31 C复审后：131文件1825通过/1个条件跳过；Spec发现漏revision会落到底层无条件写，已用JS形状缺字段/空/数字revision做set/remove RED→GREEN，最后4文件34通过。Main facade现在在任何读写前拒绝非法expected revision。Standards0/0，Spec剩余0；发布4文件30/30、源码/owned fixture类型/dts/consumer通过。npm pack dry-run确认新模板JSON入包，预算守门未调整。KodaX完整全仓回归仍保留G，未以专项替代。


### T12-D OAuth 默认文件与 Host 回归（2026-10-31）

- session-file：同 canonical 文件多 handle 共用撤销 fence；正在 refresh 的 A 被撤销后结果不向 B 发布；三个真实 Node Main 只做一次 rotating refresh。
- provider-oauth-store：只迁移 linked ID，先提交后清旧 token，其他 Key/账号保留；当前/已注销共享记录优先，旧清理失败有错误且新副本保留，竞争创建 target 不覆盖；实际 current-user DPAPI 路径迁移已运行。
- Main profile/Radius issuer 不匹配在授权前失败；缺失/不同 Host profile 不注册 lease；CLI 不注销另一 profile。实际 OAuth status/login/logout 命令改走共享文件，旧 public encrypted 后端回归保留。
- 文件初始化准备 auth.json 与整个 staging mask；实际 Windows ACL 检查 staging 去继承、OI/CI 只给 current-user/SYSTEM，未额外保护的新 probe 文件也只继承这两个账号。工作区包含配置根的沙箱 regression 从 mkdir 文件失败 RED 修至 GREEN。
- Host 失败根因：B 开始校验已有 providerProbeAuthorization 要求，独立 daemon 未转发 owner 声明。四格 owner/override handshake 测试复现（2红），修复只从真实 owner 转发后4过，不能用 override 伪造。原始真实进程4/4通过，覆盖 print/scoped Host crash recovery、SDK重附着和30秒idle-exit；初轮3个失败保留在执行机 kodax-t12d-host-published.log，修复后证据 kodax-t12d-host-cap-published.log。临时诊断无源码插桩。
- 此处为离线/本机存储及 Host 证据，不代表真实订阅权益或 POSIX 实机测试；E/F Space 和 G 全量仍未验收。

- D冻结验收：121文件1672通过；Sandbox/文件4文件117通过40条件跳过；补齐省略source.profile时从session推导及Radius缺issuer拒绝，4文件19通过。专项语句87.65%、分支85.93%；源码/owned fixture类型和dts通过；真实发布JS+Host+预算23/23。CLI5,177,265 bytes，预算5,177,344未调整。Standards0/0，Spec复核剩余0。G全仓回归正在单独执行。


## T12 E/F/G final offline acceptance (2026-10-31)

This section supersedes all earlier pending/in-review statements for FEATURE_302 implementation.
Root product source is frozen at T12-D `4b915c94c`; G changes four regression fixtures and accepted
documentation, without further product-source or CLI-budget changes. Space is separately committed
as `065cc39c` on `codex/provider-credentials-space`, based on `7801a8ca`. No push, merge, release
version change, real account inference or borrowed OAuth client identity was performed.

### Complete and supplemental verification

| Scope | Final evidence |
|---|---|
| Root complete Vitest | **1,348 files / 18,656 passed**, 6 files/97 tests conditionally skipped, 19 todo, **zero failures**; 1083.26 seconds. |
| Root published JS/CLI | Full `npm run test:bundle`: **70/70**, zero failures; native operations, credentials, real Host crash/reattach/idle-exit, resources and budget. |
| Root types/build | Source, all Root test types, owned package fixture types and self-contained SDK declarations passed; product-source builds from D remain unchanged by G. |
| Root dry package/budget | **1,103** manifest entries; static-text, generated config templates, capabilities and SDK runtime/LLM resources present. CLI **5,177,265 bytes**, unchanged guard **5,177,344** (5 MiB minus 64 KiB); 79 bytes below the guard. |
| Space complete `npm test` | Release **130 passed / 7 skipped**; Desktop **3,998 passed / 13 skipped**; IPC schema **370 passed**. Combined **4,498 passed / 20 conditional skips / zero failures**. |
| Space final review changes | Additional **12** SDK/Host/config and **9** credential tests passed after final review fixes; actual native warmup write passed. Full run is supplemented by these final focused regressions, rather than claiming an identical pre-review snapshot. |
| Space scoped new modules | **91.11% lines / 82.97% branches / 90.16% functions**; not whole-project coverage. |
| Space types/build/lint | `npm run typecheck`, `npm run lint`, `npm run build:smoke` passed; existing Vite chunk-size warnings retained. |
| Actual Electron IPC | Windows isolated desktop **1/1 passed**, 5.6 seconds: file save, cross-process update, stale delete rejection, sanitized list/config, delete exposing approved env and Renderer reload. Process restart is separately covered by an actual second Node Main; Renderer reload alone does not prove app restart. |

The first Root full run had 17 failures in four fixture files: CLI bootstrap ports/no-env setup,
current scoped capability/probe budget expectations, and static prompt sidecars in source-only
assertions/standalone build fixtures. These were corrected without changing product behavior;
the second full run above has zero failures. The original Host baseline failures were fixed in D,
not skipped or reclassified as success.

The first Space complete run exposed old private-owner construction and in-parent registry/fs
mocks that do not reach a separate Host. Public-daemon fixtures now use real loopback HTTP + Main
broker, trusted Host-loaded gated tools and real I/O failure markers. Existing question deadlines,
queue-frontier cancellation/replay, stale Stop, recovery/history and permission assertions remain.
Every isolated daemon fixture checks runtimeId, shuts down and waits before deleting its home;
the synthetic historical-active fixture alone verifies and kills its own non-executing fake owner.
No production admission or shutdown guard was relaxed to make the fixtures pass.

### Space product acceptance

Space Main uses actual shared config/auth roots, exact API/route/profile proofs, conditional
revisions and explicit legacy aliases. A different current CLI value is retained with a migration
warning; unreadable old storage is visible; tombstones block resurrection. Keys are not bulk
injected into process.env or returned to Renderer. An alias-only rename uses trusted route proof,
Core config CAS and an atomic staged write; a partial-ENOSPC RED/GREEN regression proves prior
config bytes survive write failure. Deletion captures its binding before removing config and
restores only its own Key revision if the config operation fails.

Native OAuth/cloud metadata and Main broker acquisition remain intact. Local OAuth revocation
fences pending replies and closes scopes before Host cleanup. New Host epochs reacquire authority.
Default client secrets use reserved auth.json records, while original active/retired/exitRecovery
identity values are unchanged during migration. A complete moved profile can reopen without the
old OS backend; failed import never invents a replacement identity. Partner accounts are untouched.
Details and executable fixture paths are in Space `docs/SDK_PROVIDER_CREDENTIALS.md`.

### Final verification ledger

Source reference is pi **`e7a0df27c09d11bf4161d3605246cbf57a129cb2`**, clean at final audit.
In the tables, “yes” means the declared connection/protocol contract is implemented and tested,
not that every possible remote model, parameter or entitlement was exercised. All live columns
remain explicitly **no**. KodaX's additional aliases and specific route optimizations are retained.

| Provider identity | Source-declared | Implemented | Contract-tested | Live-tested |
|---|---|---|---|---|
| amazon-bedrock | yes | yes | yes (offline) | no |
| ant-ling | yes | yes | yes (offline) | no |
| anthropic | yes | yes | yes (offline) | no |
| azure | yes | yes | yes (offline) | no |
| baseten | yes | yes | yes (offline) | no |
| cerebras | yes | yes | yes (offline) | no |
| cloudflare-ai-gateway | yes | yes | yes (offline) | no |
| cloudflare-workers-ai | yes | yes | yes (offline) | no |
| deepseek | yes | yes | yes (offline) | no |
| fireworks | yes | yes | yes (offline) | no |
| github-copilot | yes | yes | yes (offline) | no |
| google | yes | yes | yes (offline) | no |
| google-vertex | yes | yes | yes (offline) | no |
| groq | yes | yes | yes (offline) | no |
| huggingface | yes | yes | yes (offline) | no |
| kimi-coding | yes | yes | yes (offline) | no |
| meta | yes | yes | yes (offline) | no |
| minimax | yes | yes | yes (offline) | no |
| minimax-cn | yes | yes | yes (offline) | no |
| mistral | yes | yes | yes (offline) | no |
| moonshotai | yes | yes | yes (offline) | no |
| moonshotai-cn | yes | yes | yes (offline) | no |
| nvidia | yes | yes | yes (offline) | no |
| openai | yes | yes | yes (offline) | no |
| openai-codex | yes | yes | yes (offline) | no |
| opencode | yes | yes | yes (offline) | no |
| opencode-go | yes | yes | yes (offline) | no |
| openrouter | yes | yes | yes (offline) | no |
| qwen-token-plan | yes | yes | yes (offline) | no |
| qwen-token-plan-cn | yes | yes | yes (offline) | no |
| qwen-token-plan-individual | yes | yes | yes (offline) | no |
| radius | yes | yes | yes (offline) | no |
| together | yes | yes | yes (offline) | no |
| typesafe | yes | yes | yes (offline) | no |
| vercel-ai-gateway | yes | yes | yes (offline) | no |
| xai | yes | yes | yes (offline) | no |
| xiaomi | yes | yes | yes (offline) | no |
| xiaomi-token-plan-ams | yes | yes | yes (offline) | no |
| xiaomi-token-plan-cn | yes | yes | yes (offline) | no |
| xiaomi-token-plan-sgp | yes | yes | yes (offline) | no |
| zai | yes | yes | yes (offline) | no |
| zai-coding-cn | yes | yes | yes (offline) | no |

| API / operation / auth | Source-declared | Implemented | Contract-tested | Live-tested |
|---|---|---|---|---|
| openai-completions | yes | yes | yes (offline) | no |
| anthropic-messages | yes | yes | yes (offline) | no |
| openai-responses | yes | yes | yes (offline) | no |
| azure-openai-responses | yes | yes | yes (offline) | no |
| openai-codex-responses | yes | yes | yes (offline) | no |
| bedrock-converse-stream | yes | yes | yes (offline) | no |
| google-generative-ai | yes | yes | yes (offline) | no |
| google-vertex | yes | yes | yes (offline) | no |
| mistral-conversations | yes | yes | yes (offline) | no |
| pi-messages | yes | yes | yes (offline) | no |
| openrouter-images | yes | yes | yes (offline) | no |
| typesafe-system-one | yes | yes | yes (offline) | no |
| cloudflare-workers-ai-system-one | yes | yes | yes (offline) | no |
| llama-cpp-classify | yes | yes | yes (offline) | no |
| openai-decisions | yes | yes | yes (offline) | no |
| deferred submit / query / cancel | yes | yes | yes (offline) | no |
| OAuth: openai-codex | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: openai-chatgpt | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: github-copilot | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: anthropic | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: openrouter | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: kimi-coding | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: meta | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: xai | yes | yes (own registered client / grant) | yes (offline) | no |
| OAuth: radius | yes | yes (own registered client / grant) | yes (offline) | no |

OAuth login/refresh and cloud credential SDKs need the caller's own permitted registration and
actual identity. SIWC/Codex complete buffers native SSE; this is not native stream:false support.
Generated model data was absent in the Pi checkout; the inventory is not an exhaustive model list.
MiMo Coding aligns the Pi CN plan contract without changing the public MiMo route. MiniMax M Plan
keeps its official existing endpoint because Pi's public factory does not establish subscription
key/billing equivalence. No claim of real cache hits, retention, quotes-as-bills or calibration.
Windows ACL/DPAPI and actual local Host/Electron were exercised; macOS/Linux legacy-vault import
and customer-data migration require corresponding machine evidence. Space's locked Registry SDK
was not changed: production installer verification follows publishing/pinning accepted SDK bytes
and the existing exact-byte gate. Local source builds and dev links are not release artifacts.

### Standards

Final independent review: **0 hard violations / 0 smell findings**. Oversized adapter factory and
unsafe config writing were corrected; final helper, public Host fixtures and Electron regression
were re-reviewed. No new product-source changes followed the closing review.

### Spec

Final independent review: **0 remaining findings**. Alias fingerprint/name handling, missing
expected revision, deletion after config removal, partial-write preservation and four daemon
fixture lifecycle leaks each have corrected behavior and supplemental regressions. The reviewer
independently ran 10 focused tests; later Electron test review also reports zero findings.

### Concurrent workspace audit and integration boundary

Original Root HEAD **`f6a010462a477bd1b36dd849a6c9c0dbb0f76808`** is already an ancestor of this
branch. Its additional dirty changes were read only; they were not stashed, reset, imported or
overwritten. At final audit, overlap is concentrated in credentials/Host/broker, SDK Client,
sandbox, coding scope, package/build metadata and migration docs. The precise current dirty set
is volatile; the OS-temp `kodax-t12g-overlap-audit.json` records that snapshot. Reconcile those
hunks, preserve both contracts, then repeat Host/auth/recovery/type/published checks on the merged
code before integration. Passing this isolated branch does not certify the other thread's work.
Original Space HEAD **`7801a8ca099c4ecf47af5b1e361ff6812f8c12b9`** and its existing dirty fixture
were untouched; Pi was read only and clean. Independent branches remain available for integration.

Raw test/failure/coverage evidence remains in OS temporary storage: Root
`kodax-t12-final-monorepo*.log`, `kodax-t12g-*.log`, `kodax-t12g-pack-manifest.json`; Space
`space-parity-complete-final.log`, `space-parity-review-fixes-final.log`,
`space-parity-config-atomic-red2.log` / `space-parity-config-atomic-green.log`,
`space-parity-credential-coverage-final3.log` and `space-parity-electron-provider-ipc-final.log`.
No research draft or raw test output is committed as accepted design.

<a id="t12-h-upgrade-compatibility-acceptance-2026-10-31"></a>

## T12-H upgrade compatibility acceptance — 2026-10-31

H is an additional, unpublished upgrade slice after the A–G baseline above, accepted offline
after complete reruns and actual Electron verification. The current contract is
section 9 of the design and Space `docs/SDK_PROVIDER_CREDENTIALS.md`; the handoff index is Space
`docs/handoff/PROVIDER_UPGRADE.md`.
Space H is committed locally as `437cac7dfcee4d6f08a008eaee76531b4cdebdcd`, after baseline
`065cc39c`; its branch is clean. Root remains the isolated `codex/llm-provider-parity` branch.

### Account and recovery matrix

- The old single-record SDK and v1-read/v2-write remain usable. Batch API-key operations read a
  coherent snapshot and commit all CAS checks before any record; malformed, duplicate or stale
  changes preserve the full document. Tombstone revisions survive a second store instance.
- Old Space A and CLI B remain separate, including across environment removal and process restart.
  Migration writes only the private Space namespace and keeps old encrypted copies. Explicit
  publish/adopt compares private, shared and selection revisions; Save stays in the selected scope.
- Fresh/eligible discovery is protected and persistent. Fresh profiles do not probe global OS
  accounts; temporary old-store failure is unavailable, not absent. Different Space directories
  sharing one SDK root do not adopt each other's private source. Invalid identity metadata fails
  without including its content in the error.
- A pinned legacy origin that disappears before copying refuses environment/shared fallback;
  restoring that original allows retry. Configuration edits pin environment origins with a private
  tombstone and selection together, so they are not mistaken for an unfinished legacy copy.
- Initial source pin failure blocks use. A durably pinned original can continue after copy failure
  and retry. Pin/copy lost acknowledgement, concurrent adopt/remove, stale UI and deleted alias
  destination cannot revive a key or overwrite a newly chosen account. The deterministic late-pin
  RED reproduced both adoption overwrite and deletion resurrection; GREEN preserves both choices.
- API/route changes require an explicit credential choice, including returning to a historical
  route after another route was selected. The return-route RED reproduced silent use of a private
  backup after prior shared adoption; GREEN refuses, preserves both keys, then permits adoption.
- OAuth keeps original sealed records; current/revoked grants remain authoritative. Exact active
  and exit-recovery client identity bytes stay unchanged; temporary initialization failures retry.
  Persisted Space `legacy` mode takes the existing SDK shared-Host upgrade path with owner/busy
  checks. Retired third-party private embedded factories still require explicit migration.
- Explicit API-key-to-OAuth configuration uses the approved registration without trying obsolete
  API-key migration first. Proof is checked against the same captured OAuth connection; the old
  API key remains and grant presence uses its canonical profile, not the private storage namespace.
  Both the blocked acquire and false-negative status were reproduced RED and corrected GREEN;
  wrong proof and revoked grant still fail.
- OAuth A refresh held at the real file-store lock cannot delay a source-switch fence. Both
  OAuth-to-OAuth and OAuth-to-API regressions block a dummy refresh, select B, verify invalidation
  before releasing the lock, reject A's late broker result, and verify B after rebinding. Pending
  session publication and acquire both check the selected entry, and failures clear only their
  own pending entry. All requests use fake fetch and synthetic credentials.

### Verification ledger

- Root credential regressions: 19 passed. Scoped coverage with the existing authorizer regressions:
  96.03% lines / 83.41% branches / 94.33% functions; auth-file itself 96.22% / 86.28% / 93.47%.
- Root complete suite: 18,659 passed / 97 skipped / 19 todo across 1,348 passed and 6 skipped
  files. Published suite: 70 passed on the frozen build.
  CLI 5,176,458 bytes remains below the unchanged 5,177,344-byte budget; four budget/resource
  checks passed. Ten prompt literals moved unchanged to the existing static-text resource;
  independent AST/resource equality review passed. Source and test typechecks passed.
- Space final complete suite: release 130 passed / 7 skipped; Desktop 4,031 passed / 13 skipped;
  IPC 370 passed — 4,531 passed, 20 conditional skips, zero failures. Final 56-test credential/source
  regressions passed; scoped coverage across five affected modules is 91.30% lines / 82.38% branches /
  88.68% functions. This is not whole-repository coverage. Source/test types, lint and smoke build passed.
- Actual Electron: 2 passed on an isolated Windows desktop. Real IPC covers private save, explicit
  publish/adopt, cross-process shared update, stale delete, redacted state/config and approved env
  fallback. A full close/relaunch restores the provider files at the same path: removing env A does
  not dispatch CLI B; explicit adoption then dispatches B to an owned loopback fixture. This is an
  application restart test, not just Renderer reload. The separate identity tests preserve exact
  active/exit-recovery bytes; this E2E does not copy or certify client identity metadata migration.
- Independent Spec/Standards reviews report no remaining findings after first-pin, tombstone,
  late-copy race, return-route, metadata-error, OAuth-source and native-read fixes. Spec independently
  ran focused fixes, including a cold OAuth opening blocked by a real file lock; Standards performed
  static review. The main chat ran the complete suites. Final acceptance preserves all platform/release limits below.

The first complete Root run had 8 failed tests in 7 files: one tracker count inconsistency (the
completed feature count had no corresponding 302 row) was corrected; the remaining Host/Script
files passed all 60 tests in a sequential focused replay. The initial published run had a cold
startup timing failure and an auxiliary fixture AbortError; focused replay passed all 3 tests,
then the unchanged complete published run passed all 70. Space's first release stage had one
verified-shutdown hook failure; the same question fixture passed all 4 tests alone. Initial logs
are retained rather than replaced by later successful logs. Seventeen ancient Hosts from owned
isolated test fixtures were identified by exact executable entry, temporary home, creation time
and wrapper, then stopped with PID identity rechecks. No unknown or original-workspace Host was
terminated. Complete suites are rerun sequentially without weaker timeouts or assertions.

Space complete run 2 exposed two further integration checks: the new share IPC was absent from
the explicit owner manifest, and an old macOS strict-read test used a generic decoding error to
represent cancellation. The manifest now explicitly lists this Main-owned action (RED 2 failures /
GREEN 7 passed). Strict reads now distinguish ordinary failures (deduplicate, then retry) from
explicit cancellation/authentication denial (suppress until relaunch or explicit save). The latter
is tested with numeric status and nested cause, preserving the existing dialog protection. The
22 native-port/migration tests pass, including backend recovery; these are simulated darwin cases.
Status semantics were checked against
[Apple's Security header](https://github.com/apple-oss-distributions/Security/blob/main/base/SecBase.h)
on 2026-10-31. Source run 3 is the final complete rerun after these changes.

Raw evidence: OS-temp `kodax-t12h-full.log`, `kodax-t12h-full2.log`, `kodax-t12h-repro.log`,
`kodax-t12h-published*.log`, `kodax-t12h-auth-coverage*.log`,
`kodax-t12h-owned-orphan-cleanup.json`, `space-t12h-full1.log`, `space-t12h-question-repro.log`,
`space-t12h-late-pin-{red,green}.log`, `space-t12h-return-route-{red,green}.log`,
`space-t12h-discovery-redact-{red,green}.log` and `space-t12h-*` final run logs.

Windows local file/DPAPI, owned daemon and actual Electron evidence does not certify real
macOS/Linux vault migration, service subscription/cloud identities or production installer
upgrades. Backend recovery on simulated win32/darwin is an injected-port regression, not an
OS-account test. Old binaries cannot understand new selections/tombstones: arbitrary downgrade
or concurrent old/new refresh owners are not safe automatic recovery. Release the paired SDK
and Space through existing version/byte gates; backups remain recovery material, not competing
active authority. No versions, Registry locks or production packaging gates were changed.

H read-only concurrent-work audit: original Root advanced to `422acd4a84eb788e4bfe9d08da19ec5a4e2cc821`
with further execution-profile/recovery and Windows cleanup commits; the baseline common to this
branch remains `f6a01046`. Its 9 dirty paths were not imported. There are 23 overlapping paths in
the complete parity versus upstream changes, chiefly Host/broker, SDK/runtime, coding types,
bundle metadata and migration docs. Original Space remains `7801a8ca` with its existing fixture
and four new research drafts, also untouched. Pi remains clean at `e7a0df27`. The OS-temp
`kodax-t12h-overlap-audit.json` is that dated snapshot, not a guarantee that concurrent work stops.
These H test results certify the isolated branch, not the other chat's subsequent code.

## T12-I combined Host integration acceptance — 2026-10-31

This acceptance is separate from the historical H results. H checkpoint `95e95a61` is combined
with the other chat's committed local main `0fa38e5b213ee41eabb0f33e57f5353c5c507414`, preserving
both histories after `f6a01046`. The original checkouts and their dirty work are untouched.
Root's main development/default branch is named `KodaX`; this work remains on
`codex/llm-provider-parity`. The verified remote default is `KodaX` at `0f3930e95`, an ancestor
of local main (11 local commits ahead). The first remote check used the wrong token-header
format; the same existing token with standard Git HTTPS formatting succeeded. No push occurred.
Recheck both main and remote before an actual update.

Conflict resolution preserves both intents:

- Published tests include both parity operations/Responses/budget and upstream Windows cleanup.
- Managed tasks retain effective-config/profile reporting and connection-bound reasoning caches.
- Main authorization services retain full Host identity and the real `createExecutionProfile`.
- Exit tests retain the settled-view deadline and the newer Run diagnostic assertion.
- The profile helper checks that a request has a Session before using its Host catalog; a
  `provider_probe` deliberately has no Session. A broker server test now obtains its authorization
  through the real Product callback rather than treating bare Runtime as the expanded services.
- Space's private authorization helper declares only the credential service it actually consumes;
  its public request/return contracts and emitted JavaScript are unchanged. No profile method is
  faked, no public Root contract is weakened, and no new persona/Partner migration is claimed.

Initial compiler failures distinguished stale workspace declarations (rebuilt) from the actual
Session-union and bare-Runtime test mismatches above. Space's first typecheck likewise found five
bare-Runtime call-site errors; the narrow private-helper type correction passes typecheck.

The first combined CLI budget check failed: 5,196,241 bytes exceeded the unchanged 5,177,344-byte
guard. The correction reuses the existing coding static-text resource and loader: 18 adjacent
literal join groups and four static template spans across 15 files are coalesced, and 58 unused
private resource keys removed. Conditions/interpolation stay in code. Independent AST/hash review
verified all 22 resource values and reconstructed all 15 original source files identically.
The rebuilt CLI is 5,171,936 bytes; all four budget/resource checks pass. No dependency, loader,
configuration, timeout or budget limit was added or relaxed.

Combined candidate checks completed before the full suites:

- Source and test typechecks, packages/native/bundle/declaration builds passed.
- Root credential/OAuth/broker/Host-upgrade/profile/reasoning-cache/prompt slice: 16 files, 497 passed.
- Space credential migration/source/OAuth/client-secret slice: 37 passed.
- Space Host/broker/account-isolation/exit and recovery slice: 324 passed; types, lint and smoke build passed.
- Independent Spec/Standards incremental reviews report no findings. Spec independently checked
  four profile/recovery files (23 tests) and the server probe regression (one test); both reviewed
  the prompt extraction. Space transpilation equality was independently verified.

Root complete regression passed on the combined candidate: 1,358 files passed / six skipped;
18,747 tests passed / 98 skipped / 19 todo, zero failures, 1,149.21 seconds.
Frozen published suite: 71 passed. Historical owner/actual candidate npm tarball cutover: three
passed, including concurrent first startup, Session retention and old-owner rollback rejection
from v0.7.96 and alpha.11. The candidate tarball SHA-256 is
`b6efae83ea77e628ec8e6833f700f33fff045ab948de9cf9a1c319b450493118`.
Integrity-pinned real alpha.11 Host upgrade: one passed, preserving busy work and its Session.
The CLI SHA-256 is `2ef2cb4bce758bd9542c0df57a7d66ef5fcd05fe3117334faff45b93a2127483`.
Paired Space complete acceptance passed: release 130 / seven skipped and IPC 370 from the
complete run; final Desktop replay 3 has 4,031 passed / 13 skipped, zero failures (549.84 seconds).
Together the final tiers have 4,531 passed / 20 conditional skips. Release/IPC were already green
and unchanged; the test-only fixes below were verified by the complete Desktop replay.
Final source/test types, lint and smoke build passed. Actual Electron: two passed (35.1 seconds)
on an isolated Windows desktop. Save/share/CAS/redaction and full close/relaunch keep the selected
env account; removing env A cannot dispatch CLI B, and explicit adoption then dispatches B to
the owned loopback fixture. This remains separate from exact-byte client identity migration
tests. The Node sqlite ABI is restored after the Electron run.

Space's first complete run passed release 130 / seven skipped and IPC 370, with Desktop
4,030 passed / one failed / 13 skipped. The sole failure was a stale compatibility fixture
requiring a Partner Session to stay inline. A focused six-second replay reproduced it.
Upstream's accepted unified Host contract explicitly admits Partner Sessions; it retains
explicit permissions, tool ceilings and owner checks. The corrected fixture uses the actual
`productExecutionProfile` capability: v2 must create the exact Partner identity and read it
from the other process, while an absent capability must preserve the legacy admission denial.
An unsupported surface must still be rejected in both cases. Focused GREEN passes; independent
Spec/Standards reviews find no weakened assertions. Product behavior was not changed. The
complete Desktop tier was rerun; already passing release and IPC tiers are unchanged.

Desktop replay 2 exposed an unrelated connector fixture cleanup race: receipt assertions passed,
but its hook failed with `ENOTEMPTY`. Ten focused replays passed. The service records a final
receipt before its tracked background verification finishes the change notification's locked
store read; raw directory removal could overlap that read. The fixture now uses the existing
`deactivate` operation to block new work and drain active verification before deleting its owned
temporary directory. No product code, timeout, retry or business assertion changes. The complete
connector file passes all 35 tests; the complete Desktop tier was rerun after this correction.

Raw evidence is retained in OS-temp `kodax-t12i-*` and `space-t12i-*`, including the initial failures,
prompt extraction/equality receipts and the integrity-pinned alpha.11 historical artifact.

Final Spec/Standards code reviews report no remaining findings, including both fixture fixes;
the main chat ran the complete suites. Read-only final upstream audit at 13:15 Asia/Shanghai
confirms original Root remains clean at `0fa38e5b2`, remote remains `0f3930e95`, and original Space
remains `7801a8ca` with its pre-existing fixture change and four research drafts. The incoming
design gitlink `0f831024` is already an ancestor of the parity design history; it is retained.

Keep H's account-source, tombstone, OAuth refresh fencing, original identity and platform/live
limits. Original Space `7801a8ca` has its pre-existing fixture and research drafts; those changes
are outside this acceptance. Production packaging still requires published/pinned paired SDK
bytes and the existing exact-byte/installer gates. No main-branch update, version bump or release
is performed here. Carry the separate `docs/features` repository commit with Root.

Local paired checkpoints: Space I `da531f0aa30ef636c16e109b183944439d7cc278` (includes H history),
design repository `22bf9bf3332317a147fcb96595b8f42019bb12e4` (retains upstream `0f831024`).

## T12-J local main integration — 2026-10-31

User authorized safe local Root/main and design-submodule integration, post-merge regression and
review, while retaining Space on its independent handoff branch and prohibiting push/publication.
At the new preflight, main had advanced to `a9587af7eb930b5eb5708fd197a31f439a520025`: the other
chat's completed MCP/Skill merge, after I's `0fa38e5b2`. The original Root and design checkouts
were clean. These new commits were first merged into the isolated parity branch, preserving both
parents and their behavior; no file was resolved by choosing one side wholesale.

The automatically combined intersections retain authorized MCP-result restoration before
capacity accounting, physical provider/history/reasoning-cache binding, actual Host configHome
Skill lookup, persona/SA behavior, and the existing tool/profile/permission/owner fences.
The integration adds no product behavior, provider option or dependency beyond the two reviewed
parents, and does not relax their contracts.
The isolated candidate passed packages/build, source/test typechecks, 27 files / 629 focused tests
and four strict CLI resource/budget checks. CLI size is 5,176,120 bytes against the unchanged
5,177,344-byte strict guard. Independent Spec and Standards reviews found no issues in either
parent's delta or the merged tree `7b7506f85694d73e1fb30ab1b1769e6273386c02`.

The local main branch `KodaX` was fast-forwarded only after checking its exact expected HEAD,
clean worktree and ancestry, to `9674047c4a95f3d175c3206ea4113ec7ef42311a`, whose parents are
`8ec41f03f` and `a9587af7e`. The design repository imported the accepted local objects from the
isolated design clone, then fast-forwarded from `0f831024` to `22bf9bf`; no remote fetch, reset,
force, stash, or overwrite was needed. Both actual main checkouts were clean afterwards.
The design repository's old local `main` (`6afb99a`) was also ancestry-checked and atomically
fast-forwarded with its expected old value, then attached at the same `22bf9bf` checkout; its
remote-tracking refs were not changed. Subsequent design updates use ordinary fast-forward merges.

Main's new cloud dependencies were absent before integration. `npm ci --no-audit --no-fund`
installed the committed lockfile without editing it. Build and subsequent verification run in
the actual main checkout, not just the isolated source clone. Source/build manifests are captured
before and after the main suite to detect concurrent changes. The source suite uses two workers,
matching the latest main acceptance baseline, with `--retry=0`. No assertion, deadline or gate is relaxed.

Post-merge complete source passed in the actual main checkout: 1,362 files passed / six skipped;
18,777 tests passed / 98 skipped / 19 todo, zero failures, 2,737.45 seconds. The main HEAD and tree
stayed exactly `9674047c` / `7b7506f8`. All 3,267 non-Markdown tracked files and all 262 build files
retained identical raw bytes; no normalization exception was needed. Their aggregate SHA-256 values
are respectively `020a5373eef36b8c73e4caadfcf4acdeaabc0236b0402eb8af6702191a7dc13b` and
`1485834e9ca538cb8b0878e86251a2fe7e32bee6d4fde4aa9dff98bc01a28066`.
Frozen package/Host gates and final evidence are still in progress. I's counts remain historical
and do not certify this newer MCP/Skill combination. Space's product
code remains at independent commit `da531f0a`; this Root-only phase does not rerun or certify a
new Space build. Keep production byte/version gates and real-account/platform limits intact.
Raw evidence is OS-temp `kodax-t12j-*`; do not commit manifests or raw runs.
