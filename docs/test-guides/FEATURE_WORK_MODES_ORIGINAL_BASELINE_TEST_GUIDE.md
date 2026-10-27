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
