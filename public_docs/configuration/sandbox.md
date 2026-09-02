# Sandbox

KodaX supports an optional OS-level sandbox for model-issued shell commands.
On Windows, ASRT owns network/account setup while the KodaX native runner owns
the restricted token and process Job; macOS and Linux use ASRT's platform
backends directly.

## Activate the sandbox

```bash
kodax sandbox doctor    # Prove target start and check readiness
kodax sandbox setup     # Activate
```

These are host control-plane commands: run them directly in the user's terminal,
not through KodaX's Bash tool. Inside the REPL, use `/sandbox` for read-only
readiness diagnostics. A doctor launched through Bash is itself sandboxed; on
Windows the restricted account cannot inspect the host-owned ASRT state database,
so that nested result does not describe host readiness. This containment is
expected and must not be repaired by granting the sandbox account access to host
control state.

`kodax setup` and first-run setup also check sandbox readiness once. A bare
interactive Windows CLI startup (including `kodax -r`) checks the installed
setup generation before creating the REPL Runtime. An exact current marker is a
coarse, marker-only fast path; command admission still owns full fail-closed
verification. A missing or stale generation enters the existing setup boundary
in a child process, so `kodax -r` and new-session startup keep a live elapsed-time
indicator while concurrent startups converge on one install and followers
recheck the winner. After repair, one no-side-effect command must prove target
start and exit before startup reports the sandbox ready.
The explicit sandbox doctor may republish a missing protected-cache executable
from the exact hash pinned in the running package. It does not run setup, open
UAC, or repair ACL policy; those remain exclusive to `kodax sandbox setup`.
Print-mode, daemon, and SDK startup never activate setup automatically, and
ordinary tool calls never run setup or wait on its lock.

Trusted text tools have a separate native diagnostic because they do not use
the shell sandbox. Run `kodax doctor --native-text` to explicitly load and
verify the packaged trusted-text addon. This check does not require
`kodax sandbox setup` and does not change shell sandbox state.

## Platform backends

| Platform | Backend | Dependencies |
|---|---|---|
| **Windows** | Restricted sandbox account + network policy | None (UAC during activation; healthy generation upgrades preserve the existing SID) |
| **macOS** | Seatbelt (`sandbox-exec`) | ripgrep (`brew install ripgrep`) |
| **Linux** | bubblewrap | `bubblewrap`, `socat`, `ripgrep` |

KodaX never runs `sudo` or a package manager automatically. Edits and
Auto[LLM] attempt the sandbox first. Completion is silently authorized; only a
proven pre-start denial or unavailable backend reaches Exec Policy and the
profile-specific host boundary. A target-started or uncertain invocation is
never replayed.

On Linux, the kernel and host security policy must also permit unprivileged
user namespaces. Some hardened distributions disable them even when
`bubblewrap` is installed. KodaX does not change sysctls or AppArmor policy;
if the broker proves the wrapper could not spawn the target, the standalone SDK reports
`reason: 'backend_launch_failed'` with a bounded diagnostic instead of claiming
that the command completed inside the sandbox. A spawned wrapper that exits
without target-start authority, or any missing or invalid broker-only control
frame, returns `execution_uncertain`; the command may have started and must not
be retried blindly.

## REPL diagnostics

In the REPL, `/sandbox` refreshes readiness and diagnostics without activating
the backend or requesting elevation. Per-command sandbox routing remains
internal and is not shown in normal command history.

## Environment, reads, writes, and network

Sandboxed commands inherit the host environment, including ordinary
development identity, and can access external networks. A fixed internal deny
set removes KodaX/Electron execution-control variables. Reads are broad,
including Agent Home, credential locations, and global Git configuration.
Writes stay bounded to the workspace and platform temporary roots. On Windows,
the target receives an empty private child below the system temporary directory,
and `TEMP`, `TMP`, and `TMPDIR` point to it for the target lifetime. POSIX keeps
its platform-canonical Temp roots and inherited Temp variables. The obsolete
`sandbox.envPass` input is ignored.

## Historical Windows workspace Shell behavior (v0.7.86-v0.7.95)

Windows workspace Shell calls preserve the case-insensitive `PATH`/`Path` and
`PATHEXT` environment contract across the Runtime and sandbox brokers. KodaX
derives read grants from the final resolved PATH and shell executable, including
the bounded traversal needed by profile-manager junctions, rather than granting
the whole user application tree. `cmd.exe` command arguments retain their
verbatim-argument contract, so quoted paths and profile-managed executables are
not re-parsed by an intermediate broker.

The packaged Electron and Runtime smoke paths exercise this behavior. A missing
or unprovable sandbox lifecycle attestation after target start remains
fail-closed; KodaX does not retry a command that may already have started.
Commands with the same canonical workspace, Agent Home, additional filesystem,
toolchain, and network policy can share one Windows policy group across KodaX
processes. An incompatible policy or sandbox infrastructure failure before
target start returns to the separate host-boundary decision. Runtime sandbox capability v3 first fenced older daemon policy
revisions in v0.7.86. The v0.7.95 contract was `sandboxRuntime:5`: auto-start
replaces an idle v4-or-older Windows daemon and fails closed while it is busy.
The v5 advance marks self-healing Windows cleanup
(`delayedEffectDrainRecovery: 'automatic'`,
`sameBootAclRecovery: 'sandbox-user-process-probe'`): the machine-global
cleanup Job is recoverable across reboots, recovery tickets repair without
operator input, and background retries observe the exact daemon and supervisor
process generations. Those `model-filesystem-effects.*` files describe only
the historical v0.7.86-v0.7.95 coordinator. v0.7.96 ignores them and does not
acquire that command-lifetime fence; deleting them is neither required nor a
supported recovery step for an older running binary.

## Trusted text tools (v0.7.96)

On Windows, Linux, and macOS, Runtime `write`, `edit`, `multi_edit`,
`insert_after_anchor`, and `undo` are trusted KodaX host operations. They do not enter ASRT, a
workspace session, the native shell runner, or a sandbox helper. The host
authorizes the final canonical local path and uses a short cross-Runtime
per-file kernel lock, locked reread, revision/content CAS, a flushed
same-directory temporary file, and atomic replacement. Symlink/reparse and
multi-link targets, remote filesystems, and sensitive KodaX/Git control
locations fail closed; Windows additionally rejects UNC/device/ADS and other
alias namespaces. These tools are host-policy
constrained; they are not advertised as OS-token-sandboxed writes.

Atomic replacement is the commit point. If a Unix parent-directory flush or
escape rollback cannot be proven after that point, the tool returns
`text_mutation_commit_uncertain` with the complete pre/post receipt and tells
the caller to reread; do not retry the same edit blindly. Existing-file edits
retain their Undo backup. An uncertain Undo rebinds that backup to the observed
post-commit revision for a later CAS-checked resolution. A newly created file
still reports `before.state: missing` in the error receipt, but this does not
create a legacy Undo entry that deletes the file. Linux ZFS and casefold directories
are currently rejected because their namespace case/normalization semantics are
not yet proven by the native descriptor path.

Arbitrary shell programs do not participate in the text-tool lock. If the
locked final reread observes a shell change, the text operation returns a
structured stale conflict and does not overwrite the newer bytes; an
incompatible writer handle at that reread returns contention. On Windows a
delete/write reservation excludes a new writer between final CAS and the
POSIX-semantics atomic replace while compatible readers keep complete old/new
handles. On Unix, an uncooperative write, replace, or rename after final reread
remains an ordinary operating-system race.
Different canonical files do not share a transaction lock.

On Windows the kernel lock lives in a private namespace bound to the trusted
host user, so the restricted shell account cannot precreate its name. On Unix,
a fixed per-UID system coordination root is host-owned with mode `0700` and is
shared across Runtime config homes; its per-resource inode carries kernel
`flock`. The native binding is stored separately below
`KODAX_HOME/native-text-state-v1` and loaded through a no-follow descriptor
whose digest matches its content-addressed directory. Sandboxed shell policy
may read those roots but cannot write them; standalone SDK policy may deny
reads explicitly. Symlinked Agent Home state fails closed for mutation. File presence
does not mean the lock is held. Process death releases either lock
automatically and no PID/ticket recovery protocol is required. Unix atomic
replacement preserves ownership, mode, extended attributes, Linux
user-modifiable inode flags, and macOS extended ACL/file flags or fails closed.
On Windows, replacing a file left by an older sandbox identity makes the new
file trusted-host-owned while retaining its ordered effective ACE policy. The
filesystem may canonicalize DACL protection/inheritance control at the atomic
namespace commit; stale inherited authority is not copied from a former parent.
A low-integrity sandbox label normalizes to ordinary
host integrity instead of being reapplied. Thus an obsolete sandbox owner cannot permanently
block Write/Edit and does not require manual ACL repair.

## Background commands and session reuse (v0.7.96)

Windows v2 shell commands use a separate native host/runner protocol. ASRT
supplies the network proxy, WFP/CA integration, and the dedicated account;
KodaX supplies a restricted policy token, framed stdin/stdout/stderr, and a
no-breakaway, kill-on-close Job. The target is created suspended and assigned
to that Job before it may run, and a nonce-bound private desktop whose access
requires the exact policy capability avoids both
the known null-desktop loader failure and exposure to the interactive desktop. No filesystem-effect fence, workspace-session
owner, reset, cleanup, or poison gate spans the command lifetime, so shell
commands from different policies, Sessions, and Runtime processes may overlap.
A long-running shell therefore cannot make a trusted text tool unavailable.
Workspace-local `.kodax/runtime` state is readable but excluded from shell
write authority even though the surrounding workspace is writable; Session journals,
cursor files, daemon records, and grants remain host-owned control state.
The private desktop uses an ephemeral full-policy capability. Filesystem write
authority instead uses stable capabilities derived from the setup's persistent
filesystem nonce, final canonical root, and `allowRead`/`allowWrite`/`denyWrite`
clause. Every canonical root receives the same stable capability ACE set; a
read-only command token activates `allowRead` plus `denyWrite`, while a writable
token activates `allowWrite`. The dedicated account,
per-launch logon, and Everyone SIDs remain in the restricting set because real
subprocess creation requires them, matching current Codex; Issue 309 documents
the remaining ambient-trustee child-DACL boundary. The shared sandbox group
supplies the normal access-check pass. The target's enabled Windows traverse
privilege reaches an exact allowed root without persistent ACEs on its private
ancestors; KodaX never rewrites a profile/container DACL merely to make a child
root reachable. Every target is preflighted before mutation. A complete exact
ACL policy is a read-only fast path; effective inherited normal-token grants
are accepted, while a missing exact restricted capability is converged with
`SET_ACCESS` and re-read without a cross-process target mutex. Windows
`WRITE_RESTRICTED` does not enforce restricting SIDs for reads, so per-command
`denyRead` returns structured `unsupported_policy` before doctor, setup, DACL
mutation, or target start. Ordinary command start/exit performs no
execution-logon ACL mutation, cleanup, receipt scan, or
`windows-deny-*.json` publication. Explicit setup alone retires
pre-cutover execution receipts and their legacy ACEs.
Within one Runtime, commands whose canonical network policy and sandbox-account
generation match share one reusable process-level ASRT network broker; their native
requests, restricted policy tokens, controller connections, and Jobs remain
independent. The broker is referenced while starting or leased and detached
from the Node event loop only while idle. A readiness, target-start, or
terminal-proof failure, or trusted terminal proof of runner/controller loss,
immediately detaches that broker generation from reuse;
existing holders are not stopped, and a later caller uses a new generation.
Each startup/control phase has a 15-second bound without replacing the command
deadline. A caller-local timeout releases only its own reference and does not
cancel a healthy shared startup; a sequential caller may still join it. If
an OS bind fails, that broker returns a structured startup error rather than
waiting for another command lifecycle. Different network policies never share
that authority. ASRT 0.0.65 consumes two ports for each distinct broker and has
no authenticated connection identity for routing unlike policies through one
ingress. KodaX supplies a 64-port range for up to 32 exact authorities and lets
the OS arbitrate binds across Runtime processes; it does not add a process-local
capacity gate, evict another idle authority, widen a policy, or serialize shell
lifetimes.
The broker also owns a verified native liveness controller. Its named pipe is
created with a protected Host/SYSTEM-only DACL, rejects remote clients, and
keeps multiple pending instances for concurrent host launches. Restricted
targets cannot connect to or exhaust this control path. Broker/controller loss
closes the affected controller handles and drains their Jobs. A broker-attributed
command failure only detaches that generation from future reuse; it does not close
unrelated active holders.
This authority split and its private-Temp/recovery contract are advertised as
`sandboxRuntime:11`; auto-started clients
replace an idle older daemon and fail closed instead of joining a busy one.
Each loaded embedded Windows native manifest first resolves the exact verified
protected-cache executable for its content hash. Only a missing exact generation
consults mutable package or npm-link source and publishes atomically. This keeps
overlapping old/new processes on their own native evidence schemas without a
shell lock, queue, or command retry.
Upgrading an existing Windows installation enters the versioned setup boundary
once, either from explicit `kodax sandbox setup` or bare interactive CLI startup.
Setup generation 10 upgrades healthy generation 8 or released generation 9 in
place, reuses a healthy fixed account SID/group and filesystem nonce, and records protocol 10 in
protected machine state without replaying completed legacy ACL cleanup.
Generation 8 remains the proof boundary for that one-time migration. Only
missing or damaged account identity rotates.
Every protocol-10 request includes
the marker path/digest; the native host holds the marker without delete sharing
through durable target `Started`, so setup and command start cannot cross.
Doctor and native shell admission remain
fail-closed if that state is missing or mismatched; trusted text tools remain
available throughout. The embedded release manifest pins each native sidecar
protocol/SHA-256 plus the ASRT release version/SHA-256. Verified bytes are
staged in a protected content-addressed LocalAppData store independent of
`KODAX_HOME`; ASRT is checked before materialization and again before broker
startup. Windows text bytes remain Host/SYSTEM-only; the dedicated sandbox
group SID receives read/execute, but not write/delete, on the shell artifact;
local Users receive only read/execute on the pinned ASRT executable.
The current workspace sandbox grants broad host reads, including Agent Home,
credential locations, and global Git configuration. During upgrade, versioned
setup generation 8 removes only the exact obsolete KodaX sandbox-account read-
deny ACEs and keeps a healthy account generation stable.
Unrelated administrator ACLs are preserved byte-for-byte, and an ambiguous ACL
fails closed instead of being rewritten. Ordinary command admission never runs
that legacy cleanup or revokes another Session's shared ACL state; independent
Runtime processes keep separate requests, tokens, control channels, and Jobs.
Each shell receives a unique empty Temp child. The shared system Temp/AppData
roots are never ordinary-admission ACL targets, including when `KODAX_HOME` is
nested below them. Protected Agent Home directories are materialized only when
an actual requested write root contains them; Temp placement alone does not
widen that authority or add a lock, setup call, or shared ACL mutation.
The fixed hashed Temp parent is only a naming container and is not owned or
removed by an individual command. After native lifecycle/Job-drain proof,
KodaX removes only that command's unique leaf; if Windows still reports the leaf
busy after a brief bounded retry, KodaX emits a cleanup warning without changing
the already proven command result. Missing lifecycle proof remains fail-closed.
The ASRT directory is not passed as a final-target policy root. A fixed
System32 provisioner runs only during explicit artifact/setup bootstrap. One
setup-only elevated native parent receives a small explicit base64 envelope,
reads a versioned digest-bound single-use request from the protected control
directory, verifies the protected non-ready `installing` marker, and
synchronously converges NUL compatibility plus profile read capabilities. The
setup caller atomically publishes the ready marker only after confirmed parent
success; no helper overlaps ordinary admission and shared system Temp is not
prewarmed or rewritten;
ordinary command admission verifies already-provisioned artifacts and control
state without launching synchronous PowerShell. Text content and shell stdin
never enter it. Started-or-unknown cleanup succeeds only with a verified Job-
drained terminal record. Control repair may retire an atomic staging file only
after its exact creator PID is dead and two launch budgets have elapsed.

In a bundled build, the package-source ASRT executable may be a package-store
hardlink. KodaX does not trust that link relationship: it performs a
handle-bound bounded read and requires the complete bytes to match the embedded
release SHA-256 before copying them into the protected cache. Filesystem
development manifests and sources remain single-link. The executable used by
the broker still has one link and must pass the protected ACL and digest checks.
This prevents a valid installation layout from being mistaken for sandbox failure.

If a prior host died before a native request was consumed, explicit setup can
self-heal the protected control directory after proving the sandbox SID idle.
It retires only an expired request whose creator PID is dead, an aged
unconsumed network request from a dead PID, or a dead-owner terminal record
that already says `jobDrained: true`. Doctor never performs this cleanup.
Live, unexpired, malformed, unknown, and `windows-deny` recovery records remain
fail-closed instead of being treated as disposable files.

The final target is in its Job at process creation. ASRT still creates the
shared-account runner before KodaX code can apply runner-process hardening;
Issue 307 tracks that narrow upstream pre-main window, which current Codex also
retains. The KodaX host requests inherited error-mode suppression before ASRT
launch and runner code repeats it after entry, but the ASRT-owned cross-account
creation contract still controls loader faults before runner `main`; final target
faults are suppressed. It does not affect trusted text tools. Closing it requires an ASRT
creation-time process/thread security contract or privileged spawn service,
not another post-spawn patch.

Issue 309 documents the remaining Windows compatibility limitation: an explicit
ACE for a retained compatibility trustee can bypass a later root capability.
The ACE may be left by a sandbox command or already exist on an external or
host-owned descendant. KodaX requires exact write capabilities for declared
write roots and group-based normal-pass access for read roots, but the primary account, logon, and Everyone SIDs must remain
for working subprocesses; closing explicit child-DACL reuse needs a different
loader/token architecture.

Linux and macOS shell calls remain ASRT-contained per command through
bubblewrap or Seatbelt/`sandbox-exec`. They do not keep a KodaX workspace-
session owner, reset/poison state, or filesystem-effect lease across the shell
lifetime. On every platform, an arbitrary shell writer is an ordinary OS race
and does not join trusted-text CAS.

## SDK sandbox

SDK command targets inherit the environment of their execution host. SDK
embedders can also use the standalone shell sandbox capability
independently through `@kodax-ai/kodax/sandbox`. Its readiness and setup state
apply to shell/process containment only. A failed or unavailable shell runner
does not change the trusted text-tool path. An unavailable result may include
`reason: 'doctor_not_ready' | 'backend_launch_failed'`; the latter also includes
a bounded `diagnostic` and is never reported as a sandboxed completion. A
separate `execution_uncertain` result means target-start authority could not be
recovered and callers must reread external state before deciding what to do.

## See also

- [Permissions](./permissions.md) — Permission modes and Auto Mode
- [Configuration files](./config-files.md) — Config.json reference
- [SDK sandbox API](../sdk/embedder-guide.md#30-standalone-sandbox-sdk-v0778) — SDK sandbox subpath
