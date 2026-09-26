# Operations contract audit evidence

Baseline: `git diff c447c0f3...6e5d6298`; read FEATURE_298 D01/T02 and corresponding domain tickets, plus `docs/CLIENT_CONTRACT.md`.

## Confirmed P2: MCP resources survive failed Session creation

FEATURE_298 T12, `docs/features/v0.7.97.md:610`: “Host 能校验/创建/释放每 Session MCP 资源”.

`src/sdk-runtime.ts:7881–7907` creates the live Session MCP runtime before persisting its sidecar, but sets `ownsSessionResources` only after sidecar persistence. A persistence error skips the cleanup. A subsequent Session read cannot find the Session; its private MCP child remains alive and consumes resources until Host shutdown. The successful MCP creation must immediately establish cleanup responsibility; startup rollback should also remove any sidecar created by this attempt.

Reproduction uses a temporary home and the repository's real prewarmed stdio MCP fixture, with a PID marker added to the temporary fixture script. A regular file at `.kodax/runtime/session-mcp` forces the real persistence mkdir to throw EEXIST. Assertions prove create fails, Session read fails, the child remains live immediately and 500 ms later, and runtime close terminates it. No real provider, service or user Session is used.

Command: `npx vitest run src/audit-mcp-create-leak.test.ts --maxWorkers=1 --minWorkers=1`

Result, 2026-09-26 19:28:23 local: 1 file passed, 1 test passed; test 3043 ms, total 20.20 s. The temporary test was removed; its exact executable body is preserved as `mcp-create-leak.repro.ts` (copy to the indicated src path to rerun).

Limit: this reproduction exercises the real Host implementation through an embedded Runtime plus ProductClient adapter, not an IPC round trip. It verifies one deterministic persistence failure, not every startup/cleanup failure combination.

## Read coverage

- ProductClient adapter and public domain shape: sessions, inputs, runs/stop, interactions, settings/config, catalog, MCP, learning, workflows.
- Session create/delete/archive/unarchive, temporary cleanup, settings CAS, goal mutation and derivation seams.
- Input identity/digest, immediate/queued/steer/redirect dispatch, batch/withdraw, Session cancellation frontier.
- Interaction type dispatch and first-answer delegation; ACP Host initialization, prompt observation, permissions and cancellation.
- Ink/classic Host-setting helpers, catalog/default-save commands, Learning binding, Workflow recovery observer.
- Runtime config/effective/default resolution, catalog, Workflow Host startup/control and per-Session MCP ownership.

Read coverage is not exhaustive runtime verification. No manual terminal interaction, Host restart matrix or real service test was performed in this sub-audit. Existing broad suites are run separately by the coordinating audit.

## Confirmed P2: direct Workflow start ignores the product permission default

`docs/CLIENT_CONTRACT.md:94`: “产品 Session 未在 profile 或会话覆盖中指定权限模式时，Host 的有效模式为 `accept-edits`”. FEATURE_298 T22 (`docs/features/v0.7.97.md:689`) specifies workflows “共用 Run admission、有效设置、权限、sandbox、MCP”.

Static chain: ProductClient adapter forwards workflows.start directly to Runtime; `src/runtime-daemon/server.ts:2170–2195` builds the trusted workflow input without a productInput. `src/sdk-runtime.ts:4549–4569` likewise only propagates a supplied productInput. Consequently `src/sdk-runtime.ts:11296–11298` invokes resolveEffectiveRuntimeSessionSettings with productSession=false. In `src/sdk-runtime.ts:21189–21194`, the accept-edits default is only supplied for productSession=true. `src/sdk-runtime.ts:23796–23797` returns undefined policy for the resulting undefined mode, causing an ordinary write to request human permission. Session view uses productSession=true and advertises accept-edits.

Reproduced over a real daemon named-pipe IPC connection, using a temporary home, registered deterministic Provider and inline workflow with one write child. No mode is set in profile or Session. The observed view says accept-edits; the workflow's ordinary write to its own temporary workspace produces a pending permission interaction, and the target file does not exist. The test cancels this interaction and awaits the Run terminal state. It then explicitly sets the very same Session to accept-edits and launches the identical workflow: the file is written without pending interactions. This demonstrates actual authorization divergence, not only a missing field.

Command: `npx vitest run src/audit-workflow-default.test.ts --maxWorkers=1 --minWorkers=1`

Result, 2026-09-26 19:32:50 local: 1 file passed, 1 test passed; test 3153 ms, total 19.43 s. Exact reproduction source is `workflow-default.repro.ts`; copy to the indicated src path to rerun. The temporary src test was moved to this evidence directory. Two polling deadlines are 20 seconds, total case deadline 60 seconds; finally aborts only runs belonging to the isolated Runtime and closes client/Host/Runtime. No production file changed.

Remediation should preserve the distinction between product and low-level Runtime execution while ensuring ProductClient Workflow starts resolve the same product defaults as Session view and normal product input. This audit does not implement a fix or require a new public capability.
