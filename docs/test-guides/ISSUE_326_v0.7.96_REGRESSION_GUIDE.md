# Issue 326 — Windows Sandbox Concurrency Regression Guide

## Goal

Prove that Windows sandbox admission has no command-lifetime/global
coordination path and that setup, ACL, broker, and terminal recovery cannot
recreate the observed 60/75/240-second stalls.

Use a disposable Windows sandbox account/workspace. Build the current native
artifact first. The first current client must publish a missing content hash
automatically; run `kodax sandbox setup` once only when the account/setup
generation itself is absent or stale. Protocol 9/setup generation 9 and
`sandboxRuntime:10` is required; do not test a protocol-9 TypeScript bundle
against an older native sidecar.

## Automated gates

```powershell
npm run build:native
npx vitest run src/windows-native-artifacts.test.ts src/sdk-runtime-daemon-upgrade.test.ts
npx vitest run src/windows-sandbox-v2.test.ts src/sandbox-runtime.test.ts
npx vitest run packages/coding/src/tools/bash.test.ts
npx vitest run packages/coding/src/tools/worktree.test.ts
cargo test --manifest-path native/windows-sandbox-v2/Cargo.toml
$env:KODAX_REAL_WINDOWS_SANDBOX_V2='1'
npx vitest run tests/feature-295-windows-v2-policy.test.ts
```

Expected:

- native protocol is 9 and the setup marker is generation 9;
- an idle older daemon is replaced, a busy older daemon is not force-killed,
  a newer daemon is not downgraded, and an unknown/non-SemVer owner is not
  mutated;
- a missing current artifact hash self-publishes once with a protected
  owner/DACL; every warm command performs local stable-identity/path/hash
  verification without PowerShell, and byte drift fails closed even when file
  timestamps are otherwise unchanged;
- two independent processes racing to publish the same missing hash converge on
  one complete image with no staging residue or global mutex;
- pre-Resume cancellation terminates the exact host tree without the extra
  12-second terminal wait, while post-Resume termination still requires durable
  Job-drain evidence;
- the generation-9 marker retains the existing valid random filesystem-capability
  nonce; generation 8 remains the one-time legacy ACL migration proof;
  setup first publishes a protected non-ready `installing` marker; one setup-only
  elevated parent receives an explicit base64 envelope, verifies that exact
  marker, and synchronously converges NUL compatibility plus profile top-level
  read capabilities. The caller publishes ready only after success, no helper
  overlaps ordinary admission, and the shared system Temp root is never an
  ordinary-admission ACL target;
- the native/unit suites have no global-ACL-mutex assertion or timeout;
- two independent Runtime processes pass both cold cases on roots containing at
  least 24,000 entries: the exact same write root, and ancestor-read/child-write.
  The second starts and completes in less than 15 seconds while the first
  remains alive, and the first capability remains installed;
- four same-policy commands succeed while three consecutive fixed proxy ports
  are occupied;
- an independent Runtime cannot exit with Node's unsettled-top-level-await code
  while its shared broker is starting or leased;
- timeout/cancel returns only after Job-drain proof;
- dead, aged atomic staging is retired during explicit control repair, while a
  live creator's state remains fail-closed.
- concurrent Windows denyRead policies all return `unsupported_policy` before
  target start, DACL mutation, or execution-receipt creation;
- a same-SID setup republishes a fresh generation nonce while preserving the
  healthy fixed identity; old prepared requests fail before target start;
- a short caller timeout does not poison another caller sharing the same broker,
  including when the patient caller starts only after the short caller returns;
- five distinct active broker leases remain live while a sixth fails promptly
  before target start, and idle brokers release fixed proxy ports after the
  bounded reuse grace;
- setup can retire a pre-cutover immutable denyRead receipt without making
  ordinary admission scan or wait on that migration state;
- foreground Bash and the public SDK release prepared requests after a
  synchronous spawn failure, and the SDK refuses a changed setup generation
  without spawning the native host;
- rejected/closed/oversized broker-control output still releases the prepared
  Bash request, and asynchronous background spawn rejection is reported as a
  pre-start failure rather than success with `PID: undefined`;
- a foreground or background target that exits before start attestation returns
  still preserves output, records its exit, and releases its prepared request;
- an already wrapped quoted executable under Windows `cmd /S /C` reaches the
  real target with quoted and unquoted final arguments and exits 0 instead of
  producing a path-not-found footer;
- after controller loss, cleanup detaches the failed broker generation even
  while another lease remains live; the holder is not stopped and an immediate
  same-authority command starts on a fresh generation without waiting; detached
  processes remain counted against the five-broker live capacity until exit;
- a broker spawn error followed by `close` but no `exit` does not consume live
  capacity, while an unconfirmed termination remains counted until its actual
  process closes;
- a native-host bootstrap-pipe delivery timeout does not retire the already
  healthy shared broker because the broker has not yet participated in that
  phase;
- each native startup/control phase is bounded to 15 seconds without replacing
  the command deadline; cleanup-proven pre-Resume failure reaches the existing host
  permission boundary, while started/uncertain work is never replayed;
- after lifecycle/Job-drain proof, injected `EPERM` while deleting one command's
  private Temp leaf preserves the proven result and emits a warning; cleanup
  never removes the shared hashed parent, and an overlapping or subsequent
  shell starts without waiting on that housekeeping;
- failed Git Job binding with an unknown root drain retains managed-child
  recovery until the tree is proved gone.

For npm-linked upgrade recovery, leave one idle daemon from the preceding build
running and start two `kodax -r` clients concurrently. Exactly one temporary
upgrade client must perform the fenced replacement; both clients must reconnect
to the current daemon and run sandboxed Bash. Repeat with the second client
attaching after the first client's preflight, then again after its durable
prepared-exit ticket but before the revision CAS. Repeat the prepared-ticket
case with three clients: one follower resumes the ticket, the others observe
the owner change, and every client reconnects. A busy old daemon must remain
untouched and return the existing structured incompatibility instead.

## Manual two-process Bash/write overlap

1. Open two terminals in different workspaces with the same current KodaX
   build.
2. In terminal A, start a sandboxed background Bash process that writes a
   `ready` marker, remains alive for 120 seconds, then writes a `done` marker.
3. While A is alive, in terminal B run `whoami`, delete and recreate a workspace
   file, and run a short network command.
4. In both terminals inspect the identity/start output. Each Bash target must
   run as the restricted sandbox account. The trusted text write remains a host
   transaction.

Pass conditions:

- terminal B starts promptly; it must not wait 60, 75, 120, or 240 seconds;
- A remains alive while B completes;
- B's delete/recreate succeeds within its own policy;
- each Bash target's `TEMP`, `TMP`, and `TMPDIR` resolve to its own empty child
  below system Temp, and no command rewrites the shared Temp/AppData DACL;
- A reaches `done` at its requested time;
- no output contains `ACL transaction mutex timed out`, `ACL authorization
  deadline expired`, or `protocol 9 failed`;
- no `model-filesystem-effects.*` file is created or consulted by the current
  processes.
- a normal persistent capability grant never reports or waits on an `AclRoot`
  mutex name; cold convergence uses `SET_ACCESS` plus DACL readback, and
  unrelated roots remain independent;
- concurrent denyRead runs do not start and create no new
  `windows-deny-*.json` receipt;

## Same-object and worktree boundaries

1. Start concurrent trusted edits of the same file from one Runtime. Confirm
   they serialize through the text transaction/CAS and do not lose an update.
2. Start edits of two different files. Confirm they overlap.
3. Start two worktree operations against different target paths. Confirm KodaX
   adds no repository-wide owner/fence; Git's own locks decide real repository
   conflicts.
4. Start two worktree operations against the same exact target path. Confirm
   the process-local path queue prevents an internal same-path race.

## Setup/admission cutover

1. Start a protocol-9 command and pause it after admission but before target
   `Started` using the test hook.
2. Start setup. Marker replacement must wait because the host owns a
   non-delete-sharing marker handle.
3. Release target start. Confirm the resume and started records become durable,
   then setup may replace the marker.
4. Supply a protocol-9 request without marker path/digest. Native decode or
   validation must reject it before ACL mutation/target start.
5. For a protocol-8-or-older migration fixture, create both the legacy cutover marker
   and an obsolete drain marker. Setup must remove both without a 301-second
   wait and preserve a healthy account SID/group.
6. Corrupt or remove the account identity and confirm only this destructive
   repair path waits for the old SID to become idle before rotation.

## Failure interpretation

- Normal-token access accepts effective inherited ACLs and performs no shared
  DACL write. Missing exact restricted capabilities never wait on a KodaX ACL
  mutex. Exact same-root policies derive the same stable capability; the
  ancestor-read/child-write case must not overwrite the ancestor capability.
- A same-repository Git operation may encounter Git's own lock/conflict. That
  is not a KodaX sandbox admission mutex.
- Explicit destructive setup can wait for a damaged live old SID. Ordinary Bash,
  write, and worktree admission must never wait on the setup lock.
- Missing/replaced deny targets and malformed terminal evidence remain
  intentionally fail-closed; they must not be converted into success or an
  unsandboxed replay.
