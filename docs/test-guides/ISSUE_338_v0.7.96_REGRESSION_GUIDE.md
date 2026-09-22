# Issue 338: Windows daemon state replacement contention

## Scope and contract

The diagnostic checkpoint is `0ec6aa41` on the main repository's `KodaX` branch.
The owner requested that checkpoint first, then this separate repair and complete
regression/performance validation. No SDK version bump or npm publication is part
of the change; Space source and its dependency pin belong to a separate change.

An independent ordinary Node JSON reader can make the original Windows state
writer fail at `renameSync(staging, daemon.json)`. The packaged Electron incident
failed when publishing `ready` after successfully publishing `starting`. The
exact original interfering handle was not captured; both unchanged baseline and
candidate reproduce the underlying contention mechanism.

Only Windows `EPERM` during that atomic rename is retried. The same flushed,
closed staging file is reused; the old target is never unlinked or overwritten
in place. A 200 ms monotonic budget begins after the first failure, with waits
of at most 10 ms and a deadline check before starting another attempt. Permanent
EPERM preserves the first error; a different subsequent error propagates
immediately. The existing staging cleanup remains in `finally`.

The normal successful path does not allocate a wait cell, inspect the clock or
wait. There are no new processes, recurring probes, global locks, configuration
options or Bash/sandbox per-command operations. Ownership, Job containment,
credentials, compaction and existing lifecycle ordering are unchanged.

This is a synchronous failure-path budget, not a strict wall-clock bound. OS
scheduling and an already-started filesystem call can overrun it. Separate
state publications can accumulate delay, so the integration tests must cover
startup, stop and cleanup deadlines as well as ordinary throughput.

## Verification plan and evidence

Use synthetic local providers and isolated temporary homes. Do not change
production timeouts, bypass sandbox checks, delete owner fences or rerun failures
until a passing result hides the first failure. Preserve every failed run.

1. State writer contracts: temporary/permanent EPERM, unchanged old JSON, one
   staging write/fsync, cleanup, immediate non-target error propagation, no wait
   on success, monotonic cumulative budget and no attempt after its deadline.
2. Real Windows Node reader in a separate process, with 200 atomic publications
   through the real exported writer. Check every state via the public reader,
   zero invalid JSON/read failures, and exact reader shutdown.
3. Host ready/stopping publication under injected transient and permanent
   failures, concurrent close deduplication, and replacement-owner preservation.
4. Rebuild packages, native artifacts, bundle and declarations; typecheck source
   and tests. Run CLI/SDK handoff, credential/compaction, shell/sandbox/stop and
   lifecycle regressions, and the original complete packaged Electron smoke.
5. Paired cold/warm measurements: one excluded pilot pair, ten alternating pairs,
   three warm attaches per sample, client detach and exact verified shutdown.
6. Paired Bash/sandbox measurements: one excluded pilot pair and three alternating
   pairs; each sample runs two batches of four real sandboxed commands through
   the Runtime. A filesystem barrier requires four overlapping commands, so a
   silently serialized implementation cannot pass. Check applied sandbox
   observations, command output, owner shutdown and absence of ACL poison.
7. Run process-heavy functional tests and performance measurements separately.
   Compare against the isolated `0ec6aa41` build with identical dependencies and
   native binaries. Report noise and observed limits rather than claiming zero
   overhead. Independent Standards and Spec reviews must cover all changed files.

Core commands, from the SDK repository (run sequentially):

```powershell
npm run build
npm run typecheck
npx vitest run src/runtime-daemon/state.test.ts src/runtime-daemon/state.windows.test.ts src/runtime-daemon/host.test.ts --maxWorkers 1
npx vitest run --maxWorkers 4
node --test --test-concurrency=1 tests/bundled-provider-credentials.test.mjs tests/bundled-daemon-compaction.test.mjs tests/bundled-text-permissions.test.mjs tests/bundled-image-validation.test.mjs tests/bundled-text-recovery.test.mjs tests/image-codec-release.test.mjs tests/asrt-wfp-probe.test.mjs tests/asrt-wfp-build.test.mjs
node tests/windows-daemon-handoff.mjs
```

For the packaged smoke, set `KODAX_ELECTRON_DIST` and
`KODAX_ELECTRON_BUILDER_CLI` to the installed Electron distribution and
electron-builder CLI, then run `npm run test:electron-daemon:built`. Use the
normal sandbox doctor/setup prerequisites and retain failures; do not weaken
the artifact or sandbox guards. Performance/cancellation fixture sources,
baseline provenance and original raw measurements are retained at the paths
listed below.

## Recorded results

- State writer: initial transient-EPERM test observed RED before implementation;
  final file passes 55 tests, including 10 new cases.
- Host: three new cases, complete file passes 20 tests. The initial candidate
  run was already GREEN because implementation ran in parallel; loading the
  exact checkpoint state module separately confirmed the transient case RED.
- Real reader: checkpoint fails with EPERM in 71 ms; repaired writer passes
  200 publications with zero reader errors (2.51 second test body).
- Full build passed. The original complete packaged Electron 42.5.0 smoke passed,
  including independent-process sandbox sharing, 20 sandboxed commands across
  four sessions, environment isolation, detach, exact stop and successful restart.
- Cold/warm paired measurement: one excluded pilot pair plus ten alternating
  formal pairs. All 22 samples passed exact daemon/Job shutdown verification.

| Metric | Checkpoint baseline | Repair candidate |
| --- | ---: | ---: |
| Cold startup median | 2365.776 ms | 2367.245 ms |
| Cold startup mean | 2365.373 ms | 2367.251 ms |
| Warm attach median (30 formal samples) | 2.501 ms | 2.495 ms |
| Warm attach mean | 3.423 ms | 3.630 ms |
| Client detach mean | 0.214 ms | 0.211 ms |
| Verified stop mean | 426.160 ms | 427.580 ms |

Cold paired differences range from -19.967 ms to +29.665 ms, with the candidate
slower in four of ten pairs. The 1.469 ms median difference is approximately
0.06%; this sample does not show a material cold/warm regression, and does not
establish zero overhead or guarantee every customer's latency.

The Bash/sandbox run completed the excluded pilot pair and three alternating
formal pairs. All eight daemon samples passed both four-command barriers,
sandbox-applied assertions and exact shutdown, with no ACL poison. The formal
batch mean was 24,810.849 ms baseline and 26,472.412 ms candidate (+6.7%).
Per-pair differences were approximately -2.7%, +22.7%, and +1.0%. Both versions
drifted from about 20 seconds to 30 seconds over the run. Two batches within one
daemon are correlated; the independent comparison unit is three pairs, not six.
These data are noisy and do not establish throughput equivalence.

Read-only investigation found the drift in multiple stages, including the
initial Job probe and sandbox preparation, with identical log sizes/counts,
native hashes, setup generation and workspace ACL counts across arms. This
fixture deliberately uses shell cache TTL zero and registry PATH resolution,
which repeats environment probes. The measured command interval starts after
startup/configuration and ends before shutdown; no state-writer call was found
inside that interval. This supports a shared execution-cost drift rather than
a direct rename-retry cost, but does not identify the environmental cause or
turn a noisy sample into proof of no regression.

The first cancellation fixture used the wrong terminal-phase assertion:
an aborted executing Run is `interrupted`, with `failureKind: cancelled` and
confirmed Stop. The checkpoint returned that existing contract. Its initial
failed assertion and raw results are retained; the fixture was corrected to
check all three fields, without changing production behavior or deadlines.

The corrected cancellation scenario passed once on each build: four real
sandboxed children reached a shared barrier, all four Runs were interrupted
with confirmed cancellation, every recorded child PID exited, a subsequent
command completed, and exact daemon shutdown and ACL-poison checks passed.
Four-way cancellation took 2,024.168 ms baseline and 1,960.375 ms candidate.
The preceding two normal four-command batches were 28,911.933/28,166.020 ms
baseline and 29,412.180/28,166.513 ms candidate. This late adjacent comparison
is supplemental functional evidence (about +0.88% batch mean), not a replacement
for the three formal pairs or a statistically powered throughput claim.

The initial default full suite ran with four workers: 1,038 files, 15,876 passed,
9 failed, 78 skipped and 21 todo, plus one unhandled rejection associated with
the MCP cancellation test. Duration was 771.47 seconds. All 344 SDK Runtime
cases, 24 cross-process CLI cases and the real state-reader test passed.

Six failures were `EBUSY` when removing Stop-test temporary directories. One
was the MCP cancellation fixture's one-second wait for the initial validation
spy; it failed before calling abort, and left its rejection assertion pending.
Both failure categories already appear in the preceding full-suite record;
individual failing Stop cases vary. The two complete files subsequently passed
21/21 tests on both the exact checkpoint and candidate, sequentially with one
worker (58.88/57.16 seconds). This supports a load-sensitive test/cleanup issue,
but does not retroactively make the full run pass or prove every failing case
has an identical cause. No MCP, Stop, test timeout or cleanup code was changed.

Two other failures were corrected in this change: the release-workflow test
still matched the old packaging guard's literal source path, and the issue
summary temporarily included an unsupported `ready` counter. The release test
now checks the actual SDK-relative dependency resolution, ASAR mapping and
physical artifact guard; all five behavior fixtures remain unchanged. That
file and the behavior fixture file pass 22/22 tests. Issue 338 is recorded as
resolved in source and released in `v0.7.96-rc.9`, using the existing tracker summary format.

- Final source and test type checks passed.
- All 36 built-artifact tests passed, including provider credentials,
  manual/managed daemon compaction, recovery, permissions, media and native
  packaging. No external model request was used.
- All four real Windows handoff cases passed: ensure, launcher death, abort,
  and abort before RPC publication, with exact daemon/Job shutdown checks.
- A coverage run of the three state/host files passed 76 tests. It measured
  `state.ts` at 88.36% statements/lines, 95.08% functions and 79.86% branches.
  The final run added existing manager and tracker tests: 94/94 tests passed
  across six files, with 88.68% statements/lines, 96.72% functions and 81.26%
  branches for `state.ts`. The tracker correction is therefore verified.
  This is not a measurement of whole-repository coverage.

## Independent review

Standards: zero findings in production code, regression tests and the final
release-test follow-up. Spec: zero findings against the bounded rename retry,
preserved lifecycle/ownership ordering and unchanged packaging protections.
No review finding was waived. A one-decimal performance rounding error found
during evidence review was corrected.

## Acceptance and limits

The reproduced Windows state-publication contention is repaired in source and
the original full packaged Electron gate passes. The patch preserves successful
write behavior without waits and leaves command execution unchanged. No reproducible new runtime
regression was identified by these checks. The full-suite load-sensitive MCP
and Stop cleanup failures remain recorded above; the initial broad run is not
all green. The noisy parallel performance sample does not prove throughput
equivalence, and failure-path synchronous waiting can add latency.

This source-only change is not an SDK release or a claim that the customer's
specific PowerShell/CIM failure is solved. No affected customer machine was
available for this validation. Space must consume a separately reviewed SDK
artifact before these source changes reach its shipped application.

Raw logs and performance harnesses are retained under
`%TEMP%/kodax-state-repair-tex63f/`. Isolated baseline provenance is under
`%TEMP%/kodax-sdk-baseline-0ec6aa41-7caba764/`. No real provider credential or paid
model request is required by these tests.
