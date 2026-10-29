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
owner PID, with complete retained creation identities. It seeds 400 messages,
starts two public SDK clients, requires readiness below 10 seconds and first
concurrent Session/history reads below 2 seconds, verifies all fixture records
are reclaimed and checks saved messages remain unchanged. It invokes no model,
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

## Evidence still missing

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
