# Issue 337: Windows startup handoff on the KodaX main branch

## Integration decision — 2026-09-21

After reviewing the results below, the owner explicitly requested landing this
existing fix on `KodaX`, then merging `KodaX` into `codex/product-client-refactor`.
The final development-branch-to-main fast-forward remains the owner's later
release action. This instruction changes the earlier hold disposition; it does
not turn the recorded 15,845 passes, nine failures and two unhandled errors into
a clean full-suite result. Outstanding CLI/Stop/MCP observations remain tracked.
The production patch is unchanged; only an acceptance-script trailing space was
removed while preparing the commit. Development-specific hosted A2A behavior and
fixture cleanup must survive the synchronization.

## Scope and branch provenance

This backport starts at `KodaX` commit `5640cce9` (v0.7.96-rc.8), on
`codex/main-windows-daemon-handoff`. It takes only the runtime ownership fix
from `b7985d6c`, with main-branch tests and publication wiring. It does not
merge `codex/product-client-refactor` or its next-version client changes.
The 30 historical parity-local daemons came from the a72f development worktree.
Those test probes do not exist on main; their fixture repair stays on that branch.

Main independently reproduces a related production startup failure: if the
launcher is forcibly terminated before service publication, its detached Node
wrapper, PowerShell Job owner and daemon survive. A held pre-publication CLI
reproduced this twice; an explicit-cancellation control reclaimed all three.
All experiment-created processes were then reclaimed and verified exited.
The reproduction exited nonzero with `Unpublished candidate survived launcher
exit`. Raw evidence is under `%TEMP%/kodax-main-handoff-20260920/`.

## Main-branch contract

- Before publication, launcher death or cancellation reclaims the exact candidate
  and its contained descendants. It must not rely on the launcher running finally.
- After publication, launcher death, cancellation or health timeout preserves the
  shared daemon and another client's execution. Ordinary client close stays cheap.
- One exclusive-create decision file arbitrates publication against reclamation.
  An abort marker survives until target exit is verified. Errors do not authorize
  killing a possibly published service. Capture and clear the private environment
  variable before extensions can spawn children.
- Main's daemon publishes only its RPC endpoint. Its A2A integration performs
  outbound reconciliation; standalone inbound A2A uses a separate inline Runtime.
  Therefore the commit runs before RPC listen, with no hosted-A2A migration.
- Keep main's control journal, operation envelope, CLI entry selection and existing
  owner lifecycle unchanged. Do not import the development branch's owner-exit or
  client architecture changes.
- Preserve exact natural process-exit verification when IPC closes before Node's
  exit event. A retained termination result must not wait for intentional service
  persistence or claim that a competing candidate was reclaimed.
- No new production process, recurring timer, process scan or warm-attach handshake.
  Existing generic Windows Job callers retain their behavior.

## Verification gates

1. Real-process Windows supervisor tests: launcher loss, cancellation, committed
   service survival, commit/disconnect races, inherited authority, filesystem errors,
   early death, missing PowerShell, natural IPC close and descendant cleanup.
2. Host publication rejection and process retained/competing-owner contracts.
3. Built main-branch CLI/SDK acceptance: ensure and execute; B's live local stream
   completes when A dies or cancels; pre-aborted publication fails. Every shared
   owner is stopped through the SDK with exact daemon/Job shutdown verification.
4. Build, source/test typechecks and runtime/Stop/Shell/execution regressions.
5. Paired performance: same machine, fixed main baseline and candidate builds,
   one pilot pair excluded then ten alternating pairs, three warm attaches each.
   Record cold ensure, warm reuse, client close and verified stop. No concurrent
   load from this task or paid/external model calls. A repeatable regression blocks
   merging; noisy measurements do not prove zero impact.
6. Independent Standards and Spec review. If the backport requires unrelated
   changes or reveals a materially different failure, stop for user confirmation.

```powershell
npm run build
npm run typecheck
node node_modules/vitest/vitest.mjs run src/runtime-daemon/windows-job-supervisor.test.ts src/runtime-daemon/startup-handoff.test.ts src/runtime-daemon/host.test.ts src/runtime-daemon/process.test.ts src/runtime-daemon/process.cleanup.test.ts --maxWorkers 2
node tests/windows-daemon-handoff.mjs
```

## Results and performance checkpoint (2026-09-20)

The main baseline and candidate both built successfully. Candidate source/test
typechecks passed. Five focused files passed all 76 tests, including the original
tests and the new lifecycle regressions. The independent pre-publication CLI
reproduction now passes all three cases (explicit cancel and two launcher kills),
with all exact experiment processes confirmed exited.

All four built CLI/SDK acceptance cases passed: normal ensure/execute, launcher
death during B's stream, launcher cancellation during B's stream, and pre-aborted
publication. Shared cases verify the completed output and exact daemon/Job exit.
The script uses main's `connectKodaXRuntime({ autoStart: true })` and revision-
guarded `daemon.stopForInline()`. Initial harness attempts incorrectly assumed
development-only `ensureKodaXRuntime()` / `daemon.shutdown()` APIs; those failures
are retained in the logs and are not counted as product regressions. Explicit
provider/model arguments are required for the held main CLI launcher.

The main/candidate source comparison, normalized for checkout CRLF/LF, contains
only this runtime patch and its tests. Their package source and dependency lock
match. The candidate shares third-party dependency installation with main; both
CLI/SDK bundles were built from their respective source. No a72f build was used.

Performance: one pilot pair excluded, ten alternating formal pairs, three warm
attaches per sample; all 22 samples passed exact shutdown verification.

| Metric | Main baseline | Candidate |
|---|---:|---:|
| Cold median | 2974.44 ms | 3028.97 ms |
| Cold mean | 2976.73 ms | 3055.33 ms |
| Cold range | 2904.32–3085.99 ms | 2961.26–3201.05 ms |
| Warm mean (30 samples) | 4.010 ms | 3.845 ms |
| Client close mean | 0.281 ms | 0.300 ms |
| Verified stop mean | 569.46 ms | 575.94 ms |

Candidate cold startup was slower in 8/10 pairs; median increased 54.53 ms
(1.83%) and mean increased 78.59 ms (2.64%). Patch cost and checkout-path/cache
effects have not been separated. Work paused to report this measurement. The
user then explicitly accepted a difference at the 55 ms scale, distinguishing it
from prior visible delays of seconds or longer. Under that clarified tolerance,
this bounded result is acceptable; it is not proof of zero overhead or of every
startup scenario. Warm attach did not slow down. Proceed with full regression;
stop again for a material execution/shutdown problem or visible second-scale
regression. Do not import next-version features to optimize this small difference.

### Historical checkpoint: unsuitable validation directory

The four-worker, retry-zero default suite was interrupted after 124 passing files
and seven failing files had been reported. It did not complete and is not green.
The patch source and test files were not changed during that run.

- `sdk-runtime.stop-admission.test.ts`: six failures removing temporary roots
  with Windows `EBUSY`. The untouched main branch separately reproduced seven
  failures of the same kind in the same file (five identical cases). These tests
  use embedded/inline Runtime and manually wired sockets, not the new Windows
  daemon handoff. The precise handle-retention cause remains unconfirmed.
- `permission-analyzer.test.ts`: 222 failed expectations; `guardrail.test.ts`:
  five failures. The worktree is below `.codex`, which the unchanged path policy
  treats as protected. The analyzer test creates its ordinary workspace under
  `process.cwd()`, invalidating its expected writable-workspace precondition.
  A representative case passed in the ordinary main checkout with identical
  source. Do not weaken permission policy to accommodate this test location.
- MCP multimodal cancellation: `validateImageBytes` had not been called before
  the test's default one-second `vi.waitFor` expired. The test had not reached
  its abort action. LSP shutdown: 8042 ms exceeded its 8000 ms assertion. Their
  relevant implementation and tests are unchanged from main and do not call the
  handoff path, but resource-contention causality is unproven. Both remain failures.
- One confirmation-identity test also encountered temporary-root `EBUSY`; this
  exact case has not yet been compared against baseline.
- Six Electron fixture tests could not find their textual invocation boundary
  because the fixture searches for LF text in a CRLF checkout.

The test runner exited after interruption. A fresh process snapshot found no
surviving descendant of that runner and no daemon launched from this candidate
worktree. Historical parity-local residue was not cleaned.

The user authorized continuing in a normal repository directory outside `.codex`
and the OS temporary directory, with LF checkout text. All failed logs are retained.
Neither permission policy nor test timeouts were changed to accommodate the run.

### Corrected full-suite validation

An LF validation worktree at `C:/Works/GitProj/KodaX-AI/kodax-main-handoff-validation`
starts at the same main commit and contains the same 14 patch files after newline
normalization. Build, source/test typechecks and all four built acceptance cases
passed again. The directory-sensitive permission, guardrail and Electron files
passed all 1,500 tests in a focused gate and also passed in the full run. LSP passed.

The complete default suite ran with four workers and zero retries in 1,036.15 s:

- Files: 1,030 passed, four failed, one skipped (1,035 total).
- Tests: 15,843 passed, eight failed, 78 skipped, 21 todo (15,950 total).
- Two unhandled errors: the MCP pending rejection and a Vitest worker
  `Timeout calling "onTaskUpdate"` error. The run exited nonzero; it is not green.
- Remaining failures: five Stop temporary-root `EBUSY` failures, one confirmation-
  identity temporary-root `EBUSY`, one worktree drain deadline, and one MCP initial
  validation wait. The 14 patch files have identical hashes before and after this
  run; this is not a claim that all repository files or all processes were frozen.

The unchanged main branch completed the same four-worker, zero-retry default
suite in 1,076.73 s: 1,028 files passed, five failed, one skipped; 15,817 tests
passed, ten failed, 78 skipped, 21 todo. It also reported two unhandled errors.
Both complete runs exited nonzero.

Seven of the candidate's eight failed cases reproduce by exact test name and
failure category on main: MCP initial-validation wait, identity cleanup, and all
five Stop cleanup cases. Main additionally failed another Stop cleanup case,
SDK daemon auto-start, and the worktree valid-branch-name test. These are baseline
observations, not new bugs fixed by this patch.

Both full runs reported the same Vitest `onTaskUpdate` timeout. Its threshold is
60 seconds for worker-to-runner result reporting, not a product execution timeout.
Neither log identifies its originating test or the cause of delayed reporting.
Both runs also reported the MCP pending rejection after initial validation had
already timed out; the full baseline observed `media:initialize` timeout whereas
the candidate observed the media process close. The earlier serial baseline
reproduced the candidate's process-close rejection as well. JSON test counts do
not include these separate unhandled errors; retain the complete text logs.

The candidate-only case is `rejects instead of waiting forever when process-tree
drain remains unknown`: its own five-second deadline won. Main passed that case
in 3,610 ms but failed a different worktree case at its 30-second deadline. These
are not proof of the same cause. This test mocks process launch and Job binding,
but still makes real synchronous Windows process-identity queries. It does not
directly call the changed daemon handoff; indirect load effects remain possible.
The entire 37-case worktree file then ran serially on each branch with one worker,
zero retries and unchanged deadlines. All 37 assertions passed in both runs.
The drain case took 2,637.53 ms on main and 2,634.82 ms on the candidate. Each
serial run still reported one `onTaskUpdate` error and exited 1; passing assertions
must not be presented as a successful run. Thus this reporting problem reproduces
without the patch and without concurrent daemon tests, but its root cause remains
unknown. The candidate-only parallel drain failure was not reproduced serially;
that is not proof it is pre-existing or that its failure probability is unchanged.

### Prior checkpoint: pause before diagnosing the parallel discrepancy

The fix, focused lifecycle tests, built multi-client acceptance, build and
typechecks pass. Performance remains within the owner's accepted measured range.
There is no confirmed new production behavior regression. However, both complete
suites remain non-green and the parallel drain discrepancy is not fully explained.
Under the owner's instruction to stop when validation differs from expectations,
do not merge or expand the production patch. The implementation workflow's
full-green completion gate has not been met. Recommended next work is a separate,
bounded diagnosis of that parallel timeout, keeping the hotfix source unchanged.
An explicit decision is needed before accepting these verification exceptions.

At that checkpoint, main remained clean at `5640cce9`. The 14-file patch remained uncommitted on
`codex/main-windows-daemon-handoff`; the next-version branch remains untouched.
No merge or push was performed. A process snapshot after the candidate full run
found no live Node, PowerShell or conhost created within its execution window;
this does not claim historical residue was cleaned.

### Follow-up: partial process mocking caused an unreliable test deadline

The owner authorized the bounded follow-up while keeping the runtime patch
unchanged. Temporary diagnostic copies outside the repository import the original
main implementation. They time only the process-query boundary and the test gate;
they do not change runtime source or relax an assertion.

The fixture simulates Git with PID 2147483647 and mocks Job binding and tree kill,
but left `registerManagedChildProcess` real. The original drain case therefore
performs four synchronous PowerShell queries: initial snapshot, absent-root retry,
owner identity, and exit-time snapshot. These precede its three 250 ms drain waits
and all count against the same five-second test deadline.

- Four parallel copies without injected delay passed in 2.93–3.13 s.
- Adding 700 ms to each real query, without the daemon patch, reproduced the exact
  `worktree drain remained pending` failure in four of four copies. Query time
  alone consumed 4.84–5.23 s. This is controlled fault injection, not a claim that
  those exact query timings were recorded in the earlier full-suite failure.
- With the same injected-delay setting, mocking only the process-registration
  boundary made all four copies pass in 760–763 ms, retaining the original drain
  sequence, five-second deadline and recovery assertion. No OS query was needed.

A separate whole-file control kept all real queries and recorded an event-loop
pause of 70,994 ms. Its 37 assertions passed, but Vitest's 60-second report RPC
expired. Changing only temporary `afterEach` to yield with `setImmediate` kept
all 37 assertions and real queries, took 144.22 s instead of 145.51 s, and removed
the report error. This isolates event-loop starvation in the simulated-child
fixture: synchronous OS queries chained through already-resolved Promises can
prevent the worker from processing report acknowledgements. No yield or timer
was added to product code or the final fixture.

The permanent test-only correction mocks registration alongside the already
simulated child/Job/kill. Three added checks require no real OS query for simulated
Git, durable registration before `go\n`, and refusal plus exact-child cleanup if
registration throws. The new OS-isolation check failed before the fixture fix.
Afterward all 40 worktree assertions pass in 1.15 s without unhandled errors.
The real agent registration implementation retains its separate 20 tests; the
combined 60-test gate passes, as do source and test typechecks. Independent
Standards and Spec reviews each report zero findings.

This adds only `packages/coding/src/tools/worktree.test.ts` to the hotfix. Its
runtime files are unchanged, so no new startup work is introduced by this follow-up.
The corrected default full suite completed with four workers and zero retries in
1,002.18 s: 1,029 files passed, five failed, one skipped; 15,845 tests passed, nine
failed, 78 skipped, 21 todo. One unhandled MCP rejection remains. All 40 worktree
tests passed in 1.14 s and `onTaskUpdate` did not recur. The 15 patch files were
unchanged throughout this run. Other failures have not been repaired or waived.

Six of the nine failed cases exactly match failures observed on the unchanged
main full run. Three need distinct treatment:

- Stop's `shared=true` successor-protection case failed removing its temporary
  root with `EBUSY`. The same file has baseline cleanup failures, but this exact
  case passed both baseline and candidate in the subsequent serial comparison.
  The precise handle-retention cause remains open.
- `shares Space-style SDK control-plane access across daemon clients` failed
  because its child exited with code 1 before health. Main previously showed the
  same error category in a different daemon auto-start case, which is not proof
  this exact failure is pre-existing. The original fixture deleted its bootstrap
  log. The exact case passed serially on both trees; a worker-only temporary
  collector now preserves bootstrap logs before fixture cleanup, without changing
  daemon behavior. This parallel startup failure remains unexplained.
- A2A's `does not become ready before initial A2A reconciliation completes` failed
  at the `runtimeSettled === false` assertion. Both exact serial trace controls
  passed. A baseline-only control then paused the test worker for 1,200 ms after
  observing `starting`, with production code unchanged. It reproduced the same
  assertion: the daemon became normally ready during the pause and SDK connection
  fulfilled before the assertion. The fixture had already released the Agent Card
  and relied on a fixed one-second ready delay. This demonstrates an existing
  timing vulnerability, not proof of the precise earlier run's settlement cause.
  The fault-injected assertion also bypassed the fixture's SDK close and produced
  a `connected_clients` cleanup error. A fresh check confirmed daemon PID 53908
  absent and no live Node/PowerShell/conhost created in that diagnostic window.

The worktree fixture defect and report starvation have a controlled reproduction
and verified test-only correction. The new parallel SDK startup observation does
not have a confirmed cause. Under the owner's stop-on-unexpected-findings rule,
main stays clean at `5640cce9`; the now 15-file hotfix is uncommitted and unmerged.
Do not treat serial passes as permission to ignore complete-run failures. Further
work should focus on capturing the SDK startup failure under parallel load before
changing runtime behavior or accepting full-suite exceptions.

#### Standards review

Zero findings for the new worktree fixture delta. The mock and three contract
checks are scoped, the functions are short, and cleanup uses the existing hook.
The RED/GREEN execution evidence supplements the static review.

#### Spec review

Zero findings. The fixture no longer queries OS identity for a simulated child;
registration options/order and the failure gate are checked. The original four
unknown drains, five-second deadline and recovery assertion remain unchanged.
The separate real registration tests remain present and passed.

Follow-up artifacts: `prepare-worktree-diagnostic.mjs`, explicitly temporary
`worktree-diagnostic/`, `worktree-probe-parallel.*`, `worktree-probe-delay.*`,
`worktree-probe-isolated.*`, `worktree-probe-loop-control.*`,
`worktree-probe-loop-yield.*`, `worktree-fixture-red.log`,
`worktree-fixture-green.log`, `worktree-registration-gate.log`,
`worktree-fixture-typecheck.log`, and `fixture-full-*`.
Additional comparison artifacts are `baseline-startup-followup*`,
`candidate-startup-followup*`, `preserve-test-bootstrap.mjs`,
`preserved-bootstrap/`, and `a2a-diagnostic/` (normal controls, explicit delayed
baseline control, event timelines, and post-run process check). Diagnostic probes
remain outside the repository; none is part of the production patch.

Raw artifacts: `%TEMP%/kodax-main-handoff-20260920/`, including
`baseline-reproduction.json`, `reproduction.json`, `green-runtime.log`,
`acceptance-main.log`, `typecheck.log`, `provenance.json`, `performance.log` and
the timestamped `formal-*/raw.json` / `summary.json`. The interrupted suite is in
`full-suite.log`; baseline checks are `baseline-stop-admission.log` and
`baseline-permission-path.log`. The corrected complete result is
`neutral-full-results.json` / `neutral-full-suite.log`; its before/after patch
hashes are `neutral-full-start.json` / `neutral-full-end-proof.json`. The ordinary-
directory gates are `neutral-build.log`, `neutral-typecheck.log`,
`neutral-environment-gate.log` and `neutral-acceptance.log`. The same-setting main
baseline is recorded in `baseline-full-suite.log` and `baseline-full-results.json`.
The case-name comparison is `full-failure-comparison.json`. Serial worktree logs
and results are `baseline-worktree-serial.*` / `candidate-worktree-serial.*`, with
timings in `worktree-serial-comparison.json`. The process-window snapshot is
`neutral-post-run-process-window.json`.

Standards review found no production blocker and one unused acceptance-helper
option; that option was removed. Spec review found no missing production contract
or unrelated architecture migration. Performance was accepted under the user's
clarified tolerance. The full regression gate remains open; reviews do not replace it.

### SDK startup diagnostic follow-up (2026-09-20, evening)

The owner authorized further diagnosis of the unexplained SDK startup failure.
No runtime source, deadline, assertion or production configuration changed.
All probes and generated test copies remain in the external artifact directory.

The original Space failure occurred during the first `createKodaXRuntime`, before
the second client connected. The observed exit code belongs to the Windows Job
supervisor chain; it does not distinguish target failure from PowerShell failure.
The original bootstrap log was removed by the fixture, so the previous baseline
auto-start failure and candidate Space failure cannot yet be assigned one cause.

- Four simultaneous copies of the exact Space test passed on the candidate.
- Ten repetitions per worker, four workers, then passed on both unchanged main
  and candidate: **40/40 each**, no retries. Copies retain the original test body
  and cleanup; only import locations, selection and repetition were adapted.
  The first generated-copy configuration failed collection because rewriting the
  bare `vitest` import interfered with mock hoisting (zero tests ran). Keeping
  that import bare and resolving it through an alias corrected the harness;
  `candidate-1.*` retains the invalid trial and `candidate-2.*` the four passes.
- A mixed run retained the SDK's first 32 cases plus Space and ran all 24 CLI
  daemon smoke, 13 Stop admission and 69 Bash cases alongside it. Each version
  ran 139 cases with four workers and zero retries. Both returned 132 passes
  and seven failures, with different failure sets. Baseline had seven Stop
  directory-removal `EBUSY` failures. Candidate had six Stop `EBUSY` failures
  plus a foreground A2A CLI health-readiness timeout. SDK 33/33 and Bash 69/69
  passed on both versions. The candidate-only timeout is not waived.

Temporary preload v1 preserves SDK bootstrap logs before ordinary fixture
removal. V2 additionally preserves the exact Job ready files being removed by
this run's workers/wrappers. V3 observes existing CLI stderr pipes and child
exit events for disposable test homes. It leaves original stdio, timeouts,
cleanup and assertions in place. These probes introduce diagnostic module and
I/O overhead; their runs are not performance benchmarks. Repeated successful
starts do not establish the cause of the earlier failure.

Artifacts: `prepare-sdk-parallel.mjs`, `sdk-parallel/` (generated copies, configs,
repeat results, `mixed-plan.json`, `mixed-comparison.json`),
`preserve-test-bootstrap.mjs`, `preserve-startup-v2.mjs`,
`preserve-startup-v3.mjs`, `preserved-bootstrap/`, `preserved-ready/`,
`preserved-cli/`, and `sdk-diagnostic-source-start.json`.

The capture-enabled complete run finished in 1,015.37 seconds: **15,845 passed,
9 failed, 78 skipped, 21 todo; two unhandled errors**. File totals were 1,031
passed, three failed and one skipped. It used the original full configuration,
four workers and zero retries. Vitest's duration cache had been updated by the
intervening targeted runs, so this was not a replay of the original file schedule.
The SDK file passed **344/344**, including auto-start and Space. The foreground
A2A case that timed out in the mixed candidate run passed here; the retained
stderr contains its expected invalid-configuration diagnostic and an exit code
of zero. These passes do not recover the original startup failure's missing log.

The nine failures were five Stop `EBUSY` cases, the known MCP initial-validation
case, and three CLI cases:

- Arbitrary `KODAX_HOME` startup returned `started: false` where the fixture
  expected `true`; the cause remains open.
- A2A initial-reconciliation timing failed the same settled-flag assertion
  discussed above. Cleanup also reported `connected_clients`; both diagnostics
  are retained, rather than presenting the assertion as the only failure.
- Stale-stop replacement expected an owner-change error but received named-pipe
  `connect ENOENT`. The same rejected child promise also appeared as an unhandled
  error. Captured stderr identifies that symptom but does not establish its cause.

The other unhandled error was the known MCP rejection. The original worktree
deadline/report-starvation problem did not recur. No failure was waived and no
timeout was increased. Stop `EBUSY`, the A2A timing vulnerability, the original
SDK exit, and the newer CLI observations remain distinct claims.

Complete capture artifacts: `sdk-capture-full-start.json`,
`sdk-capture-full-results.json`, `sdk-capture-full.log`, and
`sdk-diagnostic-source-end.json`. The source proof verifies that all inventoried
daemon TypeScript files in main, candidate validation and hotfix remained
unchanged during this diagnosis. No commit, merge or push was made; main is clean.
The hotfix still consists of its existing runtime/test changes and updated evidence.

A final single-variable control set `TSX_DISABLE_CACHE=1` for the test process
and its children, selecting only repetition zero of each of the four Space
copies. Both main and candidate passed **4/4** with zero retries. This disables
tsx's cross-process disk cache while retaining its per-process cache; it tests
conversion pressure, not simultaneous first writes to an empty shared cache.
The setting was limited to these shell commands and is not a product change.
Logs/results: `sdk-parallel/{baseline,candidate}-no-disk-cache.*`.

Disposition: the earlier SDK exit was not reproduced by these controls or the
new complete run, and no root cause was established. Passing repetitions do not
prove absence of a regression. The full gate remains open for the unexplained
CLI startup/stop observations as well as the documented baseline failures.
Further work should explicitly scope those CLI observations before changing
production behavior; the existing handoff patch has not been expanded.

Final verification found no remaining Node, PowerShell or conhost created in the
diagnostic execution window (22:27:00–23:03:10); historical processes were not
terminated. `sdk-diagnostic-post-process-window.json` records the snapshot.
`sdk-final-canonical-source-proof.json` additionally compares all 13 runtime/test
patch files in both hotfix and validation against the preceding full-run source
hashes after line-ending normalization. Documentation is the only follow-up delta.
