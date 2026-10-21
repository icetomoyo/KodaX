# Native and bridge work-budget equivalence

Status: minimal accounting correction retained after offline and bounded paired
validation, 2026-10-21.
Baseline `3a87e7fe`. This follow-up is explicitly authorized to correct duplicate
work accounting; the earlier description-only decision did not authorize it.

## Confirmed defect and minimal correction

The two-read observation of native 2 / bridge 4 is duplicate **managed work-unit**
accounting, not duplicate provider billing. `buildManagedToolCallBridge` charged
one unit before dispatch, then registered targets and Todo overrides charged
another through `wrapCodingToolAsRunnable`. Run-scoped Host dispatch bypassed
that target wrapper and depended on the outer charge.

The correction leaves budget caps, extension thresholds, root/child ownership,
AMA planning/dispatch, all tools, model-facing contracts and SDK behavior intact:

| Path | Budget owner after correction |
| --- | --- |
| Registered target, including a handler error | Existing coding-tool wrapper; one unit |
| Todo role override | Existing base wrapper; one unit, existing reminder/evaluator composition retained |
| Run-scoped Host target | Direct bridge branch; one unit before capability execution |
| Malformed/unavailable bridge, missing runner context or unsupported dispatch | Rejection helper; one unit, as before |
| Permission denial or cancellation before target execution | No target work, zero units, matching native beforeTool rejection |

There is no subtract-after-execution correction, global spent-value inference,
new budget flag, or alternate unchecked execution route. Permission, cancellation,
target identity, event ownership, mutation tracking and result handling retain
their existing order. Discovery via native `tool_search` remains separately
charged; no discovery or disclosure policy changes here.

## Offline evidence

The read-error/recovery regression is RED on baseline (2/4 rather than 2/2), then
GREEN after the fix. Eleven executable-boundary cases cover missing and successful
reads with untouched inputs, Todo creation/completion, Host dispatch, a throwing
extension, malformed/unavailable/meta-recursive calls, native/bridge Runner
permission denial followed by recovery, and cancellation during permission.
Registered/override/Host executions are counted once; refused targets never run.

Related wiring, mutation-wrapper, real Runtime outside-read recovery, inherited
readonly-child recovery and mixed native/bridge shell scheduling pass 53 tests.
The separate agent-chain coverage run passes 142 tests: 94.44% statements,
82.60% branches, 100% functions. Production/test typechecks and build pass. The
actual Runtime offline four-response native/bridge tasks also both complete with
three work units, exact edits, public test success and independent oracle 6/6;
eight scripted responses, zero fetch calls. These are real
local executable paths with scripted responses, not model intelligence evidence.
The final real-SDK wire regression also passes all 16 scenarios against the
previous inventory: normalized complete request bodies agree, 55 native Host
entries remain, and external model calls are zero. Its source hash manifest and
the paid-run source hashes record the budget implementation separately.

## Bounded GLM/Kimi execution-entry pairs

The budget defect itself is answered by Layer 1. A paid pair can answer only the
remaining interaction question: can each requested model complete real
read/edit/test/report through native and bridge entries under the final wiring?
It is **not an old/new prompt A/B**, and no parameter hiding or new default is
being evaluated. Tool definitions and AMA strategy are identical in both arms;
the task's explicit execution-entry instruction differs and is recorded.

Use the existing actual Runtime controlled fixture, one native/bridge pair for
each of `zai-coding/glm-5.3` and `kimi-code/kimi-for-coding` (explicit user choice
overrides the default Kimi eval-pool pause). Four root responses per cell are
necessary: read, edit, actual test, then a report after observing its result.
Require the exact corrected file, preserved comments/protected files, unchanged
arguments, public test pass, independent oracle 6/6 and truthful final reporting.
Record actual budget usage, complete API input/output including cached input,
physical auxiliary calls and whole-cell wall time. A controlled-graph mismatch
is a limitation/failure, not permission to repair arguments or rerun the task.

Freeze at most 20 physical attempts (16 planned root responses plus four shared
auxiliary reservations), five responses per cell, 2,048 output tokens per call,
1,000,000 conservative total tokens, USD 0.10 frozen local reference, 120-second
request timeout and 300-second cell timeout. Default one in-flight request per
provider, independent providers parallel. Zero retry/fallback/replay, zero
children, no rescue prompts. Unknown usage retains its full reservation. Raw
inputs/results, source/helper hashes, ledger and main-session semantic review
remain in OS Temp with two verified copies. Do not expand the panel to compensate
for an inconclusive sample.

## Tool necessity follow-up

The remaining first-input cost is separately attributed in
[Tool surface cost attribution](tool-surface-cost-attribution.md). A lower tool
count is not the acceptance criterion. Alternatives must retain result fields,
mutation/permission semantics, extension precedence, identity, cancellation,
recovery and complete-task efficiency. This budget fix alone does not satisfy
the broader compaction/resume/live-capability gates for parameter hiding.

## Results and decision

All four final Runtime cells complete read → one atomic edit → actual Node test →
truthful report, exactly four responses each. Both comments, original formatting
and protected files survive; public tests pass 1/1 and independent oracle 6/6.
All four charge **three work units**, including registered edit and bash targets.
Main-session semantic review records correct scope/test claims before aggregate
token/time inspection. Arm labels are hidden at that point, but tool syntax
reveals transport; this is explicitly not a blinded old/new prompt comparison.

| Model | Full-task tokens native → bridge | Wall seconds native → bridge |
| --- | ---: | ---: |
| zai-coding/glm-5.3 | 73,203 → 73,329 | 27.463 → 33.300 |
| kimi-code/kimi-for-coding | 68,658 → 69,800 | 23.722 → 31.846 |

Complete API input/output includes cached input. First input native→bridge is
17,906→17,927 for GLM and 16,563→16,588 for Kimi; the explicit transport instruction
differs. Both cells use the full native menu, not hidden parameters. These single
samples establish neither universal intelligence parity nor causal latency/token
superiority. They show no efficiency case for switching the default to bridge.

Total: 16 physical attempts, 282,874 input + 2,116 output = 284,990 known tokens,
frozen-rate reference USD 0.00806541 (not actual subscription billing), zero
unknown usage, retry, fallback, replay or active reservations. No auxiliary call
or extra generation was needed. Physical identities, same-provider concurrency,
usage/rate arithmetic, source/helper hashes and ledger balance are independently
reconciled in OS Temp. All-history accounting becomes 557 physical calls,
10,951,993 conservative tokens, USD 0.5771270858 reference and 17 historical
unknown reservations; earlier failures remain intact.

Retain only the duplicate work-budget correction. First-input text remains at
the description-refined baseline; correcting work units does not save input
tokens. No tool replacement, retirement, schema hiding, new mode or AMA policy
change is included. The next useful comparison is the existing relationship_scan
against overlapping narrow repository entry points, subject to the independent
contracts listed in the cost attribution; implementation is not accepted yet.

## Standards

Independent review: 0 actionable findings in accounting ownership, boundary tests
or cost/necessity analysis. No new configuration or layering dependency.

## Spec

Independent review: 0 actionable implementation findings. Full capabilities and
AMA retained; offline and paired evidence is bounded to the tested contracts.
