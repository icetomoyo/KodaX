# Windows WFP probe port allocation

The Windows CI failure on commit `497ee854` came from two copies of the same
allocation strategy: KodaX `bindWindowsWfpProbe` and ASRT 0.0.65
`verifyWindowsWfpEgress`. Both requested port 0, closed listeners inside the
WFP permit range `[60080,60143]`, and gave up after five allocations. Windows
can return in-range ports repeatedly; these retries do not establish that no
out-of-range listener is available.

## SDK change

KodaX doctor now binds a randomly selected unprivileged port below the existing
proxy range. It tries at most five distinct candidates, retries only
`EADDRINUSE` and `EACCES`, and retains the successful listener until native WFP
verification finishes. Each invocation owns its listeners; there is no new
lock, sleep, queue, setup migration, command replay, or change to Bash/network
broker reuse and lifecycle. The permit range and verification result handling
remain unchanged.

`src/sandbox-runtime.test.ts`, suite `Windows WFP probe allocation`, covers
repeated in-range ephemeral allocation, occupied/reserved candidates, bounded
exhaustion, immediate resource failures, and listener lifetime on blocked,
connected, timeout, and runner access-denied outcomes. The existing Windows
native policy concurrency gate additionally exercises background Bash,
independent Runtime processes, trusted text writes, and proxy port pressure.

## Dependency boundary — still pending

`asrt-0.0.65-wfp-probe.patch` is a proposed patch against the pinned published
package's `dist/sandbox/windows-sandbox-utils.js`. It is **not applied by the
SDK build or installation**. It must be integrated into an audited dependency
release before ASRT initialization receives this fix. The public `target`
option of `verifyWindowsWfpEgress` is not exposed by `SandboxManager.initialize`;
changing only the KodaX doctor cannot replace this internal allocation.

The proposal preserves custom proxy ranges by selecting their larger
unprivileged complement, keeps candidates distinct, and retains existing
native verification. It was applied to an isolated copy of ASRT 0.0.65; a
function-level harness reproduced the old five-attempt failure and covered
nine patched success/failure cases with simulated allocation and native
verification. This does not constitute a real WFP integration test of a
published patched dependency.

Do not close the dependency issue based on a green CI rerun. An unchanged
rerun of `497ee854` passed all seven jobs, demonstrating intermittency rather
than removal of the underlying ASRT allocation defect.
