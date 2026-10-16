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
