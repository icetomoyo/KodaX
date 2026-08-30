# Permission Modes

KodaX controls file-system and shell-command permissions through four profiles.

## Permission profiles

| Mode | Behavior |
|---|---|
| **Plan** | Read-only analysis. KodaX inspects code and proposes a plan but makes no edits. |
| **Edits** | Trusted text edits apply directly; eligible shell commands try the sandbox first and ask only at a proven host boundary. |
| **Auto[LLM]** | Uses the sandbox first; only a proven pre-start host boundary is reviewed by the LLM. |
| **Full Access** | Runs directly on the host without a sandbox or Auto reviewer, while still honoring Exec Policy. |

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

Full Access bypasses both sandbox and reviewer. Exec Policy still applies its
explicit allow/prompt/forbidden rules, absolute administrator forbids, and the
narrow critical-effect fallback.

Administrator forbids are also checked inside recognized nested shell entry
forms: `cmd /C`/`/K`, PowerShell command selectors and abbreviations, and
strictly decoded UTF-16LE `EncodedCommand` payloads. Invalid nested payloads
cannot be exact-allow overrides. When an administrator forbid exists, a script
body that cannot be inspected is denied rather than treated as unmatched.

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

## See also

- [Sandbox](./sandbox.md) — Sandbox-first containment and host-boundary routing
- [Configuration files](./config-files.md) — Config.json reference
- [CLI permission control](../../README.md#permission-control) — `--mode` and `/mode`
