# Tool contract and necessity refinement

Status: minimal text refinement retained with the limitations below, 2026-10-21.
Baseline `5d460529`; reference source
Codex `3b8f43a06b`, DSH `1517a4dbca`. Preserve AMA strategy, all executable
capabilities, SDK contracts, specialist menus and isolation. No new user mode.

## Necessity and alternatives

| Surface | Source comparison and alternative | Current decision |
| --- | --- | --- |
| Child creation | Codex v2 has named spawn plus separately configured model/role exposure. DSH binds spawn/fork and optional model selection to provider capabilities. KodaX also carries read-only ceilings, isolation, evidence, specialists and quality provenance. | Keep spawn; audit each field instead of assuming another project's shorter schema is capability-equivalent. |
| Messaging and continuation | Codex v2 also distinguishes send_message/followup_task. DSH send_message starts a turn for an idle continuable child. KodaX messaging deliberately does not. | Keep both; combining them would change AMA scheduling or require a new action selector. |
| Wait/list/output/interrupt | Mailbox wake, paged topology, exact-turn output and subtree interruption have distinct contracts. A list summary does not recover exact-turn artifacts; a message cannot guarantee cancellation. | Keep; do not replace with polling or fold into a larger router without an observed benefit. |
| User questions | Codex synchronous questions require options; DSH has blocking/timed variants and pending is not permission. KodaX additionally supports flat input, batch choices, value mapping, selection bounds, custom-input fallbacks and validated expiry defaults. Plain assistant text does not supply those Host semantics. | Keep fields and handlers; remove repeated explanation only. Do not inherit a different timeout/approval policy. |
| Read/edit/search versus shell/patch | Codex uses shell and apply_patch within its own approval/sandbox path; DSH retains explicit fs/search tools. KodaX edits have trusted mutation, stale/identity checks, atomic batches and feedback. | Retain direct coding tools. Shell-based rewriting is not an equivalent replacement for checked edits. Existing parallel calls already batch independent reads; do not add a batch tool solely to lower tool count. |
| Multi-edit and duplicate detail/prepare entries | Existing edit batches, todo_list(id), incoming/outgoing-call preparation and exact tool_search cover the accepted aliases. | Previous builtin-only entry consolidation stays; old SDK handlers and extension overrides remain. |
| Local code_search/repository analysis | grep/glob cover ordinary literal lookup, but extension search, bounded repository capsules and relationship results have distinct fields and failure modes. | Keep current native entries. Avoid duplicate overview reads. Further retirement requires an output/dependency/complete-task comparison, not a name match. |
| Goal/Todo/memory/manual | Goals persist across turns, Todo tracks stable execution milestones, memory writes are mediated intents, and the manual is version-bound product knowledge. None is just a file read or interchangeable planning text. | Retain; actual missing Host bindings may justify availability gating separately, not a default capability reduction. |
| Code Mode/PTC | Both change invocation representation and keep SDK information in input. DSH PTC is larger than Standard in the captured scenario and differs in workflow bindings. | No new JavaScript runtime or preset matrix in this change. |

Primary references: Codex
`core/src/tools/handlers/multi_agents_spec.rs`,
`request_user_input_spec.rs`, `spec_plan.rs` under the reference `codex-rs`;
DSH `packages/subagent/tool-subagent/src/index.ts`,
`tool-subagent-control/src/index.ts`,
`packages/interaction/tool-ask-user/src/{index,timed}.ts` and
`packages/core/tools/src/index.ts`. KodaX's relevant contracts are
`tools/tool-definitions.ts`, `agent-collaboration.ts`, `ask-user-question.ts`,
`model-tool-definition.ts`, `task-engine/_internal/managed-task/agent-chain.ts`
and `tool-wrappers.ts` under `packages/coding/src`.

## Minimal candidate and retained obligations

Only spawn_agent and ask_user_question description text changes. All property
names, types, required fields, enums, bounds and nested shapes remain. All tool
names, handlers, permission/classifier metadata and runnable menus remain.
Worker/role prompts, dispatch policy and provider settings remain unchanged.

Spawn retains canonical ownership, atomic concurrency/work limits, read-only
review lanes, disjoint writable ownership including generated outputs, shared
edit integration, explicit worktree merge-back, productive work before waiting,
routing inheritance/fallback, registered specialists, locked effort, exact-turn
evidence and non-admission telemetry. The effort description incorrectly named
subagent_type; it now names the existing agent_id selector. A contract regression
is RED before that correction and GREEN afterwards.

Question guidance retains flat/batch precedence, 1–4 separate select questions,
required batch options, flat-only free text, ignored options for input, multiple
selection and bounds, value/default mapping, validated expiry behavior,
automatic custom input, closed-choice restriction and flat custom fallbacks.
Repeated obvious field labels are omitted; rules needed to use them remain.

## Native/bridge gate

Before any new schema hiding, exercise actual executable paths, results,
errors/recovery, mutation ownership, read-only permissions, cancellation and
budget use. Existing real Runtime native/bridge outside-read tests and inherited
child recovery remain; real managed wiring covers multimodal results and
cancellation during a permission hook.

A new direct executable-boundary check runs the same missing read followed by
a successful read. Result/error content and unchanged arguments agree, but
two native calls spend 2 work units and two bridged calls spend 4. The bridge
and target wrappers both increment the current managed budget. This is a known
non-equivalence, not a passing disclosure gate. Do not change budget policy or
hide schemas to make the comparison pass. Parameter disclosure remains deferred;
the text-only candidate can be evaluated independently.

## Validation and bounded model evaluation

Layer 1: actual SDK wire capture, stripping only descriptions for schema equality,
unchanged Worker/chain hashes, direct handlers, bridge boundary and Runtime
regressions; typecheck/build. These establish mechanism, not model comprehension.

The remaining model questions are whether the shorter contracts preserve legal
spawn/question choices, actual edit correctness and truthful verification.
User explicitly selects zai-coding/glm-5.3 and kimi-code/kimi-for-coding, overriding
the general eval-pool pause for the latter. No substitute route or retry.

Freeze exact full-production inputs with both interaction tool definitions;
baseline/candidate differ only in these two descriptions, including nested
description fields. Layer 2: two checkpoints (bounded readonly child, independent
choice questions), one sample per arm/model as pilot (8 calls), at most one more
preregistered sample per cell after main-session review (16 total). Tool calls
are observed without execution. Review blinded evidence before token metrics;
inspect validity, parameter correctness and material harm, not exact prose.

If supported, use a separate controlled read/edit/test/report task: baseline and
candidate, both models, at most four responses each (16 calls). The fourth round
is necessary to observe the real test result and report honestly. Preserve files,
comments, actual command results and the entire task's input/output tokens and
wall time. Do not compare incomplete prefixes with complete tasks.

Then at most one final complex Runtime smoke per model: real multi-package cache
repair, meaningful tests, completed inherited readonly child, protected public
files, independent six-assertion oracle, truthful scope. These Layer 3.5 smokes
validate final wiring, not A/B superiority or universal intelligence parity.

Combined hard limits: 80 reserved attempts, 3,000,000 conservative tokens,
USD 0.50 frozen local reference (not subscription billing); output at most 2048
for controlled calls and 4096 for complex root/child, unchanged 1024 judge;
120 seconds/request, 600 seconds/complex cell, 24 root/child/auxiliary responses,
60 tools and one readonly child/cell. Same provider concurrency one. No retry,
fallback, replay, parameter repair or added prompts to rescue a failed sample.
Unknown usage retains its full reserve; only the previously verified bounded
auxiliary cancellation may continue. Historical failures and cumulative usage
remain. No paid calls until final-source and budget preflights pass.

Raw inputs/results, physical observations, source/helper hashes, blinded review,
ledger and mirrors stay in OS Temp `kodax-eval-dumps/tool-contract-necessity-20261021-r1`.
Final recommendation follows observed benefits and regressions; no fixed token
target overrides capability preservation.

## Observed results

Only the two tools' text changes in production. The complete Windows Host menu
remains 55 native entries. Same-method model-field estimates fall from 20,583 to
20,191 (OpenAI) and 20,223 to 19,831 (Anthropic): 392 estimated tokens/request,
about 1.9%. No API-usage/UI interpretation is implied. The unchanged Codex Sol
reference is 17,032, leaving 3,159 estimated tokens in that comparison. Removing
capabilities or adding a Code Mode host was not needed for this narrow saving.

Schema-aware comparison preserves actual data fields named description under
properties while ignoring prose annotations: all 55 tools, both wire protocols,
property types/required/enums/bounds/order agree. Worker and chain source hashes
match baseline. The earlier generic stripping checker was insufficient for this
distinction; its corrected independent audit changes no model input or output.
Focused tests pass 111 cases; real Runtime denial/bridge/readonly-child tests pass
six more. Source/test typechecks and full build pass. The full default deterministic
suite passes 1,202 files / 16,917 tests, with four files / 90 tests skipped and
19 todo (806.75 seconds). A separate final registry/projection run passes 77 tests;
targeted combined coverage is 94.31% statements / 84.02% branches. Three stale
registry assertions initially fail after the prose change; their wording and
actual byte costs are updated without relaxing ownership, routing or byte ceilings.
The initial failures and final successful logs are both retained in OS Temp.

Sixteen Layer 2 physical calls complete, with no retry/fallback or unknown usage.
Main-session blinded review records the adverse examples before revealing labels:
GLM question defaults are correct 2/2 per arm; Kimi omits requested expiry defaults
once in each arm (1/2 correct each), in opposite samples. One candidate Kimi output
also adds an undeclared type field that the current handler ignores. Do not score
these as fully correct or claim general parameter quality. Named readonly spawn
scopes are retained; both initial GLM arms add a fast hint despite the inheritance
request, while both second samples omit it. No consistent differential harm is
established. Kimi's baseline objectives are longer in these small samples, not
evidence of a generally more efficient candidate.

All four controlled editing tasks finish the actual four-response graph with
the exact golden file, both comments, protected files, actual one-test success,
independent oracle 6/6 and truthful final scope/test reporting:

| Model | Whole-task tokens baseline → candidate | Wall seconds baseline → candidate |
| --- | ---: | ---: |
| zai-coding/glm-5.3 | 74,289 → 72,908 | 22.354 → 33.757 |
| kimi-code/kimi-for-coding | 70,473 → 68,488 | 39.467 → 24.487 |

Usage is complete API input+output including cached input, not estimated request
text. First input drops 18,224→17,899 for GLM and 16,862→16,557 for Kimi.
These are single samples: token reduction is observed, but latency moves in both
directions and does not establish speedup. Runtime path/Session facts differ per
Run. The Layer 2 mapping had already been revealed before main-session Layer 3
review; the latter is explicitly **not blinded**. Independent file/test oracles
remain valid, but do not claim blinded semantic superiority or causal efficiency
beyond these bounded observations. No extra generation is spent to repair this
review limitation.

Final candidate-only complex smokes, once each, complete without intervention:

| Model | Physical calls / tools | Conservative full-task tokens | Wall seconds | Model tests / independent oracle |
| --- | ---: | ---: | ---: | --- |
| GLM-5.3 | 18 / 33 | 366,569 | 169.077 | 10/10 / 6/6 |
| Kimi for Coding | 15 / 35 | 305,104 | 224.661 | 10/10 / 6/6 |

Both repair the three real package implementations, add nine meaningful public-
API regressions, preserve public facades/docs/old tests and finish an inherited
readonly child (six GLM responses, four Kimi). GLM first misses the exact-deadline
fix; its own new test fails (9 pass/1 fail), it corrects >= and reruns 10/10 after
the last edit. This is natural within-task recovery, not an evaluator rerun.

Kimi's code/tests and core final scope/count claims are correct, but its final
child paragraph says the old 109/111 test locks >=. That old test cannot distinguish
> from >=; only README and the new exact-deadline test establish it. Its earlier
paragraph correctly says the old test lacks those boundaries, so the report is
internally imprecise. Preserve this as a reporting limitation, not a fully passed
honesty claim or a proven effect of the description change. Child compatibility
checks may also read implementation snapshots while the parent works; they do
not establish independent review of a frozen final patch.

Total this revision: 65 actual physical calls, 1,239,406 complete known tokens and
9,893 reserved unknown tokens = 1,249,299 conservative tokens. One GLM auxiliary
judge reaches its existing timeout; its full USD/token reservation is retained.
Frozen-rate reference USD 0.036706695, not an actual subscription invoice; zero
active reservations, provider concurrency one, no retries/fallbacks/replays or
argument repairs. Source/helper hashes and physical usage/cost identities verify.
All-history totals: 541 actual calls, 10,667,003 conservative tokens, reference
USD 0.5690616758 and 17 unknown reservations; historical failures remain.

Recommendation: retain only the minimal text refinement with the limitations
above. Deterministic contracts and bounded editing closure support it; the
samples do not prove universal intelligence parity, faultless reporting, general
latency improvement or a further tool-retirement decision. Native/bridge budget
non-equivalence still blocks new parameter hiding. Do not add a mode matrix,
rewrite AMA policy, or grow a new router to chase the remaining token gap.

## Standards

Independent review: 0 actionable findings in the production text, contract
regression, bridge characterization, final result documentation and updated
registry assertions. Ownership, routing and byte ceilings remain asserted.

## Spec

Independent review: 0 actionable findings, including final evidence and registry
assertions; fields, operational obligations, AMA and all capabilities retained.
