# Issues 363 to 366 regression and audit guide

Date: 2026-10-10. Source baseline: `21969792`, `v0.7.97-alpha.3`.
The fixes are in the working tree and have not been published.

The mouse-selection report exposed a missing clipboard-stream error listener.
Further investigation confirmed an MCP send-error defect, a Provider-fallback
budget regression, and an unreliable Host admission-fence test fixture. These
repairs use existing copy, transport, child-execution, and Workflow boundaries.

## Root causes and design fit

| Issue | Confirmed cause | Repair boundary and regression constraint |
|---|---|---|
| 363 clipboard | ChildProcess and stdin are separate error emitters; the helper Promise only observed the former. Selection-finalized copy therefore escaped the existing failure handler. | The common clipboard helper owns both errors. Native/tmux/OSC52 fallback and the UI warning remain the recovery path; no global exception suppression. |
| 364 MCP | send resolved before local write completion. The original stdin listener absorbed errors; additionally, required initialized notification failures were swallowed and handshake falsely reported ready. | The Host-owned transport rejects failed writes and required handshake sends propagate failure. Optional cancellation/response sends record best-effort diagnostics. No tool replay or new retry mechanism. |
| 365 child budget | A later Provider result replaced earlier execution costs. The first repair used a UI iteration event, which is absent on max_tokens continuations before a later throw. Request usage without totalTokens could also produce NaN. | Reuse actual normalized Provider request facts, with per-chain/attempt/requestId accounting and the existing Host observer. Keep complete output components separate from conservative totals and context occupancy. No change to Main policy ownership or the admission-only budget contract. |
| 366 fixtures | A default one-second poll treated cold Actor preparation as an execution failure. | Wait for actual Provider entry, with early terminal detection and a clearable local deadline. Keep business assertions and production timeouts. |

Pipe closure is an expected I/O condition when an external helper exits or
closes input; it is not evidence of a new architecture defect by itself.
The MCP evidence is controlled fault injection, not another customer crash.
`send` completion means local write completion, not proof that a remote tool
executed. Existing process-close/request-timeout handling still applies.

The repaired accounting follows `SPACE_SDK_SEAMS.md`: Main supplies captured
Workflow ceilings, Host owns execution facts, total is input+output, missing
usage stays unknown, and exhausted budgets reject subsequent admissions rather
than pretending to precisely truncate an in-flight response. MCP executable
connections remain in the Host as required by `CLIENT_CONTRACT.md`.

## Automated reproduction and acceptance

Run from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run packages/repl/src/common/clipboard.test.ts packages/repl/src/commands/copy-command.test.ts
node node_modules/vitest/vitest.mjs run packages/agent/src/capabilities/mcp/transport.write-error.test.ts packages/agent/src/capabilities/mcp/transport.test.ts packages/agent/src/capabilities/mcp/runtime.test.ts
node node_modules/vitest/vitest.mjs run packages/llm/src/provider-request-observation.test.ts packages/llm/src/provider-credential-context.test.ts packages/coding/src/child-fallback.test.ts packages/coding/src/child-executor.test.ts packages/coding/src/workflows/agent-adapter.test.ts src/sdk-client.workflow-policy.test.ts src/sdk-client.exit.test.ts src/sdk-client.statistics.test.ts src/execution-facts.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.check.json
node node_modules/typescript/bin/tsc -p tsconfig.test.json
```

| Boundary | Acceptance |
|---|---|
| Clipboard | Pipe errors during write and end never escape as unhandled events; copying falls back or reports unavailable copying. |
| MCP stdio | A failing Writable rejects the awaited send and reports the transport error. Failure of the required initialized notification rejects public Runtime refresh and cannot publish ready. NDJSON, Content-Length, close, and reconnect behavior remain valid. |
| Returned fallback | Primary output 20 plus fallback output 1 is charged before the next child; budget 10 admits one child. |
| Unknown fallback | Missing usage never becomes known zero; preceding charges survive and conservative totals govern new admissions. |
| Throwing fallback | Previously returned charges survive both read and write child catch paths; exception identity remains unchanged. |
| Charged throwing fallback | Primary output 20 plus fallback output 50 exhausts budget 40 even when fallback subsequently throws context overflow. |
| Truncated throwing fallback | The same output 70 exhausts budget 40 when the fallback response is text/max_tokens and its continuation throws before an iteration-end event. |
| Request observation | Normalize known input/output into total, reject invalid main usage as unknown, preserve optional zero/missing fields, deduplicate request IDs, isolate parallel and nested routes, and preserve the Host observer and explicit replacement semantics. UI iteration events are not an accounting source. |
| Host readiness | Wait for actual Provider entry; early terminal results and a clearable local deadline allow fixture cleanup. Existing fence, partial-coverage, and sandbox assertions remain. |

The defect tests were observed failing before their corresponding repairs.
No real Provider request or paid model evaluation was used.

## Wider regression scan

The investigation inspected input-pipe writers, stream shutdown, MCP/LSP/ACP
boundaries, daemon transport errors, sandbox helpers, file-mutation queues,
Workflow lifetime/concurrency reservations, child cleanup, usage accounting,
and the latest alpha.2-to-alpha.3 authorization and budget changes.

The full Windows Node 22 fast/unit/contract/system tiers were run. The first
fast pass exposed Issue 366; the other tiers passed. Changes after those broad
runs receive affected-file validation, including the public Product SDK cases.

| Check | Passed | Failed | Additional status |
|---|---:|---:|---|
| Final full fast tier | 2267 | 0 | 32 skipped; final fixed source snapshot |
| Broad unit tier | 12072 | 0 | 3 skipped |
| Broad contract tier | 960 | 0 | 21 todo |
| Broad system tier | 1350 | 0 | 42 skipped |
| Root-cause affected-file gate | 360 | 0 | 13 files; before the last usage-normalization and statistics-fixture refinement |
| Final accounting/ownership gate | 88 | 0 | 8 files; includes final SDK budget, statistics, credential, and capacity checks |
| Final Node 20 critical gate | 48 | 0 | 5 files; clipboard, MCP handshake/write, request observation, fallback |
| Rebuilt bundle gate | 41 | 0 | No skipped tests |

The broad unit/contract/system runs preceded the root-cause revalidation.
The 360-test gate covers that revalidation; the 88-test gate follows the final
normalization and statistics-fixture changes. The final fast rerun uses a
fixed source snapshot. An earlier concurrent fast run overlapped the new
regression tests and their implementation change, so its four expected red
results were followed by a complete rerun. Counts overlap and should not be
treated as unique test-case totals across all gates.

Source and test TypeScript checks, configuration-template consistency,
workspace package builds, CLI/SDK bundle builds, and all SDK declaration
bundles pass. `npm run test:bundle` passes after rebuilding. Native binaries
were not republished.

Final focused V8 coverage includes the complete clipboard, child-fallback, MCP
transport, and LLM request-observation modules: lines 88.73%, statements 87.27%,
functions 90%, branches 77.45%. The six-file coverage gate passes 106 tests.
This is scoped coverage, not a repository-wide coverage measurement;
uncovered branches include existing HTTP transport paths outside these fixes.

This is a targeted source and regression audit. Windows sandbox tests include
mocked native boundaries; their success does not establish every physical
Windows account/ACL state or Linux/macOS sandbox behavior.

## Standards

Independent Standards review found and closed an unbounded fixture-entry wait,
the required MCP notification's swallowed failure, and a request-usage NaN
boundary. The final implementation uses bounded readiness, required-send
propagation, and normalization at the fact source. Repository rules and the
12-item smell baseline were checked; this review itself was read-only.

## Spec

Independent Spec review reproduced the cross-Provider budget regression,
then returned-attempt/raw-throw, charged-final-throw, and truncated-continuation
boundaries through the real Product SDK. It also reproduced the falsely-ready
MCP Runtime handshake. These cases now have permanent regressions. Normal
return and request facts do not double count; failure charges remain per route,
and Host observers, ordinary UI callbacks, and exception identity are retained.
Final review reports zero residual actionable findings.

Review summary: Standards 0 residual findings; Spec 0 residual findings.

## Performance observations

The existing end-to-end renderer benchmark was run through a temporary output
redirect, preserving its source, fixtures, 120 by 40 viewport, and 30 ticks
per scenario. Each Node version covers five history sizes (50 to 800 items)
in main-screen and windowed modes. Reports remain in the OS temporary audit
directory. The system suite was still active, so these are descriptive local
measurements, not controlled before/after release-performance claims.

| Runtime | 150000 UTF-16 units, worst of five warm splits | Maximum scenario wall-time p95 | Maximum renderer-time p95 |
|---|---:|---:|---:|
| Node 20.20.2 | 89.9 ms | 43.3 ms | 4.2 ms |
| Node 22.23.1 | 37.7 ms | 41.8 ms | 3.4 ms |

The long-line fixture retains all 120000 graphemes and matches native
segmentation across combining, ZWJ, and regional-indicator boundary cases.
The earlier Issue 358 seconds-long segmentation symptom was not reproduced.
No rendering algorithm or cache policy was changed by these repairs.

## Linux tmux acceptance

Use a Linux build containing this patch. Confirm the build provenance before
starting a separate tmux session; a version string alone does not identify an
unreleased working-tree fix.

1. Start KodaX inside tmux and produce selectable transcript content.
2. Triple-click a line, then drag-select text and release. Repeat with long
   text, Chinese, emoji, and multiple lines.
3. Verify selection survives, KodaX remains responsive, and copied content is
   intact through the available native/tmux/terminal clipboard path.
4. Repeat on a headless/remote terminal without a working native clipboard.
   An unavailable copy path must produce a warning while the session remains
   usable. Preserve sanitized diagnostics if copying itself is unavailable.

Physical Linux/tmux mouse delivery was not available on this Windows host.
The original crash mechanism is covered by deterministic stream errors and
an early-exiting real subprocess, including Windows's equivalent EOF failure.

## Remaining known limitations

The release-readiness check on 2026-10-10 verified that ordinary alpha.3 CI
passes, while its [Release workflow](https://github.com/icetomoyo/KodaX/actions/runs/38049525862)
fails the Linux ARM64 bundled startup-review HTTP wait (Issue 362). Universal
npm-package construction and GitHub Release publication are skipped. This
workflow tests the committed alpha.3 baseline, not these uncommitted repairs.

- Issue 256 remains open: Windows cannot always prove descendant closure
  after an intermediate parent exits. Cleanup continues to report `unknown`
  and retain recovery evidence; this audit does not waive that boundary.
- Issue 362 remains ready: the Linux Node 22 bundled scoped-startup review
  cancellation gate still needs its original HTTP-entry failure diagnosed.
  Windows validation does not resolve that Linux-specific observation.
- Native platform acceptance and real Provider behavior remain separate from
  these deterministic checks. No version bump, publishing, or remote write is
  part of this repair.

## SDK integration for this repair

The Product `/client` interface, RPC payloads and capability versions are
unchanged by this patch. Existing Product Client callers need no new required
arguments. Lower-level SDK changes are additive: optional
`KodaXResult.totalTokensUsed` and `runWithAdditionalProviderRequestObserver`.
The declaration and bundle builds include both. Component usage may be
undefined when incomplete; consumers must not turn missing output usage into
known zero. Context occupancy is not accumulated execution cost.

Publish/repackage the SDK and Host from the same repaired source and replace
the running old Host when upgrading. A client-only update does not repair an
old Host. Consumers using source workspace packages must include the updated
LLM exports together with Coding. Space consumers still on alpha.2 also need
the already documented alpha.3 Workflow integration when using Main-supplied
Workflow ceilings; this repair introduces no further Client contract change.
