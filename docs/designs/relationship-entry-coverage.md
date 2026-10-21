# Relationship scan versus detailed repository entries

Status: **retain the current native menu; recommend-iterate for consolidation**,
2026-10-21, source `6a0c6a0f`. This verifies the proposed first-menu replacement;
it does not adopt a projection, change AMA routing or remove an executable tool.

## Result

relationship_scan is useful for combined relationship questions, but it is not a
lossless replacement for module_context, symbol_context, process_context and
impact_estimate together. Existing Worker guidance already prefers it for
upstream/downstream questions. Keeping detailed entries does not force four
separate queries when the aggregate answers the task.

Actual local fixtures establish the following, rather than treating shared
query functions or matching headings as output equivalence:

| Intended information | Narrow entry | relationship_scan coverage |
| --- | --- | --- |
| Module orientation | Tests/docs, entry files, top symbols, language/file counts, process handles | Dependencies/dependents and identity are useful; the fixture's app test and README paths are absent. An impact symbol list is not the complete module capsule. |
| One symbol | Signature, import paths, export/kind/language information, callers/callees and alternatives | Definition location and callers/callees are retained; actual signature/import details are absent. |
| Execution flow | module-only or entry-based process, summary, ordered steps with notes and alternatives | Entry-based scan retains process steps. Module-only scan does not load process_context; process notes/alternatives are not preserved. |
| Change impact | Impact sites/callers, explicit target and changed-scope overlap | Important sites and the overlap count survive in the summary. The explicit overlap field is absent; this is **not** evidence that all impact facts were lost. |

The permanent paired output regression passes in **light and full** profiles;
auto resolves to full in this source. No conclusion rests solely on light-mode
heuristics. It verifies meaningful evidence values such as app.test.ts,
README.md, a real function signature and imports, rather than just labels.

## Permissions, extension precedence and recovery

All five tools are readonly, but they have separate concrete permission names.
Actual Runner tests deny each name, observe its real error with zero target work,
then permit it and receive actual repository evidence with one work unit.
This supports their current admission paths; it does not make one permission
name an alias for the other four.

Exact tool_search discovery returns all four detailed contracts, and checked
tool_call can recover the module's test/doc information. Discovery plus the
target costs two work units after the prior duplicate-charge fix. An actual
excludeTools denial removes the native target and rejects both discovery and
bridged execution. Exclusion is therefore **not** a way to simulate a smaller
model menu while retaining capabilities.

A registered module_context extension returns its own evidence through both
native and checked bridge entries. relationship_scan calls the underlying query
API directly and does not invoke that replacement handler. Any future root-menu
projection must be builtin-only and preserve extension and specialist entries;
adding these four names to the existing global alias filter would not establish
that role boundary. No alias filter, SDK export or role menu is changed here.

Two additional recovery/refresh differences were reproduced without changing
production code or repairing parameters:

1. On an unchanged light-mode fixture, relationship_scan(module, refresh:true)
   leaves the persisted build timestamp unchanged. A subsequent
   module_context(module, refresh:true) rebuilds it. The source forwards false
   to module and later queries; only a preceding symbol query receives refresh.
   Module/path-first refresh therefore needs an independent correction before
   claiming that input contract is equivalent.
2. With the existing off setting at the **direct SDK handler boundary**, narrow
   module output retains Capability: light/unavailable and recovery warnings.
   The aggregate retains low confidence and an unavailable impact sentence, so
   failure is not entirely silent, but drops the per-part capability warnings,
   prints empty-edge claims and ends with No additional gaps recorded. An
   enabled symbol query also produced a limited process part without surfacing
   its warning as a gap. Re-enabling light returns normal evidence. These are
   direct-handler observations, not a claim that an off-mode Runtime advertises
   these tools to the model. Existing warming tests separately retain the honest
   warming message, avoid false-negative edges and stop repeated indexed queries.

These gaps do not prove that models became less intelligent. They do prevent a
confident all-four-entry replacement under the user's preservation requirement.
Do not expand the aggregate into another large router to make a gate pass.

## Token and latency accounting

Research-only removal of the four OpenAI native entries from the sealed Windows
Host request changes 20,191 → 19,532 estimated model-field tokens: **659 saved**,
55 → 51 displayed entries. This is a static tool-array projection only, not a
complete candidate with revised routing, autonomous discovery, resume or dynamic
capability handling. The production request remains 20,191 / 55 entries.
Codex Sol remains 17,032 at the pinned reference: the projection would still
leave 2,500, rather than eliminating the earlier 3,159 gap.

Actual exact discovery of the four full contracts returns **1,315 estimated
tokens**, and may add a model round trip before the detailed query. Saving first
input bytes does not establish lower complete-task usage.

The following are three warm **local handler** samples on one small Windows
fixture, with sample order reversed in round two. They exclude all model work;
token counts describe returned text using the existing estimator, not API usage.

| Handler query | Returned estimated tokens | Median local milliseconds |
| --- | ---: | ---: |
| module_context(module) | 136 | 137.8 |
| relationship_scan(module) | 257 | 384.1 |
| symbol_context(symbol) | 130 | 136.4 |
| relationship_scan(symbol) | 392 | 657.6 |
| process_context(entry) | 174 | 135.4 |
| relationship_scan(entry) | 476 | 649.6 |
| impact_estimate(symbol) | 158 | 235.5 |

The aggregate queries several sources and returns broader evidence; it can save
multiple exploration calls when those facts are needed together. This table
does not compare equivalent full tasks or establish a general speed ranking.

## Validation and decision boundary

The three related files pass 24 tests, including both profiles, extension-aware
discovery/bridge, all five permission-denial/recovery paths, warming, depth,
LSP/text evidence and real provider serialization without external requests.
Test TypeScript checks pass. Verification scaffolding initially confused a
package display label with a canonical module path and shadowed process inside
one test; both are corrected, and failed/final logs are preserved. No production
arguments or guards were rewritten to obtain a pass.

Independent Standards and Spec reviews reported zero findings. The final
light/full output check also positively verifies that impact overlap remains
present; absent field labels are not counted as lost facts.

Passing characterization tests confirms the measured differences; it does not
mean the replacement gate passed. Main-session review recommends retaining the
native entries because useful detailed evidence, refresh and degraded-state
semantics are not yet equivalent, and the remaining fallback path has not been
shown to be efficient or autonomously discoverable after hiding entries.

**No GLM/Kimi requests were sent.** The user authorized complex E2E after offline
validation supported the candidate; that condition is not met. Actual full-task
API tokens and model wall time for the proposed menu are therefore **unmeasured**,
not substituted by the local table. Prior GLM/Kimi results belong to their own
source-pinned experiments and are not presented as this candidate's evidence.

The next minimal work, if this direction is resumed, is to correct the existing
refresh and per-part warning contracts separately, keep module-oriented access
where it supplies independent evidence, and only then consider a narrower
builtin/root-only projection with explicit discovery/resume checks. A viable
candidate should get bounded GLM/Kimi controlled pairs before two final complex
smokes; complex smokes must not be used as prompt-superiority comparisons.

Raw fixtures, complete outputs, timings, hashes, projection and recovery evidence
remain in OS Temp with two verified copies. No production implementation, model
schema, AMA policy, specialist capability or SDK contract changes in this revision.

## Minimal corrective follow-up, 2026-10-21

The follow-up starts at `9c24eb5c`; it corrects relationship_scan only. Module/path
queries now receive refresh when no symbol query preceded them. Subsequent
queries reuse the index. Actual light/full output tests verify a new build time
and shared module/impact freshness, then unchanged freshness on the cached call.

Every part's capability warnings now reach Gaps, with a recovery fallback for
non-ok status without warnings. Unavailable placeholders are excluded from
relationship findings, while their original evidence metadata and warnings
remain visible. Valid and limited results remain usable; warming still stops
indexed follow-ups and uses the existing explicit warming response.

Offline acceptance: 63 unique tests pass across the related tool/runtime and
existing complex budget/guard/recovery files; source/test type checks and package
build pass. relationship_scan coverage is 90.57% statements, 83.48% branches.
Independent Standards and Spec reviews each report zero findings. No tool schema,
native entry, SDK export, extension handler, specialist menu or AMA policy changes.

The frozen model experiment is `relationship-fix-20261021-r1`, with 823 source
hashes, real old/fixed unavailable handler outputs and unchanged production Worker
instructions/tool contracts. This Worker probe has 46 native entries; it is not
the separately captured complete Host with 55. Only the tool-result bytes differ
between paired arms. Kimi's two next responses both gather evidence; blinded
review slightly preferred the fixed arm's direct content searches. One sample
per arm cannot establish an overall token or intelligence improvement. GLM's
first arm terminated in transport without output/usage; the second arm was not
dispatched after the stop. The failed arm was not retried.

Two final-source complex Runtime smokes used the existing cross-package tenant/
TTL fixture, unchanged isolation guards and independent six-case oracle:

| Route | Result | Known API tokens, including input cache | Unknown-usage calls | Conservative task token accounting | Wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| zai-coding / glm-5.3 | 11 read calls, then transport terminated; no edit or completed report | 18,442 | 2 | 124,223 | 90.7 s |
| kimi-code / kimi-for-coding | Read/edit/new tests/test/report; public tests 10/10, oracle 6/6; protected files unchanged | 152,185 | 1 | 167,038 | 106.5 s |

Known Kimi usage is 147,779 input (including 123,136 cache-read) and 4,406 output;
cache-read is not added again. Its one cancelled auxiliary request has no usage
and retains its full reservation. GLM's two unknown calls are an auxiliary
cancellation and the transport failure. The cancelled auxiliary requests use
the existing bounded fail-open contract; no parameters or isolation rules were
rewritten. Kimi used read/edit/write/bash; GLM only reached reads. Neither smoke
called relationship_scan, so they verify general final-source operation, not the changed query branch.
The public SDK offline regressions directly exercise that branch.

Main-session review confirms Kimi's new tests are meaningful: replaying the exact
test file against original implementations fails five of ten tests. Its final
report incorrectly says eight new cases; nine were added. Keep this minor count
error visible rather than calling the report flawless. GLM quality remains
inconclusive because no completed implementation exists. These two smokes are
not baseline/candidate comparisons and cannot establish intelligence parity.

The experiment stopped after 14 physical requests: 190,082 known usage tokens,
361,489 conservatively accounted tokens including four unknown reservations,
USD 0.010055855 at frozen reference rates (coding-plan routes, not an invoice).
Limits were 40 calls, 1.5M tokens and USD 0.10, with no retry/fallback. Raw inputs,
outputs, failures, reviews, fixtures and hashes remain in OS Temp with two
verified complete copies.

Smaller-entry assessment: module/symbol/process retain independent evidence.
impact_estimate is the narrower candidate, but its 191 estimated schema tokens
compare with 350 returned tokens for exact discovery. That is a one-discovery
diagnostic, not a whole-task break-even: repeated rounds or unused tools may
change the result. Ranked impact detail, permission identity, extensions,
autonomous discovery and resume remain required checks. No smaller projection
has yet demonstrated enough value to change the default; all entries remain.
