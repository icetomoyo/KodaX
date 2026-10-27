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
