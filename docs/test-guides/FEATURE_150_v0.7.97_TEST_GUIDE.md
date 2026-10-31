# SDK bundled Skill regression guide

2026-10-27; current development version `0.7.97-alpha.10`, baseline `ed539e33`.
This records local source and installed-tarball acceptance, not an npm release or
Space integration. Space-specific first-party Skills and Host registration are
outside this change.

## Contracts

- All five core Skills are model-discoverable. Git actions, regression-first
  development, tests-only work, review, reusable Skill authoring and general
  visual evidence have scoped descriptions; conceptual/unrelated requests do
  not require a workflow.
- `Bash(git *, npm *)` matches the entire command using the existing glob
  matcher. No colon compatibility or new authority is introduced. Code Review
  allows the listed read-only Git commands; Skill allowlisting never replaces
  Host authorization or sandbox policy.
- A bug regression must fail for the intended behavior before repair. Tests-only
  work on a correct implementation may pass immediately and must not expand
  into production edits or an invented RED cycle.
- Skill Creator branches into create/change/validate, package and evaluation.
  Sharing creates an archive; install verification uses an explicit temporary
  `--dest`, retaining the real user catalog. Model-backed helpers require their
  own Provider, model, cwd and budget.
- `run-trigger-eval.js` reports `description_semantic_screening` and catalog
  visibility. Its scores do not establish actual tool selection; that needs
  the full registered catalog and actual `skill` tool calls.
- `visual-review` supplies the general evidence method; optional
  `artifact-review` describes the registered Artifact adapter. Both use normal
  managed preparation within existing authorization. Missing/denied preparation
  leaves affected scope unverified. Source inspection, ready receipts and paths
  cannot certify unseen pixels or continuous playback.

## Deterministic source and installed-package checks

```text
npm run build:packages
npm run build:bundle
npx vitest run packages/coding/src/builtin-skill-policy.test.ts packages/agent/src/capabilities/skills/skill-creator-tools.test.ts tests/sdk-builtin-package.test.ts --retry=0
```

The shipped Registry policy regression first failed 4/4 under the old metadata,
then passed after declaration repair. It checks normal commands, out-of-scope
denial before the Host callback, and an independent Host rejection. Review then
found the non-gh API path was still blocked; a fifth Registry case first failed,
then passed after Git Workflow allowed Node for authorized hosting API requests.

The package test actually runs `npm pack`, installs that tarball into a new
consumer directory, and imports every shipped Skill Creator JS helper without
repository module symlinks. It loads all five core Skills, then registers the
optional Artifact adapter and discovers its sixth Skill from the installed package.
Its public SDK executes real local Git/npm/Node commands with `enforceAtRuntime`;
code-review commit and Host-denied Node requests stay
blocked. The non-gh API fixture actually receives one local HTTP POST through
Node; Host rejection prevents a second request. A scripted Provider has a fixed
offline request budget; no external model or real Git-hosting write is used.

The helper chain covers initialization/validation, public SDK with/without-Skill
execution, grading, aggregation, analysis, comparison, HTML review generation,
description screening/rewriting/looping, packaging and isolated installation.
The test exposed the missing published `dist/skill-loader.js` import (RED) and
then a missing new description-loop workspace (RED); public Skill exports and
one directory creation resolve them. Injected graders and description judges
verify wiring, not model quality or real selection.

## Independent forward tasks

Evidence root: `%TEMP%/kodax-builtin-forward-BdRA6r`.

- Correct `clamp` implementation: independent tests-only task added 12 boundary
  cases; first run passed 12/12. Main-session rerun passed; before/after source
  SHA256 remained `f8423c430bf2694c565429257c78fd6df1428b8858ca41623b11aacc07af10c2`.
- Share-only Skill task: quick validation and `.skill` packaging succeeded;
  manifest/source hashes and archive content matched. No user catalog install.
- Rendering unavailable and managed preparation denied: review reported a
  white-on-white SVG source issue, separated from unverified pixels, PPTX layout
  and animation. The material was unchanged. This is a controlled unavailable
  capability test, not a live Office/rendering acceptance.

## Bounded natural-language selection observation

Raw requests, complete catalog/tool bytes and responses are retained under
`%TEMP%/kodax-eval-dumps/builtin-skills/forward-20261027-r{1,2,3}.json`.
Drivers are retained alongside raw. Layer 1 proves visibility and policy, but
cannot establish a model's natural-language choice among competing Skills.
These candidate-only Layer 2 observations execute no model-proposed tools and
make no quality-lift or cross-provider claim.

- r1: Ark CodingPlan rejected two pilot requests with `InvalidSubscription`
  before inference. Keep these failures; they are not model-selection results.
- r2: `zhipu/glm52`, real Registry with five core Skills plus the registered
  Artifact Skill; all 87 production core/adapter tool schemas and descriptions.
  Twelve single-turn requests, 328,496 reported tokens including cache reads;
  one request/cell, 800 output tokens/call, no retries. Git, both TDD branches,
  code review, Skill Creator and Artifact called the expected Skill; four
  conceptual/unrelated controls called no Skill. Two target-less visual prompts
  searched files first; retain this limitation rather than claiming 12/12.
- r3: clarify the generic visual task description and provide explicit visual
  targets. Recheck only the two affected positives plus Artifact/nonvisual
  controls: all four selected the expected Skill or no Skill, with 109,370
  reported tokens including cache reads. This changes both input and description,
  so it cannot isolate a causal improvement. Every raw response was read in the
  main session; assessment is retained as `main-session-review.json` alongside raw.

Frozen caps: r2 12 calls/450,000 tokens; r3 4 calls/220,000 tokens; aggregate
18 requests including the two r1 subscription rejections. Each request has a
60-second cutoff and 800 output-token cap; existing CodingPlan entitlement only,
no new purchase or per-use route. These probe cutoffs are unrelated to ordinary
AskUser waiting policy. Cross-provider robustness, actual visual inspection,
real Office fidelity and user-environment installation remain unverified here.

## Final local gates

Source/test typechecks, workspace/bundle build and all 14 SDK declaration entries
passed. Adjacent deterministic regression: 21 files, 125 tests passed, retry 0,
two workers, no skips or unhandled errors. This includes the real independent
daemon Skill-failure/IPC/Provider-classification regression and the installed
package API/Host rejection case. Report: `%TEMP%/kodax-builtin-final-results.json`.
The existing bundle suite passed 46/46 before the final Node declaration
extension; packaged Skill discovery passed again after rebuilding that metadata.
Final review: Standards 0, Spec 0 after fixing the non-gh API finding. These
focused gates do not replace the full release matrix or establish new
cross-platform/manual rendering coverage.

After a final helper line-ending and fixture-indentation cleanup, the helper
suite plus fresh isolated pack installation passed again: 2 files / 15 tests.
No runtime behavior changed in that cleanup.

## Skill discovery and activation follow-up (2026-10-28)

Baseline `84922d76`, development version remains `0.7.97-alpha.10`; this is
source/build verification, not evidence of an npm publication.

- SDK `gitRoot` discovery survives a child execution cwd. Learned identity and
  the execution directory retain their existing scopes.
- Excluded/policy-denied loaders and Runtime active-tool limits remove their
  catalog from both SA and AMA. Explicit expanded instructions remain available.
- Rediscovery updates bodies, disable flags and precedence. A load begun before
  rediscovery cannot return or republish its old source as the current Skill.
- Model activation reuses explicit action restrictions and lifecycle hooks.
  Host denials remain authoritative. Multiple Skills intersect action policies;
  instruction loading itself remains allowed. Dynamic commands are checked
  after variable substitution, before either executor.
- The direct public `Runner.run(createDefaultCodingAgent())` entry installs and
  settles the same lifecycle for both explicit and model-selected Skills.
- Same-batch loads (including `tool_call`) defer sibling actions until the next
  batch, including Host/hook/guardrail refusal and cancellation in SA and AMA.
  Repeated unchanged activation is idempotent. A changed active Skill
  is refused until a new Run, rather than silently retaining old permissions.
- Model selection takes effect on the next request. Model `context: fork`
  loads fail before dynamic expansion and require explicit Host invocation.

Regressions were first observed failing at the intended behavioral assertions.
`tests/skill-activation.test.ts` runs scripted Providers through actual SDK,
SA/AMA and tool dispatch. `tests/bundled-skills.test.mjs` additionally exercises
the built split SDK. These verify execution wiring, not semantic selection
accuracy of a real model or cross-platform behavior beyond the local Windows run.

```text
npx vitest run tests/skill-activation.test.ts packages/agent/src/capabilities/skills/skill-registry.test.ts packages/coding/src/learned-skill-runtime.test.ts packages/coding/src/prompts/capability-sections.test.ts packages/coding/src/skill-invocation-policy.test.ts --retry=0
npm run build
node --test tests/bundled-skills.test.mjs
```

Final Windows acceptance: unit 12,115 passed; fast 2,462 passed; contract 962
passed; system 1,485 passed. The 90 skips and 19 TODOs are existing exclusions.
After the last tool-output context isolation fix, the final focused gate passed
7 files / 106 tests, including all 24 scripted Provider E2E cases. The five
covered Skill/preset modules measured 87.01% line coverage. Build and source/test
typechecks passed; the complete built-SDK suite passed 50/50 with files run
serially (`node --test --test-concurrency=1`, using the `test:bundle` file list).

The in-flight read regression uses a one-shot barrier after real file I/O so its
ordering does not depend on directory depth or machine load. Full contract
testing also caught an added asynchronous commit boundary affecting idle-yield;
the batch observer now returns the original commit Promise. One parallel bundle
run recorded a loopback `transport/network_error`; the same fixture passed in
isolation, then the complete serial bundle suite passed. The final context
regression confirms Host overlays stay in the system prompt and are not copied
into Skill tool output. Final independent review: Standards 0, Spec 0 findings.

## MCP recovery and Skill catalog follow-up (2026-10-28)

Baseline `0d723c6e`; source/build verification, not an npm release.
Acceptance uses the existing public SDK/Registry, actual SA/AMA tool dispatch,
and the built Runtime daemon/stdio MCP/HTTP Provider boundaries.

- A model-loaded or explicit Skill whose `PreToolUse` hook refuses `read`
  must leave MCP evidence complete in the actual next Provider request.
  A subsequent real `read` must still be refused. The hook runs exactly once
  for that real call, never as a truncation preflight; MCP executes once.
- An unrelated hook must not disable normal spill-and-read recovery. The
  built split SDK also preserves originals through history APIs and restart.
- Default project discovery includes `.agents/skills`, retaining higher
  `.kodax/skills` precedence. Nested collections load; Skill support trees,
  hidden/dependency directories and symlink/junction cycles do not produce
  unintended entries. Shadow diagnostics identify both paths without marking
  successful precedence resolution as incomplete discovery.
- The complete model catalog stays within 8,000 UTF-16 code units, with
  single-line descriptions/hints and intact surrogate pairs. Shortening and
  omission are visible in the prompt and diagnostic receipt. Omitted entries
  remain explicitly invocable; disabled entries remain undisclosed.

The source recovery regression failed first in both SA/AMA, and the built
daemon/MCP regression failed against the previous build at the inline evidence
assertion. Directory discovery, shadow diagnostics and catalog budget tests
also failed before their minimal implementations. These scripted Providers
verify wiring and content fidelity, not real-model Skill selection quality.
Review also found AMA's separate oversized-input paging context and cached
pages. Regressions failed before forwarding the same live read policy and
checking it before cache reuse; the Provider now receives intact input when
Skill recovery is unavailable.

Final isolated Windows gates: build and source/test typechecks passed; fast
2,468 passed / 44 skipped; unit 12,121 passed / 4 skipped; contract 962 passed /
19 TODOs; system 1,485 passed / 42 skipped. All four layers total 17,036 passed,
with the same 90 existing skips and 19 TODOs, retry 0. The full built-SDK suite
passed 53/53, including six daemon + stdio MCP + HTTP Provider scenarios.
Those cover explicit/model read denial and an unrelated-hook control alongside
normal recovery, unavailable read and storage failure.

The focused coverage gate passed 8 files / 133 tests, including 28 scripted
Skill activation cases. The five measured core modules (discovery, Registry,
invocation policy, tool-result policy and capacity recovery) achieved 91.72%
line, 83.44% branch, 90.65% statement and 91.24% function coverage. These scoped
numbers are not whole-repository coverage. Final independent review:
Standards 0, Spec 0 unresolved findings. The initial Spec finding about AMA
input paging was fixed and independently reverified with its two regressions.

```powershell
npm run build
npm run typecheck
npm run test:fast -- --retry=0
npm run test:unit -- --retry=0
npm run test:contract -- --retry=0
npx vitest run -c vitest.system.config.ts --maxWorkers=1 --retry=0
$bundleFiles = ((Get-Content package.json -Raw | ConvertFrom-Json).scripts.'test:bundle' -replace '^node --test ', '') -split ' '
node --test --test-concurrency=1 @bundleFiles
```

## Host recovery and unknown Skill error follow-up (2026-10-28)

Baseline `edf21dad`; source/build verification, not an npm publication.

- Unknown Skill errors must not re-enumerate the registry, disclose disabled or
  budget-omitted names, or echo an unbounded requested name. They point back to
  the disclosed catalog. Direct and built-SDK scripted Provider checks cover it.
- Dynamic Host callbacks run only on actual calls, never as a spill preflight.
  After a refused/failed read of a Run-owned spill, its matching prior result
  must be complete in the next Provider request. The read refusal remains
  intact; no refused file is opened and MCP is not replayed. Direct, bridged,
  guardrail and missing-file paths run in both SA/AMA. An unrelated denied file
  must neither restore evidence nor disable ordinary paging.
- Native images, successive preview reductions and canonical history remain
  intact, including already-admitted image bytes after source-file deletion.
  Failed reads are observed before admitting sibling results from the same
  batch. Forged locators/modified previews cannot restore content. Snapshots
  are Run-local and cleared on settlement. A refused owned transient input
  read invalidates the cached paging projection and preserves canonical input.
- The built SDK additionally uses a real stdio MCP child and local HTTP
  scripted Provider with an embedded Host callback in both SA/AMA. These two
  scenarios first failed against the previous bundle at the precise missing
  evidence assertion. Existing six independent-daemon cases continue to cover
  normal recovery, explicit/model Skill restrictions, SDK original reads,
  restart, unavailable read, storage failure and an unrelated-hook control.

These are deterministic content/permission/wiring checks. They do not measure
natural-language Skill selection quality of real models. Remaining known
differences include automatic directory watching, semantic lookup of catalog
entries omitted by the budget, and model-triggered `context: fork` (explicit
Host invocation is required). No claim of complete MCP protocol equivalence,
universal bug absence or cross-harness model-quality superiority follows from
these tests. Restored evidence still obeys model context capacity; Run-local
snapshots are not a new persistent recovery channel.

Comparison evidence is pinned to local DSH `22ddee3792`, Pi `136b87e8a`
and Codex `970111f6cb`; their suites were not run here. Pi's
`packages/coding-agent/src/core/skills.ts` likewise exposes descriptions for
model-selected file loading. KodaX's catalog-to-loader path is tested, but
this is not a deterministic natural-language router. DSH's
`packages/skill/skill-filesystem/src/index.ts` enables watching by default;
`packages/skill/tool-skill/src/index.ts` refreshes the catalog at pre-step.
Its documented local provider scans direct bundles/flat Markdown entries,
whereas KodaX and Pi support nested formal Skill collections. Codex's
`codex-rs/ext/skills/src/render.rs` additionally supports context-window-aware
metadata budgets; KodaX deliberately uses the existing fixed catalog bound.

One concrete reliability advantage over Pi's inspected model-text path is
storage failure: `packages/coding-agent/src/extensions/mcp/tools.ts` reports a
failed save while retaining truncated text, whereas KodaX's regression requires
complete inline content. This does not describe Pi's separate codemode result:
that path receives the full normalized `CallToolResult`, including structured
content. KodaX's tested SDK original paging across Host restart and dynamic
Host-denial recovery are useful reliability properties; neither establishes
that every other harness lacks an equivalent mechanism.

The scoped coverage gate passed 11 files / 161 tests with retry 0 and a single
worker. Eight measured modules achieved 91.65% line, 82.39% branch, 90.60%
statement and 92.90% function coverage; the new recovery module reached 100%
line / 90.90% branch coverage. These are scoped measurements, not repository-wide
coverage. Review independently reproduced three implementation boundary bugs
(SA canonical writeback, same-batch failed-read ordering, and native-image
admitted-cache identity); each received a failing regression before its minimal
fix. Final independent review: Standards 0, Spec 0 unresolved findings.

The first full fast run had one Windows `ENOTEMPTY` teardown failure removing
an isolated `sdk-client.observe.test.ts` Session directory; 2,474 other tests
passed. That file passed unchanged in isolation (5/5), then the complete fast
tier passed unchanged (2,475 passed / 44 existing skips), all with retry 0.
No unrelated product or test cleanup behavior was modified to obtain that pass.

Final Windows source gates: build and source/test typechecks passed; fast
2,475 passed / 44 skipped, unit 12,122 passed / 4 skipped, contract 962 passed /
19 TODOs, and serial system 1,485 passed / 42 skipped. All four tiers total
17,044 passed with the same 90 existing skips and 19 TODOs, retry 0. System
testing retained the previously observed Node `beforeExit` listener warning;
this patch adds no process listeners and does not suppress that diagnostic.
The complete built-SDK suite passed 55/55 with files run serially, including
eight MCP scenarios (six independent-daemon controls and two embedded Host
refusals with real stdio MCP / local HTTP Provider boundaries). All 30 scripted
Skill activation tests passed; the two recovery tests exercise 14 mode/refusal
combinations. No paid Provider or cross-harness model benchmark was run.

## Runtime binding and profile catalog follow-up (2026-10-28)

Baseline `38629a1f`; source/build verification, not an npm publication.

- Runtime default and Markdown bindings use the bounded model-catalog formatter
  over admitted metadata. A 40-Skill catalog remains within 8,000 UTF-16 units
  and announces omissions. Omitted Skills remain in the pinned Registry and
  remain loadable by an authorized known name; reload still requires rebinding.
- Profile instructions stay distinct from an explicit complete prompt override.
  Actual Provider requests contain the profile and admitted catalog in direct
  `runKodaX`, managed Solo/Adaptive and public Runner paths. Model-selected Skill
  bodies really load; disabled and unselected entries do not leak. The catalog
  is hidden with the loader, while the profile remains. A complete caller
  `systemPromptOverride` retains its priority and exact Solo request content.
  Profile-default evidence and per-task verification checks also reach the
  actual Provider together with execution guidance. Independent review caught
  this context gate after the profile/override separation; its new regression
  failed in three Solo entries before widening that gate.
- The built SDK additionally exercises actual embedded Runtime
  `agents.execution.bindDefault/bindLocal/startDefault/startLocal`, Session mode
  settings and scripted Providers in four Solo/Adaptive × default/Markdown cases.
  The application config home is separate from the workspace so user Skills do
  not become project-scoped candidates that default bindings correctly exclude.
- Source budget regressions failed first at 38,401 / 35,655 characters. Source
  profile regressions failed before composition was fixed. AMA may carry the
  catalog in request messages, so E2E checks the actual system and message
  surfaces rather than requiring one exact transport slot. These simulations
  establish wiring, not natural-language selection accuracy of a real model.

Solo is live production behavior, not dead compatibility code:
`agentMode: 'sa'` dispatches through `runKodaX -> Runner -> runSubstrate`;
Runtime coding Runs use this substrate too. Retired V1 multi-role orchestration,
Sidecar Verifier, and the normalized `amaw` spelling are separate concepts.
ADR-020 also retired the separate SA execution body and Option Y facade while
retaining the Solo product mode and thin SDK entry; the current `sa` dispatch
does not reinstate that retired engine.
No execution mode is removed or reinstated by this fix. No watcher, semantic
search, automatic Skill fork, new configuration or paid-model eval is added.

Independent review finished with Standards 0 / Spec 0 unresolved findings after
fixing the verification-context gate. The scoped coverage gate passed 11 files /
134 tests, including the existing real Host/A2A binding contract, at one worker:
80.98% line, 71.16% branch, 78.74% statement and 82.81% function coverage across
five measured modules. This meets the 80% line threshold; it is not a claim of
80% branch or whole-repository coverage. The initial ten-file selection measured
78.45% line / 68.08% branch and failed its coverage gate before the related Host
contract was included; no implementation or test was changed to hide that result.

One full fast attempt recorded a 30-second Provider-admission wait timeout in
`sdk-classic-plane.test.ts`; 2,480 other tests passed. That unchanged file passed
2/2 in isolation. The complete fast tier then passed unchanged with two workers
(2,481 passed / 44 existing skips) and the same deadlines. Other tiers retain
their normal settings, including serial system and built-SDK checks. No timeout
or unrelated product behavior is relaxed.

Final source gates passed build and both source/test typechecks. Fast passed
2,481 tests / 44 skipped; unit 12,122 / 4 skipped; contract 962 / 19 TODOs; serial
system 1,485 / 42 skipped (1,144.29 seconds). The four tiers total 17,050 passed,
90 existing skips and 19 TODOs, all with retry 0. The existing Node `beforeExit`
listener warning remains visible; this change adds no process listeners.

The complete built-SDK suite passed 59/59 in 189.22 seconds with file concurrency
1, no retries or skips. This includes all eight existing MCP recovery scenarios
and the four new actual Runtime binding / scripted Provider catalog cases.
Source and built Skill activation tests verify discovery-to-load wiring; no paid
model call or same-model cross-harness selection-quality comparison was run.
The change is verified from source and local build artifacts, not published to
npm by this task.

## Main-branch integration (2026-10-31)

Integrate the three pending commits `edf21dada`, `38629a1f8` and `bf3a6c4f3`
onto local main `0fa38e5b2`, retaining its eleven commits beyond remote
`0f3930e95`. Both chat and main worktrees were clean at admission; there were
no additional chat-owned uncommitted files to transfer.

Eight textual conflicts were resolved by retaining current Host ownership,
tool aliases/projection, Bash AST checks and the relocated execution-profile
types, then composing Skill catalogs and authorized result recovery into those
contracts. SA/Solo mode and execution architecture are unchanged.

Public embedded Runtime construction is retired on this main baseline. The
four actual default/Markdown binding cases now exercise the internal Host
assembly in `tests/runtime-binding-catalog.test.ts`. The four built SDK cases
exercise independent shared Hosts, default/profile instructions, real HTTP
Providers, bounded catalogs and actual Skill loads. Both real-read-denial MCP
cases use a Host-loaded extension hook through the daemon; they retain the
denial while restoring evidence. No public owner API is restored for tests.

The shared-Host catalog cases first failed explicit preparation with `unknown`
despite successful model loading. An independent two-Host / shared-project
regression reproduced the mismatch before the fix. Explicit preparation and
queued references now use the Host's config home without global Registry reuse;
the source regression and related invocation/profile files passed 33/33.

The initial integration build exceeded the current audited CLI budget. Measured
CLI size is 5,263,514 bytes, 4,183 above main's 5,259,331; the budget changes from
5 MiB + 17 KiB to 5 MiB + 21 KiB (5,264,384 bytes), retaining all dependency and
cold-entry fences. No dependency or runtime configuration was added. Complete
build and source/test typechecks pass. The final frozen acceptance follows.

The first complete integration run recorded 18,114 passes, one failure, 98 skips
and 19 TODOs in 2,090.08 seconds. `tests/sdk-skill-failure.test.ts` still injected
its private preparer source through a process-global Registry. Its originating
contract (`ed539e33`, FEATURE_298 and the embedder guide's local-Skill failure
section) requires independently trusted preparation/execution sources, not Host
inheritance of that singleton. The fixture now installs the private source under
the preparer Host's own `main/.kodax/skills`. All IPC, zero-Provider-before-trust,
authorization, path-redaction and upstream-error classification assertions remain.
The complete exact-case repeat passed 1/1 before another full gate was started.
No production code changed for this fixture correction.

The first before/after identity also differed at two existing snapshot files:
`byte-identity-lock.test.ts.snap` and `transcript-render-golden.test.ts.snap`.
Both differences were proved to be CRLF-to-LF only by matching the original
hash after reversing that normalization; Git's normalized diff was empty.
Production/build entries were unchanged. Their observed LF working bytes are
retained for the next frozen baseline; no snapshot content change is committed.

Final Windows / Node 22.23.1 source acceptance after rebuilding and typechecking:
the complete default suite passed 1,298 files and 18,115 tests, with zero failures,
98 existing skips and 19 TODOs, in 1,910.21 seconds. Invocation:
`node node_modules/vitest/vitest.mjs run --retry=0 --maxWorkers=2` with verbose
and JSON reporters. Both the custom-home regression and the migrated IPC failure
test passed in this complete invocation. All 6,946 non-Markdown source/test/build
entries retained the same identity before and after:
`08fa164c74101f5e1c31754913fd548441f27082958df6ac20954bb73e000049`.

The focused recovery/invocation coverage run passed 30 tests across three files:
96.05% line, 79.09% branch, 94.56% statement and 88.46% function coverage across
two measured modules. This is scoped coverage, not a whole-repository measurement.
Logs and manifests use `%TEMP%/kodax-mcp-skill-main-final2-*`; coverage uses
`%TEMP%/kodax-mcp-skill-main-coverage*`. No lint script is defined.

### Standards review

Zero unresolved written-standard violations or actionable baseline smells in
the merge diff. The fixture's setup cleanup suggestion was corrected before
the final rebuild and gate. Dependency and cold-entry checks remain enabled.

### Spec review

Zero unresolved findings against Skill/MCP acceptance and current shared-Host,
profile, tool-visibility and authorization contracts. The late private-source
fixture migration was independently checked against its originating requirement.

Standards: 0 unresolved; Spec: 0 unresolved. Built/packed acceptance follows.

On that same unchanged build, the complete serial built-SDK suite passed 64/64
in 232.64 seconds, historical/packed Host cutover passed 3/3 in 29.80 seconds,
and real alpha.11 in-place Host upgrade passed 1/1 in 17.89 seconds. The first
upgrade invocation lacked its required `KODAX_ALPHA11_TARBALL` and stopped at
the fixture precondition before starting a historical Host. The exact public
`0.7.97-alpha.11` archive was then provisioned outside the repository with
`npm pack --ignore-scripts`, checked against the test's pinned SHA-512, and
the unchanged test passed. Upgrade evidence is retained under
`%TEMP%/kodax-historical-host-upgrade-aFIMoL/evidence.json`.

The complete 6,946-file identity above remained unchanged after all built/packed
gates too. The full source log contains zero unverified-managed-child cleanup
warnings. Acceptance is Windows/Node 22 offline verification; it does not claim
native Linux/macOS, Node 20, live-model selection quality, package publication
or deployed-client acceptance.
