# FEATURE 297 v0.7.96 Test Guide

## Purpose

Verify the four permission profiles, sandbox-first execution, host-boundary Auto[LLM] review, Exec Policy, and legacy Auto[RULES] migration introduced in v0.7.96-alpha.4.

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
2. Confirm no OS sandbox and no Auto reviewer are used.
3. Confirm a normal outside-workspace read/write is not blocked by legacy Agent Home or protected-path gates.
4. Confirm an administrator-forbidden Exec Policy rule still blocks.
5. Confirm a built-in critical-effect command blocks when unmatched.
6. Add an exact user allow for that concrete command and confirm it overrides only the built-in critical fallback, not an administrator forbid.

## Exec Policy

1. With no policy files, run `kodax execpolicy check -- <safe command>` and confirm the result is unmatched/allow-by-profile and nothing executes.
2. Add user `allow`, `prompt`, and `forbidden` rules to `~/.kodax/exec-policy.jsonc` using comments, trailing commas, token unions, and qualifiers.
3. Confirm the strictest matching decision wins and output identifies source, rule, and justification.
4. Confirm a partial allow does not override a critical compound command.
5. Confirm every statement and pipeline stage of a compound command is evaluated.
6. Confirm project policy is ignored until that exact canonical project root is trusted by the host.

## Environment, Filesystem, and Network

1. Define a disposable environment variable and confirm a sandboxed Bash command inherits it without `sandbox.envPass`.
2. Confirm fixed KodaX/Electron execution-control variables remain absent from the target environment.
3. Confirm sandboxed reads can inspect host files, Agent Home, credential paths, and the real global Git configuration.
4. Confirm writes succeed in the workspace and system temporary directory but not arbitrary host locations.
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

## Windows ACL Upgrade

1. On a disposable native artifact-cache root, reproduce the canonical allow
   boundary plus old machine-capability and logon-SID deny residues.
2. Confirm new native requests do not include the artifact-cache root in
   `denyWrite` and can pass the control-boundary preflight.
3. Confirm provisioning and admission leave all historical deny entries
   unchanged, including an administrator-added deny with the same SID/mask
   shape as a former KodaX entry.
4. Confirm the native artifact cache and workspace ACL counts do not grow after
   repeated commands or after rebuilding the native artifacts.

## Regression Closure

- Run the focused permission, Auto reviewer, sandbox, Runtime, CLI, config migration, ACP, and daemon tests.
- Run repository typecheck, lint, full tests, coverage, and build.
- Confirm generated configuration/help no longer advertises Auto[RULES], `/auto-engine`, or `sandbox.envPass`.
