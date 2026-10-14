# ISSUE_367 — In-flight mutation amplifies daemon preflight

Date: 2026-10-13 (Asia/Shanghai). The fix ships in `v0.7.97-alpha.5`; npm
publication remains separate.

## Symptom and confirmed scope

The user captured `kodax -r` waiting over 40 seconds and failing with
`Runtime state changed while daemon preflight was being read.` The spinner's
elapsed value covers total startup, not only the displayed connecting stage.
Current code's upgrade path reads management preflight. A held managed
`session.load` deterministically reproduced the exact error and eight full
snapshot reads. The live incident's actual concurrent method was not captured;
continuously changing state and cold scans remain alternative explanations.

The fix rejects an active mutation before a full read and names its method/count.
If a mutation begins during a read, it stops further full scans. After settlement,
normal preflight succeeds. It preserves safe shutdown, client/owner/revision
fences and read-only passive connection behavior; it does not force-stop busy work.

## Reproduce and verify

Fast loop:

```powershell
npx vitest run src/runtime-daemon/management.orphan-exit.test.ts
```

The initial Session-load regression was RED with the old conflict message.
Both new tests are GREEN: initial mutation causes zero reads; a mid-read mutation
causes one read; the initial test also checks success after settlement. All eight
management/orphan tests pass. No model calls or user Session changes are involved.

Related contract/real Host checks:

```powershell
npx vitest run src/runtime-daemon/management.orphan-exit.test.ts src/runtime-daemon/server.test.ts src/runtime-daemon/client.test.ts src/sdk-client.startup.test.ts src/sdk-runtime.launcher.test.ts --maxWorkers=2
npm run typecheck
npm run build
node --test tests/bundled-product-exit.test.mjs
```

Recorded: 119 tests passed in five files; production/test typechecks and full
build passed. Two built Product exit tests passed, covering peer protection and
exact owner cleanup without stopping a replacement Host. Standards: 0 findings.
Spec: 0 findings. No full-repository test rerun is claimed for this small fix.

## Live timing and retry

A read-only connection to the existing default Host took 7ms; its management
inspection completed at 1196ms elapsed with no active work. This is a warm,
already-running Host measurement, not a cold CLI benchmark. Neither the user
Host nor their Session was stopped or changed by that probe. The linked CLI was
rebuilt. The user then retried `kodax -r` and confirmed normal TUI entry. A read-only
state check found a ready replacement Host (PID 37792 instead of 25488), started
at 23:33:13 Asia/Shanghai. No exact retry duration was reported; this confirms
recovery of the interactive flow, not a cold latency benchmark or proof of the
original incident's precise concurrent operation.
If a busy operation is reported, retain its method/count and timing. If the old
state-change error recurs without a reported mutation, the confirmed fix does
not settle that separate state-change path; capture it before broadening changes.
