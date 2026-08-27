# FEATURE 295 v0.7.96 Test Guide

## Purpose

Verify that cross-platform trusted text transactions and platform shell
containment are independent production authorities. Text tools must not depend
on ASRT or shell lifecycle state. Windows shell commands receive native token
and Job containment; Linux/macOS shell commands receive per-command ASRT
containment. No platform carries a KodaX workspace-session owner across the
shell lifetime.

## Prerequisites

- Windows 11 on a local NTFS volume, plus Linux and macOS hosts/filesystems for
  the portable text and POSIX shell matrix.
- A v0.7.96 development package containing platform text artifacts, the
  independently protocol- and SHA-256-verified Windows shell artifact, and the
  manifest-pinned ASRT 0.0.65 version/SHA-256 entry.
- One ordinary workspace that is not under the KodaX Runtime/config home.
- `kodax sandbox setup` completed for the shell checks only. Text checks must
  also be run once with setup deliberately unavailable.
- Repeat Windows artifact provisioning with a private custom `KODAX_HOME`.
  The verified text, shell, and pinned ASRT files must resolve below protected
  LocalAppData, and the ASRT artifact directory must not appear in the final
  target's allow roots.
- Linux has `bubblewrap`, `socat`, and `ripgrep`, and its kernel/security policy
  permits unprivileged user namespaces. CI must prove this with a real
  `bwrap --unshare-net --unshare-pid` probe rather than dependency presence.
- For an upgrade, close every old sandboxed command before setup. Confirm setup
  rotates the dedicated account SID and doctor reports
  `windows_v2_acl_cutover_required` before, but not after, the cutover.

## Trusted text checks

1. Stop or rename the ASRT and shell sidecars, then use `write`, `edit`,
   `multi_edit`, `insert_after_anchor`, and `undo` on ordinary authorized files.
   All five operations must work; their diagnostics must not mention setup,
   owner, reset, cleanup, poison, runner, or workspace session.
2. Start a background shell command that remains alive for at least two
   minutes. While it runs, write a different file. The text commit must finish
   without waiting for the command.
   Repeat through root and `/coding` `runKodaX`, `startKodaX`, `runManagedTask`,
   `createKodaXTaskRunner`, `createDefaultCodingAgent`, `KodaXClient`, and `Client`. Register a linked worktree after the direct Run starts and
   confirm the next text transaction observes that live root without restart.
3. From two Runtime processes, read one file at the same revision, pause both
   before commit, then release both. Exactly one mutation must commit and the
   other must return `text_mutation_stale` without overwriting the winner.
4. Repeat with two different files and a test barrier inside both transactions.
   Both transactions must reach the barrier together; elapsed time alone is
   not sufficient evidence.
   Keep independent readers looping across both commits and confirm every read
   is exactly the complete old or complete new revision, never a partial temp.
5. Modify the target with an ordinary shell after the text preflight and before
   locked CAS. The text tool must return stale and preserve the shell content.
6. Kill a Runtime while it owns a text slot lock. A new Runtime must acquire the
   abandoned kernel object, reread, and either commit or return stale. No
   persistent owner, ticket, or recovery record may remain. On Unix an inert
   private lock inode may remain, but its presence must carry no ownership.
7. Attempt the same approved spelling through a symlink, junction, mount/cloud
   reparse point, hardlink, UNC/device/ADS path, mapped remote drive, DOS device,
   8.3 alias, drive-relative path, and a trailing-dot/space component. Each
   attempt must fail closed before modifying the external target.
8. After a successful edit, change the file from a shell and invoke `undo`.
   Undo must return stale and retain the newer shell content.
9. Repeat ordinary write, same-revision contention, different-file parallelism,
   process-death recovery, symlink/hardlink rejection, and shell-before-CAS on
   Linux and macOS. Confirm Unix uses one fixed per-UID `flock` coordination
   root across different `KODAX_HOME` and `TMPDIR` values, `fsync`s the file
   and parent, preserves ownership/mode/xattrs/Linux flags/macOS extended ACL
   and file flags, loads
   the addon through a verified no-follow descriptor below the mode-`0700`
   protected addon state root, and does not interpret inode presence as held ownership.
10. Inject a failure immediately after Windows atomic rename and at Unix parent
    directory `fsync`. The target must remain complete and present; the caller
    must receive a pre/post receipt as `text_mutation_commit_uncertain` and
    reject a retry based on the old revision as stale. Existing-file edits must
    retain their Undo backup; uncertain Undo must rebind to the new revision and
    complete on a later CAS-checked Undo. New-file uncertainty must report a
    missing pre-state without creating a delete-style Undo entry. Confirm Linux
    ZFS and casefold directories fail closed.
11. Create a Windows file through the restricted sandbox account, then replace
    it twice through trusted Write. Repeat after moving the file between
    directories so it carries stale inherited ACEs, and after assigning an
    explicit low-integrity mandatory label. All writes must succeed,
    the replacement must be trusted-host-owned, and the ordered immediately
    effective ACE type/SID/mask/order must match even if the filesystem
    canonicalizes DACL protection/inheritance control. Stale inherited
    authority must not be copied from an old parent. The obsolete low label must normalize to
    ordinary host integrity; higher or unknown labels must still fail closed.

## Shell checks

1. Start shell commands concurrently from two policies, two Sessions, and two
   Runtime processes. All must reach the runner `Ready` state; no command may
   own or queue a filesystem-effect lifecycle lease.
   Then occupy the first three ASRT ports in `60080..60089` and start four
   same-network-policy commands in one Runtime behind a target barrier. All
   four must reach the target through one shared broker. Releasing one command
   must not close the broker while another is live; an immediate next command
   may reuse the short idle broker. A changed network policy or rotated sandbox
   account SID must create a distinct broker and must never inherit the first
   policy's callback. Do not interpret Issue 308's documented distinct-broker
   capacity as permission to share unlike policies.
2. Exercise stdin with empty input, binary data including NUL, multi-megabyte
   input, and a slow consumer. Verify explicit EOF exactly once, bounded
   backpressure, harmless early EPIPE, cancellation, peer loss, and one terminal
   exit frame. Keep the control stream open after `CloseStdin`; a timed command
   must receive `Terminate`, drain its target and descendants, publish and
   validate the nonce-bound terminal record, return the original timeout, and
   allow the next command to run immediately. Verify control/events use separate
   account-ACL-protected pipes with opposite protocol directions,
   connected to the same authenticated runner PID.
3. For every target, prove it is created suspended and belongs to a
   no-breakaway, kill-on-close Job before `Ready` and resume.
4. Kill the target, runner, then host in separate runs. Descendants must drain.
   A subsequent trusted Write/Edit must still succeed without reading shell
   recovery state.
   Separately kill the shared native controller while a target and descendant
   are live. The broker must observe the exit, the Job must drain, and a later
   shell call must create a new broker and reach the target. Verify the
   controller pipe is protected, owned by the exact host SID, contains only
   Host/SYSTEM full-control ACEs, rejects restricted and remote clients, and
   serves a burst of trusted host connections without starvation.
5. Start a real restricted `cmd.exe`/Node target and verify exit 0 with no modal
   Windows Application Error. Confirm the target references a nonce-bound
   private desktop rather than `Winsta0\\Default`. While policy B remains on
   that desktop, run a native probe under policy A and confirm `OpenDesktopW`
   returns access denied.
   Repeat with a write root and a read-only root below a protected private
   parent. Node `realpathSync` and the declared root must work, while parent
   enumeration, a known sibling read/write, and child ACE inheritance remain
   denied. Run four same-policy shells concurrently with one shared `denyRead`
   root and verify all reach the target, all four reads fail, execution receipts
   are independent, and no receipt remains after Job drain. Kill one native host
   while that deny is active; trusted Write must still succeed, and the next
   shell must recover the exact stale receipt by PID creation time. A different
   write root must derive a different stable clause capability. Replace or
   remove a receipt target before recovery and verify shell admission remains
   fail-closed with the receipt retained; trusted Write/Edit must remain usable.
6. On Linux and macOS, overlap separate ASRT bubblewrap/Seatbelt commands and a
   trusted text write. Verify there is no KodaX workspace-session process,
   owner/reset/poison record, or filesystem-effect lease spanning the command.
7. On POSIX, force a failure that proves the wrapper could not spawn the target.
   `runKodaXSandboxed()` must return `unavailable`,
   `sandboxed: false`, `reason: backend_launch_failed`, and a bounded diagnostic;
   it must not return a completed exit code. A spawned wrapper that exits without
   target-start attestation is instead `execution_uncertain` and must not be retried.
8. Drop, truncate, oversize, or bind the broker control frame to a different
   invocation/backend after target start. The public result must be
   `execution_uncertain`, must warn against retry, and must never claim the
   command did not run. Confirm the sandbox/fallback target cannot write to the
   broker control channel (regardless of unrelated descriptor-number reuse) and
    no request/observation file can alter authority.
9. Verify the Windows request/terminal directory has no reparse point, is
   host-owned, uses a protected DACL with exactly host and SYSTEM full-control
   ACEs, and cannot be read by a restricted target. Submit public read/write
   allow grants at the directory, its parent, and a child; each must fail before
   doctor or target launch. Exact/descendant deny roots must also fail, while the
   normal native-cache ancestor deny remains accepted. Then bypass the SDK
   policy check with forged allow-overlap and exact-control-deny native requests;
   confirm native read-back rejects both before the target can publish a marker,
   the control DACL remains exact, and a subsequent shell succeeds.
10. Add an extra inheritable Users ACE to a host-owned control directory that
    contains both an expired request from a dead PID and one attributed to a
    live PID. Doctor must report setup required without changing the DACL.
    Explicit setup must first prove the sandbox SID idle, retire only the dead
    expired request, and stay fail-closed on the live record. After its owner
    exits or the record is removed by normal cleanup, setup must restore the
    exact host/SYSTEM-only DACL and make doctor ready. Repeat with an unknown
    owner, malformed/unexpired record, and `windows-deny` receipt; setup must
    preserve them and return precise recovery guidance.
11. With the workspace root writable, try to read, open, replace, and delete
    `.kodax/runtime` state from the restricted target. Every operation must be
    denied while ordinary workspace files remain readable/writable.
12. Put an inherited direct Modify ACE for the dedicated sandbox user on a temp
    ancestor, create a fresh workspace below it, and start a shell after reboot
    and after setup. The old user ACE must not reject admission, and exact
    `AllowRead`/`AllowWrite` capability ACEs must still be installed. No
    recursive ACL cleanup, ancestor traversal ACE, or account rotation is
    permitted as the recovery mechanism. Snapshot the private ancestor DACL
    before launch and prove it is unchanged afterward. Then prove nested Node,
    cmd, and PowerShell subprocesses work and that a fresh `%TEMP%` root reaches
    the target inside the existing 15-second budget;
    keep Issue 309's explicit/protected child-DACL bypass documented as open.
13. Complete setup before one exact sensitive Agent Home directory exists, then
    create that directory and perform a cold shell admission from two Runtime
    processes. Native no-follow guard installation must be idempotent under the
    owner-recovering cross-process mutex, both commands must proceed, and no
    command-lifetime lock may remain.

## Packaging and regression gates

- The npm package and Bun Windows distribution load and hash-check the text
  binding independently from `kodax sandbox doctor` and `sandbox setup`.
- The Windows shell sidecar protocol, architecture, and hash match the host.
- The release manifest's ASRT 0.0.65 digest matches the exact installed and
  bundled `srt-win.exe`. Cold preparation rejects modified source bytes before
  materialization, and broker startup rejects modified staged bytes before any
  restricted target starts.
- Import the embedded-manifest-pinned ASRT source once from a two-link
  package-store fixture. It must materialize a byte-identical, single-link
  protected cache executable. Mutating the linked source afterward must fail
  digest validation; concurrent growth beyond the size bound must fail before
  an unbounded read. A filesystem development manifest or source with multiple
  links must be rejected. The protected cache and its ACL/link-count
  requirements must not be relaxed.
- Read back the protected Windows store ACLs: text is Host/SYSTEM-only, shell
  grants read/execute to the dedicated sandbox group SID, and ASRT grants
  read/execute to local Users. No sandbox/local-Users trustee may have
  write/delete authority.
- A production dependency-graph test proves all five text tools cannot reach
  ASRT text-helper, workspace-session, runner, or filesystem-effect symbols.
- Hold a Session `sequence` cursor from another Windows process without
  delete sharing and verify event persistence continues. Hold it temporarily
  without write sharing and verify bounded retry succeeds after release;
  truncate the cursor and verify restart reconstructs the next sequence from
  durable event ledgers without duplicate sequence numbers.
- Native release matrices contain the text artifact for Windows x64, Linux
  x64/arm64, and macOS x64/arm64; the Windows shell artifact remains Windows-
  only.
- CI executes the native transaction smoke on matching GitHub-hosted
  architectures (`windows-latest`, `ubuntu-24.04`, `ubuntu-24.04-arm`,
  `macos-15-intel`, and `macos-15`). Linux and macOS lanes also run
  `tests/feature-295-posix-shell-policy.test.ts` with
  `KODAX_REAL_POSIX_SANDBOX=1`; a skipped POSIX gate is not release evidence.
- The release matrix builds and executes every platform archive on its native
  architecture. Cross-compiled artifacts with `smoke: false` do not satisfy
  this gate.
- Every packaged Bun executable must pass `kodax doctor --json --native-text`
  on its matching native runner, proving that the shipped trusted-text addon
  loads, verifies its digest, and reports protocol 4.
- The release job must install the exact audited universal npm tarball into a
  clean temporary prefix and run the same `doctor --json --native-text` gate
  through the installed package entry point. Testing the source checkout or a
  pre-pack staging directory is not package evidence.
- Existing POSIX text behavior, Windows/POSIX shell behavior, protected Agent
  Home policy, linked worktrees, output spooling, cancellation, and background
  process cleanup suites remain green.
- Confirm a cold installed package can prepare Windows shell directly without
  a preceding in-process doctor call; slow static preparation must not consume
  the target's fresh 30-second native launch budget.
- Confirm release notes and doctor documentation retain Issues 307, 308, and
  309: the final
  target is creation-time Job-contained, while eliminating the ASRT-created
  runner's pre-main window requires an upstream creation-time security
  contract; exact-policy broker sharing does not provide Codex-style
  identity-routed ingress for unlike policies. Neither closure is claimed by
  FEATURE_295. Stable root capabilities also do not claim to override a child
  DACL deliberately widened to an ambient Codex-compatible trustee by its owner.
