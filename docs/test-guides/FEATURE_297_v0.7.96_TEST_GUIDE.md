# FEATURE 297 v0.7.96 Test Guide

## Purpose

Verify the four permission profiles, sandbox-first execution, host-boundary Auto[LLM] review, Exec Policy, and inert legacy Auto[RULES] compatibility introduced in v0.7.96-alpha.4.

## Preconditions

- Use a disposable Git repository and a disposable KodaX home.
- Keep a marker command available that can prove whether the host command ran.
- When testing authenticated network access, use a disposable credential and endpoint.
- Do not use a production repository, registry, or remote branch for destructive cases.

## Permission Profiles

1. Open `/mode` and confirm the only displayed profiles are Plan, Edits, Auto[LLM], and Full Access.
2. Cycle modes with the keyboard shortcut and confirm that the same four profiles appear in that order.
3. Restart after selecting each profile and confirm it round-trips unchanged.
4. Seed an old Session with `permissionMode: "auto-in-project"` and `autoModeEngine: "rules"`.
5. Resume it and confirm it opens as Auto[LLM], never Full Access, and the next persistence write omits the legacy engine.
6. Place malformed legacy auto-rules files in user and project locations. Confirm startup is unaffected and the files are neither read, changed, nor deleted.

## Sandbox-First Routing

1. In Edits and Auto[LLM], run a workspace-local command while ASRT is ready.
2. Confirm it executes in the sandbox without a permission prompt or Auto review.
3. Make ASRT fail before target launch and repeat the exact call.
4. Confirm no host command runs before the mode-specific boundary resolves.
5. In Edits, approve once and confirm exactly one host attempt.
6. In Auto[LLM], return allow from the reviewer and confirm exactly one host attempt.
7. Return deny and confirm no host attempt and actionable safer-route feedback.
8. Simulate an uncertain or post-launch sandbox failure and confirm the command is never replayed on the host.

## Full Access

1. Select Full Access and run a normal workspace command.
2. Confirm the mode is read once at Bash entry and no OS sandbox, Auto reviewer,
   sandbox event, or approval prompt is used.
3. Confirm a normal outside-workspace read/write is not blocked by legacy Agent Home or protected-path gates.
4. Confirm an explicit forbidden Exec Policy rule still blocks.
5. Confirm an explicit prompt rule is rejected without creating permission work.
6. Confirm the Codex dangerous-command cases block when unmatched, while the
   retired KodaX-only format/raw-disk/fork-bomb fallback does not.
7. Add an explicit allow prefix for a dangerous command and confirm it overrides
   the fallback, not an administrator forbid.

## Exec Policy

1. With no policy files, run `kodax execpolicy check -- <safe command>` and confirm the result is unmatched/allow-by-profile and nothing executes.
2. Add user `allow`, `prompt`, and `forbidden` rules to `~/.kodax/exec-policy.jsonc` using comments, trailing commas, token unions, and qualifiers.
3. Confirm the strictest matching decision wins and output identifies source, rule, and justification.
4. Confirm an explicit allow prefix overrides only the dangerous-command
   fallback, while stricter prompt/forbidden matches still win.
5. Confirm every statement and pipeline stage of a compound command is evaluated.
6. Confirm project policy is ignored until that exact canonical project root is trusted by the host.
7. Add an administrator `forbidden ["git", "push"]` rule and confirm it also
   blocks `cmd /K`, `cmd /S /K`, PowerShell command abbreviations, and valid
   UTF-16LE `EncodedCommand` forms that invoke `git push`.
8. Confirm malformed encoded commands and uninspectable PowerShell script
   bodies fail closed when administrator forbids exist, while `echo git push`
   and `echo cmd /k git push` remain ordinary unmatched arguments.

## Environment, Filesystem, and Network

1. Define a disposable environment variable and confirm a sandboxed Bash command inherits it without `sandbox.envPass`.
2. Confirm fixed KodaX/Electron execution-control variables remain absent from the target environment.
3. Confirm sandboxed reads can inspect host files, Agent Home, credential paths, and the real global Git configuration.
4. Confirm writes succeed in the workspace and platform Temp roots. On Windows,
   confirm the command uses its private directory named by `TEMP`/`TMP`/`TMPDIR`
   and cannot write arbitrary host locations or sibling system-Temp paths.
5. Confirm unauthenticated and authenticated external network access can succeed inside the sandbox when the inherited environment provides the needed identity.
6. In Auto[LLM], modify global Git configuration: confirm sandbox write refusal reaches the reviewer, reviewer allow produces one host attempt, and reviewer deny produces none.

## Auto Reviewer Resilience

1. Confirm a normal allow returns without a user prompt.
2. Confirm a concrete high-risk result is denied with an explanation that
   narrow informed user direction is required, without opening a Runtime
   approval prompt.
3. Confirm an ordinary deny returns safer-route feedback rather than a generic keyword-based approval flow.
4. Confirm the first reviewer attempt has a 90-second deadline and only timeout/provider/invalid-output failures receive one 180-second retry.
5. Confirm an explicit deny is not retried.
6. Confirm the turn breaker opens after three consecutive denies or ten denies among the last fifty completed reviews; timeouts do not count as denies and the mode remains Auto[LLM].

## SDK, Worker, and Daemon Compatibility

1. From `@kodax-ai/kodax/runtime`, confirm `RuntimePermissionMode` exposes only
   `plan | accept-edits | auto | full-access`, while
   `RuntimePermissionModeInput` additionally accepts `auto-in-project`.
2. Confirm `RuntimeExecPolicyOptions.adminRules` accepts rules without internal
   `source` or `sourcePath`; the Runtime assigns administrator provenance.
3. Confirm embedded and Worker Runtime capability metadata advertises
   `runtimeAutoModeGuardrail:5` and `sharedSessionSettings:2` semantics.
4. Start daemon mode against an idle v4 daemon and confirm the owner is safely
   replaced before the client attaches. Repeat with guardrail v5 plus shared
   settings v1 and confirm the v2 settings gate independently triggers upgrade.
5. Attach explicitly to an incompatible daemon with auto-start disabled and
   confirm it fails closed instead of routing permissions client-side.
6. Inspect the packed declarations and smoke-import the root, `/runtime`, and
   `/repl` entries. Confirm the exact permission, policy, capability constant,
   and canonicalization exports are present.

## Windows ACL Upgrade

1. On a disposable Windows sandbox installation, record a pre-generation-8
   cutover marker, exact legacy sensitive-root guards, and an ambiguous
   administrator/cache deny with the same SID/mask shape as an older KodaX ACE.
2. Confirm doctor reports setup required. Keep one healthy old-sandbox-SID
   process alive and run `kodax sandbox setup`; setup must update in place,
   preserve its account SID/group and filesystem nonce, and not wait for that
   command lifetime. In a separate damaged-identity fixture, confirm destructive
   repair still refuses to rotate a live SID.
3. Confirm exactly one legacy removal runs at generation 8. Generation 10 first
   publishes a protected non-ready `installing` marker, synchronously converges
   setup capabilities, and atomically rewrites it as the ready setup generation
   10/protocol 10 marker only after success.
   A healthy generation-8 installation upgrades in place without replaying
   legacy removal, including while its sandbox SID is active. Protocol-8 and older
   markers must be retired without a fixed hard-timeout drain. The ambiguous
   administrator/cache deny remains byte-for-byte unchanged.
4. Confirm new native requests do not include the artifact-cache root in
   `denyWrite` and can pass the control-boundary preflight.
5. Run repeated commands and confirm ordinary admission invokes zero
   `__persistent-deny-read remove` operations and does not revoke another
   Session's shared ACL state. The native artifact-cache and workspace ACL
   counts must not grow after commands or native rebuilds.
6. Enable `KODAX_REAL_WINDOWS_SANDBOX_V2=1` and run the real dual-process test.
   Its first Runtime reaches the target and remains eligible to run for 120
   seconds; while it is active, a second Runtime with a different policy must
   reach and complete its target in under 15 seconds before the first is released. Release the
   first Runtime only after this overlap is proven. Do not add a serial queue or concurrency-
   disable setting to make the test pass.

## Regression Closure

- Run the focused permission, Auto reviewer, sandbox, Runtime, CLI, config compatibility, ACP, and daemon tests.
- Run repository typecheck, `git diff --check`, full tests, coverage, and build.
- Confirm generated configuration/help no longer advertises Auto[RULES], `/auto-engine`, or `sandbox.envPass`.
