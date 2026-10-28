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
