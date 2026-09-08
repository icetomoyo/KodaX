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

## Dependency delivery

The build/pack CLI resolves real paths when identifying its entry point, so linked workspaces and macOS temporary-directory aliases execute the same patch and validation checks.

The ASRT fix is now applied during SDK bundle/standalone-binary builds and
before npm packing by `scripts/prepare-asrt-wfp.mjs`. The build accepts only
ASRT 0.0.65 with the audited original or patched SHA-256 (after newline
normalization). It applies the one-file patch in a temporary directory,
verifies its result, and atomically replaces the installed source file so
package-manager cache hardlinks are not edited in place. Other bytes and
native binaries retain their original release version and checksums.

`bundleDependencies` includes this patched ASRT and its existing transitive
dependencies in the SDK tarball. SDK imports and public exports stay unchanged.
Consumers require no patch command or install hook: installation with
`--ignore-scripts` still receives the fixed dependency. Git is needed to apply
the patch at build/pack time, not to install or run the SDK. No runtime module
interception, global socket override, setup migration, or waiting for another
command is introduced.

`tests/asrt-wfp-probe.test.mjs` resolves ASRT through the SDK installed in its
working directory. It runs both against the build and against the npm tarball
installed with scripts disabled, including in the packaged Electron and
release installed-native gates. Network/native interception belongs only to
the test process. The real Windows concurrency and Electron gates still run
without those test doubles.

The public `target` option of `verifyWindowsWfpEgress` is not exposed by
`SandboxManager.initialize`; shipping the patched module fixes that internal
call too. The original upstream implementation remains unchanged on npm;
KodaX carries this version-scoped patch until an audited upstream fix replaces
it. An ASRT upgrade or unexpected source change fails the build instead of
silently dropping the fix.
