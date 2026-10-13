# FEATURE_301 — Managed Artifact SDK / PPT

Scope: independent optional package; existing PPTX authoring/limited edits, native PDF, PNG/JPEG/WebP/SVG, candidate DOCX, local HTML loaded viewport and SMIL samples; public preparation and checked binary evidence reading through Node or the same shared Host. Four visual kinds remain. Native Office fidelity and absent owner/decoder backends remain unverified. See [actual SDK support and migration](../ARTIFACT_SDK.md).

## Enable the optional adapter

Build the matching checkout with `npm run build`. Install/pack `@kodax-ai/artifacts` separately; it is not part of the core CLI bundle. Add a trusted extension in the configured KodaX extensions directory:

```js
import { registerArtifactTools } from '@kodax-ai/artifacts/kodax';
import { executeManagedProcess } from '@kodax-ai/kodax/coding';
export default api => registerArtifactTools(api, {
  execute: executeManagedProcess,
  nodeExecutable: process.execPath, // Node-based host; native CLI hosts supply an absolute Node runtime path
  // browserExecutable / libreOfficeExecutable: optional trusted host paths
});
```

Node >=20.16 is required; exact PNG reading/render does not require Chromium. `artifact_prepare` prepares the pinned Chromium through ordinary managed admission. A supplied browser path must identify the prepared runtime. LibreOffice is optional for PPTX conversion, explicitly selected, uses a separate profile and PDF.js pixels. It does not verify animation. `ready` never means visual approval.

## Repeatable checks

- `npm run typecheck`; `npm run build`; `npm test`; `npm run test:bundle`; `npm run test:native`.
- Set `KODAX_ARTIFACT_TEST_BROWSER` to a compatible absolute Chromium path; `npx vitest run packages/artifacts/src packages/coding/src/extensions/managed-process.test.ts`.
- `node --test tests/bundled-artifacts.test.mjs tests/packed-artifacts.test.mjs`: manifest tampering rejected; actual Host tool Runs and scripted AMA receive current images; a separately spawned Host serves Product Client evidence through the shared attachment seam; independent installation and Node-free root type checks. No external model calls.
- Opt-in paid smoke: `KODAX_ARTIFACT_E2E=1 node tests/artifact-review-smoke.eval.mjs`. Read EVAL_GUIDELINES first. Fixed subscription route `kimi-code/k3-256k`, two cases, one provider request in flight. Physical calls, rounds, tools, tokens, reservation cost and timeout are bounded; raw protocol requests exclude transport headers/credentials and stay in OS temp.

Exercise literal Windows argv (Chinese/spaces/quotes/metacharacters), sandbox admission/host denial, cancellation, overlapping bindings, stale source, protected paths, exclusive outputs, malformed/falsely sized ZIP, duplicate shape IDs, table preservation, grouped coordinates, missing fonts/images, inherited unknown objects, 3D charts, animation and missing capture adapters. Review images after every repair; verify required source/hash/page/region/state/viewport/camera/order/frame/time scope. Samples cannot attest continuous playback.

## Evidence (2026-10-12)

- Full suites: 16,557 first pass, 16,559 after AMA correction; final invocation-signal refinement passed all 155 affected tests, final Artifact package 37 passed. No lint script is configured; strict typecheck and whitespace checks passed.
- Bundle: 42 passed; native suites passed, including ASRT 89. Source/tests typecheck and full build passed. Final optional-package and fixed-process Node line coverage 82.98% (statements 73.27%, branches 79.59%); browser callbacks execute in Chromium rather than Node coverage. Worker bootstrap is checked in the built subprocess smoke, excluded from this scoped coverage report.
- Packed SDK: 82,828-byte tarball installed outside the monorepo without KodaX; actual PPTX creation and Chromium render succeeded. Dependency/browser downloads are additional to package size.
- E2E revision 1: missing AMA extension scope, no visual success; preserved at `%TEMP%/kodax-artifact-e2e-g556qN`. Fixed by reusing checked dispatch and the same Run state; deterministic regression passed before rerun.
- Revision 2: `%TEMP%/kodax-artifact-e2e-UxUa2v` holds experiment/raw/assessment and actual PPTX/PNG files. Positive used 6 calls; negative 3; total including failed revision 23, maximum in-flight 1. Main-session pixel review agrees with the agent: dark rectangle hid the title, geometry repair exposed it and preserved the table. Pixel-only nonce `55635D` was read correctly.
- Before source `615da4fa…ffcb8`, PNG `f4802bfa…cf4d`; repaired source `aa76ceca…b0288`, PNG `20e89975…bbb4`. Both PNG hashes match actual provider wire bytes (requests 18–20). Negative tools returned missing-browser/capture-unavailable and the agent marked layout and 0/1s temporal requirements unverified.
- No PowerPoint/LibreOffice/COM/proprietary Artifact Tool was used in this E2E. Microsoft Office exists on this machine but is outside this route. LibreOffice is absent: fixed conversion invocation is unit-tested, PDF.js pixels use a controlled converted-PDF fixture; live LibreOffice fidelity and other operating systems remain untested.

## Standards

0 open findings. ZIP actual expansion limits, immutable request hash binding and AMA scope/dispatch correction independently rechecked.

## 2026-10-13 contract and format extension

Use `tests/fixtures/artifacts`: `mixed-pages.pdf` has 534×294 and 294×534 pixel pages at 96 DPI; `automatic-pagination.docx` has 100 paragraphs and requires three candidate pages; `explicit-break-table.docx` has explicit breaks, Chinese and a table; both DOCX files omit optional settings. `animated.svg` contains SMIL motion. No Word/WPS comparison is claimed; DOCX evidence stays unverified. The mixed PDF is a geometry/cropping fixture, not a clean-layout reference.

`browser-formats.test.ts` exercises actual SDK output, full PDF page geometry, source-preserving DOCX pagination, HTML viewport/dependency staleness and distinct SMIL frames. `formats/contract/client` tests check corrupt/stale/provenance mismatches, required ready payloads, authority-changing JSON, binary chunk assembly, busy/disconnected/unknown and own-Run cancellation. Host attachment tests cover item membership, hash/type/bounds and the actual daemon schema/transport. Managed process tests retain literal argv, sandbox, denial and cleanup checks; cross-bundle Host binding is now explicit, and an unbound descriptor is never executed as shell text.

Validation on Windows: 50 Artifact tests passed with isolated Chromium 151.0.7922.34; explicit `prepare()` populated an initially empty, separate Playwright cache and observed the executable version. Four built/packed Artifact checks passed, including separate-process Product Client/Host image reads, actual PPT pixels, installation without KodaX and Node-free root declarations. Strict source/test typecheck, full build, 42 existing bundle checks and native suites passed. No external model calls or native Word/WPS/LibreOffice fidelity comparison were run.

Main-session visual inspection covered both mixed PDF sizes, all three automatic DOCX pages, explicit-break/table DOCX pages and distinct SMIL positions. Scope V8 coverage includes all Artifact source files: lines 83.80% (704/840), statements 75.57%, branches 77.60%, functions 71.71%. Chromium callbacks and spawned worker execution are exercised separately and do not contribute to the host's V8 counters; no all-metric coverage claim is made. Core startup does not import/probe the optional renderers; this work does not claim a new startup latency improvement.

The existing ACP tests' 1s run-registration polling ceiling failed under filesystem load (a temporary probe observed 1256ms and 776ms). Its test-only polling limit is 5s; permission assertions, the 250ms settlement check and the outer 30s timeout remain. The full 19-case ACP file passed afterward. Standards and Spec reviews closed with no open findings.

Final frozen-source full suite: 1,165 files passed, one skipped; 16,589 tests passed, 77 skipped and 19 existing TODOs, zero failures (801.88s, four workers, isolated browser). The final run includes the capability declaration, SDK PPT loop, attachment transport, managed execution and ACP fixes. Earlier attempts exposed a removed shared browser cache and a cached in-flight RED capability test; those runs are not counted as successful final validation. No lint script is configured; strict typecheck and `git diff --check` pass.

### Natural-task model smoke

`KODAX_ARTIFACT_E2E=1 node tests/artifact-auto-review-smoke.eval.mjs` is a separate opt-in Layer 3.5 check with ZAI GLM-5.3-Flash and DeepSeek Flash. It asks only for an ordinary PPT title edit, without slash/review/tool hints, through one shared Host and two Sessions. Provider requests retain actual image hashes. Shell/child restrictions and fixed call/token/time bounds are part of the fixture. No general success percentage is inferred.

2026-10-13 observations prove autonomous rendering/image delivery, and each model produced a grounded occlusion finding in a shared-Host revision. **Full repair/re-review/delivery has not passed**: preserve the registry-interference diagnostic run, output-budget calibration, final call cutoff and provider timeout rather than claiming green E2E. See [actual evidence, default adapter gap and schema mismatch](../research/automatic-visual-review-e2e-2026-10-13.md). The earlier Kimi smoke explicitly requested visual review and cannot prove automatic task-triggering.

## Spec

0 open findings after closure of locator completeness, unique IDs, rich-text preservation limits, inherited resources/3D diagnostics, font readiness and grouped coordinate ambiguity. No scope creep or new Session owner.
