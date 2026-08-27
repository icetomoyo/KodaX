# Sandbox

KodaX supports an optional OS-level sandbox for model-issued shell commands.
On Windows, ASRT owns network/account setup while the KodaX native runner owns
the restricted token and process Job; macOS and Linux use ASRT's platform
backends directly.

## Activate the sandbox

```bash
kodax sandbox doctor    # Check readiness
kodax sandbox setup     # Activate
```

`kodax setup` and first-run setup also check sandbox readiness once.

Trusted text tools have a separate native diagnostic because they do not use
the shell sandbox. Run `kodax doctor --native-text` to explicitly load and
verify the packaged trusted-text addon. This check does not require
`kodax sandbox setup` and does not change shell sandbox state.

## Platform backends

| Platform | Backend | Dependencies |
|---|---|---|
| **Windows** | Restricted sandbox account + network policy | None (UAC during activation; an upgrade SID rotation may require a second confirmation) |
| **macOS** | Seatbelt (`sandbox-exec`) | ripgrep (`brew install ripgrep`) |
| **Linux** | bubblewrap | `bubblewrap`, `socat`, `ripgrep` |

KodaX never runs `sudo` or a package manager automatically. If the sandbox is
not active, deterministic safe operations and Auto[LLM] decisions keep the same
permission behavior; only OS-level containment is absent. Ordinary runs do not
repeatedly prompt for setup.

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

## Environment variable passthrough

Credential-shaped environment variables are filtered from model-issued shell
commands by default. To expose specific host variables to those command targets:

```json
{
  "sandbox": {
    "envPass": ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]
  }
}
```

The default list is empty. Values remain in the host environment and are never
stored in `config.json`; project configuration cannot extend the list. Matching
is exact (case-insensitive on Windows), and execution-control variables such as
`NODE_OPTION` and `BASH_ENV` remain blocked.

Restart KodaX after changing the host variables or this setting; stop/restart a
persistent KodaX daemon so it receives the new environment and configuration.

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
target start returns the already-authorized command to normal permission
execution. Runtime sandbox capability v3 first fenced older daemon policy
revisions in v0.7.86. The v0.7.95 contract was `sandboxRuntime:5`: auto-start
replaces an idle v4-or-older Windows daemon and fails closed while it is busy.
The v5 advance marks self-healing Windows cleanup
(`delayedEffectDrainRecovery: 'automatic'`,
`sameBootAclRecovery: 'sandbox-user-process-probe'`): the machine-global
cleanup Job is recoverable across reboots, recovery tickets repair without
operator input, and background retries observe the exact daemon and supervisor
process generations. Do not
delete `model-filesystem-effects.lock` by hand; on Windows the coordinator
state lives under `C:\ProgramData\KodaX\sandbox-runtime\runtime\`.

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
cannot read or write either root, and symlinked Agent Home state fails closed. File presence
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
Workspace-local `.kodax/runtime` state is excluded from shell read and write
authority even though the surrounding workspace is writable; Session journals,
cursor files, daemon records, and grants remain host-owned control state.
The private desktop uses an ephemeral full-policy capability. Filesystem write
authority instead uses stable capabilities derived from the sandbox-account
generation, final canonical root, and `allowRead`/`allowWrite`/`denyWrite`
clause. Every read root has an exact allow-read capability and a read-only root
implicitly carries its deny-write capability. The dedicated account,
per-launch logon, and Everyone SIDs remain in the restricting set because real
subprocess creation requires them, matching current Codex; Issue 309 documents
the remaining ambient-trustee child-DACL boundary. The shared sandbox group
supplies the normal access-check pass. The target's enabled Windows traverse
privilege reaches an exact allowed root without persistent ACEs on its private
ancestors; KodaX never rewrites a profile/container DACL merely to make a child
root reachable. Every target is preflighted before one atomic ACL transaction. Windows
`WRITE_RESTRICTED` does not enforce restricting SIDs for reads, so `denyRead`
uses an execution-logon deny under a short ACL mutex. A durable receipt records
the no-follow volume/file identity before mutation; exact cleanup follows Job
drain. A later shell host recovers a crashed owner only when PID creation time
and target identity prove the receipt stale. A missing or replaced target keeps
the receipt and blocks shell admission until repair, but cannot block trusted
text tools.
Within one Runtime, commands whose canonical network policy and sandbox-account
generation match share one process-level ASRT network broker; their native
requests, restricted policy tokens, controller connections, and Jobs remain
independent. Different network policies never share that authority. ASRT
0.0.65 still consumes two fixed-range ports for each distinct broker and has no
authenticated connection identity for routing unlike policies through one
ingress. Issue 308 tracks this capacity difference from Codex; KodaX does not
widen a policy or serialize shell lifetimes to conceal it.
The broker also owns a verified native liveness controller. Its named pipe is
created with a protected Host/SYSTEM-only DACL, rejects remote clients, and
keeps multiple pending instances for concurrent host launches. Restricted
targets cannot connect to or exhaust this control path. Broker/controller loss
closes every controller handle, drains active Jobs, and lets a later command
create a fresh broker.
This authority split is advertised as `sandboxRuntime:6`; auto-started clients
replace an idle older daemon and fail closed instead of joining a busy one.
Upgrading an existing Windows installation requires one `kodax sandbox setup`
cutover. Setup waits for old sandbox processes to exit, recovers recorded ACL
work, recreates the dedicated account with a new SID, and records that SID and
the native protocol in machine state. Doctor and native shell admission remain
fail-closed if that state is missing or mismatched; trusted text tools remain
available throughout. The embedded release manifest pins each native sidecar
protocol/SHA-256 plus the ASRT release version/SHA-256. Verified bytes are
staged in a protected content-addressed LocalAppData store independent of
`KODAX_HOME`; ASRT is checked before materialization and again before broker
startup. Windows text bytes remain Host/SYSTEM-only; the dedicated sandbox
group SID receives read/execute, but not write/delete, on the shell artifact;
and local Users receive only read/execute on the pinned ASRT executable. Fixed
Agent Home and credential read denies are installed once on exact roots through
native no-follow handles; cold admission idempotently guards an exact sensitive
directory created after setup. They are not rebuilt for each shell command. The
ASRT directory is not passed as a final-target policy root. A fixed System32
provisioner may run during this artifact bootstrap; text content and shell
stdin never enter it.

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
host-owned descendant. KodaX requires exact read/write capabilities for normal
declared roots, but the primary account, logon, and Everyone SIDs must remain
for working subprocesses; closing explicit child-DACL reuse needs a different
loader/token architecture.

Linux and macOS shell calls remain ASRT-contained per command through
bubblewrap or Seatbelt/`sandbox-exec`. They do not keep a KodaX workspace-
session owner, reset/poison state, or filesystem-effect lease across the shell
lifetime. On every platform, an arbitrary shell writer is an ordinary OS race
and does not join trusted-text CAS.

## SDK sandbox

SDK callers pass the same shape per Run as `KodaXOptions.sandbox`, so concurrent
Runs can use different lists without mutating process-global configuration.

```ts
await runKodaX({
  provider: 'openai',
  sandbox: { envPass: ['GH_TOKEN'] },
}, 'Inspect the authenticated repository.');
```

SDK embedders can also use the standalone shell sandbox capability
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
- [SDK overview](../sdk/overview.md) — SDK sandbox subpath
