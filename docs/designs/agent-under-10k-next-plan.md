# Agent below 10K: capability-preserving next candidate

2026-10-27. Status: **source-backed proposal, not implemented or adopted**.
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
