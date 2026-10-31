# Issue 371: Windows cold resume recovery delay

Investigated and partially fixed on Windows, 2026-10-29, after `8910fcce`.
Current package version: v0.7.97-alpha.10; this fix is unreleased.

## Contract and scope

Resuming must not start a termination helper for each registered Windows tree
whose complete PID/start-identity capture is already proven absent by the
current shared process snapshot. Reclaim those records within one sweep using
that snapshot. A reused PID with a different known start identity is not the
captured process. Unknown identities, incomplete trees, unavailable snapshots,
live descendants, active/unknown owners and required Run cleanup must retain
their existing fences. Never treat a missing root alone as proof of tree exit.

Two concurrent clients must share one normal Host, read the saved Session and
newest history page promptly, and preserve the persisted conversation. No user
registry reset, forced Host replacement, skipped recovery, extra permission or
startup-timeout increase is an acceptable performance fix.

The isolated Windows fixture uses 220 verifiably absent child PIDs and an absent
owner PID, with complete retained creation identities, plus one incomplete
Run-owned record whose unresolved evidence must be preserved. It seeds 400 messages,
starts two public SDK clients, requires readiness below 10 seconds and first
concurrent Session/history reads below 2 seconds, verifies all 220 complete
exited-tree records are reclaimed and checks saved messages remain unchanged.
It then verifies the exact Host/Windows Job shutdown, starts a new Host generation and resumes the
same history with the unresolved record byte-for-byte unchanged. The fixture
HOME is deleted only after the final verified shutdown. It invokes no model,
shell command or user Session. The Host and HOME belong only to this fixture.

## Reproduction and diagnosis

The original 2026-10-28 report recorded Host birth-to-ready at approximately
49.2 seconds and a later first selected-Session read at 16,011 ms. Those two
observations alone did not identify a common cause.

On 2026-10-29 the actual default-home cold startup reproduced 23,360 ms:
recovery appeared at 1,350 ms and MCP initialization at 23,066 ms. The sweep
retired 160 of 1,352 records. A second, still-unfixed cold startup took 1,904 ms
after those records had been reclaimed: instrumented registered-child recovery
was 366 ms and persisted-Run recovery was 24 ms for 87 statuses. The remaining
1,192 records all had incomplete captures and Run references. The removed 160
records' individual contents were not captured; do not assert their exact
shapes from this count alone.

The earlier 1,191-record copy probe deliberately used a live owner of unknown
identity, bypassing the stale-tree branch. Its fast result did not clear that
branch. An isolated complete-exited-tree reproducer then exceeded the SDK's
60-second startup deadline with 220 records. This exercised real registry
recovery, not a mocked stopwatch. It verified every synthetic child PID absent
and used an ancient creation identity that cannot match a current process.

The Windows unit regression also went RED: repeated complete dead captures
returned `terminated` and spawned helpers instead of using the snapshot proof.
The minimal fix checks the existing `capturedWindowsProcessesGone` result
before termination and passes the already acquired snapshot to it. This avoids
per-record termination and invalidation without changing incomplete/live paths.

## Automated acceptance

From the repository, build the workspace packages and bundled CLI/SDK, then run:

```powershell
npm run build:packages
npm run build:bundle
npx vitest run packages/agent/src/runtime/process-tree.windows.test.ts packages/agent/src/runtime/process-tree.test.ts packages/agent/src/runtime/process-tree.identity-batch.test.ts packages/agent/src/runtime/managed-child-processes.test.ts packages/agent/src/runtime/managed-child-processes.scope.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/managed-child-processes.cache.test.ts
node --test tests/bundled-startup-recovery.test.mjs tests/bundled-shared-host-recovery.test.mjs
```

The bundled startup regression is included in `npm run test:bundle`; it skips
outside Windows. Two deterministic unit cases check 100 complete dead captures
with absent and reused PIDs: one snapshot probe, zero termination helpers.
Existing cases cover live descendants, unknown identities, missing snapshots,
incomplete captures and cache invalidation following a real termination.

Observed after the fix:

- Isolated 220-record reproducer: 1,952 ms, zero remaining records.
- Two-client bundled acceptance: 2,282 ms ready, 47 ms first concurrent reads;
  combined lifecycle run: 2,457 ms / 46 ms. All 400 messages were preserved.
- Actual default-home Host: 1,896 ms ready; reported Sessions
  `20261026_200011_47f836372c903b` and `20261008_104354_7r848c8cf21187`
  read in 23 ms and 8 ms, with 109 and 410 messages respectively.
- Packaged bin/PTY acceptance: two `kodax -r <sessionId>` terminals in different
  directories shared an isolated HOME with 220 exited records. Both emitted
  the restored final history message and normal input prompt in 3,161 ms and
  3,497 ms; no fixture records remained. Both exited through `/exit`. An earlier
  diagnostic harness incorrectly passed the unsupported CLI `--home` option;
  the passing run used the normal `KODAX_HOME`/profile environment and packaged
  bin. Its raw terminal output establishes delivery, not a screenshot audit.
- Process-tree/registry suite: 131 passed, 2 platform skips; startup/transport/
  progress suite: 48 passed; SDK history/exit/owner suites: 36 passed, 1 skip.
  Production/test TypeScript checks and all 14 SDK type bundles passed.

Real-home acceptance happened after the slow baseline had retired 160 records;
it is not a same-input comparison proving the speedup. The isolated fixture is
the causal before/after evidence. The 1,192 unresolved real records were not
deleted, altered to authorize cleanup, or declared successfully terminated.
Graceful lifecycle exit was used only when the real Host accepted an exit;
there was no force kill. These probes ran in the coding tool's filesystem
context, not a claim to reproduce the console-specific view in Issue 372.

## Regression review after `a8f992ff` (2026-10-29)

Independent Standards and Spec reviews found no actionable regression in the
runtime patch. The audit followed every changed cleanup result into its callers:
Run recovery, Bash, worktree, MCP, LSP, sandbox and daemon teardown distinguish
`unknown` from proven success and already accept `already-exited`. The public
capture signature and POSIX implementation are unchanged. Ordinary startup reads
the retained registry identities before its shared snapshot; PID reuse cannot
revive an identity already proven absent. Concurrent unrelated cleanup scopes
supplying newer captures were not stress-tested; do not claim exhaustive race
or non-Windows live-process validation from these checks.

The review strengthened the bundled regression rather than changing runtime
logic. One incomplete Run record is now mixed with the 220 complete exited
records and must remain byte-for-byte unchanged through two Host generations.
The test verifies exact process/Windows Job shutdown with
`waitForRuntimeDaemonShutdown`, not merely shutdown request acceptance, before
starting a replacement or deleting the isolated HOME. After restart it rechecks
all 400 persisted messages and the newest history page. Latest acceptance:
2,547 ms cold readiness, 53 ms concurrent first reads, 1,535 ms resume after
verified shutdown. Both Host shutdowns were verified.

The expanded regression checks completed with 485 distinct Vitest cases passed
and 2 platform skips, plus 7 bundled cases passed:

| Scope | Passed | Skipped |
| --- | ---: | ---: |
| Process-tree/registry, interrupted/generation and SDK shell recovery | 156 | 2 |
| SDK startup/interrupted/exit recovery, daemon startup and cleanup callers | 112 | 0 |
| Real Windows process cleanup, MCP transport, LSP and Bash | 109 | 0 |
| Saved-history wheel/navigation and sandbox startup/boot diagnostics | 108 | 0 |
| Bundled concurrent startup, shared Host refresh/idle exit, CLI generation recovery and Product quit | 7 | 0 |

The bundled CLI recovery cases exercise print and scoped SDK paths with local
scripted model responses; they do not repeat all Ink/classic PTY variants.
Real Windows cleanup verifies that live descendants are still terminated and
incomplete historical Run evidence survives repeated sweeps.

The first broad invocation encountered a missing `packages/coding/dist` during
module resolution: one suite could not collect and one subprocess could not
start. After the package build, both affected suites passed serially (10 cases),
with no runtime source change. Those initial failures are not counted as passes;
the table deduplicates cases whose reruns passed. The strengthened bundled case
also passed separately after its final cleanup changes.

## 2026-10-31 recurrence coverage

The original alpha.10 investigation above remains historical. The locally
rebuilt alpha.11 recurrence is a second initial-recovery branch, not removal
of the complete-exited-tree optimization. Both failed real bootstrap attempts
stopped before runtime readiness; the real registry held 3,264 records, 2,103
without root start identity. Do not clear this registry to make startup fast.

Run the new deterministic cases through the public cleanup API:

```powershell
npx vitest run packages/agent/src/runtime/managed-child-processes.cache.test.ts
```

They failed before their respective fixes with eight OS lookups per eight
records. Missing root identities now require zero OS queries and preserve each
original file byte-for-byte. Known reused identities require one shared snapshot
and zero per-record command-line queries; their original bytes survive in the
existing `.unresolved` quarantine. All process signals in these fixtures must be
existence checks only. Matching identities and unknown snapshot results retain
the original confirmation path and exact termination fences.

The native isolated public-SDK comparison measured 7,286 ms / eight queries
before and 3 ms / zero queries after for eight missing-identity records. A
3,264-record patched sweep took 146 ms. No native probe touched the real home.

```powershell
node --test tests/bundled-startup-recovery.test.mjs
```

This additionally starts the real bundled Host with 512 records covering missing
identities, known PID reuse, and incomplete trees with extinct/reused roots.
The live reused PID is the unrelated test process; absent PIDs are checked before
fixture construction. The two identity shortcuts alone still timed out against
the real default home: incomplete non-Run trees were also paying for a termination
helper per record without gaining cleanup proof. The strengthened bundled case
reproduced that same daemon-startup error in 12,485 ms before the third fix.
Non-Run recovery now reuses the existing incomplete-tree check; known live
retained descendants still require exact cleanup, guarded by a separate test.
Non-Run unknown snapshot evidence alone must not bypass cleanup: the additional
unavailable-snapshot/CIM-confirmed-live-root case failed during review and passed
after restricting the shortcut to known absence or identity mismatch.
It requires readiness below 10 seconds, reads saved history, verifies exact
Host/Job shutdown and repeats recovery in a new generation. All evidence bytes
and saved messages must survive both generations. Observed cold/restart times
were 2,205 / 1,570 ms. The original 220-tree case remained green at 2,597 ms,
with 48-ms first concurrent history reads and 1,509-ms restart. Timings are local
isolated observations, not an SLA or real-home before/after comparison.

The final isolated build also resumed the actual default home in 3,197 ms and
read the reported Session/history in 58 ms. Every one of the 2,908 registry files
present before that attempt survived with unchanged bytes in the registry or
quarantine; auth/config bytes were unchanged. Earlier failed normal recovery
had already quarantined part of the original 3,264 records. This is real-home
acceptance, not an identical-input performance comparison or a registry reset.

The representative standalone LSP suite left six registry files in an isolated
substitute user profile before test-home isolation and zero there afterwards.
`tests/test-home-isolation.test.ts` guards the private fallback and restoration
after environment stubs. Explicit default-path tests must unset `KODAX_HOME`;
ordinary tests must not use a developer's actual home. Nonempty temporary homes
are retained as evidence, not recursively deleted while cleanup is uncertain.
The legacy MCP OAuth test also binds token reads and cleanup to its own temporary
fixture. A sentinel under a substitute profile's token directory must survive
that suite; before the correction it was deleted. The interrupted first broad
run is not counted as regression acceptance. The second broad run was also
interrupted when the third runtime branch was identified; it is not counted.

## Remaining un-attributed observation

The historical 16-second Session read remains un-attributed. A separate isolated
public-SDK probe ran 16 `whoami` tool Runs in full-access temporary Sessions:
all completed in 23,904 ms; 63 sampled Session reads peaked at 1,444 ms (first:
14 ms). This did not reproduce the 16-second observation and is not a passing
result for its exact cause. Issue 371 remains Open for that observation.

Bootstrap `[kodax-startup]` records now contain `time` in UTC, retaining the
existing startupId/PID/phase binding and display-only interpretation. If the
delay returns, retain those records with the affected read's start/end times
and concurrent Run IDs. Do not diagnose it by clearing the registry. Temporary
`DEBUG-371` boundaries were removed. No Sidecar Verifier, memory-finalization,
UI scroll or sandbox policy behavior changes are part of this fix.
