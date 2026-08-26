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
incompatible writer handle at that reread returns contention. An uncooperative
write, replace, or rename after the final reread remains an ordinary
operating-system race.
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
This authority split is advertised as `sandboxRuntime:6`; auto-started clients
replace an idle older daemon and fail closed instead of joining a busy one.
Upgrading an existing Windows installation requires one `kodax sandbox setup`
cutover. Setup waits for old sandbox processes to exit, recovers recorded ACL
work, recreates the dedicated account with a new SID, and records that SID and
the native protocol in machine state. Doctor and native shell admission remain
fail-closed if that state is missing or mismatched; trusted text tools remain
available throughout. Native artifacts are independently checked against the
embedded packaged protocol/SHA-256 manifest and staged in a protected content-
addressed Agent Home store. The restricted account receives read/execute, but
not write/delete, access to its exact runner artifact. A fixed System32
provisioner may run during this artifact bootstrap; text content and shell
stdin never enter it.

The final target is in its Job at process creation. ASRT still creates the
shared-account runner before KodaX code can apply runner-process hardening;
Issue 307 tracks that narrow upstream pre-main window, which current Codex also
retains. The KodaX host requests inherited error-mode suppression before ASRT
launch and runner code repeats it after entry, but the ASRT-owned cross-account
creation contract still controls loader faults before runner `main`; final target
faults are suppressed. It does not affect trusted text tools. Closing it requires an ASRT
creation-time process/thread security contract or privileged spawn service,
not another post-spawn patch.

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
