# FEATURE_301 — Managed Artifact SDK / PPT

Scope: independent optional package; common static PPTX create/import/inspect, single-run text or ungrouped geometry edits to new files, lightweight render and actual image delivery. Contracts cover static, paginated, interactive and temporal evidence. Other capture adapters return unverified. No verifier runtime/config/notifications are added.

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

Node >=20.16 and Chromium are required. `artifact_prepare` installs the pinned Chromium through ordinary managed admission. A supplied browser path must identify the prepared runtime. LibreOffice is optional, explicitly selected, uses a separate profile and PDF.js pixels. It does not verify animation. `ready` never means visual approval.

## Repeatable checks

- `npm run typecheck`; `npm run build`; `npm test`; `npm run test:bundle`; `npm run test:native`.
- Set `KODAX_ARTIFACT_TEST_BROWSER` to a compatible absolute Chromium path; `npx vitest run packages/artifacts/src packages/coding/src/extensions/managed-process.test.ts`.
- `node --test tests/bundled-artifacts.test.mjs`: manifest tampering rejected; actual Host tool Runs and scripted AMA receive real current raster images with zero external model calls.
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

## Spec

0 open findings after closure of locator completeness, unique IDs, rich-text preservation limits, inherited resources/3D diagnostics, font readiness and grouped coordinate ambiguity. No scope creep or new Session owner.
