# Issue 372: Windows setup capability readiness

Observed 2026-10-28, diagnosed and repaired 2026-10-29 after `1783ab78`.
The source change is unreleased, on v0.7.97-alpha.10. Issue 371's intermittent
startup latency is not declared fixed by this work.

## Contract

A current setup marker, healthy sandbox account and NUL access do not prove
the setup-owned filesystem capability ACEs still satisfy native admission.
Interactive setup-current checks and doctor must reject missing/unsafe setup
capabilities in the calling process's filesystem view. Checking must not repair
ACLs, elevate or mutate an account. Explicit setup must repair a healthy account
in place. Ordinary calls retain their permission boundary; no post-start work
is replayed. Persist the cause of a pre-start sandbox failure in diagnostics.

## Automated checks

```powershell
npx vitest run src/sandbox-runtime.test.ts
npx vitest run packages/coding/src/tools/bash.test.ts src/kodax_cli.sandbox-startup.test.ts src/sandbox-runtime.boot-diagnostics.test.ts
cargo test --manifest-path native/windows-sandbox-v2/Cargo.toml --locked setup_owned_read_root_is_verify_only_during_admission
npm run typecheck
npm run build:packages
npm run build:native
npm run build:bundle
npm run build:dts
```

The readiness regression first failed because setup-current returned true
despite missing read capabilities. It now rejects startup/doctor readiness,
does no implicit installation, and verifies explicit repair without changing
the account SID. The native test checks missing capabilities and installed
capabilities while confirming verification never changes the directory DACL.
The Bash diagnostic regression first failed to retain the pre-start cause,
then passed after the diagnostic was emitted before fallback authorization.

Recorded validation: 96 runtime tests passed (40 skipped legacy/platform cases),
80 Bash/startup/boot-diagnostic tests passed, and the targeted native ACL test
passed. Source/test TypeScript checks, workspace/native/bundle builds and all
14 SDK type bundles passed. A warm setup-current verification measured 58 ms
in the coding tool context; this is not a cross-context latency guarantee.

## Existing console Host acceptance

Keep the actual console Host running. This test connects only; it must not
start or replace a fresh Host in the test runner's own filesystem context.
After building, run:

```powershell
node tests/windows-sandbox-shared-host-readiness.mjs C:\Works\TMP
node tests/windows-sandbox-shared-host-readiness.mjs C:\Works\GitProj\KodaX-AI\KodaX
```

Use the affected workspaces on another machine. The test creates an owned
temporary Session and invokes only `whoami` through the public SDK tool Run.
It permits at most one one-shot approval in that Session; no persistent grant,
provider prompt or existing Session edit is involved. Success requires the
actual result to identify `srt-sandbox`; host execution is a failure. The two
workspaces passed concurrently against the original console Host after repair.

## Incident evidence and limits

Six Bash calls in the reported sandbox-test Session and 137 in the other
Session recorded backend-failed fallback. Native pre-start probes in the
affected Host context identified missing setup capabilities at AppData. That
path had a different NTFS file ID in the coding tool context; equal path text
was insufficient to prove equal filesystem objects. Both processes reported
no package identity, so an MSIX cause is not claimed. The source of the view
difference and original ACL divergence remains unverified.

The first repair failed at Bash's 300-second hard limit. Do not count an
`installing` marker or a successful installer launch as readiness. Official
setup subsequently finished in Windows Terminal at 00:07:30 on 2026-10-29;
doctor reported ready, a fallback-disabled source probe identified the sandbox
account, the original Host passed SDK acceptance, and the marker no longer
contained `installing`. Account/group SIDs and filesystem nonce remained stable.
All temporary native debug instrumentation was removed before final build.

## Standards review

No actionable findings against AGENTS.md or the code-smell baseline.

## Spec review

One P3 finding: the acceptance script originally failed to delete its owned
draft if setup failed before receiving a Run handle. The script now stores
the Session ID immediately and deletes it in that failure path; disconnect
still runs if deletion fails. Re-review confirmed no remaining findings.
