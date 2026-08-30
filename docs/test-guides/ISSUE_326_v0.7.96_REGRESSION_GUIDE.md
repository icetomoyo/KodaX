# Issue 326 — Windows Sandbox Concurrency Regression Guide

## Goal

Prove that Windows sandbox admission has no command-lifetime/global
coordination path and that setup, ACL, broker, and terminal recovery cannot
recreate the observed 60/75/240-second stalls.

Use a disposable Windows sandbox account/workspace. Build the current native
artifact first and run `kodax sandbox setup` once. Protocol 8/setup generation
8 and `sandboxRuntime:7` are required; do not test a protocol-8 TypeScript bundle against a protocol-7
native sidecar.

## Automated gates

```powershell
npm run build:native
npx vitest run src/windows-sandbox-v2.test.ts src/sandbox-runtime.test.ts
npx vitest run packages/coding/src/tools/bash.test.ts
npx vitest run packages/coding/src/tools/worktree.test.ts
cargo test --manifest-path native/windows-sandbox-v2/Cargo.toml
$env:KODAX_REAL_WINDOWS_SANDBOX_V2='1'
npx vitest run tests/feature-295-windows-v2-policy.test.ts
```

Expected:

- native protocol is 8 and the setup marker is generation 8;
- the generation-8 marker retains one valid random filesystem-capability nonce;
  one setup-only elevated helper receives an explicit base64 envelope and
  prewarms profile top-level/existing canonical TMP ACLs together with NUL
  compatibility before marker publication; the caller does not release the
  setup lock before helper exit, and exact-object waits obey the overall setup
  deadline;
- the native/unit suites have no global-ACL-mutex assertion or timeout;
- a 120-second holder target remains alive while a second independent Runtime
  starts and completes in less than 15 seconds;
- four same-policy commands succeed while three consecutive fixed proxy ports
  are occupied;
- an independent Runtime cannot exit with Node's unsettled-top-level-await code
  while its shared broker is starting or leased;
- timeout/cancel returns only after Job-drain proof;
- dead, aged atomic staging is retired during explicit control repair, while a
  live creator's state remains fail-closed.
- after a native host is killed, the next denyRead request for the same exact
  object recovers that dead-runner receipt; unrelated roots are not locked.
- a same-SID setup republishes a fresh generation nonce only after the sandbox
  SID is idle; old prepared requests fail before target start;
- a short caller timeout does not poison another caller sharing the same broker,
  including when the patient caller starts only after the short caller returns;
- five distinct active broker leases remain live while a sixth fails promptly
  before target start, and idle brokers release fixed proxy ports after the
  bounded reuse grace;
- an open immutable denyRead receipt does not block its exact owner from
  deleting it; concurrent owner/recovery cleanup converges without a sharing
  violation;
- foreground Bash and the public SDK release prepared requests after a
  synchronous spawn failure, and the SDK refuses a changed setup generation
  without spawning the native host;
- an already wrapped quoted executable under Windows `cmd /S /C` reaches the
  real target with quoted and unquoted final arguments and exits 0 instead of
  producing a path-not-found footer;
- after controller loss with the final broker reference, cleanup retires the
  old broker before an immediate same-authority command starts; another live
  holder is not stopped by a command-local terminal-proof failure;
- failed Git Job binding with an unknown root drain retains managed-child
  recovery until the tree is proved gone.

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
- A reaches `done` at its requested time;
- no output contains `ACL transaction mutex timed out`, `ACL authorization
  deadline expired`, or `protocol 8 failed`;
- no `model-filesystem-effects.*` file is created or consulted by the current
  processes.

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

1. Start a protocol-8 command and pause it after admission but before target
   `Started` using the test hook.
2. Start setup. Marker replacement must wait because the host owns a
   non-delete-sharing marker handle.
3. Release target start. Confirm the resume and started records become durable,
   then setup may replace the marker.
4. Supply a protocol-8 request without marker path/digest. Native decode or
   validation must reject it before ACL mutation/target start.
5. For a protocol-7 migration fixture, remove the legacy marker and simulate a
   pending admission beyond 30 seconds. Setup must not rotate during that
   window; the contract drains the full 300-second Bash bound plus margin once.
6. Interrupt setup after it retires the old marker but before the drain ends.
   The next setup must resume the protected pending/draining state and must not
   rotate the account early.

## Failure interpretation

- A same-object ACL update may wait up to the single five-second ACL phase
  budget. Different objects must not wait on it.
- A same-repository Git operation may encounter Git's own lock/conflict. That
  is not a KodaX sandbox admission mutex.
- Explicit setup can wait for a legacy cutover or live old SID. Ordinary Bash,
  write, and worktree admission must never wait on the setup lock.
- Missing/replaced deny targets and malformed terminal evidence remain
  intentionally fail-closed; they must not be converted into success or an
  unsandboxed replay.
