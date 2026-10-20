# Local search entry refinement

Current decision (2026-10-20): retain native `code_search` and `repo_overview`.
Only accurate guidance and overview reuse are accepted. Auxiliary-provider
compatibility and usage repair is implemented. Final-source GLM complex editing
completes; Kimi editing acceptance remains open. No intelligence non-inferiority
claim is made.

## Accepted implementation

Mainline `87502cb9` (alpha.9) is merged at `ba4d7035`; both discoveryToolNames
and configHome, Host/Session/history/Artifact changes survive. Feature submodule
histories merge at `167c9b1`. Prior validated local changes are preserved at
`6c8751b9`; independent backup, backup branch and stash remain available.

`e85d57e7` corrects literal path/content search descriptions and removes claims
of relevance ordering or special minified/lock filtering. Existing applicable
overview is reused; missing/stale overview remains recoverable. `0390d5df`
clarifies native direct calls versus discovery/bridge calls independently of
which entries are native. No mandatory new workflow is added.

| Retained contract | Decision |
| --- | --- |
| Native search and repository tools | All retained, including code_search/repo_overview |
| Literal and extension-provider search | Registry, SDK and discovery/bridge execution retained |
| Specialized roles and children | Their original callable menus retained |
| AMA planning, dispatch and internal single-Agent executor | Unchanged |
| SDK profiles, extensions and permissions | Unchanged; no new routing/configuration |

The evaluated root-only native projection is withdrawn. The current adapter has
no change from `0390d5df`; executable regressions retain native search and verify
real literal/provider bridge results. No lower-level capability is deleted.

## Validation evidence and limits

A cross-package cache fixture follows aliases/re-exports, includes unused same-
name examples, protects public facades/README/old tests, and checks identity
encoding, tenant separation, TTL boundaries, concurrent de-duplication and retry.
Its independent six-assertion oracle fails original defects and passes golden
repairs. Actual Runtime scripted root/readonly-child execution passes with zero
network; shared request caps and child mutation/recursive-spawn guards pass.
Final build and source/tests typechecks pass. Full deterministic run: 1,197
files / 16,890 tests pass, one old tool_search-description assertion fails;
4 files / 90 tests skipped, 19 todo. That assertion is updated to the accepted
native/bridge contract and its entire 44-test file passes on focused re-run.
No production code changes for this assertion repair; the full suite is not
repeated merely for one stale expected string. No unresolved deterministic
failure remains across that full run plus focused verification.

Exploratory menu probes (four models, two checkpoints, two menus = 16 calls):

| Provider/model | Reconstructed full menu input | Candidate input | Difference |
| --- | ---: | ---: | ---: |
| deepseek/deepseek-flash | 19,244 | 19,040 | 204 |
| kimi-code/kimi-for-coding | 17,263 | 17,096 | 167 |
| zai-coding/glm-5.3-flash | 18,614 | 18,414 | 200 |
| zai-coding/glm-5.3 | 18,614 | 18,414 | 200 |

Final ordered-menu audit finds the reconstructed control inserted code_search
at index 1; the actual final Runtime puts it at index 5. This fails exact ordered
production-menu parity. Preserve these paid samples as exploratory evidence;
do not use them as adoption-grade causal comparison or re-run merely for green.
The token numbers above are observed inputs, not the actual final default's
first-request counts. Actual final-native fixture inputs: GLM 5.3 18,657; Kimi
17,301 (with different generated Session/provider context, not a paired delta).

All repair responses start with relevant inspection. Provider-only checkpoint:
candidate DeepSeek misses latest steering once; native discovers the contract.
Kimi and GLMs attempt discovery in both variants. These small samples do not
establish causal harm or benefit. Roughly 1% first-input savings do not justify
adoption without the full-task gate. Counts use each model's own tokenizer.

**Live complex editing E2E: not passed.** The first attempt exposed an eval
wrapper that lost internal-judge reasoning=false, forced-tool and 1024-output
options. A zero-network regression is RED before forwarding and GREEN after it.
The corrected final-native attempt then records real existing auxiliary limits:
GLM 5.3's judge cancels at exactly 5,000ms; Kimi returns HTTP 400, specified tool
choice incompatible with thinking enabled. Production ordinarily treats these
auxiliary failures as no nudge; the eval stops new dispatch on unknown usage.
No real edit, completed child or final task test occurred. Initial oracle failure
is fixture ground truth, not a model-generated regression. Interrupted prefixes
cannot support completed-task token/time comparison or intelligence conclusions.

Total this work: 25 physical calls, 522,593 conservatively charged tokens,
USD 0.0369060194 frozen-rate reference; four unknown-usage reservations fully
charged. No retry/fallback/replay. Coding-plan reference cost is not subscription
billing. Both revisions' raw inputs/outputs/failures/ledgers/source snapshots are
in OS Temp with two hash-verified mirrors; detailed exploration remains local.

## Next gate

The owner authorized the separate internal-judge compatibility/usage repair on
2026-10-20. Kimi's always-thinking profile omits its unsupported specific tool
choice on the first request; thinking, tool schema, output cap and validation
remain. Failed/cancelled Anthropic streams retain received progress separately
as partialUsage; complete usage and task totals remain explicitly unknown.
No AMA, sidecar routing, 5-second timeout or fail-open policy changes.

Before paid execution, freeze a new final-source revision with two complex
Runtime smokes: zai-coding/glm-5.3 and kimi-code/kimi-for-coding (the latter
explicitly authorized despite the default eval-pool pause). Each requires actual
read/edit/new-test/test execution, one completed inherited readonly child,
protected compatibility files, the independent six-assertion oracle and truthful
final reporting. Main-session raw review decides acceptance. These are closure
smokes, not A/B prompt or intelligence non-inferiority evidence.

This revision replaces the earlier experiment's blanket unknown-usage stop only
for an actual bounded stall-judge cancellation: exact report-only tool, reasoning
false request, output cap at most 1024, one cancelled physical attempt, auxiliary
signal cancelled while the task remains active. Charge its entire token/USD
reservation, retain partial/unknown usage explicitly and allow production to
fail open. Cancelled queued requests never dispatch. Unexpected auxiliary errors,
primary errors, ambiguous physical attempts and exhausted hard caps still stop.
No refunds based on partial usage, sidecar bypass, timeout increases or retries.

New hard ceilings: 48 physical requests total; 24 shared root/child/auxiliary
responses and 60 tools per cell; one readonly child; 4096 output per main/child
request and the existing 1024 judge cap; 120 seconds per physical request and
10 minutes per cell; 1,477,407 conservatively charged tokens and USD 0.9630939806
frozen-rate reference. Same-provider concurrency is one, providers may run in
parallel. No fallback or replay. Old failures stay in cumulative accounting:
433 physical calls, 8,495,407 conservatively charged tokens, USD 0.5123256958
reference, 13 unknown-usage calls. Estimated new reference spend USD 0.05;
existing coding-plan subscriptions are not billed by this reference estimate.
Freeze ordered production inputs, source/helper hashes, routes/rates, ledger and
two raw mirrors in OS Temp after zero-network forwarding/cancellation/budget
checks. Further repo_overview/entry retirement remains deferred; the original
88-call/2M-token/USD1 ceiling is not a spend target.

The first closure revision (`judge-closure-v3`) stops after six actual physical
requests and seven reserved logical attempts: a queued Kimi judge is cancelled
after release but before SDK fetch. Its native pending/cancelled operation has
zero physical attempts; the guard incorrectly rejects that cancellation and
stops both tasks. Kimi's former 400 does not recur. No edits or final task tests
are reached; this is an eval cancellation defect, not a model regression.
All seven reservations stay charged: 109,412 tokens, USD 0.00285197 reference,
two unknown reservations (one actual cancelled request, one zero-fetch native
operation). Historical cumulative actual physical calls are now 439; cumulative
conservative tokens 8,604,819 and reference USD 0.5151776658.

The corrected closure revision additionally recognizes a single completed
native pending/cancelled sidecar operation with no fetch boundary, consistent
request/logical identity and the same bounded judge contract. A real SDK
zero-network regression confirms this pre-dispatch cancellation emits no fetch;
unavailable/custom operation boundaries remain ambiguous and stop. Its full
reservation still stays charged and unknown; physical and reserved call counts
are reported separately. Re-check cancellation immediately after preflight as
well as queue release. This changes the evaluation driver, not production AMA,
provider routing or timeout. Two closure smokes remain necessary because v3's
eval defect interrupted both tasks before editing; no model-failure replay.
Fresh revision ceilings: 48 reserved attempts (thus at most 48 physical calls),
1,367,995 conservative tokens, USD 0.9602420106 reference; all per-cell, timeout,
output and no-retry/fallback limits above remain. Preserve v3's frozen sources,
raw failures, budget and two mirrors before new dispatch.

## Final repair verification (2026-10-20)

Final production regression: 73 files / 1,106 tests pass, including the complete
LLM package, judge, stall sidecar, child usage, persisted execution facts, fixture
and budget/isolation guards. Full build and source/tests typechecks pass; the
last revision changes only eval guards/tests/docs, with production unchanged
from the verified build. No extra configuration, dependency or retry is added.

Final-native `judge-closure-v4` results (actual complete usage, not estimates):

| Route | Physical calls | First input | Whole observed task tokens | Elapsed | Closure |
| --- | ---: | ---: | ---: | ---: | --- |
| zai-coding/glm-5.3 | 14 | 18,671 | 281,900 | 165.695s | Editing/test/child loop completes |
| kimi-code/kimi-for-coding | 4 | 17,322 | 66,200 | 40.145s | Interrupted before editing |

GLM follows the aliases/barrels to the three real implementations, preserves
public compatibility files and the opaque-identifier comment, adds 12 meaningful
tests and completes its inherited readonly child. It initially miscounts the
expected concurrent failed loads (3); actual test failure leads it to correct
that expectation to 2 (one shared failure plus one retry), which is the right
deduplication contract. After its final edit it actually reruns all 13 tests
(12 new plus one existing) successfully; the untouched external oracle passes
6/6. It retrieves and integrates the child's report. Its final report describes
the repairs and test result faithfully, with a minor counting imprecision:
one heading attributes all 13 tests to the new file, which itself contains 12.
This is one closure smoke, not a statistical intelligence comparison.

Kimi locates the implementations and starts the readonly child, but its root
generates a malformed absolute read path with an invented directory/.. segment
outside the fixture. Isolation rejects it before the read and terminates the
cell; there is no edit, new test, completed child or final report. The original
oracle defects remain (2/6 baseline assertions pass); these are not introduced
regressions. Do not count this sample as a pass, infer ability loss from it or
silently rewrite its arguments/re-run it for green. The stricter eval abort also
means this sample cannot establish whether normal tool-error recovery succeeds.

The final revision uses 18 physical requests / 348,100 known tokens, reference
USD 0.01473435, zero unknown usage. Including the preserved v3 eval failure,
this repair work totals 24 physical requests, 25 reserved attempts, 457,512
conservatively charged tokens, reference USD 0.01758632; two unknown reservations
stay fully charged, one of which is the proven zero-fetch native cancellation.
All-history cumulative: 457 physical calls, 8,952,919 conservative tokens,
reference USD 0.5299120158, 15 unknown reservations. Subscription reference costs
are not actual token invoices. Separate-provider timings/partial tasks are not
an efficiency comparison. No retry/fallback/replay occurs in either revision.
Source/helper hashes, raw inputs/outputs, model edits, test failures and successful
rerun, physical timelines, ledgers and main-session semantic review are preserved
in OS Temp with two hash-verified mirrors.

The combined GLM/Kimi editing gate is still unsatisfied. Retain both native
search tools and AMA; do not promote further menu/parameter disclosure changes.
Next investigate the denial/recovery contract offline: malformed out-of-fixture
reads must stay denied, with no argument rewriting or outside reads, while
checking whether an ordinary tool error can allow bounded recovery. Freeze that
contract and preserve the observed Kimi failure before any new paid recovery
sample. Current evidence cannot guarantee unchanged intelligence universally.

## Standards

Earlier refinement review: 0 actionable findings. Repair review finds one eval
settlement flaw (cancelled usage could reduce the reserve); RED regressions,
terminal-identity-based usage and full cancellation charging resolve it. The
native zero-fetch cancellation extension is independently rechecked. 0 open
findings; no production framework, configuration or layer coupling added.

## Spec

Independent review: no confirmed production deviation. One documentation finding
required the second attempt's failure, cost and incomplete edit/child/test loop;
resolved above. Standards: 0 open. Spec: 0 open implementation findings, 1 resolved
documentation finding. Repair review: 0 implementation findings. The combined
real-model acceptance gate remains unsatisfied; only GLM closes the editing loop.
