# Space #222: alpha.7 Host crash recovery

This is Space's issue number, separate from historical KodaX Issue 222.

## Original failure and cause

[alpha.7 CI run 38857483212](https://github.com/icetomoyo/KodaX/actions/runs/38857483212)
failed all three `src/sdk-client.crash.test.ts` cases on Linux Node 20 and 22.
The original stack is `connectKodaXRuntimeInternal:6404` →
`killHostAndRestart:131`, the `ensureKodaXRuntime` call. The subsequent passive
`connectKodaXClient` call had not run and does not discover shared owners.

`kill(pid, 0)` succeeds for an unreaped Linux zombie. Shared storage discovery
could retain N1, while the daemon health check recognized N1 as terminated and
started N2. Authenticated attachment then compared N2 with the old N1 snapshot
and threw `session_storage_owned`. Reaping N1 after discovery does not update
that snapshot; this failure does not prove that later fresh attempts cannot
converge.

## Regression commands

Run after `npm ci` and `npm run build:packages`:

```sh
npm run typecheck
node node_modules/vitest/vitest.mjs run src/runtime-daemon/state.test.ts src/runtime-daemon/lifecycle.test.ts src/runtime-daemon/lifecycle.process-identity.test.ts src/runtime-daemon/process.owner-exit.test.ts src/runtime-daemon/process.test.ts src/runtime-daemon/shutdown-verifier.test.ts src/sdk-runtime-daemon-upgrade.test.ts src/sdk-client.crash.test.ts
```

Use the normal CI workflow for Linux Node 20/22 and the full release gate.
Node 20 covers ownership through the unit/system tiers; an explicit Node 22
ownership gate covers the same regression files. Both Fast suites retain the
three original crash tests.

## Required assertions

- Input acceptance, tool dispatch and committed tool-result crashes preserve
  interrupted/unknown facts, one user input and at most the original provider
  requests. Tool marker count remains exactly one where dispatch occurred.
- The real Linux zombie fixture uses a Python parent that defers `waitpid`
  until all assertions finish. `/proc/PID/stat` must show `Z` while
  `kill(PID, 0)` succeeds. Discovery ignores the terminated owner, health marks
  it dead, exact-owner exit waiting succeeds and shared storage can be acquired
  before the parent reaps it. This case is Linux-only; it must run on both CI
  Node versions, not merely pass through a platform skip on Windows.
- Portable process fixtures cover `Z`/`X`/`x`, PID reuse, unreadable/malformed
  evidence and denied/unknown process probes. Uncertain or live owners retain
  both locks; timeouts and cancellation never kill the owner.
- Owner changes during discovery/attachment or probe/attachment close the
  temporary client before fresh discovery, including a different owning
  profile. Repeated changes exhaust the existing two-retry budget; the original
  startup deadline and cancellation signal apply to every attempt.
- A replacement that never completes authenticated initialization still times
  out or cancels within that same budget and closes the temporary client.
  Shutdown outcome verification and Client exit receipts use the same
  conservative generation check.
- Newly spawned candidates hold a temporary authenticated Client admission
  during OS identity inspection, then close it before the real attachment.
  This preserves the existing 150ms Windows orphan-exit smoke with slower
  process identity queries. Ordinary health and existing-owner probes stay
  passive; no PID generation assertion or orphan timeout is relaxed.
- Initialization is the only replayed RPC. No retry bypasses identity checks,
  force-releases a live owner or resubmits an input/tool operation.

## Evidence

Before the fix, the deterministic discovery test failed with the zombie Host
returned instead of `undefined`. The deterministic attachment test reproduced
the original `session_storage_owned` at `sdk-runtime.ts:6404`.

Local Windows Node 22 validation passes the original three crash cases, typed
source/test checks and the related ownership/upgrade suites. Linux acceptance
and full CI must pass on the fixed commit before creating the release tag.

## Windows startup latency follow-up

An automatic historical child sweep must preserve an incomplete Run tree as
`unknown` when none of its retained process identities can be verified alive.
A live PID with unreadable start identity, `EPERM`, or an absent snapshot row
does not justify launching an exact-termination helper for every old record.
Those helpers invalidate the shared process snapshot and make startup cost grow
with history. Keep the records intact; explicit Run recovery can still attempt
exact-handle recovery, and a verified live descendant still receives cleanup.

Run the Windows query regression and the existing recovery cases:

```sh
npx vitest run packages/agent/src/runtime/managed-child-processes.cache.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts
```

The deterministic cases cover 32 records each with unreadable, denied, or
missing current identities: no termination requests, at most one snapshot,
unchanged records, and no verified cleanup. A separate case retains exact
cleanup of a known live descendant under an unreadable root.

Local Windows Node 22 measurement with 24 protected-PID historical records:
11,069ms and 48 PowerShell helpers before the fix; 10ms and no helpers after it.
Termination calls were removed from the diagnostic subprocess scripts, so this
measurement exercised OS helper startup without signaling any real process.
All 24 records remained unknown and present in both runs.

The user's active Host was left running. Its passive connection measured 6ms;
same-build attachment measured 747ms and 745ms. Its full management inspection
still measured 5.4s/5.1s with 3,015 active Session files. These are separate
costs; the screenshot's entire 33-second refresh was not replayed against the
active user Host.

Follow-up validation on Windows Node 22: 162 tests passed and three
platform-specific cases skipped, including all three original crash cases;
the full build and source/test type checks passed. Both review axes reported
no findings. The changed cleanup predicate has 17/17 statements and 19/19
branches covered. The selected suites cover 70.85% of the whole registry
module's lines; this is not a claim that the repository's 80% overall coverage
or a new release gate has passed.

## Rebuild, persistent Hosts and existing terminals

PowerShell's `kodax.ps1` starts a fresh Node process for each invocation. In this
installation both observed FNM paths resolve to Node 22.23.1 with the same
executable hash; both global `@kodax-ai/kodax` links resolve to this checkout.
Alternating those paths against the same current Host measured 1.03–1.13s per
SDK ensure. No evidence supports a PowerShell JavaScript module cache.

A running Client or Host does retain its loaded build. A same-version rebuild
changes the disk fingerprint, and a new launcher must refresh an idle old Host
through authenticated managed shutdown. A retained old Client correctly blocks
that shutdown. An isolated experiment held such a Client for 10s: the new
launcher remained pending and the original Host stayed alive. Closing only the
Client allowed refresh at 12.1s, preserving the saved Session. The PowerShell
process stayed open. This explains one possible benefit of closing a terminal;
it does not establish what processes the user's original terminal retained.

Historical cleanup overhead predates the October CI fixes. Same-installation
build refresh dates to `99ad85e3` (September 10). Concurrent refresh contention
also predates alpha.7; `224813c6` (October 15, Issue 369) added retries whose
backoff grows with the preceding inspection duration. Slow history scans and
temporary launchers counting each other as connected Clients can amplify that
backoff. Git records do not identify which model produced these edits.

The follow-up fix serializes startup per canonical Session directory **before**
discovery or attaching a temporary management Client. The coordinator is
separate from the Host's owner lock and reuses the existing nonce, process
generation and zombie-aware coordination primitive. A queued launcher reads
the current owner after obtaining the gate. Queueing, initialization and refresh
share the original startup deadline and cancellation signal. Passive connects
remain passive. No business RPC is retried and no active Host lock is replaced.

Actor metadata preflight retains the main/islands/archive identity checks,
writer fences and topology witness. It now captures identities once before
reading metadata and verifies them once afterward, rather than taking two full
double-checked snapshots. Direct read-only scans of the user's 3,015 Sessions
improved from 4.8–5.8s to 2.5–2.6s. The initial 2s diagnostic target was not met.
Tests inject main, islands, archive, writer and topology changes during the read
and require `data_changed` rather than an idle result.

Run the compiled CLI acceptance with `node-pty`, `@xterm/headless` and
`@xterm/addon-unicode11` installed in `KODAX_ACCEPTANCE_TOOLS` (default:
the temporary directory's `kodax-acceptance-tools/node_modules`):

```sh
node tests/repl-concurrent-startup.mjs
```

This uses private installations and dummy credentials, initializes actual Git
projects, retains 3,000 historical Sessions including 50 large transcripts,
changes a runtime asset while the Host is loaded, and resumes saved conversations
from two concurrent terminal Clients. Both must display the saved conversation,
reach readiness within 20s, exit normally, and observe a different Host identity.
It makes no model requests and does not stop the user's Host.

Windows Node 22 measurements: the old launcher reproduction took 31.5s for one
Client and rejected its peer as draining. With startup coordination, both actual
resumes completed in 14.4s/15.6s; upgrading a pre-fix Host completed in
15.9s/17.0s. Same-build full CLI resumes completed in 4.7s/5.8s and retained the
same Host. These timings include CLI startup, picker selection and Session
attachment; they are not just passive socket timings. They are local acceptance
measurements, not a claim that every rebuild is instantaneous.

The startup coordinator tests retain a live owner and malformed/unreadable
coordination evidence, and reclaim a proven terminated zombie. The Linux real
unreaped-zombie fixture now checks startup coordination as well as shared-owner
discovery and exit verification. Rerun it on Linux Node 20/22 in CI before a
release; a Windows platform skip is not Linux acceptance.

`src/sdk-runtime.launcher.test.ts` also holds a real old Host's first management
inspection open. The second public ensure must report queueing without issuing
another inspection; after release both Clients must attach to the same new Host
and retain the saved Session. Its former two-Client rendezvous deliberately
required the overlap that startup coordination now prevents, so that fixture
must not be retained as an expectation of the new startup order.

## Concurrent daemon start before the ready descriptor

Initial A2A reconciliation can hold both daemon and shared-storage owner locks
before publishing `daemon.json`. The CLI used only its initial daemon state
snapshot to decide whether to report `already_running`. A second `start` that
observed no descriptor therefore reported `started: true` even after attaching
to the original owner. The fix retains the initial daemon-lock snapshot when
the state is absent and compares its runtimeId and PID after the existing
authenticated ready-owner verification. Startup coordination, owner discovery,
Host refresh, retry budgets and Session reads are unchanged.

On Windows, the original assertion failed at `143e74e3`. Additional assertions
confirmed that both CLI results and the SDK follower retained the initial
owner's runtimeId and PID: the failure did not demonstrate a replacement Host.
The `connected_clients` cleanup rejection came from the assertion skipping the
test's SDK follower close. Its outer finally now closes that connection even
when an assertion fails.

The original test passed in a `cc2d02bc` source snapshot using the same installed
workspace dependencies. Once a test-only observer pinned the second CLI's
actual missing-descriptor lookup before releasing A2A discovery, that snapshot
also reported `started: true` for the same owner. Thus the passing/failing
anchors alone do not establish that owner discovery regressed. The committed
test uses this observation barrier, preserves the real filesystem lookup
result, and verifies original-owner identity before checking CLI classification.

Rerun the public CLI regression with:

```sh
node node_modules/vitest/vitest.mjs run -c vitest.system.config.ts src/kodax_cli.daemon-smoke.test.ts -t "does not become ready before initial A2A reconciliation completes"
```

The compiled 3,000-Session concurrent resume acceptance after this fix completed
in 13.2s/14.3s on Windows Node 22, rendered both saved conversations, refreshed
one idle Host, and closed both Clients and the private Host normally. This is
within the existing 20s gate and does not replace Linux Node 20/22 CI acceptance.

## Windows SDK attachment deadline under CPU contention

CI run `38996333556`, attempt 1, failed the bundled idle default-Host recovery
test on its second public `ensureKodaXRuntime` call. The stack ended in
`initializeRuntimeDaemonForStartup` with `Host startup timed out during
authenticated attachment.` The successful rerun of the same SHA did not
resolve or explain that failure. Passive `connectKodaXClient` does not discover
or refresh the shared owner in this scenario.

The original two ensures use 15s and 10s startup budgets. Three independent
callers pinned to one Windows CPU, each with an empty private Home, reproduced
9/9 failures at `1ec38d12`. The first three refreshes reached `connecting` at
12.89–12.92s, then immediately rejected before authenticated initialization.
Repeated synchronous PowerShell queries cost approximately 1–2.5s each under
that contention. Each scalar PID check compiled C# and enumerated the full
machine process table; startup also captured an unused tree of the already
Job-contained wrapper. No historical Session scan, shared-Home peer, model
request or tool execution was required to reproduce the failure.

The process lease incorrectly started another readiness budget after spawning,
and accepted a ready observation before checking whether that observation had
crossed its deadline. The SDK's original deadline was already exhausted when
the lease returned. A separate failure path could then rediscover its own newly
published Host and replace the real timeout with `session_storage_owned`.
Deterministic clock-controlled regressions reproduce these errors without
relying on CPU timing.

Scalar Windows checks now read only the requested PIDs' OS creation times.
Integer FILETIME division preserves the existing native identity exactly.
Every external-PID observation is fresh; permission failures and unreadable
identities remain unknown. Tree capture retains its native snapshot, fallback
routes and cleanup-scope invalidation. Initial Job membership and the exact
Host/supervisor identities are collected in one subprocess. Only the current
process's immutable identity and Job membership fact may be cached; later
supervisor checks still re-read its identity. The contained startup candidate
uses its existing Job cleanup handle without the unused wrapper tree capture.

The lease passes one deadline through existing-owner waiting, child spawning,
readiness and socket attachment. Late ready evidence is rejected; an expired
failure does not trigger more owner discovery. Committed Job owners remain
protected by the existing retained-handoff behavior. Timeouts, retry counts,
identity assertions and Session ownership locks are not relaxed.

The same three-caller, single-CPU, empty-Home reproduction then passed 9/9
with unchanged budgets; refreshes took 8.50–9.89s, including all three first
calls. This is a deliberately constrained local stress result, not a promise
of success under unlimited CPU starvation. Synchronous OS queries cannot be
preempted by a JavaScript timer; expiry is checked immediately after them.

The expensive snapshot backend and the readiness budget reset predate the
October fixes (July commits `a0a67a8f3` and `7cafcd364`). `f336c165` correctly
extended exact owner identity checks to Windows health and exit waiting,
making that existing query cost more visible during refresh. This shares a
costly primitive with the earlier startup slowdown, but is distinct from the
historical-child sweep and concurrent Actor inspections already fixed. The
original user terminal has no retained timing trace proving which costs
dominated that particular 20–33s wait. Restarting a terminal is not required to
reload JavaScript; a still-running Client/Host keeps its loaded build until
normal detach and refresh permit replacement.

Run the committed Windows pressure gate after building:

```sh
node tests/windows-sdk-attach-pressure.mjs
```

It runs the original bundled recovery test three times per worker, with up to
three isolated workers bounded by the available CPU count. It retains the original startup budgets and
assertions, waits for every worker's cleanup, and reports every failure. The
bundled test records public startup stages on failure and attachment timings
on success so a future CI failure has evidence beyond its terminal stack.
The Windows packaged CI job runs this gate in addition to the full bundle
suite. Release remains on hold at the user's request.

Follow-up validation did not treat the first improvement as sufficient. The
committed pressure gate passed 9/9 on Windows Node 22, but Node 20 still timed
out on one first refresh. A health probe could retain its initial `starting`
descriptor even though that same owner became ready during authentication and
OS identity inspection. It then repeated the entire expensive probe. Health
now refreshes readiness after that inspection only if the latest descriptor
and lock still name the exact same owner, endpoint and process generation.
Owner/PID-generation replacements cannot be promoted by this refresh. A
deterministic public health-observation test reproduces the stale status, and
separate replacement cases retain the changed fence without returning ready.

Independent Spec review also found two budget/cancellation gaps. SDK success
now checks the original deadline and signal after its final synchronous
owner/build validation, inside the existing cleanup boundary. Pending socket
attachment accepts the same cancellation signal and destroys the canceled
socket. Windows supervisor readiness observes that signal through its normal
Job cleanup/retained-handoff path. New public-boundary tests first failed for
late owner verification, pending socket cancellation and pre-ready Job
cancellation, then passed with these corrections.

Validation status for the follow-up remains deliberately qualified. The
Windows Node 20 single-CPU, three-worker pressure gate still failed 2/9 cases
after the readiness/cancellation corrections; the failures were startup
readiness timeouts rather than a reported successful attachment or the old
misleading authenticated-attachment error. These failures are retained and
are not converted into acceptance by rerunning the same code. The normal
Windows Node 22 full bundled suite passed 43/43; Windows Node 20 targeted
ownership/deadline/cancellation tests passed 208 (3 platform skips). The real
3,000-Session concurrent rebuild/resume completed in 13.46s/14.24s, retained
both conversations, observed the new Host and closed both Clients normally.
This confirms no measured regression in that scenario, but does not clear
the single-CPU pressure limitation. Release remains held and the fix branch
must not be described as fully accepted on the basis of a rerun of the same
single-CPU experiment.

The initial fixed single-CPU gate was too restrictive as a success requirement:
it forced three independent cold Host replacements to compete for one CPU
while assuming all would finish within 10s. CI run `39002116074` passed the
original Windows bundled suite, but that additional gate failed one pressure
case. The user explicitly permitted correcting this acceptance criterion.
The committed concurrent gate now respects the available CPU count, requires
every original SDK scenario to succeed, and keeps the 15s/10s deadlines and
owner/cleanup assertions unchanged. It does not accept timeouts as success.
Deadline expiry, cancellation and changed-owner behavior remain separate
deterministic regressions that first fail against the old implementation.
The earlier single-CPU failures above remain diagnostic evidence of resource
starvation and are not erased or represented as successful acceptance.

The final boundary audit also covers the synchronous owner discovery itself.
The SDK checks the original deadline and signal before and after discovery,
after authenticated owner revalidation, and after the final build check. If
discovery consumes the deadline or observes cancellation, it must not open a
process lease with a new minimum budget. Both public ensure regressions first
failed by opening that lease and now pass without any lease acquisition.

## Fixed-commit acceptance

The Windows attachment fix was verified at
`ae77c2b7836b1130ed1426bb508d3f324ab9cad2`.
Local Windows Node 20 and 22 each passed all nine CPU-aware concurrent SDK
cases. The final quiet empty-Home runs measured 1.50–1.75s for the initial
attachment and 2.16–2.34s for idle-Host replacement, compared with the original
2.0–2.5s and 3.34–3.73s. These SDK timings do not include a large Session picker.
The actual 3,000-Session concurrent CLI rebuild/resume remained within its
existing 20s gate at 13.46s/14.24s, with both saved conversations restored.

Linux Node 22 CI passed all three original crash cases and all 96 explicit
ownership regressions, including the real unreaped-zombie fixture. Independent
Standards and Spec reviews of the final source reported zero findings.

Windows CI passed the original 43 bundled tests, nine concurrent SDK cases,
141 startup ownership/cancellation tests, concurrent CLI startup/rebuild
refresh, native policy gates and the Electron 42.5.0 packaged daemon. The nine
concurrent SDK cases measured 3.734–3.891s for initial attachment and
4.967–5.176s for Host replacement, within the unchanged 15s/10s budgets.

[Full CI run 39003213083](https://github.com/icetomoyo/KodaX/actions/runs/39003213083)
passed six platform jobs. Linux Node 20 also passed the three original crash
cases and all ten owner-exit tests, including the real unreaped zombie, in its
Fast/Unit tiers. Its System tier passed 1,344 tests but timed out after 90s in
`keeps the session usable after stopped Shell cleanup remains unknown`.
That in-process Runtime test does not use the Windows daemon attachment path.
The overall run is therefore **failed**, not accepted by rerunning; it
triggered a separate Stop wait-chain diagnosis. Release remains held.

## Queued Run handoff found by the full gate

[Scoped Linux Node 20 diagnosis 39004848120](https://github.com/icetomoyo/KodaX/actions/runs/39004848120)
reproduced the same 90s timeout on its first case. Public wait-boundary probes
showed Stop returning in milliseconds and the original Run settling as
`interrupted` about six seconds later. The successor Run then failed to advance.
This is distinct from Windows daemon startup or authenticated attachment.

Run admission decides whether to queue before awaiting settings/journal work.
The active predecessor can finish during those awaits and drain an empty
queue. Publishing the already-classified queued Run afterward did not wake
the drain, leaving it queued indefinitely. Queue publication now calls the
existing drain helper, which still refuses to start work while another Run is
active or a Session Stop fence remains. No timeout, authorization or ordering
check is relaxed, and no input or tool operation is resubmitted.

The asynchronous journal binding was added by `ceb4ed10c` on October 12;
`152ec646` widened this Shell test from 30s to 90s on October 13 without
repairing the handoff. These changes predate the Windows attachment fix.

Two deterministic public SDK tests pause journal binding, complete the first
Run, then publish the second through `runs.start` or `after_turn`. Both failed
against the old code because only the first executor started, then passed with
the queue-publication fix and exactly one executor call per Run. The original
Shell cleanup test retains its five cases and 90s limit. Temporary diagnostic
workflow/input/probes were removed; the normal CI matrix is restored.

The expanded local Windows Node 20 SDK/Stop/Shell gate passed 321 tests but
also exposed two existing fixture cleanup failures. T14 detached its Client
then removed its Home while the persistent Host was still writing; it now
cooperatively shuts down that private Host and verifies its exact owner exit.
The snapshot budget case attempted to delete a directory with an open blocked
writer, which Windows rejects. Its barrier now pauses the pending materialization
after capacity reservation but before opening the file, preserving the
`overloaded` and `resync_required` assertions on both platforms. Its first-page
outcome is observed immediately and awaited during cleanup. Both original
failures are retained in the local logs, and both corrected target cases pass.
No tests are skipped and no timeout is increased by these fixture corrections.

## Final build validation

At `61a67599cd6c25237c97a2352f05c374c4e38b99`, the complete build and source/test
type checks passed. The full Windows Node 20 SDK file passed 305/305, including
both queue-handoff regressions and the corrected fixtures, without unhandled
errors. The related Stop suite passed 13/13 and all five original Shell cleanup
scenarios passed.

The final compiled SDK recovery measured 1.754s for initial attachment and
2.346s for idle-Host refresh. Actual concurrent CLI rebuild/resume with 3,000
Sessions measured 10.756s/11.442s against the unchanged 20s gate. Both saved
conversations resumed, both Clients exited normally without forced termination
or reported errors, and both observed the replacement Host. Private Host
cleanup succeeded. These are measurements of the final build, separate from
the earlier SDK timings and the constrained single-CPU diagnostic experiments.

[Final CI run 39006197931](https://github.com/icetomoyo/KodaX/actions/runs/39006197931)
uses this exact commit. Its Linux Node 22 job passed all three crash cases and
all 96 explicit ownership regressions, including the unreaped-zombie fixture.

All seven final CI jobs completed successfully. Linux Node 20 passed its three
original crash cases and all ten owner-exit tests, including the unreaped
zombie, then passed 1,347 System tests. The original stopped-Shell successor
case passed in 6.566s instead of timing out at 90s. Its full SDK file passed
with the two existing platform skips; Windows ran all 305 cases without skips.
Windows CI passed all 43 bundled tests, nine concurrent SDK cases, 141 startup
ownership/cancellation tests, the native policy gates and packaged Electron.
Both macOS jobs, Linux ARM64 and Windows Shell contracts also passed.

The temporary diagnostic workflow, dispatch input and probes are removed.
Release remains held by explicit user instruction; no release or tag was made.

## Interactive Host lifetime follow-up (accepted 2026-10-17)

Accepted user requirement: ordinary `kodax` auto-started Hosts exit after the
last logical Client disconnects and governed background work remains idle for
30 seconds. Explicit `kodax daemon start` and configured A2A serving Hosts remain
persistent. Reconnecting cancels the idle exit. Active owners and work must not
be reclaimed, and rebuild/resume performance must not regress. Release stays held.

The CLI selects an interactive startup default only for a newly spawned Host;
it reuses a compatible persistent Host without a policy upgrade or another
startup scan. Explicit start retains an existing temporary Host through its
authenticated logical-client initialization, with `daemon:admin` authorization;
probe and observation-only connections cannot change lifetime. No extra RPC is
added. A2A retention uses the Host's already-created serving handle. Rebuild
refresh carries a declared persistent lifetime into the replacement owner.
For old Hosts without a lifetime field, a valid orphan-exit capability is
positive evidence of an interactive policy; otherwise refresh conservatively
retains persistence. Old automatic and explicit startups were indistinguishable.
An old automatic Host therefore needs one normal, idle `kodax daemon stop` before
the next ordinary CLI startup can select the new interactive default.

Idle exit reuses the existing draining fence and governed-work preflight. The
last disconnect checks for idle work; observed work or inspection failures
reset the grace. A newly observed idle state receives the complete grace, and
attach/detach during inspection rechecks the latest state. Idle inspection runs
only when no logical Clients remain; persistent/A2A Hosts avoid these scans.
Existing startup deadlines, cancellation, PID identity and owner fences remain.
The real Runtime preflight additionally reports its already-tracked pending
memory review and managed-task maintenance count, including after the Run has
completed. This is an in-memory check, with no new history scan. Automatic idle
exit preserves this work, including its final check inside the draining fence.
Explicit shutdown retains its existing contract: cancel optional review and
await cleanup/maintenance. Active Runs, ownership and process checks remain.

Regression commands:

```sh
npx vitest run src/runtime-daemon/management.orphan-exit.test.ts src/runtime-daemon/server.test.ts src/runtime-daemon/host.test.ts src/runtime-daemon/schema.test.ts src/sdk-runtime-daemon-upgrade.test.ts
npx vitest run src/sdk-runtime.maintenance.test.ts src/sdk-runtime.memory-review.test.ts
npx vitest run src/kodax_cli.daemon-smoke.test.ts
npm run typecheck
npm run build
node --test tests/bundled-shared-host-recovery.test.mjs
node --test tests/bundled-memory-review-shutdown.test.mjs tests/bundled-daemon-compaction.test.mjs
```

The original approximately 30-second first resume after rebuild remains an open
performance diagnosis. A warm successful run is insufficient to close it. This
lifetime change does not claim to resolve that delay; the one-off local startup
trace remains available in `.tmp/Trace-KodaXStartup.ps1` for a slow real attempt.
