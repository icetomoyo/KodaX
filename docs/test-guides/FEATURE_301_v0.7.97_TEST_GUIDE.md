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

Supported file rendering uses headless Chromium: a terminal-only Host needs no desktop or browser window to produce PNG evidence for an image-capable provider. No manual browser path is required; the runtime uses its default Playwright Chromium unless a trusted override is supplied. Prepare missing runtime dependencies explicitly before rendering.

## Repeatable checks

- `npm run typecheck`; `npm run build`; `npm test`; `npm run test:bundle`; `npm run test:native`.
- After building, explicitly prepare the default Chromium for local acceptance with the existing SDK operation (may download the runtime and write its cache; a product Host uses admitted `artifact_prepare`):

  ```sh
  node --input-type=module -e 'import {executeArtifactRequest} from "./packages/artifacts/dist/runtime.js"; const result = await executeArtifactRequest({operation:"prepare",input:{}},{workspaceRoot:process.cwd()}); if(result.status!=="ready") throw new Error(JSON.stringify(result));'
  ```

  This command also works in PowerShell. An optional `KODAX_ARTIFACT_TEST_BROWSER` supplies an already-prepared absolute Chromium path to the tests; it does not enable production visual review. Set it in PowerShell with `$env:KODAX_ARTIFACT_TEST_BROWSER = 'C:\path\to\chrome.exe'`, or in Bash with `export KODAX_ARTIFACT_TEST_BROWSER='/absolute/path/to/chrome'`. An explicitly supplied path remains the trusted host's responsibility.
- `node --test tests/bundled-artifacts.test.mjs tests/packed-artifacts.test.mjs`: manifest tampering rejected; actual Host tool Runs and scripted AMA receive current images; a separately spawned Host serves Product Client evidence through the shared attachment seam; independent installation and Node-free root type checks. PPT render/hash and AMA image assertions always run, including when the test browser variable is unset and the production default runtime is used. A missing or unusable runtime fails this full acceptance; it is never counted as a visual pass. No external model calls or implicit browser installation.
- For the source tests, set `KODAX_ARTIFACT_TEST_BROWSER` to the prepared Chromium path, then run `npx vitest run packages/artifacts/src packages/coding/src/extensions/managed-process.test.ts`. Their browser-dependent cases still explicitly skip without that test variable; those skips do not establish full visual acceptance.
- Opt-in paid smoke, Bash: `KODAX_ARTIFACT_E2E=1 node tests/artifact-review-smoke.eval.mjs`; PowerShell: `$env:KODAX_ARTIFACT_E2E = '1'; node tests/artifact-review-smoke.eval.mjs`. Read EVAL_GUIDELINES first. Fixed subscription route `kimi-code/k3-256k`, two cases, one provider request in flight. Physical calls, rounds, tools, tokens, reservation cost and timeout are bounded; raw protocol requests exclude transport headers/credentials and stay in OS temp. In PowerShell, remove the opt-in afterward with `Remove-Item Env:KODAX_ARTIFACT_E2E`.

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

`KODAX_ARTIFACT_E2E=1 node tests/artifact-auto-review-smoke.eval.mjs` (Bash), or `$env:KODAX_ARTIFACT_E2E = '1'; node tests/artifact-auto-review-smoke.eval.mjs` (PowerShell), is a separate opt-in Layer 3.5 check with ZAI GLM-5.3-Flash and DeepSeek Flash. Remove the PowerShell opt-in afterward with `Remove-Item Env:KODAX_ARTIFACT_E2E`. It asks only for an ordinary PPT title edit, without slash/review/tool hints, through one shared Host and two Sessions. Provider requests retain actual image hashes. Shell/child restrictions and fixed call/token/time bounds are part of the fixture. No general success percentage is inferred.

2026-10-13 observations prove autonomous rendering/image delivery, and each model produced a grounded occlusion finding in a shared-Host revision. **Full repair/re-review/delivery has not passed**: preserve the registry-interference diagnostic run, output-budget calibration, final call cutoff and provider timeout rather than claiming green E2E. See [actual evidence, default adapter gap and schema mismatch](FEATURE_301_v0.7.97_TEST_GUIDE.md#natural-task-observations-2026-10-13). The earlier Kimi smoke explicitly requested visual review and cannot prove automatic task-triggering.

### Natural-task observations (2026-10-13)

Historical baseline: `27d08788`, Windows, AMA/full-access, one isolated shared
Host with two Sessions, explicit Artifact registration and separate headless
Chromium cache. Real routes were `zai-coding/glm-5.3-flash` and
`deepseek/deepseek-flash`, at most one request in flight per provider, with no
third judge or child/workflow. Production tool descriptions/prompts were used.
The input only requested renaming the PPT title to “Quarterly revenue review”,
saving `final.pptx` and retaining the revenue table/other content; it contained
no slash, review, skill or tool hint. A dark overlaid rectangle hid the title.

| Model | Autonomous rendering / PNG delivered to provider | Grounded occlusion finding | Full repair/re-review/delivery |
| --- | --- | --- | --- |
| GLM-5.3-Flash | Observed; actual PNG SHA-256 matched request image bytes | Observed in revision 2 | Unproven; final verification hit provider termination/timeout and test cutoff |
| DeepSeek Flash | Observed; actual PNG SHA-256 matched request image bytes | Observed in revisions 2 and 3 | Unproven; final verification reached the ten-request cell limit |

Both models loaded `artifact-review` without being asked. GLM compared original
and edited pixels; DeepSeek also rendered a probe to investigate text/layer
ordering. Main-session pixel inspection agreed with the occlusion findings.
These observations establish possible automatic triggering, not a reliability
percentage, every-format coverage or completed final acceptance.

| Revision / directory under `%TEMP%` | Actual generation requests | Diagnostic result |
| --- | ---: | --- |
| 1 / `kodax-artifact-auto-e2e-1cu2up` | 14 | Two in-process Runtimes interfered through extension registration; closing one invalidated the other's scope. Event callbacks did not enforce the intended AMA fixture restriction. Keep observed image delivery; do not attribute scope failure to model review ability. |
| 2 / `kodax-artifact-auto-e2e-juzwDb` | 11 | One Host and trusted `tool:before` fixture checks removed the scope error. Both models found the defect. The normal 2,048→64,000 output-budget upgrade met the fixture's 32,768 wire cap. |
| 3 / `kodax-artifact-auto-e2e-apjfWR` | 16 | Initial budget 8,192 allowed the existing 64,000 upgrade. DeepSeek reached the request cap; GLM had three normal responses before termination/request timeout and the 300-second cutoff. |

Total: 41 actual generation requests including diagnostic failures. Per-cell
limits were ten requests, 50 tool events and 300 seconds. Each `experiment.json`
froze limits and accumulated prior rounds; the final conservative token/spend
reservation was 6,171,182 / USD 26.142904, not actual usage or billing. Raw request
bodies without auth headers, responses, tool events, source/PPT/PNG and
`main-session-review.json` retain image hashes, decisions, attribution and limits
in those temporary directories; generated outputs are not repository fixtures.

Unmanaged shell was intentionally prohibited in revisions 2/3, so this did not
cover ordinary CLI script/OOXML/layer-order repair alternatives. No further
samples were added to chase a green result. The engineering recommendation was
`recommend-iterate`. Keep the [local adapter inspection and tool schema gaps](../ARTIFACT_SDK.md#integration-gaps-recorded-on-2026-10-13)
separate from model behavior and the user's independently reported Space behavior.
This is migrated historical evidence, not a new paid run.

## Spec

0 open findings after closure of locator completeness, unique IDs, rich-text preservation limits, inherited resources/3D diagnostics, font readiness and grouped coordinate ambiguity. No scope creep or new Session owner.
