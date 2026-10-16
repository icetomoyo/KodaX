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
  Shutdown outcome verification uses the same conservative generation check.
- Initialization is the only replayed RPC. No retry bypasses identity checks,
  force-releases a live owner or resubmits an input/tool operation.

## Evidence

Before the fix, the deterministic discovery test failed with the zombie Host
returned instead of `undefined`. The deterministic attachment test reproduced
the original `session_storage_owned` at `sdk-runtime.ts:6404`.

Local Windows Node 22 validation passes the original three crash cases, typed
source/test checks and the related ownership/upgrade suites. Linux acceptance
and full CI must pass on the fixed commit before creating the release tag.
