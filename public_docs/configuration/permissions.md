# Permission Modes

KodaX controls file-system and shell-command permissions through four profiles.

## Permission profiles

| Mode | Behavior |
|---|---|
| **Plan** | Read-only analysis. KodaX inspects code and proposes a plan but makes no edits. |
| **Edits** | Trusted text edits apply directly; eligible shell commands try the sandbox first and ask only at a proven host boundary. |
| **Auto[LLM]** | Uses the sandbox first; only a proven pre-start host boundary is reviewed by the LLM. |
| **Full Access** | Runs directly on the host without a sandbox, Auto reviewer, or approval prompt. |

In the REPL, **Shift-Tab** cycles Plan → Edits → Auto[LLM] → Full Access.
Legacy Auto[RULES] settings normalize to Auto[LLM] and never migrate to Full
Access.

## Auto Mode

Auto[LLM] first executes operations inside the OS sandbox. Sandbox completion is
authoritative and silent. Only a sandbox that is unavailable or refuses before
the target starts reaches the host boundary:

- Edits asks the user.
- Auto[LLM] asks the reviewer; allow performs exactly one host attempt, while a
  concern blocks the attempt and tells the Agent to use a safer route.
- A command that started, or may have started, is never replayed on the host.

Reviewer infrastructure failures retry once (90 seconds, then 180 seconds).
Explicit deny does not retry and Auto review never opens its own approval
prompt.

Full Access bypasses sandbox, every approval path, and built-in dangerous-command
fallbacks (including forced deletion and Windows URL launch patterns). Unmatched
commands and explicit `allow` rules run directly. Explicit user, administrator,
and trusted-project `forbidden` rules block; an explicit `prompt` rule is
rejected because Full Access uses Never approval semantics.

Explicit forbidden and prompt rules are also checked inside recognized nested shell entry
forms: `cmd /C`/`/K`, PowerShell command selectors and abbreviations, and
strictly decoded UTF-16LE `EncodedCommand` payloads. If a nested body cannot be
lowered reliably, KodaX keeps the complete outer argv opaque. Exact
outer/interpreter policy still applies; otherwise Edits or Auto[LLM] performs
the normal host-boundary decision. Parse uncertainty alone is not a critical
effect. Built-in dangerous-command fallbacks remain active outside Full Access.

Exec Policy rejection text is JSON containing `code`, `denialSource`, `source`,
`sourcePath`, `permissionMode`, `matchedRules`, `retryable`, `remediation`, and
`guidance`. A KodaX built-in or configured rule is not proof of an OS restriction.
For explicit forbids, ask the policy owner to review the rule. For prompt rules
under Full Access, ask the user to select Edits or authorize a policy change.
Malformed policy must be repaired by its owner. Configuration is snapshotted;
start a new Run after an authorized policy change. Never rewrite the command,
switch interpreters, or create a script to bypass a refusal.

Use `kodax execpolicy check --mode full-access -- <command>` to inspect Full
Access policy without execution. Without `--mode`, the checker uses the
conservative built-in fallback contract. This is a token-prefix policy, not a
semantic analyzer of arbitrary script files or dynamically generated programs.

## SDK permission control

SDK callers control permissions through shared Runtime Session settings.
Direct `runKodaX`/Coding consumers own their host guardrails and permission
policy; `KodaXOptions` does not select a Runtime permission profile. The
Runtime owns sandbox-first routing; clients must
not add a second preflight classifier or reconstruct authority from a display
preview. `RuntimePermissionMode` is the canonical four-mode output type, while
`RuntimePermissionModeInput` additionally accepts the legacy
`auto-in-project` input alias.

## Shell Execution Contract

KodaX supports a host-configurable Shell Execution Contract. Runtime Session
settings or an individual Run can select `pwsh`, Windows PowerShell, `cmd`,
`bash`, `zsh`, or an explicit Git Bash executable. KodaX resolves the shell
environment in the effective project cwd and then executes the command through
that same interpreter.

Resolved environments are isolated by contract and cwd, expire after a bounded
TTL, and can be explicitly refreshed. The host environment, including normal
development credentials, is inherited; only fixed KodaX/Electron
execution-control variables and explicit `denyPatterns` are removed.

When `shellExecution` is absent, the established interpreter path is unchanged.

## Full Access text tools and explicit commands

Full Access permits ordinary Git metadata and outside-workspace text targets
through the trusted transaction host. Each operation rechecks authority; it does
not permanently add disk roots. Protected Runtime/control files and native
no-follow, hard-link, revision/CAS and atomicity rules remain enforced. Text
policy refusals identify `builtin_fallback` versus `runtime_integrity`, the
matched rule and remedy. The native text protocol is version 5; older native
bindings must be upgraded together with the host.

Manual `!command`, extension managed commands and nested scope tools enter the
same Session Run and Shell policy. Handwritten input does not revoke an explicit
ban. Stop requests cancellation from the owning Runtime and waits for real tool
cleanup before confirmation. A failed or missing execution owner cannot be
replaced by an ungoverned child process.

## See also

- [Sandbox](./sandbox.md) — Sandbox-first containment and host-boundary routing
- [Configuration files](./config-files.md) — Config.json reference
- [CLI permission control](../../README.md#permission-control) — `--mode` and `/mode`
