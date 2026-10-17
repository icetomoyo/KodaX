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
