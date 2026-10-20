# Local search entry refinement

Current decision (2026-10-20): retain native `code_search` and `repo_overview`.
Only accurate guidance and overview reuse are accepted. Complex live editing
acceptance remains blocked; no intelligence non-inferiority claim is made.

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

Keep the minimal product scope while the owner decides whether to include the
separate internal-judge protocol/usage-observability fix. After that fix, require
final-source GLM/Kimi read/edit/test/truthful-report closure and whole-task usage
and elapsed time. Do not disable the sidecar, raise its timeout or waive unknown-
usage stops to manufacture a passing run. Further repo_overview/entry retirement
remains deferred; the original 88-call/2M-token/USD1 ceiling is not a spend target.

## Standards

Independent review: 0 actionable findings. No production framework, configuration
or layer coupling added; fixture/guard changes are limited to verification.

## Spec

Independent review: no confirmed production deviation. One documentation finding
required the second attempt's failure, cost and incomplete edit/child/test loop;
resolved above. Standards: 0 open. Spec: 0 open implementation findings, 1 resolved
documentation finding. The real-model acceptance gate remains unsatisfied.
