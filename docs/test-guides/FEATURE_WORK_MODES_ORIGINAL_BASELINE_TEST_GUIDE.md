# Original-version comparison — 2026-10-27

## Scope frozen before generation

Compare the parent of the first input optimization,
`bd4479d59cab3d082f07c2d34681fff198d82fa0`, with `c9645bc9`.
The original has AMA Coding only; Agent and Script are current-only surfaces.
This is a **product-version** comparison, not attribution of every difference
to prompt compression. Dependencies, bug fixes and tools also evolved.

First reproduce both versions offline with their own source aliases and real
provider SDK serialization. Count the same nonempty model fields, in order:
`system`, `instructions`, `messages`, `input`, `tools`. HTTP control fields are
excluded. UTF-16 units, UTF-8 bytes and the repository heuristic are reported
separately from actual provider usage. No API bill is inferred from characters.

The original archive may borrow current external dependencies; this limitation
and lockfile differences must be recorded. Internal package imports must resolve
to the original archive. No original production source may be adapted to pass.

## Bounded behavioral check

Layer 1 cannot determine whether a model still makes a correct repair decision
or reports the scope of verification truthfully. Use two existing natural,
local-session-inspired cases with their actual Runtime input contracts:

1. `symptom-repair`: the real second request after one batch of three reads of
   README, recovery implementation and public tests. Review safe-restart logic,
   identity/tree/resource checks, preservation of unknown task outcome, scope
   and whether the next action makes useful progress. A legitimate further
   evidence request is not automatically a failure.
2. `verification-followup`: answer a natural verification question using supplied
   receipts. Distinguish unit coverage from OS integration; do not invent tests,
   force a plan/delegation/discovery, or rerun adequate existing checks.

Both are Layer 2 checkpoints of real histories. Proposed tools are observed,
not executed by the paid probe. They do **not** prove complete-task success,
end-to-end round non-inferiority or statistical intelligence equivalence.
Compare deterministic first/second-request costs separately from actual API
usage on these checkpoints; never label their sum a completed task's bill.

Pilot: GLM (`zhipu-coding/glm-5.3`) and Kimi (`kimi-code/kimi-for-coding`),
one sample per version and case: at most **8 calls**, one per cell, no retries
or fallback. Run repair pairs first, inspect task validity, then the reporting
pairs. One in-flight request per provider; independent providers may overlap.
Use the same current transport/settings for both frozen inputs, so this probes
old/current harness contracts rather than historical API transport behavior.

Hard limits: 8 calls, 1 round/cell, 8,192 output tokens/call, 1.2M total reserved
or charged tokens, USD 3 reference cost, 180 seconds/request. Coding subscriptions
have no measured marginal dollar bill; cost rates are reference accounting.
Reserve conservatively before dispatch, persist receipts before the next call,
charge unknown usage at its reservation, and stop on transport/accounting error.
Never reset an older experiment ledger or rerun a failed cell to obtain a pass.

Randomize and conceal version labels during main-session paired review. Preserve
raw inputs, outputs, physical request observations, usage and wall time in OS
Temp with two backup copies. Freeze input/driver hashes and the experiment
revision. Review each pair for task validity, correctness, necessary next work,
truthfulness, meaningful regressions and attribution (`eval-design`,
`provider-noise`, `version-regression`, `inconclusive`). Report sample counts;
do not convert this small pilot into a universal no-regression claim.

## Dynamic-context disposition

No dynamic teaching is changed during this comparison. Audit the actual dynamic
user envelope and subsequent delta path, not a synthetic system-only fixture.
Keep AMA, SDK, specialist roles, catalogs, facts, tool execution and capabilities.
Only consider a follow-up change when savings survive complete-input counting
and useful rules remain at a clear owner without extra discovery or round trips.

## Results — 2026-10-27

The requested initial commit was pushed as `c9645bc9` to `origin/KodaX-next-dev`.
No production behavior was changed during this audit or comparison. The new
files are an explicit manual probe, offline checks and this evidence record.

### Original source and capture validity

`bd4479d` is the direct parent of `de3d8ff9`, the first input optimization.
The earlier 14,376 checkpoint was already optimized and is not this baseline.
The original was exported into OS Temp, with production files unchanged.
The 16 original wire cells passed; 968 resolved source paths and the package
entrypoints were checked against the archive, not today's workspace packages.
External node_modules were borrowed: 16 lockfile entries differ, primarily
canvas/pdfjs and the newer QuickJS dependency. Original `tsc` still reports
two artifacts/pdfjs type errors; source-alias captures work. This is not an
original binary/package acceptance claim.

Current fast-tier execution also generated a new 32-cell wire inventory with
source metadata explicitly at `c9645bc9`. Do not confuse the earlier same-byte
candidate capture, whose Git HEAD metadata was `3df6f10f`, with a committed run.

| Real Windows Runtime Host input | UTF-16 units | UTF-8 bytes | Heuristic tokens |
| --- | ---: | ---: | ---: |
| Original AMA/Coding | 113,763 | 114,543 | **28,734** |
| Current default Coding | 56,618 | 57,122 | **14,344** |
| Current Agent | 42,122 | 42,606 | **10,712** |
| Current Script | 64,097 | 64,601 | **16,214** |

Coding decreases **50.08%** in this fixture. Original Agent/Script did not
exist, so their differences from original Coding are not same-mode savings.
The historical 28,805 includes HTTP control fields; it is reproduced, but not
used as the denominator above. Personal/project instructions, actual MCP
bindings and catalogs can increase real-user inputs beyond this fixture.

Measured separately, system-message arrays decrease **7,956 → 3,555** heuristic
tokens; tool arrays **19,567 → 9,625**; non-system message arrays **1,206 → 1,160**.
These component counts have their own JSON delimiters/rounding and are not
additive exact totals. Most savings are tool contracts and shared system teaching,
not removal of dynamic facts or Skills catalogs.

Original/current Coding menus contain 66/54 entries. The 12-entry difference
does not mean 12 capabilities disappeared: `multi_edit`, `changed_diff_bundle`,
`tool_describe`, `todo_get` and LSP prepare have existing combined replacements;
local `code_search` leaves the ordinary default menu but retains SDK/provider
compatibility; five MCP entries are absent because this fixture has no MCP
binding; `run_skill_script` has no effective runner binding. Repo narrow tools,
AMA, SDK and specialist execution remain. This inventory is not a new all-tool
behavioral proof; it explains why menu size is not a lost-capability count.

Evidence: Temp `kodax-first-turn-wire-9I4HI8` (original),
`kodax-first-turn-wire-a6QpYK` (current), and
`kodax-eval-dumps/original-version-checkpoints-r1-20261027/uniform-report.json`.
Recount uses the tracked `tests/first-turn-uniform-costs.ts` implementation.

### Same natural first/second-request trace

Both versions ran the same current test harness against their own Runtime
sources, without production adaptation. Public fixture files, natural request,
three actual read results and fixture Git revisions agree. Paired inputs only
normalize generated workspace/session paths and message time/IDs. The reporting
case uses the same actual current test receipts after asserting the only receipt
difference was three `duration_ms` values. System/tool contracts and routing
facts remain each version's own bytes. Raw originals and transformation hashes
remain available; this is controlled normalization, not rewritten model output.

Serialize both frozen histories through the same current OpenAI SDK, intercepted
before network. Skills are empty and LSP/Repo are explicitly off in this natural
fixture, so these rows intentionally differ from the full Runtime Host table.

| Fixed trace input | Original | Current Coding | Unit |
| --- | ---: | ---: | --- |
| First request, before reads | 27,866 | 12,390 | heuristic tokens |
| Second request, after identical three reads | 28,612 | 13,135 | heuristic tokens |
| Sum of these two requests | **56,478** | **25,525** | heuristic input tokens |

The two-request fixed-trace reduction is **54.81%**. It is not a completed-task
bill: the fixed history contains no model repair, testing or AMA completion.
Real tools add history to each later request, and different decisions can change
round counts. Do not extrapolate this saving linearly to arbitrary tasks.
Zero-network capture: Temp `kodax-original-history-wire-0m972R/report.json`.

### Real-model paired observations

All **8/8** pre-registered calls completed with physical-attempt and usage
receipts; no retries, fallback or model-output repair. Each version/provider/
case has **one** observation. Models used the same current transport and settings
for both frozen inputs; historical provider behavior is not being recreated.

| Checkpoint / model | Original input / output tokens | Current input / output tokens | Original / current request time |
| --- | ---: | ---: | ---: |
| Repair after reads / GLM 5.3 | 25,562 / 15 | 11,733 / 15 | 6.00 / 10.14 s |
| Repair after reads / Kimi | 24,042 / 56 | 10,769 / 55 | 3.68 / 3.30 s |
| Verification report / GLM 5.3 | 25,836 / 342 | 12,006 / 112 | 9.90 / 7.85 s |
| Verification report / Kimi | 24,103 / 281 | 10,833 / 197 | 8.12 / 5.23 s |

These are provider-reported token counts, not the heuristic above. Cache reads
are included in provider input totals: reporting GLM original/current
17,920/7,936; Kimi 16,128/6,656. Request time excludes future tool execution and
continuations, so faster response here does not establish faster task completion.
Across all eight calls: **145,957 total tokens**. The local coding-plan rate table
produces **USD 0.00416282 reference accounting**, not an invoice, verified current
market price, or measured marginal subscription cost.

Main-session reviews were saved with concealed version labels before reveal:

- **Repair:** 4/4 responses request the same relevant `examples/restart.mjs` read.
  Neither version adds a discovery/plan round at this checkpoint. No model patch
  was produced, so these samples do not evaluate repair correctness or completion.
- **Reporting, GLM:** original directly gives a bounded, truthful answer; current
  requests Git inspection plus `node --test`. Current therefore needs at least a
  tool-result continuation to answer. This is an observed efficiency disadvantage
  in this sample, not a reason to claim no additional round trips.
- **Reporting, Kimi:** both request Git inspection plus a test rerun (two bash
  calls in one response). The extra work is shared, not uniquely introduced by
  compression. Neither has yet delivered the final verification answer.
- No sampled response fabricated a passed check. However only **1/4** reporting
  responses finished directly; none of the repair probes completed a repair.
  Do not report these as eight passed tasks or an intelligence-equivalence result.

Offline attribution found that both effective versions retain the rule to cite
already verified evidence and reverify only after changes/conflicts. Current
`compact-worker-contract.ts` retains it in TRUST AND SCOPE; original
`worker-role-prompt.ts` has the expanded equivalent. Therefore this is not evidence
that the rule was simply deleted. One sample cannot separate version wording
effects from model variance. Also, the reporting fixture embeds real receipts in
a user-role prior-context message rather than replaying original tool-history
messages: whether rechecking those claims is unnecessary in production is not
fully established. This limitation applies to **both** versions and does not
erase the observed extra work. Attribution remains **inconclusive**.

Disposition: retain the measured existing savings; do not add more compression
or revert the whole optimization from this one uncertain pair. Future validation
should target faithful receipt continuity and complete-task efficiency, with a
single bounded comparison if needed. Do not repeat the full panel or add a
case-specific instruction just to make this fixture pass.

### Bounded full-task observation, registered after the checkpoint review

The repair probes all requested another legitimate read, so they cannot answer
the user's full-task quality/token question. Add **one task, two Runs**: original
and current Coding on `zhipu-coding/glm-5.3`, same natural `symptom-repair` fixture,
unchanged guard, public tests and independent hidden oracle. This is L3.5
product-version observation; it must not be used as isolated prompt attribution
or statistical non-inferiority. Do not extend the model/mode matrix or rerun a
failed Run. The two versions execute sequentially in one provider lane.

Per Run: at most 32 shared root/child/auxiliary provider calls, 80 tools,
1.2M tokens, USD 0.30 reference reservation/charge, 8,192 output tokens per
request, 180 seconds per request and 600 seconds total. The existing fixture
permits at most one read-only child; no worktree, isolation or command whitelist
is broadened. All actual calls count, including Runtime auxiliary judgments.
Two-Run ceiling: 64 calls / 2.4M tokens / USD 0.60 reference, additional to the
completed eight checkpoint calls. Outcomes may finish well below these caps.

Use each version's actual Runtime and provider implementation; record source
hashes. This intentionally includes historical Runtime/provider differences.
First verify the original archive's read-only, permission, budget and cancellation
guard paths offline. At completion, inspect source patch, protected-file hashes,
public tests, hidden safety/original-receipt oracle, final report, AMA terminal
state, refusals/recovery and request counts. A successful test-harness process
means an observation was saved, not that model quality automatically passed.

Preflight exposed two archive-only execution prerequisites. The copied scripted
test initially used current `edit.edits[]`; original advertised top-level
`old_string/new_string`, so only that offline scripted call was adapted to its
native schema. The independent oracle still failed. Saved edit receipts then
identified the real remaining blocker: the Git archive had no generated Windows
text-transaction native artifact, so editing returned an explicit unavailable
error and the original file was unchanged. Both revisions' entire native Git
tree is `ca20e5243da717005031d9c257c3b3317e4c28d5`; loader/text-transaction source
and protocol are also unchanged. Reuse of the current built artifact was recorded
by file SHA-256 (text binding
`7239d5bf5bc751622e8309aee5284f3536d121a1655353e540d07701e928e385`).
This is a shared binary for identical source, not proof of a historical release
build. Original offline read-only, budget, cancellation and guard checks passed
5/5; after staging the missing artifact, the Coding read/refusal/edit/public-test/
hidden-oracle trace passed. No production source, paid model argument, output,
guard or oracle was changed. Failures and compatibility notes remain in the
original archive and Temp `kodax-original-offline-edit-diagnostic.json`.

Both paid Runs completed once, without intervention or retries. Actual GLM
usage and wall time (Runtime execution only, excluding import/startup and the
harness's post-Run oracle) were:

| Complete task observation | Original | Current Coding |
| --- | ---: | ---: |
| First request input, provider usage | 24,935 | 11,105 |
| Root model requests | 9 | 15 |
| Child / auxiliary requests | 0 / 0 | 0 / 0 |
| Tool calls | 10 | 21 |
| All-request input tokens | 246,673 | 219,346 |
| All-request output tokens | 2,691 | 3,024 |
| **Whole-Run total tokens** | **249,364** | **222,370** |
| Input cache-read tokens (included above) | 235,072 | 187,008 |
| **Run wall time** | **83.04 s** | **119.12 s** |
| Fixture refusals, none executed | 2 | 3 |
| Public + model-added tests | 7/7 | 7/7 |
| Independent hidden safety tests | **4/5** | **4/5** |
| Protected files unchanged / AMA terminal | yes / completed | yes / completed |

Current total tokens decrease **10.83%**, but model requests increase **66.7%**
and elapsed time **43.44%** in this pair. This is an observed whole-task efficiency
disadvantage, despite a much smaller first request. Request counts are model
responses, not user question/answer turns. Different caches, source versions and
one sample per version preclude statistical or causal timing claims.

**Quality:** both miss the same legitimate safety boundary: if the receipt and
observation both lack `startedAt`, `undefined === undefined` incorrectly counts
as verified identity. The hidden assertion follows the user's requirement to
keep uncertain safety blocked; it is not a preferred implementation style. Both
preserve historical unknown outcomes and handle the tested running/replaced/
unreleased cases. Both report real passing public tests, but broader safety
claims exceed their verified coverage. Neither Run passes full independent
acceptance. This shared defect is not evidence that compression introduced it.

**Where the extra work went:**

- Current's first patch returned `undefined` instead of `false` for absent
  observation. Its own added test caught that, and the model repaired it with
  `Boolean(...)`. This was useful recovery from its own initial implementation
  error, not a Runtime-injected extra request.
- Both versions receive the **same** iteration-8 missing-plan reminder. Original
  ends after verification; current creates three retrospective Todos, updates
  them, then later completes the remaining item. Three current responses contain
  only Todo bookkeeping (calls 8, 9, 13; 48,636 total request tokens). This is
  associated observed cost, **not** a proven removable counterfactual budget.
- Both encounter the unchanged guard's rejection of compound shell commands.
  Current retries `npm test && node examples/restart.mjs` after the earlier
  `node --test && ...` rejection, then recovers with separate legal calls. Original
  separates them after its first compound-command refusal. No prohibited command
  is executed and no model argument is rewritten.
- Neither version spawns a child in this task. Read-only child/budget/cancel
  coverage in this batch is offline; do not advertise this pair as live child E2E.

The reminder's source is `packages/coding/src/task-engine/todo-throttle-reminder.ts`
(missing-plan branch around line 167), not a newly introduced AMA strategy.
The fixture refusal comes from `checkComplexTool` followed by the unchanged
`checkNaturalTool` boundary in `tests/shared-contract-natural-runtime.ts`.
The visible error says that only local tests are in scope, without identifying
compound-command shape as the precise failing restriction. That is a possible
evaluation-feedback confound, **not** permission to loosen the whitelist or
forbid normal production command composition.

Full raw: Temp
`kodax-eval-dumps/original-version-complete-observation-r1-20261027/`;
`main-session-review.json` records the trace review and limits. Total work in
this batch was **32 physical model calls** (8 checkpoints + 9 original + 15
current), **617,691 tokens**, no retries. Nominal local reference accounting
totals USD 0.02803527; these are subscription quota observations, not invoices.

### Next minimal work, not implemented here

1. Prioritize **dynamic reminder consistency**, not the 316-token wording cut.
   Keep early AMA planning/dispatch policy, tool availability and SDK unchanged.
   Audit whether a late reminder can communicate remaining work without causing
   retrospective completed milestones or a plan-only extra response. Reuse the
   existing reminder path; no new router, judge call, state machine or configuration.
   Validate active/incomplete work, completed work, failed checks and resumed
   plans against both captured histories before changing production behavior.
2. Separately make fixture denials identify the rejected operation/shape and
   allowed recovery precisely. Preserve the same whitelist, isolation and raw
   parameters. This is test validity work, not claimed product-token savings.
   Do not immediately regenerate the paid traces after changing feedback.
3. Retain the shared missing-evidence failure as a general safety-validation
   case. Do not add `pid`/`startedAt` examples to production prompts to force this
   particular oracle. Existing evidence-preservation/safety constraints must
   continue to apply; review their rule ownership before considering any generic
   improvement. More samples alone are not a fix.

Existing input savings remain adopted; this turn does **not** approve additional
compression or claim no intelligence/round regression. No further paid calls
are warranted until the above offline questions are resolved.

### Dynamic teaching audit

Actual Agent dynamic user content contains about 1,052 heuristic tokens. Skills
occupy about 709 including the catalog; capacity about 200; routing about 78.
These are occupancy, not removable budgets. Subsequent deltas are fingerprinted
and append only changed scratch/capacity/team facts; Skills and routing are not
newly appended in full every turn. Their continued presence in request history
is not duplicate append. Repo overview/scope same-source dedup is already present,
Agent has no default automatic Repo context, and user AGENTS rules must remain.

Keeping all useful rules and the entire catalog, offline text-only candidates
save **235** for Skills wording and **81** for capacity wording. Combined complete
Agent input would be **10,396**, still above 10K. This candidate is **not adopted**.
Skills formatting is also an SDK surface, and budget attribution matches the
catalog text exactly; a root-only rewrite would need a proven provenance/ownership
boundary. Do not introduce a parser, router, extra discovery call or new switch
for these small gains. No valid rule was deleted to chase the threshold.

Primary source owners: `packages/agent/src/capabilities/skills/skill-registry.ts`,
`packages/coding/src/prompts/capability-sections.ts`,
`packages/coding/src/task-engine/_internal/managed-task/role-prompts.ts`,
`packages/coding/src/task-engine/runner-driven.ts`,
`packages/coding/src/agents/worker-role-prompt.ts`, and
`packages/coding/src/agent-runtime/middleware/repo-intelligence.ts`.

### Offline checks and remaining limits

- Fresh full fast tier: **294 files passed, 5 skipped; 2,861 tests passed,
  45 skipped** (406.8 seconds). No failure was rerun to obtain this result.
- Natural fixture/runtime and checkpoint validation: **19 passed** in three
  files. These overlap fast-tier coverage; do not add them as unique tests.
- Final probe/budget regressions with explicit SDK capture: **23/23 passed**.
  All six original/current history wire requests were intercepted with no network.
  The optional capture is skipped in ordinary test runs without its explicit
  OS Temp fixture path. Final TypeScript test checking passed.
- The paid runner encountered only IEEE-754 USD subtraction residue
  (`8.67e-19`) after four fully settled requests. An audited reconciliation set
  that pending residue to zero, preserving calls, charged tokens/cost and raw
  receipts. After all eight calls, a test-first fix permits machine-precision
  residue while rejecting actual pending tokens/USD or unknown usage. The
  executed driver is preserved with its original manifest hash; no generations
  were rerun after that test-harness fix.

This batch includes one completed old/current GLM editing E2E pair, with the
independent failures reported above. It does not claim quality or round/time
non-inferiority, a complete Kimi/DeepSeek task pair, all-tool coverage, a fresh
full four-tier repository run, or macOS/Linux execution. Production sources,
AMA policy, SDK, tool capabilities and Coding default remain unchanged. Evidence
supports a large input reduction, with actual whole-task efficiency and quality
gaps explicitly unresolved.

## Offline six-request analysis and minimal correction (2026-10-27 follow-up)

No model requests or first-turn compression in this follow-up. Read the existing
R1 inputs/results without modifying them. Match original zero-based calls
`0,1,2,3,4,5,6,7,8` to current `0,1,2,3,4,5,6,12,14` by work performed.
The remaining six current calls break down as follows:

| Observed extra work | Current call indices (zero-based) | Calls | Associated tokens |
| --- | --- | ---: | ---: |
| Repair its initial undefined/false defect and retest | 7, 11 | 2 | 31,461 |
| Repeat compound-command attempt after refusal | 10 | 1 | 16,082 |
| Retrospective Todo creation/updates only | 8, 9, 13 | 3 | 48,636 |

This is alignment/accounting, not six experimentally proved removable requests.
The current model's initial implementation error required legitimate repair and
retesting; the single sample cannot isolate model variance from contract effects.
No new repair-specific prompt is justified. The missing-identity oracle failure
is shared across versions and remains unresolved by these changes.

The iteration-8 reminder is byte-identical in both captured histories (SHA-256
`edde931e881cf8bf8cde63f834b13735afcc5875ef0643d2ebcab3609cc9a74a`). At that
point original had finished its checks, while current had just repaired its own
bug and still needed verification. Current creates two already-finished items
plus a verification item, then spends separate responses updating them. The
reminder assesses the **whole task's** step count and says to commit a plan now,
which conflicts with remaining-work and no-bookkeeping-round guidance. It is an
existing late-injection contract problem, not a newly introduced scheduler.

Implemented minimal production change: only the **empty-store reminder text**
now asks for milestones when multiple execution steps remain; completed work
must not be retroactively turned into milestones. A single remaining action may
proceed directly; delivery is allowed only when work **and verification** are
complete. Missing/failed checks remain unfinished work. Necessary plan changes
should accompany independent useful work. Early planning for new multi-step
work stays required. The threshold, recurring cadence, resets, existing-plan
and failed-item handling, schemas, dispatch policy and SDK interfaces are unchanged.
There is no automatic task-completion inference, new model judge or configuration.

Implemented evaluation-only correction: `checkNaturalTool` now names command
composition as the failing shape for command lists/pipelines already rejected by
the fixture. It says no part ran, changing the executable/alias does not fix
composition, and separately submitted commands still face the same path,
argument and read-only restrictions. More specific escape/unknown-executable
errors keep precedence. No command is rewritten or newly admitted. This feedback
does not redefine production shell permissions. Historical R1 evidence is
unchanged; the manual complete-task harness labels any future run **R2**, not R1.

Offline acceptance covers the exported reminder renderer/state machine and the
actual Runtime provider boundary: late empty plans, remaining/finished work
contract, missing checks, existing/resumed/failed items, unchanged threshold and
repeat/reset cadence; composition rejection and legal continuation; Windows and
POSIX paths, readonly, cancellation and shared budgets. Scripted responses test
wiring and enforcement, not LLM compliance or a guaranteed six-request saving.
No new live-model improvement claim is made.

### Follow-up verification and review

- TDD: the late-reminder contract test failed on the old whole-task wording,
  then passed after the empty-store-only change. The composition test failed on
  the ambiguous local-test denial, then passed after the feedback-only change.
- Final targeted run: **173/173 passed in 6 files**, covering Todo cadence,
  store/drift behavior, real native/Script refusal/recovery, shared budgets,
  cancellation, read-only boundaries and the new tests. Source and test type
  checks both passed. No paid eval was launched.
- One initial scripted reminder-wiring test repeated the same read eight times
  and hit the existing loop protection. It was replaced with eight distinct
  ordinary read/inspection/test operations; the actual threshold was then
  verified. The loop protection, limits and guard were not changed to pass.
- Fresh SDK capture: **32/32 complete normalized requests byte-identical** to
  `kodax-first-turn-wire-a6QpYK`, across protocols, Coding/Agent/Script and SDK
  fixtures. New evidence: Temp `kodax-first-turn-wire-AeERZq`. Initial injection
  is unchanged; the new reminder is a later-turn message only.
- Standalone empty-store reminder text increases from **143 to 206 heuristic
  tokens** (+63); this is an explicit clarity tradeoff, not a first-turn saving.
  It does not establish a measured reduction in future model requests.
- The six-request audit is saved alongside R1 evidence as
  `six-round-offline-analysis.json`; no historical inputs/outputs were rewritten.
  The r1 executed drivers remain frozen. R2 records a changed substrate for any
  future manually authorized run, not an already executed improvement result.

#### Standards

0 findings. Independent review found no new layer coupling, speculative config,
silently swallowed errors or broadened admission. Review itself was static;
RED/GREEN and execution evidence is supplied by the tests above.

#### Spec

0 findings. Only empty-plan reminder text and fixture denial explanation change;
existing timing/plan handling, AMA/SDK, native/Script execution, shared budget and
cancellation paths remain. No claim of model compliance or six saved calls follows
from the offline verification. Neither axis has an unresolved finding.


## 2026-10-27 finite reminder × guard factorial (pre-registered before dispatch)

User explicitly requested multi-sample complete-task GLM/Kimi/DeepSeek comparisons to resolve the six extra requests. This overrides the normal EVAL_GUIDELINES restriction against using free-running E2E for prompt comparisons for this finite investigation only. Results remain descriptive; neither 2 draws nor a single task family establish general non-inferiority. Offline tests cannot predict autonomous late-plan compliance, error recovery or complete-task latency.

Production substrate is `edbc5afd` (full SHA in each manifest). Four arms vary **only** the empty-store reminder (c9645bc9 legacy / edbc5afd current) and test-only denial wording (legacy / specific). Cadence, initial prompts, schemas, AMA, model arguments/output, permission decisions, budgets and protected files are unchanged. No capability removal or new production options. A Vitest-scoped text-producer mock selects legacy wording; exact archived-text SHA256 is checked offline. The nullable guard admission result must match for both revisions on Windows/POSIX and read-only cases.

- Routes: zhipu-coding/glm-5.3, kimi-code/kimi-for-coding, deepseek/deepseek-flash. Kimi on/low; GLM and DeepSeek off/none, matching previously validated route settings.
- Task: unchanged natural `symptom-repair` prompt and protected recovery fixture. Two independent draws per route × arm = **24 maximum complete tasks**. This measures repeatability within one task family, not task diversity. No retry, fallback or replacement for a failed cell.
- Pilot: first GLM block of four arms; expand only if guard isolation, actual wire factors, physical accounting and task validity are intact, regardless of model quality outcome. Order is rotated across provider lanes; second block reverses order. Different providers run concurrently; each provider is serial.
- Per task: 32 shared root/child/auxiliary requests, 80 tool calls, 1.2M accounted tokens, 8192 output tokens/request, 180s/request and 600s/Run. GLM/Kimi $0.30 nominal accounting cap; DeepSeek $0.90 peak-price cap. Total hard envelope: 768 calls, 28.8M tokens, $12 mixed nominal/peak accounting; expected much lower (~250–400 calls, 4–7M tokens). Unknown usage charges reservation and stops that provider lane. Reservations happen before dispatch; singleAttempt=true.
- DeepSeek official pricing read 2026-10-27: https://api-docs.deepseek.com/quick_start/pricing/ — peak USD/1M input miss 0.30, cache hit 0.006, output 1.20. Off-peak half. Use peak upper bound throughout, do not label it invoiced cost. GLM/Kimi local coding-plan rates are reference accounting only.
- Raw root: OS Temp/kodax-eval-dumps/late-reminder-factorial-r1-20261027; per-cell raw inputs, model output, physical receipts, source hashes, immutable manifest, two backups. Existing cell directory refuses rerun. Frozen driver and pre-registration are copied before dispatch.
- Primary quality: independent hidden safety oracle (including absent identity), actual public/new tests, unchanged protected files, AMA terminal state, truthful final report. Runtime success alone is not quality acceptance.
- Efficiency: root/child/auxiliary physical calls, all-task input/cache/output tokens, wall time, tool calls, late retrospective Todo-only calls, repeated composition denials. Necessary repair/retest is distinguished from administrative overhead. Less testing or premature completion is never counted as an improvement.
- Analysis: compare reminder effects holding feedback fixed and feedback effects holding reminder fixed, inspect interactions and each raw trajectory. An arm not encountering the relevant reminder/refusal is unexposed, not evidence that the change works. Blind final patches/reports for semantic assessment before linking the trajectory labels; save structured main-session review. Do not infer exact six-call savings by subtracting stochastic full-run totals.
- Stop and inspect infrastructure/accounting or isolation failures. Quality failures stay in the sample. No unregistered full-matrix reruns or case-specific production instructions. New evidence-backed production changes require a new revision and only affected finite checks.


### Post-panel finding: delayed stall verdict blocks unrelated planning

All 24 R1 tasks finished before production changes below. In `deepseek-s1-new-old`, eight inspection rounds triggered an AMA stall judgment. At physical call 9, the model submitted three `todo_create` operations; the queued inspection nudge blocked the first and only two actual ids were minted. The model subsequently guessed `todo_3`, received an unknown-id receipt, then created the missing milestone and repeated verification. This is a concrete production delivery defect plus model receipt-handling error; it is not attributable entirely to the empty-store reminder or evaluation guard wording.

Minimal correction: bind a pending verdict to the original detector's exact stable call signature or existing repository-inspection family. Unrelated plan/control calls continue without consuming it; inspection that continues still receives the warning. Reuse existing progress boundaries to invalidate queued or in-flight verdicts about preceding work. Do not change detector thresholds, family classification, LLM judgment prompt/model, AMA strategy, permissions, tool schemas or budget. An identical repeated edit must remain eligible for intervention (not misclassified as progress).

The new factory-level regression failed on the old gate (legitimate `todo_create` received the read-loop nudge), then passed. Additional checks cover repository-family matching, changed read inputs, queued/in-flight expiry after edits, repeated identical edits and existing reset generations. A zero-network actual Runtime trace inspired by the paid failure verifies eight inspection requests, one real auxiliary dispatch through the injected provider, three intact Todo ids, legal edit/test/reproducer and completed AMA: exactly 12 root + 1 auxiliary requests, protected files intact, public and hidden verification passing. Scripted compliance is execution-chain evidence, not a new model-quality claim. The paid R1 matrix precedes this gate fix; do not relabel it as paid validation of the later source revision.


### Final-source R2 smoke registration (before dispatch)

After the real production stale-verdict fix and 194 offline regressions pass, run exactly one current/current `symptom-repair` task for each of GLM, Kimi and DeepSeek. No repeated factorial, retries or replacement of failures. Use unchanged task, natural prompt, model settings and per-Run caps from R1. R2 upper bound: 3 tasks, 96 physical calls, 3.6M tokens, $1.50 combined nominal/DeepSeek peak accounting, 600s per task. Freeze source hashes including all three modified stall modules and the driver; separate `late-reminder-final-smoke-r2-20261027` raw directory, mirrored backups. This checks final-source integration, not causal savings or general model non-inferiority. Whether the stochastic trace triggers the repaired delayed-verdict branch must be reported separately from its deterministic offline reproduction.


## 2026-10-27 results and limits (R1 + final-source R2)

R1 completed **24/24** isolated tasks: three routes, four combinations, two independent draws of one task family. All retained protected files and reached completed AMA; all local/public test suites passed, but the independent and semantic review below prevents interpreting that as full task correctness. Each cell was run once. The initial GLM 429/code1308 request is retained separately (one physical attempt, zero executed tools); only the user-confirmed credential replacement authorized continuation in a new raw directory.

R1 means below use known API input+output tokens, cache-read included once. Calls are root requests; cancelled auxiliaries are accounted separately. Each independent check has five assertions.

| Route | Reminder / feedback | Root requests (two draws) | Mean known task tokens | Mean Run seconds | Hidden checks passed (of 5, each draw) |
|---|---|---:|---:|---:|---:|
| zhipu-coding | old-old | 13 / 13 | 185,234 | 108.0 | 4 / 4 |
| zhipu-coding | new-old | 10 / 9 | 129,864 | 79.5 | 4 / 5 |
| zhipu-coding | old-new | 13 / 9 | 153,078 | 103.0 | 4 / 4 |
| zhipu-coding | new-new | 9 / 10 | 127,826 | 81.8 | 4 / 4 |
| kimi-code | old-old | 9 / 11 | 135,908 | 96.2 | 4 / 4 |
| kimi-code | new-old | 7 / 8 | 96,994 | 71.4 | 2 / 2 |
| kimi-code | old-new | 12 / 9 | 139,044 | 81.3 | 4 / 4 |
| kimi-code | new-new | 9 / 9 | 120,368 | 82.2 | 4 / 4 |
| deepseek | old-old | 17 / 18 | 293,187 | 55.1 | 5 / 4 |
| deepseek | new-old | 22 / 15 | 327,138 | 53.5 | 5 / 4 |
| deepseek | old-new | 22 / 18 | 397,674 | 66.5 | 5 / 5 |
| deepseek | new-new | 20 / 16 | 321,016 | 60.0 | 5 / 5 |

Interpretation:
- GLM old/old produced two retrospective Todo-only requests in each draw. Current/current produced none: root requests 13/13 → 9/10; mean task tokens 185,234 → 127,826; mean time 108.0s → 81.8s. Current reminder with legacy feedback also had no late Todo-only requests. This supports retaining the remaining-work reminder; it does not assign every saved request to that text.
- Specific feedback did not guarantee fewer requests for every route. It clarifies why a compound command is refused without widening admissions. Root-local and child execution permissions remain distinct. Kimi current-reminder/legacy-feedback tasks completed before the empty reminder fired; their identity omissions appeared before the changed feedback, so they cannot be attributed to the reminder.
- DeepSeek root mean old/old 17.5 versus current/current 18.0: **the global no-extra-rounds target is not established**. Early planning, broader investigation, changed scope and repair choices contribute. Some runs never see the empty-store reminder; some legitimately still have multi-step work. Todo-only calls are not automatically retrospective waste.
- Hidden pass counts are insufficient alone: blind code/report review identified unsupported fallback fields in two 5/5 patches. Offline post-hoc counterexamples confirmed they permit restart despite contradictory running/held evidence. These checks are labeled post-hoc and do not overwrite original oracle scores. Other patches kept/invented a cleanup prerequisite and did not fix the actual symptom. Missing identity is a common failure across arms, not grounds to label every candidate failure as prompt regression.
- All 24 final patches and reports were semantically reviewed with arm labels concealed before revealing the mapping. Counts/trajectory inspection itself was unblinded; directory paths contain different arm names and timestamps, and n=2 with one fixture family is not a statistical or broad task non-inferiority claim.

### Final production-source R2 (after delayed-verdict repair)

| Route | Root + child + auxiliary requests | Full known tokens | Seconds | Public/new tests | Independent checks |
|---|---:|---:|---:|---:|---:|
| zhipu-coding | 9 + 0 + 0 | 121,160 | 79.0 | 7/7 | 4/5 |
| kimi-code | 13 + 8 + 0 | 282,294 | 191.0 | 5/5 | 5/5 |
| deepseek | 19 + 0 + 1 | 335,640 | 63.3 | 10/10 | 5/5 |

GLM returned in 9 root requests (the historical problematic optimized run used 15), but still missed the missing-identity case seen in controls; it is not a full quality pass. Kimi independently delegated a read-only review, used its finding to repair the missing identity, and then passed all five checks. Those child calls add cost and useful quality; some additional calls were avoidable refusal retries. DeepSeek also passed all five checks, but its auxiliary judged the investigation legitimate, so R2 does not supply paid positive-verdict coverage; the real Runtime offline reproducer supplies that gate coverage.

After R2, a final **eval-only** feedback patch retains the exact admission result and adds the child read-only boundary to every denied shell result. This prevents the contradictory sequence “children cannot run repository code” → “only local tests are allowed” from suggesting a test-command workaround. No command was admitted, rewritten or executed for passing the evaluation. Offline Windows/POSIX read-only/root cases, real Runtime guard/budget/cancel tests pass; no further paid calls were used. Do not claim this last wording patch has already improved autonomous model behavior.

Validation: 194 tests passed across 11 focused files after the production fix; the subsequent read-only-feedback change passed 62 tests across the guard/runtime/budget subset, adding one new regression (195 distinct focused tests in total). Source and test typechecks passed. Zero-network actual SDK serialization confirmed all 32 normalized first requests byte-identical to the prior inventory (new inventory OS Temp/kodax-first-turn-wire-BthDa1/inventory.json). Production first-turn teaching, tool definitions and capabilities remain unchanged. Standards and Spec review of the production correction returned zero outstanding findings; final feedback Spec review also zero.

Accounting: R1 314 physical requests; R2 50; quota failure 1 = **365 physical attempts**. Known API task usage **5,593,753 tokens**; conservative reservations including two cancelled auxiliaries and the quota rejection bring charged budget to **5,693,705 tokens**. Combined nominal/upper-bound accounting $0.225969519: this is **not an invoice**. DeepSeek peak-price estimate $0.147931824 (off-peak actual may be half); coding-plan GLM/Kimi values are local nominal rates. Cache-read tokens are part of input, not added twice. No fallback or retry-until-pass was used.

Decision: retain the remaining-work reminder and precise refusal feedback; keep the narrowly scoped delayed-stall delivery repair, supported by deterministic failing→passing and real Runtime tests. Do not claim all quality/efficiency goals are closed, do not continue first-turn compression, and do not rerun the matrix for green scores. Remaining evidence gaps are general task diversity, autonomous compliance with final read-only feedback, and avoiding standalone plan updates without losing useful planning or reviewer quality. Further work should start with existing failure transcripts, not another unrestricted panel.
## 2026-10-27：拒绝恢复与独立 Todo 回合的定向续验

基准提交为 `f2661c2e`（已推送）。先重读 R2 原始轨迹，不再跑完整矩阵。

- DeepSeek R2 的纯 Todo 请求为 9、10、12、16、18：9 创建尚未执行的里程碑并取得 ID；10/12/16 是可与独立工作合并的状态推进候选；18 的最终状态回执仍须确认。不能直接把这五次都视为浪费。第 17 次的 `npm test` 与第 15 次 `node --test` 在该 fixture 中等价，但同时含尚未读取的 diff，不能把整次请求算成零价值。
- Kimi R2 子 Agent 捕获了真实的身份边界遗漏，审查和随后修复、复测必须保留。其 `node --test` → `node --check` → `npm test` 的拒绝恢复，已在上一版统一只读范围反馈；禁止命令从未执行。
- 现有 Runner 同轮非 shell 工具可并行，不能把调用列表当作“前项成功后才执行后项”。本次候选只澄清已知 ID 的状态更新可随独立工作同轮提交；依赖新 ID、审批、验证结果的操作必须等待回执，不能提前宣称通过。无工具、调度、权限、AMA 策略变更。

离线验收：三模式实际 Runtime 中批量计划/独立读取 → 已知 ID 更新/编辑 → 状态推进/测试 → 收到测试结果后完成验证项/独立 diff → 最终报告；另测只读子 Agent 拒绝执行、静态审查、主 Agent 修复和验证的完整链路。预设回调只证明运行机制，不证明模型自发选择或实际任务轮次下降。

**单轮补测预注册**（`todo-recovery-checkpoints-r3-20261027`）：Layer 1 无法判断模型能否自发采用批量进度更新、停止权限同效重试，故只重用 R2 原始历史的三个 checkpoint。DeepSeek call 10 / 12 各比较原共享契约与新增共享教学；Kimi call 14 比较旧只读拒绝和已提交的新拒绝反馈。每格一次，共最多 6 次物理请求，单格 1 回合、8,192 输出 token、180 秒；总上限 800,000 token / $0.50 参考费用。DeepSeek 使用同日官方价格峰时上界，Kimi 使用本地 coding-plan 名义计费，不视为账单。先跑 DeepSeek call 10 两格 pilot，经主会话盲化语义评审后才继续其余四格；异常或用量未知立即停，不补跑。保留原生产工具 schema、完整历史和推理设置，只改变指定变量；不执行生成工具、不改写返回参数。当前主会话先评审隐去 arm/usage 的输出，再揭盲：是否维持有效计划、采取独立实际工作、未提前完成验证，以及拒绝后继续合法静态审查。少量 checkpoint 只能支持方向判断，不能替代完整任务质量/轮次/耗时结论。

原始输入、输出、源文件哈希、双备份、费用和盲评存 OS 临时目录；研究驱动保存在忽略的 `docs/research/` 并随 raw 冻结，不进入产品代码。

### R3 结果与采用边界

6/6 物理请求完成，未知用量 0，无重试、无生成工具执行；合计 **97,133 API token**，**$0.00932789 混合参考费用**，不等于真实账单。各格 token 为该次完整请求的输入加输出，耗时为该次请求，不是整项任务。

| 检查点 | 基线下一响应 | 候选下一响应 | token 基线 / 候选 | 耗时秒 基线 / 候选 | 结论 |
|---|---|---|---:|---:|---|
| DeepSeek 已取得 Todo ID，准备开始修复 | 只更新 in_progress | 同一响应更新 in_progress + 写入修复 | 17,085 / 17,552 | 1.08 / 2.90 | 有批量推进信号，未提前宣称验证通过；候选增加身份类型检查，完整兼容性未由该单轮证明 |
| DeepSeek 已收到修复回执，准备补测试 | 编辑受保护原测试，未更新 Todo | 写入受保护原测试，未更新 Todo | 19,155 / 19,543 | 4.00 / 5.68 | 两版都有越界尝试及漏更新，无批量收益；不能因基线也失败就声称候选正确，也不能据此认定精简退化 |
| Kimi 子 Agent 收到只读执行拒绝 | 改试 `node --check` | 尝试 `read_only:false` 子 Agent 执行测试 | 11,821 / 11,977 | 4.56 / 6.83 | 两版都未自主恢复；更明确反馈仍不足以阻止改入口追求被禁止效果 |

评审限制：pilot 两格已在揭盲前完成主会话语义评审；揭盲时误输出了完整 mapping，因此剩余四格主会话评审为**非盲**。该偏差原样记录于 raw，不为恢复盲化而重新生成。样本少、历史路径保留、cache 命中不同；费用和单轮时长不能作为全任务降本或非劣结论。

实际采用为一条共享的安全批量教学，供普通 Worker 原契约与 Agent/Coding/Script 紧凑契约共用。保留已有的里程碑时机、子 Agent 审查、权限及全部工具，不新增工具、自动合并器或阻断机制。此处是对已有调用能力的澄清，不宣称解决全部额外回合。首轮 32 格 SDK 离线抓包中工具菜单/schema 均不变；三模式完整 Host 输入按同一仓库启发式增加 **78–79 token**（OpenAI 场景 Agent 10,739→10,818、Coding 14,371→14,449、Script 16,241→16,319；该 fixture/估算口径不等同 API 用量）。接受这点教学开销是为了完整任务效率，未继续削减有效规则。

拒绝恢复方面，不再根据单个失败继续堆叠提示。离线确认子 Agent 已有通用拒绝恢复规则，生产 Actor 能力上界禁止从只读父级派可写子级，fixture 也拒绝嵌套派发；并未发现可执行的提权。新增真实 Runtime 回放覆盖执行拒绝 → 尝试可写派发且被拒绝 → 静态审查 → 主 Agent 修复、测试、复现与如实报告；生产 `cannot escalate a read-only Actor to a write child` 回归另行通过。该回放证明安全与恢复路径可用，**不证明模型已自发遵守**。

验证合计 **298 项不同的定向测试通过**：264 项 Runtime/预算/守卫/stall/Todo 回归，32 项共享契约与 Worker 测试，1 项 32 格首轮抓包，1 项生产 Actor 权限上界。子 Agent 回放随后加入 R3 可写派发反例并再次通过，不重复累计测试数量。类型检查通过；Standards / Spec 独立代码评审各 0 项发现。当前仍未达到“所有模型完整任务不增加回合”的证明标准；后续应在下一次有实际功能改动的完整任务验收中检查这一指标，保留失败与有价值审查，不再为这一条教学重复跑矩阵。
## 2026-10-27 R4：原始产品版本与当前版本的多轮配对

用户在 R3 后明确要求多轮完整工作验证并对照优化前。本次据此作为有限的产品版本比较例外执行，保留 EVAL_GUIDELINES 的冻结输入、预算、隔离、不重跑和语义评审要求；单轮证据不再替代完整任务结果。

原版固定 `bd4479d59cab3d082f07c2d34681fff198d82fa0`，当前为 `f2661c2e` 加已记录的共享批量教学工作区 diff。使用原版新 Git archive 和本版源码各自的 Runtime、提示与工具 schema；原版仅复制共同评测辅助文件，生产源码不适配。两边同一当前 guard、相同任务、相同自然中文 prompt、相同额度、隔离和 reasoning；不是原版旧 guard 对新版新 guard。原版复用外部 node_modules 与经同源核对的 Windows 原生文件事务产物，须保留依赖差异与非历史二进制验收限制。先以离线 read/write/refusal/child/budget/cancel 回归检查两端装配。

固定 10 个完整任务样本：GLM/Kimi/DeepSeek 三路各一对 `symptom-repair`，Kimi/DeepSeek 各一对 `incremental-review`。两种任务均源自既有自然任务重建，仍共用一个小仓库，不能宣称跨仓库智能非劣。GLM 修复两格为 pilot；若隔离、用量或实验装配有错误立即停并保留证据，不以模型任务失败为理由重跑。pilot 有效后，其他八格每格一次，不为获得通过重复。原版/新版顺序按 route/task 交错；同 provider 串行，不同 provider 可并行。

每 Run 最多 32 次物理请求（root/child/aux 共用）、80 工具、1,500,000 token、8,192 输出 token/请求、180 秒/请求、600 秒/Run；GLM/Kimi 各 $0.30 名义费用上限、DeepSeek $0.90 峰时参考上限。整个已登记集合不超过 320 次请求、15,000,000 token、$5.40 参考费用；不会一次性烧满预算。原始输入/输出、全部回执、独立 oracle、最终补丁、模型报告、时间和双备份保存在新的 OS Temp 根目录，旧 R1–R3 不变。

主会话先审阅去版本标签/用量的配对补丁、报告和验证证据，再揭盲比较：完整需求与安全边界、是否修复/正确评审、公开与独立测试、报告真实性；随后分解 root/child/aux、首轮输入、全任务输入/输出/cache、费用、耗时，以及规划、拒绝、修复复测、审查等回合。审查任务不得以“源码仍含待报告缺陷，oracle 未通过”判失败；是否指出新身份漏洞、区分旧缺陷已修复、不擅自编辑才是验收重点。必要复测与有价值子审查不能算浪费。

产品版本结果受模型波动、Runtime/工具演进、外部依赖和路径差异影响，不能独立归因提示精简。若发现仅当前失败的具体边界，先对源码与既有轨迹定位遗漏/冲突，再另登记最小控制变量复核；不自动追加矩阵，不直接移植其他 agent 的整个提示或执行壳。本轮不预先修改产品契约以追逐样本。
### R4 后的窄修复与 R5 有界恢复验证

R4 全部原定样本均已尝试（旧 Kimi 增量审查在 sidecar 400 后失败保留；全局停止暂缓的唯一未开始样本另根续跑，未重试失败样本）。结束后才修改 `withEffectivePermissionContext`：存在 `permissionIntent.readOnly` 时显式披露任务只读上界，替代该任务不适用的 full-access mutation 教学；宿主模式未知时不猜测模式，也披露已知只读范围。普通 root 原字节不变；不改 guard、能力上界、SDK 接口、工具菜单或 AMA。该缺口在 `bd4479d` 已存在，不能归因首轮精简。

R5 (`readonly-scope-recovery-r5-20261027`) 只比较这项上下文事实修复。复用 R2 Kimi child call 14 的真实历史与工具定义，把旧短拒绝回执在两臂统一为当前 guard 文案；baseline 保留旧 full-access 说明，candidate 用实际当前 formatter 提供 read-only scope，其他内容相同。Kimi 每臂最多 3 次请求，最多共 6 次，8192 输出/请求、180秒/请求、400,000总token/$0.10名义费用上限。每格一次，无重试。每轮仅调用现有 guard 计算拒绝；若所有调用都被拒绝，原样保留模型 assistant blocks 并追加同 guard 错误进入下一轮；若出现允许的工具调用或终止文本则停止，不执行生成工具、不伪造读取结果或任务成功。该 L3 检查能回答是否持续追求被禁效果、是否改用合法读取/向调用方报告，不能代替完整编辑 E2E 或证明后续任务质量。该补测不与 R4 的完整任务次数合并。先主会话隐去臂标签/用量评审，再揭盲，不根据结果追加样本。

### R4 完整结果：产品版本差异，不是单条提示的因果试验

原版为 `bd4479d59cab3d082f07c2d34681fff198d82fa0`，当前版为 `f2661c2e` 加安全批量教学的未提交修改；**均在 R5 权限事实修复之前冻结**。两版分别使用自己的生产 Runtime 和真实工具契约，使用相同当前 guard、任务与独立检查。原版 archive 的 1,054 个生产 TS 文件与 Git blob 比较无语义差异（1,049 个仅导出换行不同）；外部依赖借用当前安装，原版 dist 来自已有同提交构建，不能称为历史发行二进制复验。首次离线预检因未备好 dist 失败，补齐后 4 个零网络预检通过，之后才开始模型调用。

| 任务 / 模型 | 主请求 原 / 今 | 首轮 API input 原 / 今 | 全任务已知 API token 原 / 今 | 秒 原 / 今 | 实质结果 |
|---|---:|---:|---:|---:|---|
| 修复 / GLM 5.3 | 9 / 10 | 24,935 / 11,168 | 248,009 / 135,796 | 78.33 / 75.45 | 都修好主要症状、独立 4/5；都漏双方身份字段缺失，并过度报告安全覆盖 |
| 修复 / Kimi | 16 / 13 | 23,272 / 10,062 | 458,839 / 188,392* | 151.01 / 141.71 | 都修好主要症状、独立 4/5；同一身份缺口，当前少 3 个主请求 |
| 修复 / DeepSeek Flash | 27 / 19 | 25,753 / 11,614 | 883,933* / 343,559 | 82.85 / 67.03 | 原版保留旧 cleanup 前提，未修好主症状；当前修复且独立 5/5，但新增身份类型约束的广泛兼容性未验证 |
| 增量审查 / DeepSeek Flash | 8 / 16 | 26,641 / 12,499 | 224,941 / 249,855 | 25.81 / 43.78 | 原版漏身份漏洞；当前发现，但误称新引入、低估缺失字段问题，并残留临时文件，报告不完全准确 |
| 增量审查 / Kimi | 6 后失败 / 10 | 24,113 / 10,909 | 148,831* / 149,351* | 25.27 / 159.06 | 原版辅助请求触发 provider 400，无最终报告；当前完成并指出身份漏洞，不能据此归因推理提升 |

星号表示另有无实际 API usage 的物理请求，不能把已知用量当完整账单：Kimi 修复当前、DeepSeek 修复原版、Kimi 审查当前各有一次有界取消的辅助请求；Kimi 审查原版一次 400。含保守预留的预算 token 分别为 202,339、899,313、162,454、161,421。其余已知与预算 token 相等；cache 是 input 的子集，不重复加总。

修复原/今参考费用：GLM $0.012532/$0.006906，Kimi $0.002356/$0.001075，DeepSeek $0.031917/$0.016672；审查原/今：DeepSeek $0.012102/$0.011270，Kimi $0.000827/$0.000884（失败与取消包含保守预留）。编码套餐是本地名义费率，DeepSeek 是当日峰时上界，均非账单。全批 **142 次物理请求、3,031,506 已知 API token、3,086,526 预算 token、$0.096539957 混合参考费用**。不以较高 cache 命中下的低费用掩盖增加的请求与耗时。

归因与限制：

- GLM 当前多 1 次主要对应读取顺序：原版早期一起读 `package.json`，当前后读；两版都遇到一次保护测试拒绝和一次复合命令拒绝，均未使用 Todo。因此不是这次晚到 Todo 补账的复现，也不是已经证明的压缩退化。
- DeepSeek 审查多出的工作包含发现真实漏洞所需的探查，也包含 `node -e` → `--eval` 同效重试、越界写入和临时文件清理拒绝。不能把多 8 轮全部当成智能退化，也不能全部解释为必要质量成本。当前的“工作区干净”与残留空临时测试文件相矛盾，应记录为报告缺陷。
- 原 Kimi 400 为 `tool_choice 'specified' is incompatible with thinking enabled`，来自旧辅助链。当前 `packages/llm/src/providers/anthropic.ts` 已有 Kimi 参数兼容处理，本轮未修改旧版生产代码来让它通过。全局停下后仅在新目录启动唯一尚未开始的 cell-09，未重跑失败格。
- 两版最终补丁/报告先作主会话隐去版本与用量的语义评审。旧 Kimi 400 为诊断先读取身份；续跑唯一剩余格的身份可推断，不能宣称该格严格盲化。单格一次、两个同族任务，不作统计非劣结论。
- **这 10 格没有实际 child 模型请求**。固定评测守卫拒绝了模型主动选择的 `model_hint`/专用角色等参数，未改写参数、未放宽白名单。源码权限与离线 child 闭环通过，R2 曾有真实有价值的 child 审查，但不能用 R4 宣称当前全部协作能力均已完成真实 E2E。
- **多轮模型调用不等于多条用户消息的连续会话**。R4 增量审查以既有变更和已保存的上下文模拟后续任务，实际是新 Session 的一次 Run；尚未覆盖同 Session 两次用户输入、冷恢复、跨 Run Todo 状态保留。后续必须单列这些边界，不能把 R4 表格改名为完整多用户轮验收。

Raw：OS Temp `kodax-eval-dumps/product-multiturn-r4-20261027` 和 `product-multiturn-r4-unstarted-20261027`，含固定源码、生产输入/输出、独立检查、语义评审、`complete-metrics.json` 和两份备份。保留基础优化与当前最小修复；**总体不增轮目标尚未证明，不继续为小首轮收益跑矩阵**。

### R5 结果与最终离线验收

实际仅 3 次请求，没有执行模型生成的工具：原版 A 直接静态报告（1 次、13,058 token、34.15 秒），权限事实修复版 B 先尝试 `dir` 读取工作区父级评测目录，被守卫拒绝后静态报告（2 次、25,670 token、47.57 秒）。合计 38,728 已知 API token，$0.0002273 名义费用；无失败重跑、未知 usage 或放宽守卫。评审在 mapping/usage 揭盲前落盘。

两版都不再尝试仓库代码执行，也诚实说明未跑测试；但候选有一次不必要的越界读取，**本配对没有显示减少请求的收益**。两版都提到缺失身份却错误降低其严重性，原版还有错误的状态兜底推断；不能认为静态审查通过。正确区分：权限事实修复有源码与离线依据，模型恢复效率和审查准确性仍未达标，不为获得更好分数继续重跑。

三个 formatter 回归先 RED，再修复 GREEN。修复后 5 个文件 **203 项测试通过**（权限上下文、真实 Runtime、child executor、协作工具、Kimi 辅助链兼容），`npm run typecheck` 通过。实际 SDK 离线序列化 **32/32 请求与修复前逐字节一致**（包括普通 root 三模式、SDK 及 Script 叶工具），新 inventory 为 OS Temp `kodax-first-turn-wire-687uWH/inventory.json`，比较基准 `kodax-first-turn-wire-tUdtLt/inventory.json`。子请求的只读上下文则有意变化，测试证明不持久化入历史、下次重新读取权限意图。Standards 审查 0 项，Spec 审查 0 项。此次没有重新跑全仓/发布包/非 Windows 平台，也没有模型非退化的全面证明。

### 2026-10-27 后续：初始 Todo 状态与真实连续 Session 离线回归

本批无付费模型调用。沿用上一节的产品计划，完成最小 `todo_create.status` 可选参数（pending 默认 / in_progress），未新增 batch 工具或发现调用。创建 completed/failed/skipped/cancelled、null、数字均在分配 ID 前拒绝；默认调用仍创建 pending。状态作为同一 seed 通过 before-create，允许后只发一次最终 store 通知和 todo:created，否决不分配 ID。原生与桥接各按原预算计一次；in_progress 创建不跑 evaluator，后续 completed 仍跑原检查并回传失败，重复 completed 不重复检查。

TDD：新增单次创建 in_progress 测试在旧实现得到 pending（RED），最小实现后通过；终态/非法类型六例在未校验实现错误通过（RED），加窄校验后全部拒绝；canonical/compact 实际装配测试先缺失 status（RED），加入公共 schema 后通过。旧 todo-create 测试 helper 的 s.content 改为正确的 s.subject，避免验证已删除字段。已审计的紧凑契约哈希仅随这一 description 变更更新，其他工具结构一致。

连续用户任务测试使用真实 Runtime、同一 Session，Agent/Coding/Script 各运行 3 个 Run：

1. 创建 in_progress Todo，与独立真实修改同响应；如实报告尚未运行测试。
2. 用户追加只读审查，Session 切 Plan；读回修改，Todo 列表为空；调用 undo 被明确 Plan 权限拒绝，前一 Run 修改仍保留。
3. 关闭 Runtime、创建新 Runtime 使用同一 home 和 Session，用户追加实际测试并切回 full-access；请求含前两次用户/助手历史，Todo 仍为空；实际运行 node --test，收到 2 项通过回执后报告。最终隐藏检查通过、保护文件未改。

每模式为预设 **3 用户轮 × 2 模型回调 = 6 回调**，总请求上限跨 Run 共用；无网络。这个次数是机制断言，不是 LLM 自主选择的效率证据。任务计划按既有定义隔离，不能宣称复活了旧 task 的活动 Todo。未覆盖崩溃中断任务恢复或真实模型多用户轮表现。

评测设计修正全部离线保留解释：初版误以为 Plan 会禁止 OS Temp fixture 的普通写入，源码 permission.ts 明确允许系统临时目录写入，所以该测试前提无效；改为生产明确禁止的 undo，未改生产权限或放宽 fixture。另一个取消初稿直接调用原生 execute，绕过真实 Runner observer，而桥接内置权限检查，不能公平类比；改为两路都从 Runner 经过相同 observer，取消后都无状态变更、预算为零。JSON 历史中的嵌套转义也改为检查实际 tool_result 回执；最终拒绝断言针对具体 undo 的 Plan 回执，不靠历史任意 Error 字样。

32 格零网络实际 SDK 序列化：OS Temp `kodax-first-turn-wire-DtufjL/inventory.json`，比较 `kodax-first-turn-wire-687uWH/inventory.json`。逐字段差异检查确认所有请求只改变 todo_create.description 和可选 status，工具清单及其他所有输入不变。归一完整 Host 估算 token：OpenAI Agent 10,866 / Coding 14,497 / Script 16,367；Anthropic Agent 10,630 / Coding 14,132 / Script 16,212；均较本批前 +48。不可与 API 计费 token 混用。SA 行仅是保留 SDK 基线场景，不代表恢复 SA 用户入口。

TodoStore/todo-create 定向覆盖率（连同桥接回归共 112 测试）：语句 98.70%，分支 94.65%，函数 100%，行 99.22%；覆盖输出位于 OS Temp `kodax-todo-initial-status-final-coverage-20261027`，不是全仓覆盖率。`npm run typecheck` 与 `npm run build:packages` 通过。未重新验收完整发行二进制、全部仓库测试、其他平台或真实模型效果。

额外 SDK 边界先 RED 后 GREEN：无类型 JavaScript 消费者若传入未支持的 completed，store.add 保持原有 pending 行为，仅显式 in_progress 可改变初态，不能通过跳过 TypeScript 校验在创建时标完成；模型工具层对非法 status 则明确报错。该窄防护不改变已有 patch/update 能力。

最终离线回归：本批涉及的 9 个定向测试文件累计 **241 项通过**；其中连续会话文件完整 26 项通过，随后加强具体 undo 拒绝断言的三模式 3 项再次通过。新增 SDK 边界后的 Todo/Store/桥接 112 项通过。32 格首轮抓包单独通过。最终类型检查、workspace 构建和 git diff --check 通过。不存在未解决的已运行检查失败；这不表示重跑了全仓或全部智能能力评估。

#### Standards

0 项成文规范违反，0 项可行动 smell；独立审查覆盖本批生产与测试改动，最终 SDK 和取消边界修订也已复核。

#### Spec

0 项未解决发现；确认接口兼容、任务隔离和实际验证范围，未将预设模型回调等同于真实模型非退化。模型补测、完整发行包及其他平台仍按前述范围未验证。


### 2026-10-28 R6：来源明确的 Todo 错误回执与连续用户任务（预注册）

基线为已推送 `8a1afc77`。候选只为 Todo 创建/更新/查询已有失败补充来源码：`todo_invalid_input`、`todo_unavailable`、`todo_hook_veto`、`todo_state_conflict`，保留原始 reason；现有分类器将完整已知失败标为工具错误。成功 JSON、输入 schema、提示、AMA、隔离和取消不变；未知 hook veto 不推断 retryable，不添加自动重试。SDK 的失败 JSON 新增 code 属于增量字段，严格拒绝未知字段的外部消费者须适配，不能声称失败字节完全兼容。

离线先验证真实工具结果、原生/桥接等价且每次计费一次、非法输入不分配 ID、合法修复可继续、三模式模型历史收到 is_error、现有取消/权限/连续 Session 行为，以及首轮序列化不变。Layer 1 能证明机制，无法证明模型收到失败状态后的真实决策和完整任务效率，因此才按用户明确授权进行有限连续任务配对；这覆盖指南默认不做自由完整任务比较的限制，不把自主轨迹当严格因果或非退化证明。

R6 固定一个任务族，两次真实用户请求共享 Session：先沿用 incremental-review 的自然“请再看一下最新的改动。”及明确标注的 fixture 前文，再请求“请修复审查中发现的问题并补充测试，保持原来的兼容边界。”隐藏 oracle 仅在两次 Run 结束后执行。禁止命令和保护文件边界保持原样，不注入特意构造的 Todo 错误，不重写参数/输出，不强制或关闭子 Agent。若未自然触发来源错误，仅报告机制未暴露，不能宣称改善了拒绝恢复。

三条固定路由：zhipu-coding/glm-5.3、kimi-code/kimi-for-coding、deepseek/deepseek-flash；每路基线/候选各一次，共 6 cell。GLM 一对先作实验有效性 pilot，确认后才并行 Kimi/DeepSeek 两条 provider lane，同一 provider 串行。每 cell 两个用户 Run 合计最多 32 次物理请求（含子任务/辅助）、80 工具、150 万 token，单请求 8192 输出/180 秒，cell 600 秒；全实验最多 192 请求/900 万 token，计价参考预算上限 $3（GLM/Kimi 每格 $0.30、DeepSeek $0.90）。套餐参考费用不等于实际新增账单；未知用量按保留预算计入并遵循既有 stop 规则。失败保留，不补跑直到通过。

比较目标预先固定：第一轮是否准确区分已修复旧问题与新身份匹配缺陷；第二轮是否修复且保留不确定性和原始 receipt；测试是否实际执行、报告是否准确；保护文件/权限/拒绝后的行为；两 Run 的 root/child/aux 请求、全任务 API token、未知保留额和耗时。主会话先读取隐藏 arm/费用的语义包再揭盲；机械 oracle 只是诊断证据。已知缺失身份边界若双方均遗漏，不归罪于本次标签；单次差异记为有限证据而非统计结论。

原始结果、源码冻结、两份备份和 ledger 位于 OS Temp `kodax-eval-dumps/product-multiturn-r6-20261028`，两个独立源码快照均从基线归档，只有候选覆盖生产 diff；两者使用同一评测驱动和守卫。真实模型结果尚待执行，不能提前宣称质量/往返改善。


R6 离线记录：首个 source-owned code 断言在旧实现因缺失 code 失败（RED），修复后工具/classifier/桥接/完整 natural Runtime 7 文件 178 项通过；另执行分类契约和首轮 8 项、多模态 3 项（去重共 189 项）。覆盖率目标仅本批 5 个生产文件：语句 95.45%、分支 93.35%、函数 100%、行 96.17%。工作区 typecheck/build 通过；32 格新抓包 `kodax-first-turn-wire-InvrfT` 与 `DtufjL` 归一 model input 哈希全部一致。两个源码快照构建、Coding 连续三 Run 和候选三模式错误回执预检通过。

快照首轮离线失败保留：git archive 未包含原生 textTransaction 二进制，write 返回缺少兼容 native manifest；同时未映射 artifacts 包内依赖，build 错误解析根目录 pdfjs 版本。两边补齐相同已构建 native 及各包实际 node_modules 后构建和编辑预检通过，未修改产品代码、隔离、调用参数或输出。source-audit 确认只有四 Todo 处理器及分类器存在生产差异。未在环境有误时调用模型。

#### Standards

独立评审发现 1 项 P3：两处返回契约注释误标来源码，已在冻结前修正为 todo_unavailable / todo_state_conflict。无硬规范违反或未解决 smell。

#### Spec

独立评审同样发现 1 项 P3 注释不准确，已修复；未发现行为超范围、原生/桥接不一致、自动重试或权限改变。两轴各自 0 项未解决发现；仍需真实模型结果说明完整任务表现，不能先宣布不增轮。


#### R6 完整结果：六格连续任务均完成，未触发新增 Todo 失败分支

基线为 `8a1afc77`，不是优化前的最初版本；候选是本批冻结的 5 文件生产 diff。每格真实同 Session 两个用户 Run（审查→修复），六格均 completed、公开测试退出 0、保护文件未改，未重跑任何模型格。以下是 API 实测，不能与首轮字符估算混用：

| 路由 | 独立 oracle 基线→候选 | 主请求 | 全部物理请求（含辅助） | 已知全任务 API token | 全任务耗时 |
|---|---:|---:|---:|---:|---:|
| zhipu-coding / glm-5.3 | 2/5 → 4/5 | 15 → 16 | 16 → 17 | 207,457 → 230,555 | 107.3 → 111.3 秒 |
| kimi-code / kimi-for-coding | 4/5 → 4/5 | 16 → 18 | 16 → 19 | 244,774 → 268,809 | 130.8 → 150.2 秒 |
| deepseek / deepseek-flash | 4/5 → 4/5 | 19 → 16 | 20 → 16 | 353,044 → 279,143 | 61.9 → 45.7 秒 |

主请求合计 50→50、物理请求 52→52 是本次样本事实，不能掩盖模型间差异或当作“不增轮”的普遍保证。GLM 两格各有一次正常取消的辅助请求，物理 dispatch 已观测、用量未知，分别额外保留 11,913 / 12,170 token；其预算口径为 219,370 / 242,725。全实验 104 个物理请求、100 主请求、4 辅助、0 子 Agent；已知 1,583,782 token，含未知保留额为 1,607,865；参考计价 $0.059700，保守计价 $0.061007，低于预注册预算。套餐参考价不是账户实付账单。首请求 API 输入：GLM 12,139→12,138，Kimi 10,944→10,940，DeepSeek 12,544→12,546；临时路径等动态差异未归一，标准化 32 格抓包已证明首轮静态契约没有变化。

语义结论：

- GLM 候选修复了基线漏掉的身份匹配，但两者都遗漏证据完整性。基线把公共测试文件拒绝错误扩展为源文件也受保护；候选实际成功修改源文件，说明并非守卫禁写源码。报告的公开测试数分别 6/8 与真实执行一致。
- Kimi 两版都把身份风险低估为非阻塞，第二次请求仍进行了修复；候选增加缺失 process 对象保护及更多测试，双方仍没有检查身份字段本身有效。公开测试数 6→8 与实跑一致。
- DeepSeek 两版都找到真实匹配缺陷并补测试，候选保留 10 条而基线有 19 条（含重复探针），双方独立检查均漏一项。两版均有错误历史归因（旧代码也没有身份匹配检查）；候选还把复合 git 命令拒绝扩大成所有 git 都不可用。基线删除被拒后没有换别名反复尝试；最后保留探针并报告。其“去掉失败断言”的表述不准确，核对两次真实 write 后，关键 assert false 被保留，没有靠删断言通过。
- **勘误：原统计只计 UI 事件，遗漏了专用 Todo 执行链。真实模型 tool_use 和回执证明 Kimi 两格各有 5 次 Todo 调用，全部成功；其他四格为零。** 因此没有自然暴露本次新增的四类失败来源回执；新标签既不能解释 GLM/Kimi 增轮，也不能领取 DeepSeek 降轮的收益。共同缺口及轨迹差异应记为模型行为变异/归因不确定，不应说是这次收缩导致，也不能说这次修复提升了智能。子审查未自然发生；不能声称本轮实际验过子 Agent 的模型表现。

预注册 oracle 只是诊断之一。事后对六份最终源码做相同三例离线诊断（不重跑模型、不改 oracle 分数）：双方身份字段均缺失时，六格都错误放行；receipt.process 缺失时，GLM 候选、Kimi 基线抛异常，DeepSeek 候选错误放行而其基线拒绝，Kimi 候选正确拒绝。说明单一 4/5 会掩盖不同失败形态，不能将核心匹配改善等同于完整正确。诊断 raw 为 posthoc-offline-edge-diagnostic.json，明确标为事后分析。

评审限制：先读隐藏 arm/费用的语义包，再冻结评语、揭盲看效率。GLM pilot 的 oracle 栈路径泄漏 cell ID，已记录该污染；后两对补充去标识，不重生成模型输出。主会话知道执行顺序，不宣称独立双盲。单任务族、每路一对，也不支持统计性智能非退化结论。

**建议**：保留已证明的来源分类修复（recommend-ship，针对该窄缺陷），不新增提示、发现调用、重试机制或测试豁免。完整任务质量/效率目标仍有未完成部分；不因为基线共同失败而撤回正确修复，也不靠反复重跑凑全绿。下一步优先用已存轨迹分析“单个操作拒绝被泛化”与“证据缺失被当成匹配”的通用原因，只有确认产品契约缺口才改；本轮不为 Todo 标签追加付费样本，不继续首轮精简。


### 2026-10-28 R7 三版本、两类连续任务预注册

- Owner 要求以后始终同时展示最初未优化版、已采用版、候选版。本轮分别为 `bd4479d59cab3d082f07c2d34681fff198d82fa0`、`8a1afc77`、`8a1afc77` 加冻结的五文件 Todo 错误回执补丁。原始版同一案例/模型只运行一次，保存后复用，不因失败追加重复。当前/候选也各一次；不能据此宣称统计显著或普遍无退化。
- Owner 明确要求完整多任务比较，作为 EVAL_GUIDELINES 通常禁止完整循环 prompt A/B 的显式例外。本轮是产品版本观察，不用完整任务的随机差异证明单一提示或未触发的错误分类补丁有效。机制正确性先用离线测试验证。
- 两类新任务均以自然中文请求启动，然后在同一 Session 中继续一个真实用户 Run：缓存租户串数据→失败重试与并发；配置优先级→零值、false 与缺省兼容。公开契约在 fixture README，独立 oracle 与参考修复留在模型工作区外。原始缺陷、不完整修复和完整修复均已离线区分。不会把旧缓存案例中的 TTL 等额外要求强加给本案例。
- 三组保留各自真实生产装配、AMA 和工具；共用同一评测守卫、文件保护及调用观测。最多一次只读子 Agent，未强制派发；不改写模型参数/输出，不放宽 shell 白名单。固定 Coding 工作面，不声称覆盖另外两种模式或所有外部服务。
- 顺序：先 GLM/Kimi × 缓存任务 × 三版本，共六格，核实实验有效后继续配置任务及 DeepSeek，共最多 18 格。各 provider 单并发，不同 provider 并行。每格 32 物理请求、80 个工具提议及 80 个执行边界调用、1.5M token、每请求 8192 输出 token/180 秒、每格 600 秒。全局上限 576 请求、27M token、参考费用 $9（GLM/Kimi 每格 $0.30、DeepSeek 每格 $0.90）；这是停止上限，不是预计支出或实际订阅账单。
- 判读先看匿名化代码、报告及测试回执，再揭示版本和效率。按用户 Run 分解首轮输入、全任务输入/输出/缓存、root/child/aux 请求、参考费用、任务/模型耗时；区分有效工作、首次守卫发现、重复禁止操作、重复读取、独立 Todo 回合。不能把遗漏验证算作效率提升。
- 工具统计取实际模型响应并独立检查执行回执，不依赖 UI start 事件；补充提议数硬上限，原有执行预算保留。原始 API usage 缺失时保留未知并计入保守预算，不记零。
- 冻结源码、映射、输入输出与双备份：OS Temp `kodax-eval-dumps/product-multiturn-r7-20261028`。研究驱动不入 Git，长期案例和离线回归保留在 benchmark/tests。未启动或中止的格明确保留，不为通过重跑。

### 2026-10-28 R6 逐请求复核与测量勘误

本节纠正上一轮报告的控制工具漏计，并补齐开销归因；没有新增模型调用或修改生产提示。`metrics.json` 和原评语保留，新的权威派生结果为 OS Temp R6 下 `forensic-breakdown-v2.json`、`metrics-v2.json`、`analysis-correction-v2.json`，都有两份备份。

**漏计原因**：原聚合脚本从 UI 导向的 onToolUseStart 事件数 Todo，这条样本事件流并不覆盖专用 Todo 执行链。真实 provider response.toolBlocks 表明 Kimi 基线/候选各提出 5 次 Todo（2 create + 3 update），后续模型可见回执均 ok:true/is_error:false。GLM/DeepSeek 为零。共享分析 helper `tests/shared-contract-trace-metrics.ts` 改为逐个模型响应计数，不把重复历史再数一次，也不把工具提议等同已执行；Script/bridge 内部调用须另看执行回执。两条离线回归通过，测试类型检查通过。原始 API 请求数、token、时间未受这项错误影响；“没有 Todo 失败分支暴露”仍成立。

| 模型 | 审查阶段主请求 基线→候选 | 审查已知 token | 修复阶段主请求 | 修复已知 token | 净 token 变化 |
|---|---:|---:|---:|---:|---:|
| GLM | 9→9 | 115,511→116,395 | 6→7 | 91,946→114,160 | +23,098（+11.13%） |
| Kimi | 7→10 | 88,588→126,902 | 9→8 | 156,186→141,907 | +24,035（+9.82%） |
| DeepSeek | 10→8 | 153,286→118,891 | 9→8 | 199,758→160,252 | −73,901（−20.93%） |

GLM 修复阶段既多做了有价值的源码匹配修复，也额外提出 README 编辑。该请求被既有 guard 拒绝，本身输入 16,416、输出 128，合计 16,544 token（净增量约 72%）；后续还携带其历史。这个核算不是“删除此调用即可无损节约”的反事实结论。两版审查主请求一样，取消辅助也各一次，不应把上涨笼统归为新增计划或 provider 故障。

Kimi 审查阶段：基线将 changed_scope 与 git log 合在一响应，候选先发复合命令被拒，再独立 log、changed_scope、changed_diff，才改用 git diff；候选另把 README 从批量读取中拆出。基线也有一次复合测试命令拒绝，不能只记候选失误。阶段净增 3 主请求和 1 辅助判断（辅助实际 2,147 token）；修复阶段候选把两个 Todo 更新与测试写入同响应，少了 1 个独立 Todo 回合，纯 Todo 响应从 3 降到 2。原生菜单和三条批量/不为计划单独加回合的现有规则，在两边实际首请求中均各出现一次。并非未注入、重复注入或缺少并行机制。

DeepSeek 候选减少了重复探针整理、删除尝试、额外改写及部分请求，也批量执行了验证。但其首次复合 git 被拒后直接放弃 Git 归属核实，并错误声称所有 git 被禁；因此较低费用混有调查范围损失，不能作为同质量提效的完整证据。缺失 receipt.process 的事后诊断也表明候选并非在所有边界等价。两版 4/5 不足以掩盖这些差异。

六格已知 token 合计 805,275→778,507（−3.32%），三个顺序任务耗时之和 300.0→307.2 秒（+2.4%，非并行实验墙钟时间）。聚合不能覆盖 GLM/Kimi 的增长，也不能把 DeepSeek 的节约直接认作产品收益。请求变长主要通过上下文反复携带放大，而非单纯多输出几百字。

**因果边界**：本轮是 8a1afc77 与 Todo 失败分类修复之间的 smoke，并不是最初优化前与当前版的总体对照。两边菜单、共享契约相同，唯一变更的失败路径未触发；第一次模型输出就已发生选择差异。真实首输入仍有 fixture 路径、临时 provider UUID、前文实际测试耗时等动态差异；不能把它当成严格同字节 A/A，更不能单次就宣布精简造成退化。应分别记录模型采样/动态输入差异、守卫边界探索成本及真实质量差异。第一次遭遇未知评测边界不自动等同无益重试；不据评测白名单反向删除生产能力。

**R6 当时提出的后续验证设计（历史提案；最终执行以 R7 三版本预注册和结果为准，未执行这里的重复波动样本）**：

1. 将“错误回执机制验证”与“整体优化前后任务效率”分开。前者使用真实返回值的离线拒绝→恢复回归和必要的固定检查点，必须覆盖失败分支；后者采用原始产品基线 bd4479d 与当前完整产品快照、各自真实装配，使用同一评测边界。明确跨版本总体表现不等于某条提示的单因果效果。
2. 新增两个独立任务族：跨包缓存的租户隔离定位→修复失败重试；配置优先级错误修复→用户追加零值/未设置值兼容检查。自然用户请求只描述症状与工作要求，公开 README 承载正常接口契约，验收不暗中要求修复任务外所有旧缺陷。不要把 shutdown identity 换名充作新任务，也不在 prompt 列隐藏测试答案。
3. 先做两边 gold repair、失败 oracle、合法工具路径与边界拒绝的离线验证。旧版正常工具若被评测人工禁止而无法公平比较，则该格标注不可比，不能通过改输出、宽松 oracle 或删生产工具来制造可比性。所有控制工具统计从原始响应与回执取证，guard/UI 事件只用于拒绝归因。
4. 首批 GLM/Kimi × 2 个新任务族 × 2 个产品版本，共 8 个完整连续任务。预先固定第一个任务族每模型每版再抽一次作为波动校准（4 格），所有结果保留，不按通过与否追加；合计最多 12 格。pilot 验证设计有效后再扩 DeepSeek 的两个配对（4 格），不是重复旧完整矩阵。拟每格最多 32 请求/80 工具/150 万 token/8192 输出每请求/600 秒；模型费用与 provider 并发沿用已验证规则，正式执行前冻结全局预算。该样本量只能提供多任务的方向性及波动证据，不足以给普遍非退化保证。
5. 决策按质量、拒绝后恢复、独立 Todo 回合、请求数、完整输入/输出/缓存用量及耗时分层，不仅报总量。只有多个任务支持同方向、有效工作未减少，才确认收益；真实共同遗漏不自动否决候选，孤立失败不自动归因精简。优先调整明确无益的调用依赖和来源反馈，不继续叠加同义提示、不关闭审查或 AMA。

### 2026-10-28 R7 完整结果：原始版一次留存，三版本逐任务比较

已记录 18 格，原始版、当前版、候选版每个模型/案例各一次，每格同 Session 两个真实用户请求。没有重复任何已调用模型的格。三个源码快照各自构建，生产差异审计确认当前→候选只有五个 Todo 来源分类文件；最终冻结文件哈希全部一致。首轮静态契约未因该补丁变化。原始版不是将当前提示换成长提示，而是 `bd4479d59cab3d082f07c2d34681fff198d82fa0` 的真实产品装配；当前为 `8a1afc77`，候选加上述补丁。

下表每格为 **已知全任务 API token / root 请求数 / 整格秒数**。token 包含两 Run 的输入、输出及实际子任务/辅助用量；root 请求包含最终报告，不等于用户轮数或工具调用数。耗时是每格墙钟时间，各格之和不等于并行实验耗时。

| 模型 / 任务 | 最初未优化 | 当前已采用 | 候选 |
|---|---:|---:|---:|
| GLM / 租户缓存 | 686,437 / 22 / 325.56 | 236,211 / 15 / 158.95 | 318,433 / 17 / 234.66 |
| GLM / 配置优先级 | 304,257 / 11 / 230.85 | 135,962 / 10 / 82.10 | 222,380 / 15 / 121.38 |
| Kimi / 租户缓存 | 373,870 / 14 / 125.98 | 128,522 / 10 / 97.24 | 117,504 / 9 / 93.19 |
| Kimi / 配置优先级 | 274,202 / 10 / 137.46 | 142,637 / 10 / 97.81 | 130,369 / 10 / 67.99 |
| DeepSeek / 租户缓存 | 1,079,143 / 31 / 69.85 **预算截断** | 248,687 / 15 / 51.21 | 539,966 / 27 / 69.94 |
| DeepSeek / 配置优先级 | 497,539 / 15 / 41.55 | 607,039 / 27 / 72.87 | 248,174 / 15 / 44.48 |

原始 DeepSeek 缓存第二个 Run 达到 32 物理请求硬上限（31 root + 1 auxiliary），保存的代码通过独立检查，但没有第二轮最终报告，不能计为完整任务成功，也不能根据其截断耗时推断完成速度。触发后全局调度暂停；离线确认是该格追加验证与修复耗尽预算，未发生鉴权/网络/隔离故障。人工复核后仅继续从未启动的格，没有提高预算或补跑失败格。一次在派发前被 STOP 拦住的 cell-08 当时没有 provider 调用或结果目录，保留原调度日志，并以独立 remaining-1 日志执行。STOP 首因被调度器退出码覆盖的研究脚本缺陷已离线修正，原始 ledger/summary 保留真实首因。

| 汇总（每版六格，原始含一格截断） | 最初未优化 | 当前 | 候选 |
|---|---:|---:|---:|
| root / child / auxiliary | 103 / 4 / 1 | 87 / 2 / 0 | 93 / 4 / 1 |
| 全部物理请求 | 108 | 89 | 98 |
| 已知 API token | 3,215,448 | 1,499,058 | 1,576,826 |
| 未知用量保守预留 token | 0 | 0 | 20,649 |
| 各格耗时之和（秒） | 931.25 | 560.18 | 631.64 |
| 已知用量参考美元 | 0.105917 | 0.060508 | 0.066894 |

当前/候选相对原始的已知 token 分别减少约 53.4% / 51.0%；候选相对当前增加约 5.2%，耗时之和增加约 12.8%。这不是同质量普遍提效证明，尤其不能掩盖 DeepSeek 当前配置任务多 12 个 root、GLM 候选配置任务比原始还多 4 个 root。全部 295 物理请求、6,291,332 已知 token；计入 GLM 候选配置中一次正常取消辅助请求的未知预留后为 6,311,981。参考费用合计 $0.233319，保守口径 $0.234403；这是冻结参考费率而非套餐实际新增账单。未知用量没有按零计入预算。

首请求 API 输入（两个案例的范围）：GLM 原始 24,901–24,913→当前 11,178–11,181；Kimi 23,243–23,245→10,063–10,072；DeepSeek 25,721–25,726→11,628–11,634。候选分别约 11.18K / 10.07K / 11.64K，与当前静态契约相同，动态路径等使实测有少量差异。这是 Windows、Coding、无技能教学、LSP 关闭、RepoIntel 关闭的受限任务抓包，不是三模式全服务宿主的总量，也不能与字符估算混用。

**质量与评分器校正**：17/18 格完成 Runtime，两轮完整结束且独立 oracle 通过的格数为原始 2/6、当前 4/6、候选 4/6；这些计数不替代语义评审。GLM/Kimi 三版本的配置任务全部遗漏公开契约中“未提供值应继续从低优先级读取”的边界：例如 CLI 属性为 undefined 时不应覆盖有效的环境/文件值。部分实现还把空环境字符串转成 0。六格都修好了表面优先级及零/false，但测试未覆盖正确的缺省组合；不能把这项共同失败归因于本次精简，也不能称质量全绿。实际 read 轨迹里这六格均没有读取 README，而三个 DeepSeek 配置格均读了公开契约并通过；这只支持调查契约获取路径，不证明强制读 README 必然有效。

Kimi 原始缓存用空格拼接两段任意字符串，仍有碰撞。原 oracle 测了冒号和 NUL 却漏了空格，语义审查发现后先加离线 mutant 获得 RED，再将通用分隔符族纳入 oracle v2，GREEN；统一对所有 18 份保存结果重评，没有重跑模型、修改模型输入或覆盖原 oracle。只有该格从原来的假阳性通过改为失败，v1/v2 结果同时保存。当前/候选缓存实现通过。报告另有过度声称：GLM 候选将前一 Run 已完成的修复描述为本轮刚完成；DeepSeek 部分报告把未证实的竞争风险当成实际缺陷，或从一条复合 npm 命令被拒推断 npm test 不可用。公开测试退出 0 不代表这些叙述准确。

**额外开销的来源**：

- GLM 候选缓存比当前多 82,222 token。子审查确实发现了 falsy 值覆盖不足，不能为省轮删除。随后 anchor 插入把测试错误嵌套，三个 read/edit/edit 恢复响应本身消耗 60,893 token；这不是“无损删掉三轮即可省同等量”的反事实。候选 child 4 请求，当前 2 请求；当前子任务已有 knownEvidence 全部源码和测试，不能因没有再 read 就判断其伪造审查。两格均有带 agent_id 的派发被评测边界拒绝，属于隔离驱动限制，不能据此删生产角色。
- GLM 候选配置比当前多的 5 个 root 全在第一 Run：局部编辑留下重复旧尾部，以及修正后测试仍失败，引发读取、再修复、复测。第二 Run 两者都是 4 个 root。原始版个别响应延迟超过 40/70 秒，也有 provider 时延差异，不能把全部墙钟差算到 harness。没有根请求传输故障。
- Kimi 本轮候选两个任务的 token 和时间均低于当前，配置任务 root 同为 10、缓存 10→9。R6 的增长没有在新任务中一致复现；单样本仍不能证明稳定改善。三版本共同遗漏应先查契约获取与验证范围，不能反复添加案例答案。
- DeepSeek 当前配置多出了范围较大的测试矩阵、纯 Todo 响应，以及一个明确的评测缺陷：大段失败输出写入工作区外的宿主工具缓存，后续 grep 恢复文件被隔离守卫拒绝，继而出现 reporter/background 等额外尝试和再次生成同样截断输出。索引 17–22 的原始回执完整保留，相关六个输出/清单文件已按原路径取证备份。恢复路径不可达属于评测装配问题，不能据此削减模型能力或放宽越界读取。
- DeepSeek 候选缓存比当前多 12 个 root，包含初始数组作为 Map key 的自生错误、测试异步时序修复、三个纯 Todo 响应及缺乏生产触发条件的额外竞争验证。原始版也在预算耗尽前追逐类似竞争问题，属于多版本均可发生的范围扩张，不能证明本次 Todo 分类导致。纯 Todo 回合不是全部增量，有价值的验证不能一并删掉。
- 所有 18 格均没有来源明确的 Todo 错误回执（成功 Todo 共 22 次，无缺失回执）。当前与候选的唯一生产差异没有自然暴露，不能把上述涨跌当作该补丁的因果收益或退化。

**已完成的最小离线修复验证**：复用生产已存在的 `KODAX_TOOL_OUTPUT_DIR`，将评测子进程的工具输出位置设为其 fixture 内 `.agent/tmp/tool-results`，不改权限判定。新增真实 Runtime 回归先用工作区外目录复现恢复被拒，再用工作区内绑定确认读取失败标记成功，同时任意工作区外读取仍拒绝、保护文件不变。该配置验证未追溯修改已冻结的 R7，也未据此追加付费样本；未来评测启动器应在创建 Runtime 前按进程设置，避免并行格污染全局环境。该断言证明恢复路径可用，不承诺真实模型一定少几轮。

**交付与局限**：新增两个产品 fixture、缺陷/不完整/完整修复判别、分隔符错误修复反例；共享 Runtime 支持这两类自然连续任务，并分别统计工具提议预算与执行预算。相关 Runtime/fixture/trace 离线测试累计 37 项通过（最后的输出恢复测试单独运行），测试类型检查通过；三个版本独立构建与各三项预检通过。主会话先审匿名语义包再看部分效率，但已见进度、部分诊断和预算事件，不是独立双盲。两个小任务族、每格一次、仅本地 Windows，不支持所有能力/复杂仓库/其他平台的全面非退化结论。

原始六格已登记 `original-baseline-registry.json`（源码、案例/守卫冻结哈希、路由、结果、用量和证据哈希）；以后同案例/模型/协议复用，不为失败重跑。原始 API 请求响应、最终文件、v2 oracle、结构化语义评审和逐请求分析保存在 OS Temp R7 目录及 backup-a/backup-b。补齐会话附属文件备份时处理了 Windows 长路径，最终证据副本无哈希差异、冻结源码无差异。正式判读为 `final-review.json` 与本节，不能把原始研究草稿当已接受结论。

**建议**：保留已采用的累计优化；Todo 来源分类仍只按离线正确性证据建议保留，不领取未观测的效率收益。先落实评测输出的现成绑定，再离线审计通用的契约获取、合法拒绝恢复和有依据的验证范围；不要追加 README/零值等案例专用提示，不强制增加读取/发现回合，不关闭 AMA 或有价值的子审查。暂不继续首轮精简，也不再跑完整矩阵。“完整任务不增轮”尚未达成，下一候选须针对已定位缺口而不是为某个分数补词。

### 2026-10-28 R8 离线阶段：落实输出绑定，校正参数错误反馈

本阶段没有付费模型调用，没有修改生产提示、编辑语义、AMA 或工具菜单。沿用 R7 三版本及原始留存；R8 的新反馈协议尚无真实模型成绩，不能给它填写 R7 的效率数字或称已消除额外轮次。

**已落实**：`benchmark/harness/isolated-output-binding.mjs` 是评测专用 Node preload。现有 cell 子进程启动命令在入口前加 `--import ./benchmark/harness/isolated-output-binding.mjs`，沿用已有 `KODAX_ORIGINAL_SMOKE_ROOT` / `KODAX_ORIGINAL_SMOKE_CELL`，将现有 `KODAX_TOOL_OUTPUT_DIR` 绑定到 `<root>/<cell>/workspace/.agent/tmp/tool-results`。只修改该子进程环境，不修改父进程、用户环境或生产默认值；并行 cell 分别绑定，不在共享 Runtime helper 中临时切换全局环境。启动时拒绝缺失/非法 cell、相对根目录和 Temp 之外的根目录。它是受信评测启动器，不宣称替代生产沙箱或防御任意恶意符号链接。

回归先复现两子进程仍继承宿主输出目录（RED），加绑定后 GREEN；并行目录各自正确、父环境不变、其余环境保留。另实际以该 preload 启动 Vitest 子进程，运行完整 Runtime：写入产生大段失败输出的测试→执行→grep 原始失败标记与尝试范围外读取→文本报告，四次离线预设响应完成；原始标记可读、范围外读取仍拒绝、保护文件不变。不是把输出改写成成功，也没有提高预算。构造该离线探针时修正过 Windows import 文件 URL、缺少 cell 父目录和空白最终响应等测试脚手架问题；其中空白响应触发额外请求符合 Runtime 现有语义，不能当生产缺陷。失败离线产物保留，没有任何模型重跑。

下一次付费评测须新冻结协议，包含 preload、实际启动命令与守卫版本；研究启动器已接入该 preload，但未启动 R8 付费面板。R7 原始快照、18 格原始输出和评分不变。不同协议下的新结果可与历史并列，必须注明恢复目录/反馈差异，不能冒充严格同环境配对。

**第二项最小修复**：R7 DeepSeek 候选缓存曾提出没有 path 的 edit，旧守卫返回“只有 root 源码和新测试可修改”，把参数缺失描述成范围拒绝。仅评测守卫现在对 root 的缺失、非字符串或空白 path 返回明确参数错误，说明未执行、需补齐参数且权限不变。没有自动补 path、改写 edits 或扩大白名单；只读 child 仍先受禁止写入约束，越界和保护文件仍拒绝。离线用原失败形状复现 RED 后，验证三响应的拒绝→合法修改→如实报告，权限边界不变。该反馈不会替模型修复 edits 数组中其他错误，生产 schema/执行链仍负责真实参数校验。

**完整轨迹审计后的取舍**：

| 问题 | 证据与判断 | 本阶段处理 |
|---|---|---|
| 契约获取 | 配置任务六个 GLM/Kimi 样本均未 read README，首请求也没有该任务的缺省契约；三格 DeepSeek 在第一响应五项批量读取中包含它。GLM/Kimi 首响应已经能批量读 3–4 项，不存在必须先调用发现工具或串行的接口依赖。当前/候选真实 system 含独立读取批量规则、范围/恢复和计划合批规则。 | 原始版也漏边界，不能归因精简。可探索将相关行为契约纳入已有取证批次，但没有证据支持强制每任务 read README、增加一轮预检或追加案例答案；本轮不改提示。 |
| 编辑自修复 | 对 cell-16 第 1 个编辑响应和 cell-03 第 15 个插入响应，使用原参数和可见源文件做真实工具离线重放。结果与所请求的文字替换/锚点插入一致；前者遗漏原 return 尾部，后者选在回调开头。原 diff 已显示错误位置，模型随后发现并修复。 | 不把 insert_after_anchor 改成猜测函数尾部、不暗改参数、不增加默认 AST 修复/强制读取轮次。两个重放诊断通过，未证实执行器缺陷；保留现有 diff 和有价值的子审查。 |
| 独立 Todo 回合 | 18 格共 7 个纯 Todo 响应。原始 GLM 缓存末尾 1 个、DeepSeek 当前配置两 Run 末尾各 1 个、DeepSeek 候选缓存末尾 1 个，均在验证后、最终报告前；剩余 3 个为候选缓存中途 2 个及当前配置第二 Run 创建计划 1 个。 | 4 个最终状态回执不能算可无损删除的空转：不能在测试结果未返回时标完成，也不能假设 hooks/evaluator 已成功。其余 3 个可与独立工作合批，现有接口、初始 in_progress 和合批教学已支持。三模式现有真实 Runtime 合批回归通过，不新增批量工具、不关闭 Todo、不强制合并依赖调用。 |

现有完整 Runtime/fixture/trace 回归与新增子进程绑定测试 **43 项通过**；测试类型检查通过、git diff --check 通过。另有 2 项原参数工具重放和 1 项实际 preload→Runtime 恢复诊断通过，属于离线预设响应，不是模型行为证明。本地 Windows 已实测；POSIX 风格权限路径断言通过，未实机运行 macOS/Linux。

R8 离线证据位于 OS Temp `kodax-eval-dumps/product-multiturn-r8-offline-20261028`，包含 `contract-acquisition-audit.json`、`glm-edit-replay.json`、`glm-anchor-replay.json`、`preloaded-runtime-recovery.json` 及双备份。后续只有出现可证伪、通用的生产候选才做固定检查点的有限模型验证；原始版继续复用 R7 留存，不重新跑完整矩阵。当前结论是修复评测装配与反馈正确性，不是宣布智能和全任务效率目标全部完成。

### 2026-10-28 R9：相关契约取证固定检查点（预注册）

候选仅替换现有 MUTATION DISCIPLINE 第一条：保留非平凡文件编辑前读取与当前锚点要求，明确从代码、邻近文档和测试建立相关行为/兼容约束；把尚缺的独立证据并入现有读取批次、复用已有证据，不设置固定发现步骤。候选位于 benchmark，未进入生产默认；没有改 AMA、子审查、SDK、工具 schema 或调用权限，也不指定 README、特定文件名或某个缺陷答案。离线证明替换只有一处，缺失/重复规则则停止；无法用离线断言证明真实模型会选择相关证据，因此进行 Layer 2 单请求验证。

使用一个不同于 R7 的 CSV 格式修复任务，两个固定检查点：尚未取证（已知项目目录）与证据已齐（完整当前实现、格式契约、测试及明确尚未修改/测试的前文）。第一点看是否同一响应读取相关实现/契约/测试，避免猜测或新增固定发现；第二点看是否直接开始合法修复，避免重复读完备证据。后者是受控历史，不是假装来自已运行生产会话。工具描述、schema 和 system 基底来自 R7 保存的真实生产请求；仅替换 fixture 目录、用户任务和受控历史，并在当前→候选之间只替换一条 system 规则。原始版使用原始生产快照的完整 system/tools，不用当前版拼接长提示替代。

三版本：原始 bd4479d、当前 8a1afc77、当前加取证教学候选（不是 R7 的 Todo 回执候选）。GLM/Kimi 先检查“尚缺契约”，共 6 个单请求，审查实验有效性后才继续证据复用及 DeepSeek；全实验最多 18 请求，每案例/模型/版本仅一次，无自动重试，不执行模型提出的任何工具，不扩成自由任务循环。原始新检查点各运行一次并保存，R7 原始完整任务留存继续并列，两个协议不混成同一成绩。

预算冻结为每格 1 请求、最多 4096 输出 token、180 秒；全局最多 18 请求、300 万保守计量 token、参考美元 $2。同 provider 串行，跨 provider 可并行。使用 zhipu-coding/glm-5.3、kimi-code/kimi-for-coding、deepseek/deepseek-flash；保留各自已用 reasoning 设置。调用前预留，按物理尝试与 API usage 结算，未知按预留计并停止，失败不补跑。费用为参考费率，非订阅实际账单。

冻结输入/哈希、来源映射、预算、原始响应及双备份写 OS Temp `kodax-eval-dumps/contract-evidence-r9-20261028`。主会话先读匿名化下一步选择与参数，再揭示版本/效率；主会话知道设计和 pilot 顺序，不宣称独立双盲。先判语义：必要证据、有效修复、兼容范围、无虚构验证、是否引入不必要取证/计划/等待；工具计数仅辅助，不能用 mentions 判读。不因单格不全绿否决，也不凭单次选对证明全任务无退化。采用决策必须明确：本轮只能证明检查点选择，不等于三模式完整任务 token/耗时已改善。

#### R9 结果：保留当前教学，不推广本候选

18 个单请求全部记录，无传输/计量失败，无重跑，没有执行模型提出的工具。原始版六个新检查点各一次，已单独登记复用；R7 完整任务原始留存未重跑。候选替换一条规则，当前/候选工具和消息完全一致，system 净增加 177 字符；API 输入每请求增加 GLM/Kimi 各 23 token、DeepSeek 22 token。这里分别标明字符与实测 token，不混用单位。

尚缺契约时，三模型 × 三版本共 9 格均在同一响应提出读取源码、相关格式文档和既有测试，部分再读取 package.json。候选未显示增益。GLM/Kimi pilot 已发现正向选择达到上限，之后仅完成原定证据复用负向检查和 DeepSeek 对照，没有为拉开差距修改案例或追加样本。

| 证据已齐时的下一响应 | 原始未优化 | 当前已采用 | 取证教学候选 |
|---|---|---|---|
| GLM | write 重写现有源码 | edit 源码和测试，同响应 | edit 源码，测试尚未提出 |
| Kimi | write 源码并 edit 测试 | edit 源码和测试，同响应 | 只 read package.json |
| DeepSeek | 只创建两个 Todo | 执行修改前的现有测试 | read package.json 与 README |

这些是**提议**，没有对应执行成功回执。静态审查 GLM/Kimi 的修改逻辑均合理保留引号转义、CRLF、普通/空值等边界，但没有运行测试，不能写成已修复通过。原始两格 write 现有文件违背已保留的 edit 偏好；当前两格使用 edit 同批提出源码与回归测试。DeepSeek 当前先跑基线测试属于有价值的验证，不能为了要求第一响应必须编辑而判失败。

检查点设计也有局限：所谓“证据已齐”是源码、行为契约、现有测试齐全，并未提供 package.json。候选的包信息读取可以服务后续测试准备，不能全部误标为无用重读或已证实退化；九格都没有重读已给出的那三份内容。但候选 Kimi/DeepSeek 没有同批推进已具备证据的修复，不能据此承诺不增加往返。正向案例中文档名称明确，三版本都容易选对；它验证了已有能力，不能证明新提示解决了 R7 中 README 入口不明显时的遗漏。

以下仅为**每模型两个检查点合计的 API token / 请求耗时之和**，不是完整任务用量或墙钟完成时间：

| 模型 | 原始 | 当前 | 候选 |
|---|---:|---:|---:|
| GLM | 50,223 / 12.56 秒 | 23,181 / 14.64 秒 | 22,853 / 11.29 秒 |
| Kimi | 47,661 / 17.11 秒 | 21,379 / 17.28 秒 | 20,962 / 9.93 秒 |
| DeepSeek | 52,375 / 3.05 秒 | 23,977 / 2.82 秒 | 24,015 / 2.03 秒 |

全部 286,626 token，参考费用 $0.011070，无未知用量；套餐实际账单另计。当前→候选合计 token 68,537→67,830 的减少主要来自少生成修改/测试内容，不能算同质量提效。所有格人为限定一个请求，不能把“每格都一轮”作为不增轮证明。R7 完整任务 3,215,448 / 1,499,058 / 1,576,826 的历史比较仍独立保留，且其候选是 Todo 回执补丁，不能冒充本轮取证候选的完整任务成绩。

三项新增离线回归、真实请求冻结中的当前/候选消息与工具等价断言通过；将 shared-contract、产品 fixture 和新检查点测试显式纳入 tsconfig.test.json 后，类型检查通过。此前 typecheck:tests 的 include 没有完整覆盖这些文件，本次补齐，避免继续误称它们已被该命令检查。冻结候选/驱动源码哈希及原始输入输出双备份核对无差异。正式结论保存于 `final-review.json`，匿名语义评语先于揭盲落盘；样本为 Coding/Windows 请求模板，不能宣称其他模式或完整智能非退化。

**决策**：`recommend-retain-current`。候选仅留作 benchmark 中可复核的实验，不进入生产默认，不追加同义规则、不扩付费矩阵。这不是因为要求所有格全绿，而是未观察到新增价值，且不能排除它把部分模型引向更多上下文收集。下一生产候选需要不同的、可定位的缺口证据；不为了使当前案例出现 lift 而调整措辞反复重跑。AMA、子审查、SDK、工具能力与当前批量执行策略不变。

### 2026-10-28 R10：准确拒绝反馈与整体进展校准（纯离线）

**保留当前生产默认，零模型请求。** 没有推广 R9 取证提示，没有修改 AMA、SDK、专用角色、
工具菜单或隔离规则。整体状态、三模式当前成本及下一阶段顺序已提到
[总计划顶部](../designs/agent-under-10k-next-plan.md)，避免用历史检查点冒充当前状态。

**真实缺口**：R7 GLM 缓存 cell-03 请求索引 7、cell-18 索引 9 均提出
`spawn_agent`，携带 `agent_id: kodax/role/worker` 和 `read_only: true`。
隔离评测不允许显式角色选择，但旧回执只说“只允许一个只读、继承模型的子 Agent”。
这没有点明实际被拒的字段，容易被理解为配额或只读性问题。两格后来分别在索引 9/10
去掉角色字段后成功派发，子审查提供了有效证据；不能据此删掉生产角色或子审查。

**最小改动**：只在共享评测守卫区分只读拒绝、显式 provider/model 拒绝、显式 agent_id 拒绝。
后两类明确指出字段、可省略以使用默认值，并说明未启动子 Agent、现有权限/配额仍适用。
没有自动删字段、改写参数、增加调用或扩大白名单。真正的子任务数量仍由现有 Runtime 控制。

TDD 先以缺少 `agent_id` 反馈复现 RED，再通过 GREEN：72 种只读/角色/provider/model 参数组合
与旧拒绝谓词完全等价；实际 Runtime 中先拒绝显式角色，随后由预设下一响应提出合法参数，
只启动一个只读子 Agent 并正常收尾，保护文件不变。该预设响应是离线执行验证，
不宣称模型已自主少跑一轮，也不保证消除首次被拒。目标 Runtime 三项、共享守卫/统一计数/
输出绑定 39 项通过；测试类型检查通过。此前的写入子任务拒绝和提议预算上限仍通过。

本轮另重跑 SDK 首轮截获测试，32 个输入，外部调用为零。按统一模型字段重算得到
Agent **10,839**、Coding **14,470**、Script **16,340**；旧整对象数字各多计 27 个
控制字段估算 token，这只是统计修正。完整字符/字节/hash 见
[统一计数](../designs/first-turn-uniform-costs.md)。本轮未重跑全部能力、发布包或付费完整任务。

R7 三版本完整任务、R9 单请求候选成绩分别保留；R10 没有模型成绩，不借用别的候选成绩。
原始失败派发/恢复证据、补丁源码、32 份序列化输入与统一重算保存在 Temp
`kodax-eval-dumps/feedback-r10-offline-20261028`，39 个证据文件有两份逐文件哈希核对的备份。
下一步以已有版本收束及可定位的完整任务成本为主；没有新机制证据时不再增加泛化提示、
发现步骤或完整矩阵。首次输入下降已明确，完整任务质量及不增轮仍须按具体差异验收。

### 2026-10-28 R11：当前补丁装配与发布产物收束

本阶段保留当前默认与 R9 不采用决定，没有修改生产提示、AMA、角色分派、SDK 入口或工具集合，
没有真实模型调用。待提交的生产差异仍为五个 Todo 工具/回执分类源码文件；成功 JSON 与原始
reason 保留，失败新增 `todo_invalid_input`、`todo_unavailable`、`todo_hook_veto`、
`todo_state_conflict` 来源码，转发时标为错误，不自动赋予重试权限或当作取消。
这不是把 extension 任意 `{ok:false}` 都视为已知失败，也没有替模型改写参数。

| 最终工作区检查 | 结果与边界 |
|---|---|
| `npm run build` | 通过：工作区包、原生资产、bundle 和 14 个 SDK 类型入口 |
| `npm run typecheck` | 源码与测试均通过 |
| 定向 Vitest 装配/恢复 | 20 文件、344 项通过；含三模式、Todo、原生/桥接权限预算、真实 Runtime、多轮恢复及 combined MCP/RepoIntel 装配 |
| `npm run test:bundle` | 48 项通过，使用刚构建的产物；含真实 npm tarball Script 执行、隔离和缺失 worker 拒绝 |
| 扩展后的 `node --test tests/script-release.test.mjs` | 2 项通过；新增 packed SDK 三模式 Todo 错误→合法创建→报告，每模式恰好 3 个主请求，无外部网络 |
| `npm pack` 与 `audit-runtime-tarball.mjs` | 真实 tarball 保留；112 个 bundle 审计通过，SDK/Artifact 入口齐全、已退役 verifier 未混入 |
| Windows 二进制 | Bun 1.4.2 从当前构建重新编译，SDK、原生文本、技能和 A2A 冒烟通过 |
| Windows 发布 ZIP | 按 release.yml 文件布局打包；实际启动新二进制，8 场景通过：默认 Coding、Agent、Script 部分失败、恢复、取消/未取消对照、CLI 临时模式、清空模式回到 Coding；缺失 worker 拒绝仍有效 |

ZIP 生命周期共捕获 18 个本地请求，其中 11 个是主请求，其余辅助请求仍记录，未将它们隐藏或
误称为零。使用预设本地 provider，证明执行链和精确调用边界，不是模型智能非退化证据。
SDK 新增测试首次遗漏 Script 的 writable canonical Session storage，按既有要求补入 `session.storage`
后通过；初次失败日志保留，只修测试装配，没有降低产品要求或扩大权限。

打包产物 SHA-256：

- npm `kodax-ai-kodax-0.7.97-alpha.9.tgz`：`4b743e13a0242a74da7755a8c0e84e92b5fea4110ce83cba1958fcc3638c2986`
- Windows `kodax-win-x64.zip`：`44b276d54b352198b535067975f64358f34ffff5c0d7054452c70b3370f9748a`

15 个首轮注入/装配源码 hash 与 R10 抓包相同，故不再为未变的提示重复抓包或运行模型。
Agent/Coding/Script 仍为 10,839 / 14,470 / 16,340 同口径估算；R7 原始/当前/Todo 候选完整任务
与 R9 取证提示检查点仍分开列示。此次没有新候选的模型成绩，不宣称已消除实际多出的轮次。

**针对完整任务额外开销的处理边界**：已证实的工作区外输出恢复、缺 path 和角色字段误导反馈，
保持最小离线修复；独立 Todo 最终确认、有价值的子审查继续保留。编辑位置错误原参数重放符合
工具契约，没有依据改写模型选区；共性契约遗漏的通用提示试验未获收益，不增加固定读取步骤。
没有新可证伪机制候选时不追加模型验证，不通过重复矩阵寻找好结果。

证据保存在 OS Temp `kodax-eval-dumps/release-consolidation-r11-20261028`，包括源码快照与补丁、
验收日志、原始失败、npm/ZIP、生命周期请求及结构化 `acceptance.json`，有两份哈希核对备份。
此处只验收当前补丁相关装配和发布包，不声称重跑此前全部能力套件、macOS/Linux 实机或任意外部
MCP/LSP 服务；没有执行 publish、提交或推送。

### 2026-10-28 R12：恢复修复后的有限真实任务复核（预注册）

R11 已验收补丁于 `490ea6dece90b2f8e1688f6d311f5fe74e35e9ab` 提交并推送。
本轮只新增三格：GLM `tenant-cache`（旧角色拒绝轨迹）、DeepSeek `config-precedence`
（旧输出恢复越界轨迹）、Kimi `tenant-cache`（无该阻断的对照）。沿用 R7 两轮自然用户任务、
完整 AMA、只读子审查权限和不强制派发；原始/旧当前/旧 Todo 候选全部复用留存，不重跑。
新候选是提交版本加评测输出目录绑定及准确拒绝反馈，不是 R9 取证提示。

每格 32 次请求、80 次执行/提议工具上限、150 万保守 token、8192 输出 token、请求 180 秒、
全格 600 秒；三格合计最多 96 请求、450 万 token、参考 $1.50（GLM/Kimi 各 $0.30，
DeepSeek $0.90），未知用量按预留计；单次尝试，无失败重跑、自动换模型或修改输出。
先 GLM pilot 检查实验有效性，才启动另外两格；各 provider 串行。收费是冻结参考费率，非订阅账单。

离线已经证明权限、回执和合法恢复，不能证明模型会选择有效恢复，因此本轮做有限完整任务观察，
不比较提示措辞。先审最终源码、测试和报告，再看效率；先标注修复分支是否实际触发，区分必要
审查/自修复与禁止操作重试。操作员知道设计和运行次序，只作部分盲化，不宣称独立双盲。
历史协议的恢复目录/反馈不同，三版本并列只是观察，不能冒充严格因果性能实验。
原始基线注册哈希、2401 个冻结文件、预算和映射保存于 Temp
`kodax-eval-dumps/recovery-r12-20261028` 及双备份。若分支未触发，不为凑证据反复跑同一格。

#### R12 结果：有局部效率改善，未证明完整任务非退化

三格按冻结计划各运行一次，共 43 个实际请求、633,638 已知 token、参考费用 $0.026168477，
无未知用量、传输故障或重跑。每格均完成两个用户 Run、保护文件不变。主 Agent 自主决定没有派发
子审查；能力与权限仍存在，未强制添加派发步骤。原始版与旧当前版全部使用 R7 留存。

表中单元为 **主请求数 / 全任务 API token / 各格耗时秒**；token 包含子 Agent 和辅助请求，
主请求数不含它们。GLM 原始额外 4 个 child、旧当前额外 2 个 child；其余所列格无 child/aux。

| 模型 / 连续任务 | 最初未优化 bd4479d | 旧当前 8a1afc77 | 恢复候选 490ea6de + 新评测绑定 |
|---|---:|---:|---:|
| GLM / 缓存 | 22 / 686,437 / 325.56 | 15 / 236,211 / 158.95 | 14 / 186,564 / 141.56 |
| DeepSeek / 配置 | 15 / 497,539 / 41.55 | 27 / 607,039 / 72.87 | 17 / 291,487 / 49.36 |
| Kimi / 缓存 | 14 / 373,870 / 125.98 | 10 / 128,522 / 97.24 | 12 / 155,587 / 88.95 |

所选三格合计 token 为 1,557,846 / 971,772 / 633,638，参考费用 $0.058872912 /
$0.037128984 / $0.026168477，耗时之和 493.09 / 329.06 / 279.87 秒。
这不是质量相同的性能比：独立检查分别通过 **2/3、3/3、1/3**。旧 R7 Todo 候选也单独保存，
对应 GLM 17 / 318,433 / 234.66、DeepSeek 15 / 248,174 / 44.48、Kimi 9 / 117,504 / 93.19，
三格独立检查均通过；不能把它与 R12 候选混成同一批数据。

**逐项判读**：

- GLM：两轮都用 NUL 分隔拼接任意 tenant/key，NUL 输入仍碰撞；独立检查失败。
  试图修改保护测试被拒后正确另建文件，但先后两次重复 `npm test 2>&1`、`node --test tests`，
  共 4 个整轮命令被守卫拒绝（旧当前 2 个整轮拒绝）。报告诚实说明没有实际跑测试，却把不支持的
  命令形状推广成全部测试不可运行，也夸大了碰撞保护。少一个主请求并不能算质量相同的收益。
- DeepSeek：公开和独立检查通过，报告准确区分被拒的 `node -e` 与实际测试；第二轮新增测试中
  写错一个预期值，读取原始失败后修正为正确的逐项优先级，最终 20 个公开/新增测试通过。
  整轮守卫拒绝从 6 个降到 2 个，主请求从 27 降到 17；但没有溢出输出文件，没有实际经过此次修复的
  大输出恢复路径，不能把节省的 10 次主请求直接归给输出绑定。额外 null 处理不作为通用兼容性证明。
- Kimi：真实执行的 3/7 个测试通过，报告有回执支持；同样用 NUL 分隔拼接，独立检查失败。
  原始 Kimi 曾用空格分隔并碰撞，旧当前和旧 Todo 候选则正确。新样本比旧当前多 2 个主请求、
  21.1% token，但时间略低；既不能忽略质量，也不能从单格波动认定提示精简导致退化。

三格没有触发 `agent_id` 拒绝、来源明确的 Todo 失败或大输出恢复，且 Todo 调用总数为 0。
不能宣称本轮已验证这些修复能减少模型往返。首请求工具定义与旧当前逐字相同；system 只归一化
cwd 和临时 provider ID 后逐字相同。R7 Todo 候选 1,073 个生产源码文件与本次文本相同，13 个
字节差异仅是 CRLF/LF；这些取证支持“尚未定位精简导致的变化”，不证明模型随机性是唯一原因。
质量检查与源码/报告评语先于 aggregate 成本审查落盘，操作员已看到进度与部分轨迹，仍只作部分盲化。

**运行后最小离线改进，未混入上述模型成绩**：守卫维持拒绝重定向和目录参数，但对 root 明确说明
拒绝的是该形状，允许使用无重定向的合法测试命令、`node --test` 或显式测试文件。只读子 Agent 仍
收到只读边界，越界路径和命令组合优先拒绝，没有执行禁止命令、删参数或扩大白名单。
回归先因缺少准确原因而 RED；144 组命令/只读/cwd/后台参数允许与拒绝结果与 legacy 反馈一致。
实际 Runtime 先接收两条原始拒绝，再执行模型回调另行提出的合法测试，恰好三请求完成。
这是预设回调的离线验证，不能写成真实模型自主恢复成功。新增及相邻 38 项测试、测试类型检查通过。

**决策**：保留当前生产默认和正确性修复；不推广新提示、不强制派发、不因少轮牺牲质量。
此次不足以宣布整体非退化或修复带来因果提效，也不为覆盖未触发分支再跑同一完整任务。
下一机制验证若必要，使用保存的失败检查点作有限对照；先分清回执缺信息、模型漏契约和实际执行缺陷。
首轮低于 10K 继续后置。付费运行结束时 2,401 个冻结文件无变化，随后离线修正另存，原始输出不改写。
源码/输入/输出、原始注册引用、语义评审、全任务与逐请求指标、离线 RED/GREEN 均保存在 R12 Temp 目录及双备份。

### 2026-10-28 R13：来自真实会话需求的跨案例连续任务

用户要求不要围绕单一失败反复重跑，改用不同问题观察已采用优化与候选的泛化表现。
本轮从独立的本地 KodaX 人类会话提取两类需求，改编为小型 JavaScript 仓库修复任务：
SDK 结果截断后的全文保留、归属隔离与清理；SDK 从子目录发现技能、同进程目录更新一致性。
来源为 2026-10-28 的本地会话 `01a18059-5edd-7611-9935-ea244163edd7` 中用户消息
（UTC 02:31:45、03:03:06、04:57:06、05:13:10）；选取消息逐条哈希及原文只存 OS Temp。
这些是合成编码任务，不是客户原始仓库，也不是实际 MCP 服务或 Skill 集成验收。

可执行案例在 `benchmark/datasets/product-multiturn/fixture.ts`；每例先运行自然修复请求，
再在同一 Session 追加隔离/更新需求。隐藏 oracle 位于模型工作区之外；公开 API、测试与文档
不允许修改，新增测试可运行。离线分别验证原始缺陷、不完整修复失败，完整修复成功，
以及真实 Runtime 的两轮状态连续性。模型的取证、编辑、验证与报告决策不能靠这些离线断言证明。

预注册六格：GLM `zhipu-coding/glm-5.3` 运行全文保留任务，Kimi
`kimi-code/kimi-for-coding` 运行技能发现任务，各三版一次，不展开模型×案例完整矩阵。
原始版 `bd4479d59cab3d082f07c2d34681fff198d82fa0`；当前版
`490ea6dece90b2f8e1688f6d311f5fe74e35e9ab`；候选与当前生产代码相同，仅评测守卫增加
R12 后的命令形状拒绝原因与合法测试恢复说明。三版使用共同的新 fixture、输出目录隔离与
执行准入规则。AMA、子审查能力、SDK、Coding 默认均保留，不强制额外工具或审查步骤。

每格上限 32 次物理请求、80 次工具、150 万 token、8192 输出 token/请求、180 秒/请求、
600 秒/格；总上限 192 请求、900 万 token、参考 $1.80。GLM/Kimi 参考费不是订阅账单。
每 provider 一条串行队列，两 provider 并行；各先一格检查实验有效性，才继续其余版本。
原始同模型同案例只跑一次留存，失败不重跑；不修改输出、隔离或提示以追求通过。

先按匿名单元审查最终源码、实际测试回执和报告，再揭示版本及质量/往返/token/费用/耗时。
作者了解构造与部分执行信息，只作部分盲化。拒绝修复分支未出现时，不归因其减少往返；
单样本跨版本仅为用户授权的完整产品探索观察，不作提示因果或统计非退化结论。
旧 R7/R12 数据独立保留，协议差异不混算。证据目录为 OS Temp
`kodax-eval-dumps/session-diversity-r13-20261028`，源码、输入和输出冻结并双备份。

#### R13 结果与采用判断

六格各运行一次，共 79 次物理请求、1,532,129 已知 token、参考 $0.037543925；无未知用量、
传输故障或重跑。全部完成两个用户 Run，保护文件不变。表中为 **主请求 / 全任务 token / 秒**；
本轮没有 child、辅助请求或 Todo 调用，能力仍保留，不能视为本轮覆盖了这些执行分支。

| 连续任务 / 模型 | 最初未优化 bd4479d | 当前 490ea6de | 候选：同生产代码 + 评测反馈 |
|---|---:|---:|---:|
| 全文保留、归属清理 / GLM | 13 / 345,574 / 129.88 | 13 / 165,156 / 151.47 | 11 / 142,422 / 127.22 |
| 技能根目录、更新一致性 / Kimi | 14 / 418,672 / 239.40 | 15 / 248,339 / 199.33 | 13 / 211,966 / 166.00 |
| 合计 | 27 / 764,246 / 369.28 | 28 / 413,495 / 350.80 | 24 / 354,388 / 293.22 |
| 冻结独立功能检查 | 1/2 | 2/2 | 2/2 |
| 参考费用 | $0.01955185 | $0.009650315 | $0.00834176 |

首请求真实 API input：GLM 24,911 → 11,192 / 11,195；Kimi 23,260 → 10,084 / 10,083。
这些是受限 Coding fixture，不能替代完整宿主三模式估算。候选合计较原始少 53.6% token、
3 次请求和 20.6% 耗时，但原始有功能失败，所以不是严格同质量性能比。
当前 Kimi 仍比原始多一次请求；当前 GLM 时间高于原始，不能声称所有模型/任务零增轮或更快。

**质量与原因**：

- GLM 三版都正确保留全文、校验 owner、按 owner 清理，接口不变；模型实际测试分别最终
  6 / 4 / 8 项通过，报告有回执支持。候选测试覆盖了更多预览与生命周期情形。
  原始两次命令形状拒绝，当前一次拒绝后另读 package.json；候选拒绝组合命令后直接合法执行。
  三版均尝试改保护测试，收到拒绝后另建测试；这是评测限制产生的开销，不能直接当作生产退化。
- Kimi 原始版没有读取 README，最终用 `package.json` 而非约定的 `.git` 判定根，新增测试也
  围绕错误假设编写，因此自己的 6 项测试通过而独立检查失败；另加入不必要的 mtime/size 缓存，
  并在报告中承认可能漏更新。当前和候选读取了公开契约，使用 `.git`，移除陈旧缓存，实际均
  9 项测试通过。两者各有一次自行写错测试预期，收到原始失败后自主修正，没有外部干预。
- 当前 Kimi 额外处理了 list/read 之间的删除竞态，属于有价值的完善；不能为了减少一轮删除该能力。
  但源码审查发现其根标记检测把所有 `fs.access` 错误当不存在。运行后单独的离线 EACCES 注入
  确认了这处异常语义缺口，候选正确传播。另一个离线等长度/保留 mtime 检查确认原始缓存元数据
  陈旧而正文已更新，当前/候选一致。这些是 **事后诊断**，未改写冻结 oracle 的通过数，未重跑模型。
  缺口出现在模型生成的案例代码中，不是发现 KodaX SDK 本身新增了同一缺陷。
- 候选 Kimi 报告把按 root 缓存本身描述成可能串项目，因果说明过度；当前的竞态补丁也没有
  以确定性竞态测试证明。主流程正确不代表报告每句话与每个异常边界都经过验证。

**归因边界**：当前和候选生产代码完全一致；候选新增的两条命令形状反馈在这六格中均未触发，
既有组合命令反馈才被使用。不能把候选少 4 次请求归因该小补丁，也不能从当前 Kimi 的一次
异常处理遗漏认定精简导致退化。不因单样本全绿宣布通用智能提升，也不因基线共同问题反复否决优化。

**实验环境限制**：原始 Kimi 的中间 `.kodax` 向上搜索实现，在生成测试中读到了宿主用户技能
元数据；原始回执保留在本地 Temp。执行准入与保护文件规则没有放宽，但允许运行普通 Node 测试
不等于 OS 级文件系统隔离，宿主内容对那次失败及开销有影响。原始最终错误根标记可由冻结 fixture
独立复现，其功能失败结论不依赖宿主内容。后续新付费案例应先验证测试进程的宿主目录隔离/受控祖先，
不把此轮称为安全沙箱验收；不通过放宽守卫或重写模型代码修饰数据。

**决策**：继续采用已经落地的生产优化，保留 AMA、SDK、全部能力及有价值的审查；评测反馈修正
依靠离线等价性保留，不领取未经证明的模型收益。新场景支持此前的总体改进方向，当前没有依据再加
通用取证提示、强制发现/计划或删能力。后续优先处理有直接证据的通用契约/执行缺陷，按多案例判断，
不继续围绕一格扩矩阵。43 项相邻离线回归通过；三版独立构建与各 8 项 fixture/Runtime 检查通过。
匿名质量评审先于映射/汇总读取，作者见过部分日志，故仍只作部分盲化；完整证据及原始版一次留存
注册均在上述 Temp 目录。此次没有生产源码修改，也没有改变首轮注入数字。

### 2026-10-28 R14：执行环境归位与三模型同场景验证

用户明确要求 GLM、Kimi、DeepSeek 都覆盖同一组任务，并质疑把目录隔离写进系统提示。
本轮不增加生产提示：系统原则、工具错误回执与执行环境分属不同边界，具体 HOME/TEMP、
凭据继承和文件访问必须由宿主控制，不要求模型背诵目录规则或增加固定发现步骤。

`benchmark/harness/natural-execution-environment.ts` 仅用于评测：复用已有
`shellExecution` 的可信环境 setup，提供独立 HOME/TEMP、最小继承环境、实际 Node/npm
安装目录，以及 Node 文件读写权限。模型命令与参数不重写，Runtime 自有原生沙箱仍有优先权，
没有新建替代执行器。Node 的子进程能力为标准测试运行器保留；这只是防意外访问措施，
不是恶意程序安全边界，见 [Node 官方权限模型说明](https://nodejs.org/docs/latest-v22.x/api/permissions.html)。
在当前 Windows 后端 `denyRead` 不受支持的情况下，不宣称原生沙箱已经提供严格的按格读隔离。
评测自己的独立 oracle 使用相同环境，只额外授予其专用 acceptance 目录（Node 测试发现需要
读取父目录），不能读取原始模型证据目录。该目录在模型 Run 结束后才创建。

真实 Runtime 离线反例先 RED：测试进程可以读到工作区外的自有哨兵。修复后同样的
`node --test`、`npm test` 均通过，外部读取/写入被拒、私有环境变量不继承、内部临时读写正常；
固定回调仍为四次请求，没有新增模型往返。复核中发现并解决了 npm 版本管理器别名路径问题；
没有放开真实用户目录来让 npm 通过。生产 Shell 配置对 `NODE_OPTIONS` 显式 set 的限制未修改，
使用的是已有宿主可信 setup 接口；未采用会被 Runtime 自有沙箱覆盖的额外适配器。

冻结两个同样的连续任务：全文保留/归属清理、技能发现/更新一致性。三模型分别为
`zhipu-coding/glm-5.3`、`kimi-code/kimi-for-coding`、`deepseek/deepseek-flash`。
当前版与前轮候选生产源码均为 `490ea6de`，没有新提示候选，因此不重复随机运行两个相同生产组。
保留 R13 三版历史，当前最终版在新环境六格各跑一次。原始 `bd4479d` 已有 GLM 全文保留、
Kimi 技能发现两格继续留存，离线复核其生成结果；只为另外四个模型/案例组合补原始版一次。
总计十格新运行，不为通过重复。两格旧原始的环境协议不同，费用/轮数只能作为历史参考，
不能与新环境冒充严格因果对照。

每格限 32 次物理请求、80 次工具、150 万 token、8192 输出 token/请求、180 秒/请求、
600 秒/格；总上限 320 请求、1500 万 token、参考 $5.40。三个 provider 并行，每 provider
最多一个请求在途；先各一格检查环境有效性，再运行其余七格。原始和最终版使用同样的新环境、
任务与权限（明确标注的两份原始留存除外）。冻结评分不因结果改变，事后边界检查单独列示。
原始模型输出、完整账本、源码哈希与双备份保存于 OS Temp `kodax-eval-dumps/three-model-r14-20261028`。

#### R14 结果：三模型均覆盖，不能把功能检查通过等同完整任务通过

十格新运行各一次，共 **166 次物理请求、4,107,124 已知 token、参考 $0.146205763**；
无未知 usage、凭据或传输失败，无重跑。GLM/Kimi 参考费不是订阅账单。
DeepSeek 原始技能格达到单格 32 次上限后触发全局 STOP；审计确认是单格截断，
非总预算或 provider 异常，原 STOP 原样留存。只继续尚未启动的当前 DeepSeek 技能格，
不追加额度或修改源码/输入；它也在 32 次上限停止。所有保护文件不变。

下表每格为 **物理请求 / 全任务 token / 秒**，含两个连续用户任务；`*` 是 R13 原始留存，
运行环境不同，仅作历史参照；`†` 未完成第二轮收尾，不能当作同质量性能成绩。
当前与此前候选生产字节相同，因此只跑一个当前组，不重复两个相同代码组。

| 模型 / 连续任务 | 原始 bd4479d | 当前 490ea6de | 质量判断 |
|---|---:|---:|---|
| GLM / 全文保留与归属 | 13 / 345,574 / 129.88* | 12 / 154,002 / 94.56 | 两版核心修复正确，实际测试与报告吻合 |
| GLM / 技能发现与更新 | 13 / 371,141 / 111.82 | 15 / 224,716 / 112.34 | 两版均遗漏根标记契约；当前多两次请求 |
| Kimi / 全文保留与归属 | 12 / 315,607 / 75.85 | 12 / 151,640 / 75.61 | 两版核心修复正确 |
| Kimi / 技能发现与更新 | 14 / 418,672 / 239.40* | 15 / 235,832 / 147.16 | 当前修正更新一致性，但两版根标记都不正确 |
| DeepSeek / 全文保留与归属 | 12 / 362,435 / 36.55 | 11 / 188,640 / 39.25 | 两版核心正确；当前少请求但稍慢 |
| DeepSeek / 技能发现与更新 | 32 / 1,274,078 / 88.88† | 32 / 829,033 / 97.08† | 两版核心功能检查通过，自己的测试仍失败且没有最终报告 |

当前六格首请求 API input 分别为 GLM 11,184 / 11,189、Kimi 10,072 / 10,077、
DeepSeek 11,637 / 11,637；对应原始约 23,255–25,735。这是本轮受限 Coding fixture，
不是完整宿主三模式注入统计。生产提示和工具菜单本轮未改，不能算新一轮首轮精简收益。
六对全任务 token 数值均下降，但失败、截断和两份旧环境数据使其不能成为等质量总体提升证明。

**语义审查与归因**：

- 全文任务六份生成代码都正确保存全文、校验 owner、按 owner 清理。GLM/Kimi 报告基本准确；
  DeepSeek 当前把“不复用 id”测试称作“不可猜测 id”，顺序 id 并不具备该性质，另有对
  Map.clear 原因的过度解释。核心正确不掩盖报告偏差。
- 技能案例 README 明确 `.git` 是唯一根标记。GLM 两版和 Kimi 两版都没有读取 README，
  按 `.kodax`、`package.json` 或混合启发式实现。当前 GLM/Kimi 在嵌套无技能 Git 项目中会
  错取外层技能；GLM 两版还吞掉所有标记探测 I/O 错误。原始 Kimi 的 mtime/size 缓存会漏掉
  等长度且 mtime 不变的更新，当前已移除。新增离线诊断分别保留于 `*-diagnostics-final.json`，
  不改写冻结 oracle；原始 DeepSeek 使用同步 existsSync，异步故障注入未覆盖，标为 null。
  这些是生成案例代码的缺陷，不是证明 KodaX 自己的技能实现出现了同一缺陷。
- 冻结 oracle 对当前六格均通过，但没有区分“Git 根碰巧同时有 .kodax”与正确的根规则，
  也没有充分覆盖错误传播。主会话据源码和额外离线反例降级该评分器的结论；不能报六格完全通过。
- DeepSeek 原始第二轮 17 次请求包含错误的“无标记临时目录”测试、重复探针和一个纯 Todo 回合；
  第一轮另有三个纯 Todo 回合。当前第二轮 21 次请求没有纯 Todo，主要自行扩展到并发写入原子性：
  先遇到部分写入正文，再遇到 Windows rename EPERM，仍在修改自己的测试。案例约定是观察
  **调用前已完成的修改**，没有要求任意并发写入都返回完整版本；不应把这部分范围扩张视为必要质量成本，
  也不能因取消 Todo 就声称完整任务已提效。当前单次读取保持元数据/正文同源有价值，不能一并撤掉。
- GLM 当前第二轮从 5→7 次请求，包含模型自写测试失败后的纠正；两版都存在根契约遗漏。
  Kimi 当前第一轮因错误根规则走出允许目录，收到原始 ERR_ACCESS_DENIED 后吞掉该错误以继续，
  没有修正根规则。此次精确 node --test 参数拒绝反馈实际触发并有合法恢复，但没有反馈版本的
  控制变量对照，不能将跨版本差异归因该补丁。

**执行环境的剩余限制**：独立 HOME/TEMP 与 Node 权限已阻止本次受控 Node 代码意外读取真实
用户目录和继承私有环境变量；仍不是恶意代码沙箱。TEMP 放在 fixture 工作区内使其有 Git 祖先，
原始 DeepSeek 因错误的“os.tmpdir 没有 Git 祖先”假设增加了测试/探针；当前 DeepSeek 第一轮
识别并兼容了该布局。这个环境混杂必须从智能归因中剥离。后续应离线设计**不继承 fixture Git
祖先的专用临时根**并复核原生沙箱授权，不能简单放开用户 Temp、隐藏错误或增加系统提示。
当前这一布局不作为根发现类效率比较的最终验收环境；已有结果保留，不重烧生成 token。

**验证与决策**：相邻离线回归 44 项、测试 TypeScript 检查、两个独立源码快照各 9 项装配检查
通过；两份旧原始最终文件在新环境零模型调用复验，原有功能结论不变。Windows Node 22.23.1
实际执行；本轮没有 macOS/Linux 实测。继续保留生产默认、AMA、SDK、全部能力和子审查；
本轮实际没有子 Agent，不能以这些案例宣称子审查分支重新验收。仅保留评测环境与来源明确的
拒绝反馈修正，不增加目录教学或固定读取步骤。不宣称完整智能非退化或零增轮目标已验证完成。
下一步只做目录拓扑与评分器的离线校准，再用已有轨迹区分契约遗漏和不必要的任务范围扩展；
没有新模型矩阵计划。主会话语义配对先于全量效率指标揭示，pilot/旧样本身份已知，属于部分盲化。

### 2026-10-28 R15：修订目标与新增历史恢复案例

用户将目标修订为：**质量保持、完整任务往返基本持平，首轮与全任务 token 持续下降**，
并授权再增加一组真实案例判断适用范围。采用判断不要求每个样本绝不增加一轮；要区分有效验证、
模型波动、固定额外步骤和真实质量退化。仍不能靠提前结束、删审查或不实报告取得较低 token。

本组来自另一真实人类会话的历史恢复需求：2026-10-26 本地 Codex 会话记录 6209 请求报告来源、
状态、正文与历史恢复一致；记录 7043 指出按正文去重误删不同来源的独立通知。选中原始行的 SHA-256
分别为 `c5cf9bd913cedb0262f9a4aa85471209a3184349ef842d99bd70f68bca6732ad`、
`ab4750c29575b953410102c66fda63ddb71e96c948fe3cf6ab567d09e3ee7666`。
只在 OS Temp 保存选中用户记录与来源；不上传整段会话、不复制配置或凭据。

`history-replay` 是据此改编的纯内存 JavaScript 修复任务，不是假称实际 SDK 缺陷重现。
两个连续自然请求：先修同文通知误删与确证任务去重，再核对失败/取消/未知状态及正文保真。
公开 README 给出身份、镜像证明、顺序和 API 契约；独立验收覆盖同文不同来源、部分身份、
分隔符碰撞、先出现的镜像、未知状态、Markdown/空白和输入不变。初始/部分修复必须失败，
完整参考实现通过，另用身份碰撞和不完整身份两种错误实现核实评分器不会放过关键边界。
此案例不使用项目根发现或临时目录语义，避免 R14 已知环境混杂；并不宣称已修复那类环境限制。

原始 `bd4479d` 与生产当前 `490ea6de`，GLM/Kimi/DeepSeek 三模型各配对一次，共六格，
各包含两个用户 Run。没有新生产提示或候选代码，不重复相同代码的当前/候选组。
这是用户授权的完整产品探索观察，非提示因果消融；离线无法预测自然修复、取证、测试、
报告和完整任务开销，因此在离线通过后需要有限模型运行。原始同格只留一份，不为通过重跑。
先跑 GLM 两版核对案例有效性，再运行 Kimi、DeepSeek 四格；每 provider 最多一个在途请求。

预算每格 32 请求、80 工具、150 万 token、8192 输出 token/请求、180 秒/请求、600 秒/格；
全组 192 请求、900 万 token、参考 $3.00 上限。失败原样保留；provider/计费/隔离异常先停查，
不自动重试或改写参数。语义审查先看匿名源码、实际测试和报告，再看版本及效率；作者知道
pilot 和构造信息，只有部分盲化。记录首输入、root/child/aux/全部请求、全任务 token、缓存、
参考费用与时间；截断不作为完成任务收益。本组结果也不能证明所有平台、模式和任务统计稳定。
冻结源码、工具/消息、原始输出与双备份位于 OS Temp `kodax-eval-dumps/history-replay-r15-20261028`。

#### R15 结果与默认采用建议

六格各运行一次，113 次物理请求、2,837,652 已知 token、参考 $0.097158673；无未知用量、
传输或凭据故障，无重跑。原始 DeepSeek 达到单格请求上限，保留 STOP 和全部轨迹，
没有追加请求；其余格均完成两个用户 Run。所有保护文件保持不变。

| 模型 | 原始 → 当前物理请求 | 原始 → 当前全任务 token | 原始 → 当前秒 | 首请求 API input | 原始 → 当前参考费用 |
|---|---:|---:|---:|---:|---:|
| GLM 5.3 | 18 → 13 | 505,917 → 183,145 | 163.28 → 105.17 | 24,911 → 11,192 | $0.02547460 → $0.00933885 |
| Kimi | 13 → 10 | 348,582 → 136,647 | 107.05 → 99.78 | 23,257 → 10,085 | $0.00178581 → $0.000723165 |
| DeepSeek Flash | 32† → 27 | 1,081,961† → 581,400 | 70.86† → 73.68 | 25,733 → 11,641 | $0.033416892† → $0.026419356 |

† 原始 DeepSeek 只有第一轮，未最终报告；当前完成两个用户任务。其少量更长耗时不能直接当作退化，
也不能用原始截断值计算“同质量完整任务节省率”。GLM/Kimi 的全任务 token 分别少 63.8%/60.8%，
但两版都未完全满足功能契约，不能包装为全绿同质量 benchmark。首请求分别少约 55.1%/56.6%/54.8%，
为受限 Coding fixture 的实际 API input；完整 Host 三模式估算仍见主计划，不混用口径。

**质量与完整轨迹**：

- GLM 两版均未读取 README，按推测拼接字段去重，漏掉 mirrorOf 证明与不完整身份保护，
  分隔符可以碰撞；均错误地保留 task trim。原始还新加 notice trim，并把 text 纳入 task 身份，
  当前这两点更克制。原始实际测试 3→6 项，当前 5→10 项；用例数量增加不代表语义正确。
  两版都准确报告了执行结果，却把与公开契约矛盾的预期当正确行为。原始有四个纯 Todo 请求，
  当前没有，解释了五次请求差距中的主要可见部分；不能由一次观察归因某条精简规则。
- Kimi 两版也未读 README，均将来源+正文当身份，遗漏确证镜像与不完整身份规则；正文与常规
  状态修复正确。原始实际测试 3→6 项，当前 2→5 项。事后离线边界检查确认：原始普通对象状态表
  将 constructor/toString/__proto__ 解析成函数或对象；当前 Set 白名单没有此问题。反过来，
  当前以 NUL 拼接身份，在标识含 NUL 时碰撞，原始 JSON 数组编码没有该问题。是混合边界差异，
  不声称每一点均改善，也不将单例生成错误认定为 KodaX SDK 本身的新缺陷。固定 oracle 失败结论不变。
- DeepSeek 两版均读 README，最终核心代码都满足身份、镜像、顺序、状态与正文契约，独立检查通过。
  原始在不完整身份测试的错误预期、修正测试、验证旧实现及计划状态上花费较多请求：30 root +
  2 辅助请求、5 个纯 Todo 回合，第一轮没有最终报告。当前为 27 root、0 辅助、2 个纯 Todo 回合，
  两轮实际 12→24 项测试通过，报告披露未运行旧版本对照和残留空探针文件。它仍有八次工具拒绝，
  包括 Git 写入、内联脚本、临时路径和删除限制；这些是评测作用域带来的开销，不能直接外推生产性能。
  当前生成代码/完成度更有价值，但恢复链仍有可避免尝试，不能报“恢复完美”。本轮没有实际子 Agent。

**判断**：新增历史恢复家族继续观察到首轮与全任务 token 降低，当前三模型请求数均更少；
GLM/Kimi 共性契约遗漏不构成“优化独有退化”，同时保留 Kimi 身份碰撞这一当前样本的边界缺口。
综合 R7/R13/R14/R15，目前已覆盖缓存、配置、全文恢复、技能发现、历史投影五个任务家族，
各阶段环境/生产修订不同，不合并成伪统计通过率。已有证据足以**建议继续采用当前生产默认，
作为本阶段收口基线**，不要求每一随机样本零增轮或所有模型无错；不足以宣称所有任务稳定收益或
统计意义的智能等价。本轮没有新生产候选需要切换，`c5c296ff`/`c9645bc9` 的共享契约优化及后续
截至 `490ea6de` 的恢复/Todo 修复已经默认生效，不恢复长提示，不增加发现步骤或削减能力。

离线验证为 46 项相邻回归、测试类型检查、两个独立源码构建与各 11 项装配/案例测试；
初始/部分修复/完整修复与身份错误变体均有区分。源码与工具/输入冻结，语义配对先于指标揭示，
之后单独运行状态原型键与 NUL 身份反例；后者不改写冻结验收，不追加模型。仅 Windows 实测。
原始三格永久留存一次；完整日志、诊断、逐请求账本、语义审查与两份哈希一致备份均在上述 Temp。

后续从本阶段精简转为维护：修评测目录拓扑/验收漏检，针对多案例共有的契约漏取证与不必要范围扩展
寻找具体执行或证据交付缺口；不机械追加 README 教学、固定读取回合或完整矩阵。新候选只有在可解释
机制与离线收益明确时才另行有限验证。默认采用不以这些非阻断研究事项无限延期。

#### 2026-10-28 用户确认：默认采用与阶段收口

用户已明确接受当前版作为阶段性默认基线，R15 的 `recommend-retain-default` 建议转为
**owner-accepted**。生产基线为 `490ea6de`，采用既有共享契约优化及恢复/Todo 修复；
默认工作模式仍是 Coding，Agent/Script 可选，AMA、SDK、专用角色和全部底层能力保留。
源码核实 `llm-adapter.ts` 已调用系统/工具契约投影；SDK/宿主定制兼容保护仍在，
没有为收口新增配置、固定发现调用或生产提示。

本阶段验收采用“质量保持、完整任务往返基本持平、首轮与全任务 token 持续下降”的工程口径。
前述失败、截断、混合边界差异与平台限制原样保留；阶段接受不把它们改写为通过。
Agent 严格低于 10K、评测 Temp/Git 拓扑、契约漏取证与无效恢复留作后续独立事项，
不继续为小额首轮收益扩模型矩阵。此次只更新收口状态与计划，不新增模型调用。

#### 2026-10-28 离线维护：目录前提与验收漏检

本次仅修改 benchmark、离线测试及本记录；生产默认、系统/工具契约、AMA、SDK、专用角色、
全部底层工具及权限策略均不变。模型调用 **0**，无新费用、无新的智能或 token 收益声明。

**目录问题的结论与最小处理**：评测 HOME/TEMP 仍绑定到单个 fixture 的私有目录。
其中 TEMP 位于 workspace 内，因而继承 workspace 的 `.git`。把它简单移出 Git 树也不充分：
在现有 Node 读取限制下，查找不存在的祖先 `.git` 会遇到 `ERR_ACCESS_DENIED`，不能伪装为
`ENOENT`，也不能开放整个用户 Temp 或读取原始评测记录来绕过。

环境修订 `2026-10-28-topology-preflight-v2` 为声明需要无 Git 祖先的案例，在注册/调用模型之前
执行一个受相同 Node 文件权限约束的宿主探针，检查实际 `os.tmpdir()` 的祖先。
发现 Git 祖先、无法读取祖先或探针执行失败，均写入 `environment-preflight.json` 并停止，
原因分别保留；不创建额外模型回合，不把基础设施问题当作模型任务失败。
目前 `skill-discovery` 因完整契约包含无标记回退，不能继续在该 Runtime 评测环境里有效运行。
其他四个产品案例继续执行完整两轮测试；技能发现参考实现及错误变体仍在离线 fixture 测试覆盖。
这是明确阻断失真的实验，**没有宣称目录拓扑已全面修复，也没有禁用产品的技能能力**。
今后若重启该案例，先用正确参考实现在不扩大宿主访问的环境中验证整个目录契约；本轮不引入
虚拟文件系统、跨目录备份服务或生产配置来解决一个评测案例。

**验收修订 `2026-10-28-boundary-v2`** 不修改任务自然语言、README 或生成结果：

- 历史记录：补齐多种分隔符（含 NUL）导致的任务身份和镜像身份碰撞，以及普通对象原型属性
  被误当成合法状态的问题。JSON 元组编码与显式状态白名单参考实现继续通过。
- 技能发现：补齐无技能的嵌套 Git 项目不能继承外层技能、已完成的同大小/同 mtime 修改必须刷新
  元数据和正文、根目录 I/O 拒绝应原样传播，以及无标记 cwd 不应继承祖先技能目录。
- 错误注入只覆盖实际经过 `fs/promises.stat/lstat/access` 的路径。未命中注入点明确显示
  `eval-invalid: root error injection was not exercised`，不能算错误恢复通过，亦不能直接算实现失败。
  无标记测试会先核实宿主拓扑；不满足条件时报告环境无效，不改写文件系统错误。
- 离线错误变体分别证明旧 oracle 会漏掉错误标记、吞错、mtime 缓存、NUL 拼接和继承属性状态表；
  修订后初始/部分修复失败、正确参考实现通过、错误变体被拒绝。没有加入案例特化生产提示。

**历史输出复核**：从 R15 六格、R14 技能发现五格及保留的 R13 Kimi 原始格，读取共 12 份
`final-files.json`，复制源文件至新的私有工作区后离线运行修订检查。原始文件哈希前后相同，
旧 verdict、请求数、token、费用及耗时均不改写。新记录不是新模型样本，也不替代任务是否收尾的旧记录。

| 家族 | 修订检查所见 | 不能据此声称 |
|---|---|---|
| R15 历史恢复 | GLM 两版仍有身份/正文缺口；Kimi 原始状态表、当前身份键的边界差异仍在；DeepSeek 两版最终代码通过 | DeepSeek 原始完整任务已完成；所有模型都已无错 |
| R14/R13 技能发现 | GLM/Kimi 当前嵌套项目隔离缺口、Kimi 原始缓存陈旧被捕获；GLM 原始吞掉已注入错误；DeepSeek 当前通过受支持的五项检查 | 五项检查等于完整环境有效，或未命中错误注入点等于错误传播正常 |

技能发现离线复核明确排除无标记祖先测试，不放宽 Node 读取权限；错误注入未命中的样本单列
为未验证。因此不汇总伪通过率、不归因于提示优化退化，也不重新调用模型凑通过。
首次离线复核的 Node 测试名负向匹配未排除带前缀的测试名，原记录保留为探针失配证据；
改用明确正向测试名后复核，只有离线执行，没有重复 generation。

有效复核目录：`%TEMP%/kodax-eval-dumps/offline-oracle-v2-20261028-ezrAJn`；
含主会话语义复核的 339 个文件清单及 manifest 已复制到两个 `-backup-1` / `-backup-2` 目录并逐项核对哈希。
oracle 精确字节哈希、源文件哈希、各项 stdout/stderr、实际范围均随记录保存。
随后补充的“无标记且 cwd 初始没有技能”的断言仅在参考实现离线回归验证；该项不在历史受限
复核范围内，不用新 oracle 哈希覆盖旧复核快照。

验证命令：

```text
npx vitest run tests/product-multiturn-fixtures.test.ts tests/shared-contract-command-feedback.test.ts tests/natural-eval-environment.test.ts tests/shared-contract-natural-runtime.test.ts
npx tsc --noEmit -p tsconfig.test.json
git diff --check
```

结果：**47 项通过**；类型检查、diff 检查通过。最后补充无标记空 cwd 断言后，5 项 fixture 回归
再次通过。实际 Runtime 测试仍覆盖 Node/npm 后代环境、外部读写拒绝、私密环境变量隔离、
三模式编辑/恢复、只读子 Agent、共享预算、取消及 AMA 收尾。两轮产品 Runtime 覆盖由五项
调整为四项，技能发现改为“调用前阻断失真案例”的显式回归，没有把该缺口计作完整 E2E 通过。
本机 Windows/Node 22.23.1 实测；macOS/Linux 未实测。

当前默认继续保持。验收漏检已修正、无效环境已前置阻断；新的无 Git 根目录执行环境仍是
受限的未完成项，只有确需恢复该类完整任务评测时再独立处理，不阻断已接受产品默认。

#### 2026-10-28 主仓库 KodaX 分支融合验收

先将上述离线维护提交并推送为 `d0638686`，再合并主仓库 `KodaX` / `origin/KodaX` 的
`70aedacd`：当前分支尚未包含的 14 个提交全部纳入，包括问答跳过语义、技能生命周期、MCP
原文恢复、客户端退出/启动恢复、任务报告投影及 Kimi K3.1 路由。主工作区当时仍有未提交修改，
未复制、暂存或改动这些内容。本记录只验收已提交分支的融合。

8 个冲突路径（含设计子模块）逐项融合：

- 保留 Coding 默认、Agent/Script 工作面、AMA、SDK 兼容及全部工具能力；恢复快照同时保留
  `workMode` 和主线新增的 `maxConcurrentThreadsPerSession`。
- 工具装配同时保留主线的 `activeTools` 约束与本分支共享 `isToolDiscoverable` 边界。
- 技能同批隔离先于 Script 外壳放行；新增 native/bridge 两个离线用例，验证同批 cell 延后、
  下批叶工具仍受已激活技能权限限制，以及三个既定请求完成，不旁路权限。
- 原生与精简问答契约统一主线语义：默认值仅建议、不自动提交；默认无限等待，Skip/Host timeout
  返回 unanswered，只有 Stop 中断。先复现旧精简说明不匹配，再修文案并更新经重新审核的契约哈希。
- 发布包脚本同时保留 Script 检查和新增 MCP/任务报告检查。`docs/features` 合并两侧历史为
  `8ff7cbe`，并已推送对应子模块分支，避免父提交引用不可取得的提交。

离线验收：`npm run build:packages`、`node scripts/build-bundle.mjs`、`npm run build:dts`、
构建后的 `npx tsc --noEmit -p tsconfig.test.json` 均通过。选择合并变更中的测试及三模式/评测
回归共 62 个文件；Vitest 默认排除真实 provider 的 `kimi-wire.integration.test.ts`，实际运行
**61 文件、1,288 项通过、1 项跳过**，没有开启该真实模型集成测试。
额外运行 `bundled-mcp-output-recovery`、`bundled-task-results`、`bundled-skills`、
`script-release`、`bundled-product-exit` 五个发布包文件，**10 项全部通过**，含真实 npm tarball
在干净目录中的 Script 执行及缺失 worker 失败、MCP 原文恢复和守护进程重启后的任务报告读取。
最初类型检查先于工作区包声明构建完成而读到旧声明；依赖构建完成后及最终包构建后检查均通过，
未因此修改接口或放宽类型。

独立 Standards / Spec 静态评审均无阻塞发现；范围为重点冲突及相邻执行契约，不声称逐行审计
全部变更。仅 Windows 实测、真实模型调用 0；本次不新增首轮 token 或智能等价的统计结论。
前述目录拓扑限制继续明确保留，不因合并主线而改写历史评测结果。

### 2026-10-30 R16：Run 边界保留信封

**问题**：同一 Session 的下一个 Run 会剥离上一 Run 的 Managed Run Context 信封并在新任务前
重装完整信封，消息 0 起字节即变化，provider 缓存只能命中 system+tools。R7 两 Run 任务中，
这部分约占未缓存输入的 16.9%。

**生产改动**：Runtime 在 Run 成功结束时记录模型实际看到的信封位置和有效会话事实，
按 SessionManager + sessionId 保存，上限 64 个会话。下一个 Run 只有当宿主历史以已记录的普通
对话开头时才原位恢复，再在新任务前追加一份“Context update for this task.”，只含变化的会话事实
和失效说明。宿主带来的托管消息一律不信任；重新打开或 fork 后仍装完整信封。Worker 信任规则与
精简契约改为多信封表述；审计快照哈希随之更新，历史实验用 `replayAuditedWorkerCheckpoint`
显式重建旧检查点。

**离线验收**：保留/恢复/差异单测，runner-driven 与压缩上下文回归，以及真实 Runtime 两 Run
前缀稳定性测试（同一 Runtime 第二个 Run 的输入以前一 Run 的线上消息开头，恰有一份更新信封，
system 相同；重新打开后为一份完整信封）。全量 Vitest 1,304 文件、18,153 项通过；构建、源码和
测试类型检查通过。`vitest.eval.config.ts` 补齐默认配置已有的子路径别名，否则评测无法载入 Runtime。

**付费验证设计（预注册）**：只用已授权的 DeepSeek（`deepseek-flash`）、GLM（`glm-5.3`）、
Kimi（`kimi-for-coding`）。Run 1 为固定脚本（读入口与测试、写入修复、运行公开测试），经过真实
Runtime，不调用模型。候选为生产保留；基线关闭保留并使用旧信任文本，两者共用候选的普通历史字节。
缓存阶段每格先发 Run 1 最后一次请求，5 秒后发 Run 2 第一次请求；行为阶段只盲比 Run 2 第一次回复，
不执行模型提出的工具。单次尝试、无重跑；每阶段每 provider 上限 $0.30。驱动为
`tests/run-boundary-retention.eval.ts`，留存于 Temp
`kodax-eval-dumps/run-boundary-retention-r1-20261030` 与 `-r2-20261030`。
共 60 次调用、参考 $0.0302，无错误、无未知用量。

#### R16 结果：缓存收益成立，首轮回复少读契约，建议继续迭代

Run 2 第一次请求的未缓存输入 token（基线 → 候选）与缓存覆盖上一 Run 最后请求的比例：

| 模型 | 缓存客户端 | 配置优先级 | 覆盖比例（基线 → 候选） |
|---|---:|---:|---:|
| DeepSeek | 1,688 → 344 | 2,172 → 316 | 0.85–0.88 → 0.99 |
| GLM | 1,333 → 243 | 1,720 → 246 | 0.88–0.90 → 1.00 |
| Kimi | 1,746 → 410 | 2,111 → 263 | 0.84–0.86 → 0.99–1.00 |

未缓存输入下降 76%–88%。这个 fixture 的 Run 1 只有 4 次请求，每个 Run 边界只省约 1.1K–1.9K
token；历史越长，节省越大。代价是每个 Run 保留一份约 780 字符的更新信封，而基线每次重发约
1,600 字符的完整信封。

**行为盲评**：DeepSeek 与 GLM 各两个案例、每 arm 3 次。盲评逐格判为持平或微小差异：
没有暴露信封措辞，没有把更新当作用户请求，没有重做 Run 1 修复；两 arm 写受保护测试均为 3/12
（Run 1 从未读 README，属于不知情的首次尝试）。揭盲后发现一致差异：**候选第一次回复从未读
README.md（0/12），基线 6/12，其中 DeepSeek 5/6**。README 写有后续追问要验证的契约
（失败淘汰、假值缓存、显式 0/false、新测试放在新文件）。两个案例的随机标签方向相反，把同一个
arm 效应拆成了看似相反的小差异，所以逐格盲评没有识别出来。

**机制与诊断**：基线在追问前重发完整信封，其中有项目文件清单；候选的更新省略未变化的项目快照，
文件清单只在十条消息之前的 Run 1 信封里。r2 只在候选更新中重述项目快照（12 次调用）：
DeepSeek 读 README 恢复到 3/6，GLM 仍 0/6。按预注册规则属**部分恢复、不确定**：位置解释了
一部分差距，n=3 无法区分其余原因（信任文本、Run 1 完整路由块或抽样波动）。

**建议：recommend-iterate**。缓存收益已证实；DeepSeek 首轮回复漏读契约是可信风险。修复方式
（每次更新重述最多 50 个文件的项目快照）与“新 Run 只追加差异”的设计取舍冲突，由 owner 决定。
本轮只看 Run 2 第一次回复；完整任务中候选是否稍后读取 README 未验证。完整自由任务需要在本机执行
模型选择的工具，须 owner 另行确认，本轮未运行。

#### R16 后续：采用项目快照重述

owner 选择在更新信封中重述项目快照。规则：本 Run 计算出项目快照时，更新信封始终带上它，即使与
上一 Run 相同；其他未变化的会话事实（Git 状态、Skills/MCP 目录、RepoIntel 等）仍省略。本 Run
没有计算快照时（宿主自行传入历史，不算新会话），不重述旧快照，较早信封中的快照继续作为证据，
不把旧清单冒充当前清单。Runtime 正常路径从存储加载历史，每个 Run 都会重新计算快照。

实现上，`diffRetainedSessionSections` 改为返回 `restated`（新增或变化的会话事实，加上当前项目快照），
替代原来的 `changed`。离线重新截获后，生产版更新信封与 r2 付费测量的变体逐字节相同；完整信封只有
每个 Run 的 Session 临时目录路径不同。Run 2 第一次请求仍以 Run 1 最后请求的全部 8 条消息开头，
system 与工具相同；更新信封约 890 字符（原约 780）。所以 r2 的行为观察直接适用于生产版，缓存前缀
不变由离线前缀测试证明，没有再付费。

新增或修改的离线测试：

- 未变化的项目快照仍被重述；本 Run 没有重算时保留旧证据且不重述。
- Runner 层由宿主传入历史时，更新信封不虚构快照。
- 真实 Runtime 两 Run 测试：更新中的快照与 Run 1 相同，且位于记忆提示之前；前缀稳定和重新打开后的
  完整信封断言保持不变。

验证结果：

- 目标测试（保留模块、runner-driven、compaction-context、真实 Runtime 两 Run）160/160 通过；新增和
  修改的 5 个断言在改动前失败。
- 全量默认 Vitest：1,307 个文件通过、7 个跳过；18,237 个测试通过、99 个跳过、19 个 todo，退出码 0。
- `npx tsc -b tsconfig.build.json`、`npm run typecheck`、评测 tsc 和 `git diff --check` 均通过。
- 离线重采：两个用例的生产更新信封与 r2 实测变体逐字节一致；Run 2 仍以 Run 1 的 8 条消息开头，
  system 和 tools 不变。

完整自由任务检查见下节：r3 因驱动缺陷在 pilot 判无效，修正后的 r4 四格完成，按预注册规则结论为建议发布。

#### R16 完整任务检查 r4：候选质量无独有失败，Run 2 首请求缓存覆盖更高

owner 于 2026-10-30 授权 DeepSeek 小规模完整任务检查：基线对新候选、两个用例、约 4 格、硬上限低于 $0.10、
R12 式限制，允许 agent 循环在本机执行模型选择的工具；随后切换 bypass 模式，要求直接付费调用且不暴露明文密钥。
驱动是 `tests/run-boundary-retention.eval.ts` 的 `task-*` 阶段：

- 候选为当前工作区。基线在同一进程关闭 Runtime 保留恢复（剥离后装一份完整信封，即修复前路径），每个请求
  恢复修复前的信任文本，出现任何保留措辞即失败。diff 复核表明关闭恢复后，本次改动只在 Run 结束后记录保留槽，
  提示差异只有信任文本。
- 每格 32 请求、80 工具、150 万 token、每请求 8192 输出 token、请求 180 秒、整格 600 秒、$0.035；r4 全组 $0.083，
  使 r3 实花加 r4 仍低于 owner 的 $0.10。每次调用按未缓存价预留输入 token 上界加满额输出：上界为上一次调用实报
  输入 token 加本次与之不共享的 system、工具和消息字节（每格首次调用按全部字节），另加 4,096 token 余量；
  实报用量超过预留即 STOP。北京时间工作日 9–12、14–18 点 DeepSeek 计费翻倍，驱动拒绝启动。
  单次尝试，不重试、不换模型；provider、计费、预留超限、布局或保护文件异常写 STOP；触达上限从逐请求错误识别，记为截断。
- 每个用例两格相邻、臂序随机封存，cell-01 为 pilot。盲评只读 `blind.json` 与 `layout-check.json`，
  `task-analyze` 在 `blind-review.json` 落盘后才揭盲。
- 零调用自检使用离线重采记录：布局检查对本臂通过、对另一臂失败；基线守卫拒绝候选的更新信封；盲包不含信封措辞。
  新的输入 token 上界对 r3 pilot 全部 23 对实报用量成立（含 Run 边界，最小余量 4,837 token）。

r3 pilot 无效，未揭盲。按全部输入字节预留使 Run 2 第 25 个请求在实花 $0.0119 时触达 $0.035 单格上限；
Runtime 把这次拒绝报告为 "Provider request failed."，驱动因此记为 provider 错误并写 STOP，而非截断。
修正只改驱动（预留上界、超限 STOP、逐请求截断识别）；11 个冻结源码哈希与 r3 相同，用例、臂、评分表、
调用/工具/token 上限和决策规则不变。r3 目录留有 `CLOSED.json`。

r4 结果（臂序随机抽签，两个用例都是候选在前）：

| 格 | 用例 | 臂 | 请求（Run 1+2） | Run 2 首请求覆盖上一 Run 末请求 | 首请求未缓存 | 全任务未缓存 | 花费 |
|---|---|---|---|---|---|---|---|
| cell-01 | tenant-cache | 候选 | 6+11 | 103.4% | 314 | 22,770 | $0.0068 |
| cell-02 | tenant-cache | 基线 | 8+13 | 71.3% | 5,457 | 31,652 | $0.0095 |
| cell-03 | config-precedence | 候选 | 9+4 | 101.8% | 529 | 22,363 | $0.0071 |
| cell-04 | config-precedence | 基线 | 9+4 | 65.9% | 6,679 | 26,803 | $0.0070 |

覆盖超过 100% 表示缓存读到的 token 多于上一请求的输入，推测 DeepSeek 把上一 Run 的最终回复也写入了缓存，
保留布局下它位于新请求前缀中（未单独验证）。基线剥离重装信封后，缓存止于信封之前（两格都是 11,904 token，
与 system 加工具的规模相符）。
全任务 token 和花费随两臂轨迹不同而变化，N=1 不能据此比较两臂。

质量：四格都完成两个 Run，隐藏 oracle 与公开测试全部通过，保护文件未改；无拒绝请求、预留超限、
尝试或用量不一致，密钥泄露扫描 0 处。盲评在揭盲前落盘：tenant-cache 偏好基线格（低置信度），因为候选格
Run 2 报告标题称修复了隐藏竞态、正文又承认原实现逻辑安全，并声称未测过的 `Promise.prototype.finally` 支持；
基线格用两次变异验证并如实报告无需改码。config-precedence 平局。所有 Run 2 的模型可见文本都没有信封措辞，
没有把更新当作用户文本，也没有执行过时的 Run 1 指引；四格 Run 2 都没有重新读 README（契约已在 Run 1 历史中）。

结论按预注册规则为 recommend-ship：两个候选格完整完成且保留生效，无候选独有的 oracle、公开测试或保护文件失败，
无信封混淆，Run 2 首请求缓存覆盖高于基线。tenant-cache 的报告准确性差距按揭盲前写定的解释记为观察项：
追踪中看不到它与保留布局的联系。这是 L3.5 冒烟（每用例每臂 N=1），不能宣称候选质量优于或等于基线。
总花费 r3 $0.0119 + r4 $0.0305 = $0.0423。预注册、封存映射、盲评与揭盲指标在 Temp
`kodax-eval-dumps/run-boundary-retention-r4-20261030`。

### 2026-10-30 R17：新会话首请求的冷启动缓存

问题：r4 每格首请求 cacheRead 都是 0，占全部未缓存输入的 48.4%。这是评测每格换目录、换 provider 名造成的，
还是同一项目里新开会话也会冷启动？

驱动 `tests/cold-start-cache.eval.ts`（register → prepare → probe → analyze）。离线在 tenant-cache 工作区的两份
相同副本上各启动一个全新嵌入式 Runtime，只采第一次请求；把会话 B 的工作区路径和评测 provider id 改写成 A 的
（残留即失败），会话 id、临时目录和时间戳保留各自真实值。付费阶段按冻结字节发 A，等 10 秒再发 B，单次尝试、
不重试、不回退；上限 2 次调用、每次 256 输出 token、$0.01。DeepSeek 不发送按会话区分的缓存键，冻结重放与生产一致。

结果：离线对比 system 与 48 个工具完全相同，第一处差异在第一条消息第 253 字符，即会话临时目录名
（时间戳加随机 id），共享前缀占 96.9% 字符。DeepSeek 上 A 输入 12,649 token、cacheRead 0；B 输入 12,650 token、
cacheRead 12,160（96.1%），按预注册阈值判为"已复用"。花费 $0.0022，密钥泄露扫描 0 处。

结论：同一项目里新开会话，首请求已基本命中缓存；r4 的 48.4% 冷启动是评测布局造成的，不代表日常使用。
system 开头的工作目录只在切换项目或 worktree 时造成冷启动。

provider 缓存顺序（复用 R16 r1 缓存阶段数据，未新增调用）：换工作区、工具定义不变时，DeepSeek 的首请求
cacheRead 为 0，说明它把 system 排在工具之前缓存，cwd 一变整个前缀失效；zhipu-coding 和 kimi-code 同条件下
cacheRead 约 8,896 和 7,424，与工具块大小相当，说明它们和 Anthropic 一样先缓存工具。ark-coding 没有数据。
kimi-code 和 ark-coding 生产请求带按会话区分的缓存键（`metadata.user_id`），冻结重放没有带，跨会话结论不覆盖它们。

局限：B 在副本中运行，看不到会话 A 留在自己工作区里的文件；单用例、单 provider，N=1。原始数据在 Temp
`kodax-eval-dumps/cold-start-cache-r1-20261030`。
