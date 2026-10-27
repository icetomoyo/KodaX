# Agent below 10K: capability-preserving next candidate

2026-10-27. The original plan below is retained; the execution record at the end distinguishes implemented changes from remaining proposals.
Production checkpoint `c5c296ff` is committed and pushed. Its broad offline
acceptance, repaired fixture drift and explicit unverified scope are recorded in
[the capability acceptance guide](../test-guides/FEATURE_WORK_MODES_v0.7.97_TEST_GUIDE.md).
No new paid model calls were made for this analysis. SDK, specialist profiles,
AMA policy, native handlers and Coding default remain unchanged.

## Current complete input, not just system text

Same Windows Runtime Host, empty project, official builtins, actual OpenAI SDK
serialization intercepted locally. Count only nonempty system, instructions,
messages, input and tools using [the uniform method](first-turn-uniform-costs.md).
These are heuristic estimates, **not provider tokenizer counts, bills or UI usage**.
All nested Script contracts are included. Temporary paths/session facts are
normalized. Counts below supersede historical KodaX rows for this checkpoint.

| Mode | UTF-16 characters | UTF-8 bytes | Estimated tokens | Native entries |
| --- | ---: | ---: | ---: | ---: |
| Agent | 45,606 | 46,090 | **11,583** | 36 |
| Coding | 60,102 | 60,606 | **15,215** | 54 |
| Script | 67,581 | 68,085 | **17,085** | 25, including nested leaf contracts |

Source: OS Temp `kodax-first-turn-wire-Tr0MDA`, `inventory.json` records source
hashes. Re-serialized complete model-field SHA-256 values:

- Agent: `763fdf28f48d7bf8eac903285aa1381b2d831b8de5e67ae8b95daae654e0fe55`
- Coding: `7cbf1984f2de17e59abc95eacd93ba3924b74215f6fb319af5bcd1dcfb6b23aa`
- Script: `3b948daaa53c56896dbbaa23a7f2c1db42a2a7ee69f0193ce31fa62823a689e0`

Agent comprises system **3,812**, dynamic context/user **1,092**, tools **6,676**;
the remaining 3 come from combined JSON framing/rounding. Against the matching
historical Agent 14,376 input, the reduction is **2,793 (19.4%)**. This is a named
checkpoint comparison, not an assertion about the original project's first release.
Strictly below 10K still requires at least **1,584** fewer estimated tokens.

## External comparisons and their limits

| Reference | Same-counter estimate | Evidence scope |
| --- | ---: | --- |
| Codex Sol Direct / mixed / Only | 15,174 / 18,476 / 17,047 | Historical Windows capture, `deede7201`; **not current HEAD** |
| DSH Standard / PTC | 9,499 / 11,326 | Current revision's tracked Bash snapshots mapped through serializer, not new Windows HTTP capture |
| DSH Minimal Bash / Pwsh | 477 / 463 | Reduced capabilities; Pwsh is a source projection |
| Pi default / specified extensions | 1,414 / 2,282 | Source renderer/schema projection, not installed-provider capture or all plugins |

Methods and exact revisions are preserved in [uniform costs](first-turn-uniform-costs.md).
The numerical gap to DSH Standard is 2,084 and to Pi's selected extensions 9,301,
but these are **not equal-capability optimization budgets**. The latest local
Codex full request has not been captured; its Sol base template alone is 5,446
estimated tokens and cannot be compared with KodaX's complete input as a total.

Current local source review, without pulling:

- **Pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`:** default tools are
  read/bash/edit/write (`packages/coding-agent/src/core/settings-manager.ts:85`).
  The prompt collects tool-contributed guidelines with exact-text deduplication
  (`core/system-prompt.ts:88–124`). Todo, questions, plans and subagents are
  extensions that add their own contracts. Current builtin codemode exists but
  is inactive by default (`src/extensions/codemode/index.ts:2–5`). Its optional
  describe/search path is not automatically a zero-round-trip substitute.
- **DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`:** Minimal disables optional
  runtime context and text read/write/edit (`packages/bundle/web-app/presets/minimal.patch.yml:15–22`).
  Standard includes a much wider plugin surface. PTC still renders complete
  argument/output contracts (`packages/core/tool-executor-ptc/src/index.ts:40–49`).
  Shared delegation teaching has one contributing tool
  (`packages/subagent/tool-subagent/src/index.ts:363–379`).
- **Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`:** model `tool_mode` takes
  precedence over feature defaults (`codex-rs/core/src/tools/mod.rs:64–86`).
  Local Sol and 5.6-Terra entries specify `code_mode_only`; feature default false
  does not mean the actual model uses Direct. Only still teaches nested leaf
  contracts (`core/src/tools/spec_plan.rs:1020–1090`). Model switching recomputes
  ModelInfo/settings, not a hardcoded Sol/Terra toggle. Its smaller plan schema
  and different delegation policy are not substitutes for KodaX's richer Todo/AMA.

The useful lesson is information ownership and compact complete interfaces.
Low injection does not itself prove equal intelligence; long teaching is also
not a necessary condition for a strong harness.

## One coherent next candidate

Use existing managed-system/tool projections. Do not introduce another mode,
rule engine, keyword router, schema discovery step or configuration switch.

| Work | Smallest scope | Effective constraints that must survive |
| --- | --- | --- |
| Single owner for shared rules | Jointly reorganize collaboration, Todo, Memory, editing and interaction across system and tools | Keep planning/dispatch decisions, independent-read batching, no duplicate child work, completion evidence, refusal recovery and memory authorization |
| Complete parameter teaching | Audit the actual 36-tool menu, especially ask/spawn/Todo/grep; shorten duplicate annotations only | Every field/type/required/enum/default and operational distinction; flat vs batch question limits, incremental Todo/evaluator semantics, grep paging/literal modes |
| Facts versus repeated policy | Capacity/route context carries current facts; Skills usage and platform guidance taught once | Actual capacity, unknown versus zero, refresh conditions, active shell/OS and skill catalog remain visible |

Global system text owns when/why and cross-tool invariants; directly available
tool contracts own invocation, defaults, result meaning and failure conditions.
Each retained rule gets an identifiable owner in the final **combined** request.
SDK, host overrides and specialized roles retain canonical contracts under the
existing provenance/full-menu gates. This must not weaken AMA's dispatch policy.

These are measurable audit surfaces, **not promised savings**:

- ask_user_question 801; spawn_agent 550; todo_update 411; grep 355 total tokens.
  Their schemas contain real behavior, not merely verbose descriptions.
- Six larger tools' parameter annotations occupy about 1,168 in total. Even
  deleting all of them, which is unacceptable, would not close the 1,584 gap.
- Skills usage 342 plus three builtin catalog entries 363: approximately 705,
  only 6.1% of Agent total. Skill bodies are not injected. Keep catalog visibility;
  audit duplicated usage rules rather than hiding skills behind another call.
- Platform/role tail 321; capacity 200; route facts 78. Only duplicate instructions
  can go; these blocks cannot be counted as wholly removable.

Repo/LSP/code_search are already absent from this Agent initial menu, so hiding
them again cannot reduce its 11,583. Script's complete-contract representation
may be studied separately, but its gains cannot count toward Agent's target.
Moving text between system/user, caching, or hiding schemas behind discovery
does not satisfy a reduction in complete first input without added round trips.

## Verification and stopping rules

1. Freeze a full candidate and a rule-owner map before measuring. Review effective
   edit semantics explicitly: KodaX multi-edits are sequential, unlike Pi's
   original-file anchor semantics. Retain explicit independent-read batching.
2. Assert identical tool sets and structural schemas; check annotation rules
   separately. Verify both provider serializations and Agent/Coding/Script, SDK,
   host override and specialist exclusions, including bound MCP/Repo contexts.
3. Exercise existing read/edit/test/AMA completion, readonly child refusal and
   legal recovery, cancellation, permissions, capacity changes, Todo veto and
   session recovery. Compare exact adapter-call counts in deterministic traces.
   Preserve existing guards and raw model output; do not revise inputs to pass.
4. Measure the complete request with the same counter. Report real net savings
   and remaining gap. Do not treat the cost of an audited block as savings.
5. Only unresolved behavioral questions justify bounded model evidence, following
   [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md): reuse existing natural
   checkpoints, freeze baseline/candidate, preregister calls/tokens/cost, review
   blind pairs and distinguish shared model errors from prompt regressions.
   Full-task smoke is separate from prompt-comparison evidence. No new matrix
   for a small saving and no rerunning until pass.

Adoption requires retained task quality and recovery as well as no added
discovery round or credible increase in task calls, total tokens/cost or latency.
Deterministic equality cannot alone prove natural-language intelligence equality.
If the complete candidate cannot save the required amount safely, report that
limit and retain the effective rules; do not break interfaces to force a number.


## Execution record: rule ownership candidate

Baseline: `3df6f10f`, ordinary managed roots only. This batch uses the existing
projections; no tool is removed/deferred, no parameter type/required/default/enum
is changed, and no handler, dispatch strategy or discovery step is added.
Canonical SDK and specialist instructions remain unchanged. The existing
independent-read batching, full mutation discipline, Repo policy and explicit
refusal-recovery paragraph are retained verbatim.

### Rule retention map

| Rule family | Final owner / unchanged boundary |
| --- | --- |
| Synthetic envelope authority, untrusted embedded markers, stale evidence, compaction checkpoints/deltas | Worker TRUST AND SCOPE |
| Scope revisions, contrary evidence, reuse of verified evidence, requested language | Worker TRUST AND SCOPE; language includes Todo and child objectives |
| Trivial versus substantive plan, same-response reads/dispatch, no acknowledgement-only round | Worker TASK AND PLAN |
| Existing-plan reuse, scope growth, deduplication, one active item per owner, milestone evidence | Worker TASK AND PLAN |
| Description only when useful, activeForm on every milestone, deterministic evaluator | todo_create parameter teaching; todo_update preserves transition/evaluator/veto rules |
| Unknown/external plan changes versus ordinary turns; no redundant refresh | Worker TASK AND PLAN and tool invocation conditions; existing state machine unchanged |
| Independent lanes, broad review, root blocker, solo exceptions | Worker PARALLEL WORK |
| Exclusive writes, stable verification target, no duplicate/reapplied work, root integration | Worker PARALLEL WORK; spawn isolation field retains worktree merge-back |
| Child goal/evidence/output shape, data versus prescribed shell, readonly investigation | Worker PARALLEL WORK and spawn parameters |
| fast/balanced/deep, evaluated readonly fast, write-capable fallback, inherited tiers | spawn model_hint; system says choose intentionally using its contract |
| Parent permission ceiling, canonical identity, history, effort conflict, evidence refs | Existing spawn fields |
| Concurrency/work budget, no retry while full, no capacity through recursion | Worker PARALLEL WORK; atomic enforcement unchanged |
| quality_strategy optional telemetry, invalid data ignored, never admission control | spawn tool/field; system retains no dispatch delay |
| Mailbox evidence versus wake acknowledgement, terminal summaries, sparse waiting | Worker lifecycle decisions; wait_agent result contract |
| send does not wake idle Actor, broadcast cap 20, followup starts a turn | send_message/followup_task contracts; system retains evidence communication decisions |
| Interrupt conditions, cancellation, live descendant ownership and final settlement | Worker PARALLEL WORK |
| Refusal versus invalid input, legal recovery, budget/cancellation, truthful delivery | Unchanged recovery/delivery and mutation discipline |
| Memory authority, legitimate intent, no file/shell bypass, applicability and receipts | compact Memory section |
| Exact quote/span/key/ref, decision authorization, requested decisions/show | memory_intent contract, required by existing full-contract gate |
| Skill match/invoke before response, no guessed names/read bypass, no duplicate host invocation | Original dynamic-envelope Skills teaching and catalog unchanged |
| Actual OS/cwd/provider/model, unknown-host fallback | Original Environment unchanged; shorter workspace tail only when that environment is present |
| Scratch as last resort, automatic parent creation, empty dirs, missing-command recovery | compact workspace tail; same canonical strings remain for other consumers |
| Exact machine-readable closing and completion authority | compact closing rule |
| Question flat/batch, free text/select, options/default/expiry, custom fallback, multi-select bounds | ask_user_question shared description plus distinct field annotations; original schema untouched |

The first independent review caught one lost obligation: supplying activeForm
at milestone creation had been reduced to a field definition. The requirement
was restored to todo_create's field teaching, with a failing-then-passing check.
The newly projected question contract also has its own canonical drift hash.
No acceptance guard was weakened to address this finding.

### What was deliberately not changed

The remaining Agent tools were reviewed as part of the joint contract: file and
shell editing/recovery, grep paging, Goal authorization, manual version routing,
search/bridge, history, Memory and Actor lifecycle all carry real operation
semantics. No further parameter was hidden to save their schema structure.
In particular the dual-form question interface stays intact. Canonical tool
schemas and handlers remain the source of execution truth.

Dynamic capacity/route and Skills messages are unchanged. They contain state and dispatch
limits; compressing them requires a separate provenance-aware message boundary,
which is not justified for their small cost in this batch. Actual wire inspection showed that Skills teaching is in the dynamic user envelope, not system. A trial system-only projection and its new Agent-package export were withdrawn because they supplied no production benefit; an artificial system fixture was not accepted as production savings. Repo/LSP/code_search
remain as before. Script receives the same shorter shared contracts, retaining
its complete leaf-schema presentation and native undo/background shell boundary.

This batch's adoption evidence is offline contract/execution equivalence and
independent source review. It adds no statistical model-quality guarantee.
No paid model calls or repeated matrix were used. Further reduction is not
justified solely to hit 10K if it sacrifices useful constraints or introduces
new discovery/refresh calls.


### Final measured request

Same uniform method and baseline as above, final pre-withdrawal capture
`kodax-first-turn-wire-2RqlDv` (the withdrawn Skills branch never matched these
production requests). OS Temp `kodax-rule-owner-final-comparison.json` preserves
all 32 comparisons and additional source fingerprints. Final post-withdrawal
checks are listed below; no projected future saving is included.

| Mode | Before | After | Net reduction | After UTF-16 / UTF-8 |
| --- | ---: | ---: | ---: | --- |
| Agent | 11,583 | **10,712** | **871** | 42,122 / 42,606 |
| Coding | 15,215 | **14,344** | **871** | 56,618 / 57,122 |
| Script | 17,085 | **16,214** | **871** | 64,097 / 64,601 |

The 32 protocol/mode/scenario comparisons retain every native schema structure
and non-system message. All eight internal SDK complete requests are equal.
All eight Script captures retain byte-equivalent parsed leaf contracts (23 or
31 leaves according to host capabilities). Shared control and system teaching
accounts for the reduction, not fewer leaf tools or additional discovery calls.

Agent is down 7.5% from this batch's baseline and 25.5% from the named historical
14,376 checkpoint. Strictly below 10K still needs **713**. The existing DSH/Pi
scope and historical Codex limitations above still apply. No claim is made that
an equal-capability KodaX can reach Pi's size or that this is a current Codex
full-request measurement.

Complete model-field SHA-256, Agent/Coding/Script respectively:

- `978be98ee904de31644dda86e9f331ee79648f274f84163a2ff4b0342b5ca591`
- `d3d386fc36e95cee540246cd0ab831c3e591810e708db77a6264dbad6014f765`
- `b9c5b2ea2e054d0f3e47225711f0cfca5035d162be3acffac9e100994981250c`


### Validation and disposition

Implemented in the ordinary-root default projection for all three work modes;
no optional feature flag was introduced. Coding remains the default work mode.
This is not an unadopted experiment. SDK/host-specialist exclusions remain.

- TDD: question annotation ownership, workspace/platform rendering and the
  reviewed activeForm obligation each failed before their implementation/fix.
- Related prompt/tool/role regressions: **335 passed**; final post-withdrawal
  projection/historical-fixture checks: **26 passed**. These groups overlap and
  should not be added as unique coverage.
- Actual Runtime editing/refusal/AMA/Script and natural fixture runs: **37
  passed** in six files before withdrawing the ineffective Skills branch.
- Full fast tier: initially **2,856 passed, 4 failed, 45 skipped**. Three failures
  came from the frozen historical experiment using current tool descriptions.
  Its fixture now explicitly reconstructs the prior contracts; the frozen hash
  gate is unchanged and a new test rejects current contracts in that old
  projector. All six historical-fixture cases pass in the 26-case follow-up.
- The fourth failure hit the existing **5-second Script cell deadline** during
  suite load. The complete file passed **15/15** in one isolated rerun with no
  code, deadline or isolation changes. This is evidence of a load-sensitive
  fixture, not permission to claim the original full command passed.
- Final source and test type checks and full build passed. Actual installed npm
  tarball checks passed **2/2**, including shared three-mode question contracts,
  Script read and durable receipts, exact two execution calls, and explicit
  missing-worker failure. The obsolete assertion that a managed question's
  wording must equal the SDK's canonical wording was replaced by full
  cross-mode equality and schema-structure equality with SDK.
- Final actual SDK wire capture: **32/32 normalized requests equal** before and
  after Skills withdrawal. Final directory `kodax-first-turn-wire-eXlkwk`;
  inventory SHA-256
  `76a4fbecb837f8382b48322ddd5e5dd4c90134d97dfb36742c371a7aee3097e1`.
  The earlier baseline comparison therefore remains applicable, including all
  native schemas, eight SDK full requests and eight sets of Script leaves.
- Independent Standards review: **0 findings**. Independent Spec review:
  **1 P2 found and fixed**, final **0 unresolved findings**. No model generation
  output was modified and no frozen experiment acceptance fingerprint expanded.

Raw logs use OS Temp prefix `kodax-rule-owner-`; no raw evidence or research
scratch files are tracked. There are no unresolved executed-check failures after
these targeted corrections, but this is not a freshly green rerun of all four
full-repository tiers or all platform/package gates from the prior acceptance.
No new live-model quality, bill or end-to-end latency claim is inferred. Existing
full-task call-count/recovery checks remain unchanged; model semantics beyond
those checks are not statistically certified by this batch.

Remaining under-10K work is **not yet justified implementation**. Skills and
capacity teaching in the dynamic envelope are the identified remaining duplicate
surface, but their useful facts/catalog must remain and removing all of them is
neither valid nor enough evidence of a safe saving. A future joint candidate
must first demonstrate the remaining 713-token reduction at that actual
provenance-aware boundary, with unchanged messages' facts and no extra lookup.
Do not add a new router, hide parameters or run a paid matrix merely to force
10K. The current verified reduction can stand independently of that target.
