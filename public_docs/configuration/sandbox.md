# Sandbox

KodaX supports an optional OS-level sandbox (ASRT) that contains file-system and
network access for model-issued shell commands.

## Activate the sandbox

```bash
kodax sandbox doctor    # Check readiness
kodax sandbox setup     # Activate
```

`kodax setup` and first-run setup also check sandbox readiness once.

## Platform backends

| Platform | Backend | Dependencies |
|---|---|---|
| **Windows** | Restricted sandbox account + network policy | None (UAC prompt on first activation) |
| **macOS** | Seatbelt (`sandbox-exec`) | ripgrep (`brew install ripgrep`) |
| **Linux** | bubblewrap | `bubblewrap`, `socat`, `ripgrep` |

KodaX never runs `sudo` or a package manager automatically. If the sandbox is
not active, deterministic safe operations and Auto[LLM] decisions keep the same
permission behavior; only OS-level containment is absent. Ordinary runs do not
repeatedly prompt for setup.

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

## Windows workspace Shell behavior (v0.7.86)

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
revisions in v0.7.86. The current contract is `sandboxRuntime:5`: auto-start
replaces an idle v4-or-older Windows daemon and fails closed while it is busy.
The v5 advance marks self-healing Windows cleanup
(`delayedEffectDrainRecovery: 'automatic'`,
`sameBootAclRecovery: 'sandbox-user-process-probe'`): the machine-global
cleanup Job is recoverable across reboots, recovery tickets repair without
operator input, and background retries observe the exact daemon and supervisor
process generations. Do not
delete `model-filesystem-effects.lock` by hand; on Windows the coordinator
state lives under `C:\ProgramData\KodaX\sandbox-runtime\runtime\`.

## Concurrent text tools (v0.7.94)

Runtime `write`, `edit`, `multi_edit`, `insert_after_anchor`, and `undo` may
overlap a compatible live Bash lease. Snapshot and commit use the same ASRT
workspace policy, with same-path FIFO. A covered workspace target fails closed
when that sandbox is unavailable. Hard-linked workspace targets are rejected.
Windows sandboxed git trusts authorized repo roots only
(`gitSafeDirectory: authorized-repo-roots`) and never emits `safe.directory=*`.
Linked-worktree and submodule relationship files are read through strict byte
bounds before that trust. Sandboxed text-helper stdin failures stay on the
operation Promise. A missing workspace directory omits the concurrent text
sandbox at Run start instead of aborting the Run.

## Background commands and session reuse (v0.7.96)

A long-lived background command (for example a dev server started through the
`bash` tool) no longer interferes with later sandboxed tool calls on Windows:

- The workspace session it shares stays cached and reusable, so subsequent
  `write`/`edit` calls execute sandboxed instead of failing or falling back.
- Session cleanup defers behind live leases and never terminates a running
  background command; cleanup converges automatically after the command exits
  (worst case ~5 s later), and a deferred close that waits on a leaked lease is
  reported through diagnostics rather than killed.
- Cleanups that never started no longer poison the Windows sandbox account, so
  the "unavailable until reboot" lockout this produced in v0.7.95 is gone.
- Standalone SDK admission (see below) fails with a structured contention
  error while a leased session is active instead of terminating it.

When a sandboxed text mutation is unavailable, the error carries a structured
reason: `not_ready` (setup or readiness), `not_selected` (the call was not
admitted to the sandbox policy), `session_reset_pending`, or
`acl_transition_pending` (a same-policy reset or an account-wide ACL
transition is in flight; retry after it settles). Runtime event consumers see
the same reasons on `tool.sandbox` fallback observations.

## SDK sandbox

SDK callers pass the same shape per Run as `KodaXOptions.sandbox`, so concurrent
Runs can use different lists without mutating process-global configuration.

```ts
await runKodaX({
  provider: 'openai',
  sandbox: { envPass: ['GH_TOKEN'] },
}, 'Inspect the authenticated repository.');
```

SDK embedders can also use the standalone sandbox capability independently
through `@kodax-ai/kodax/sandbox`. Since v0.7.96, a standalone sandboxed run
does not terminate a live workspace session: while a leased session is active
(typically a long-running background command inside a Runtime), standalone
admission rejects with a structured contention error after a short grace
period — retry once the background command completes. Other `unavailable`
results keep carrying the doctor snapshot for setup guidance.

## See also

- [Permissions](./permissions.md) — Permission modes and Auto Mode
- [Configuration files](./config-files.md) — Config.json reference
- [SDK overview](../sdk/overview.md) — SDK sandbox subpath
