# FEATURE_299 v0.7.96 regression guide

Use disposable Sessions, projects and policy files. The implementation does not
repair a user's Session by deleting Actor snapshots or changing its bytes.

## Automated acceptance

```powershell
npm run build:packages
npm run typecheck
npx vitest run src/trusted-coding-permissions.test.ts src/trusted-coding-entry.test.ts src/windows-text-transaction.test.ts packages/coding/src/client.test.ts
npx vitest run src/sdk-runtime.test.ts -t "Auto|auto|permission|Permission|Full Access|setting|outdated text authority"
npx vitest run src/sdk-runtime-daemon-upgrade.test.ts
npx vitest run src/sdk-runtime.stop-admission.test.ts src/sdk-runtime.tool-invocation.test.ts src/sdk-conversation-history.test.ts packages/repl/src/interactive/storage.conversation-page-admission.test.ts
npx vitest run src/runtime-daemon/server.test.ts src/sdk-runtime.shell-cleanup.test.ts src/sdk-runtime.shell-recovery.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/process-tree.windows.test.ts
npx vitest run packages/coding/src/tools/bash.test.ts packages/coding/src/tools/bash-cleanup.test.ts packages/coding/src/agent-runtime/tool-invocation.test.ts
npx vitest run packages/coding/src/extensions/managed-execution.test.ts packages/coding/src/extensions/session-isolation.test.ts packages/coding/src/extensions/command-lifecycle.test.ts packages/repl/src/interactive/commands-extension.test.ts
npx vitest run packages/coding/src/permissions/exec-policy.test.ts packages/repl/src/permission/standalone-shell-boundary.test.ts src/exec-policy-cli.test.ts src/windows-text-transaction.test.ts
npm test
npm run test:native
npm run build
node --test tests/bundled-text-permissions.test.mjs
cargo fmt --manifest-path native/windows-text-transaction/Cargo.toml -- --check
git diff --check
```

Run native Windows ownership/ACL and real process tests in the normal user test
environment. Tests create their own temporary configuration. Do not set one
global KODAX_HOME for the full suite: existing HOME-mocking tests require their
own configuration roots. Platform-specific native tests run on their matching
OS; Windows execution does not prove Unix handle/CAS behavior.

| Seam | Required evidence |
|---|---|
| Large metadata | First line over 64 KiB, split UTF-8, LF/CRLF/EOF and exact chunk boundary; cold page, continuation and reopen; invalid JSON still rejected; original bytes unchanged |
| Full Access Shell | Real temporary forced deletion succeeds without custom policy; explicit user/admin/trusted-project forbids and prompt rules remain binding, including recognized nested wrappers |
| Refusal source | Stable code, actual denialSource, source/path and matched rules, non-retryable remediation; no invented machine-policy attribution or script rewrite |
| Shared Stop | Actual FileSessionStorage write lock makes history read fail while admitted get/abort/cancel work; duplicate Stop, natural terminal race, wrong Session/Profile/owner/control scope |
| Session frontier | Accepted queued Runs cancelled first; new submissions retained; same request replays after restart; a genuine control-lock delivery failure stays fenced even if an older successful request is replayed |
| CLI/ACP | Stop failure remains visible and retry uses the same request ID; accepted does not mean confirmed; natural completed/failed outcomes remain truthful; captured UI inputs exclude later additions |
| Managed effects | Real shared socket Runtime executes tools without a model; nonzero Shell exit/start failure is unsuccessful; actual slash command starts a process through nested checked tools and Stop under a history lock confirms only after the PID exits |
| Default daemon | Initialize and capability query derive both v1 capabilities from the owner; overrides cannot fabricate support. Use handshake capabilities in client tests; read succeeds without a model, forbidden write changes no bytes, and events/messages survive restart |
| Shell self-recovery | Unknown Stop cleanup fences successors; bounded automatic retries and concurrent same-request retries only clean the original child. Exhaustion remains unknown. Owner close refuses to release liveness while cleanup remains pending; retry can finish it |
| Durable cleanup | Preserve exact Run/PID/registration references through status and Stop writes. Dead-owner recovery verifies cleanup before clearing references and deleting registry evidence. Missing/malformed identities or OS failures remain unknown; refreshing A→B→C after B exits must retain C, including PID-reuse isolation |
| Extension isolation | Separate Sessions and Runtime instances, same-name tools, null Runtime, combined Runtime, reload during admission, delayed cleanup, default restoration and command unregister/override restoration |
| Workflow | Session-owned stop only; no global enumeration/optimistic stopped state; paused and already-cancelled owner signals propagate; confirmation follows cleanup |
| Text transactions | Full Access edits ordinary .git metadata and external temporary targets through native host authority; protected controls, unsafe paths, link identity, stale revisions and atomicity still enforced; protocol 5 capability required |
| SDK text authority | Actual provider-driven `runKodaX` and `runManagedTask` writes/edits outside both the effective workspace and system Temp; Full Access and explicit Auto review; native `tool_call` writes; absent approval, reviewer deny, and host veto remain denied |
| Approval isolation | Different path/content and replay cannot consume an approval; Client sends with the same tool ID have independent authority; vetoed execution cannot leave a reusable grant; Runtime mode round-trip revokes even an already-snapshotted grant |
| Live permission facts | Actual Runtime provider requests follow Session mode switches over caller defaults; direct requests and managed role requests refresh their mode, including retry; no stale mode is added to stored conversation messages |

## Manual client check

1. Open two disposable Sessions. Run a slow parent with child work and a slow
   Shell tool. Queue two follow-ups, then Stop from Space or Ctrl+C in CLI.
2. Observe accepted/pending cleanup, followed by the actual terminal outcome.
   The sibling Session continues. Submit another explicit message after Stop;
   it must remain available. Repeat Stop with the original request ID.
3. Try a client with observe-only scope and a mismatched expected Run. Verify a
   structured scope/binding rejection and that no cancellation was delivered.
   Let Run A finish, start B and queue C, then send a previously unaccepted Stop
   request bound to A. Expect `conflict` / `stale_run`; B and C must finish
   normally. Repeating an already accepted Stop after A ends must still replay
   its original frontier, including over the daemon and after Runtime restart.
4. In Full Access with no custom policy, use a temporary file and
   `Remove-Item -LiteralPath <temporary-file> -Force`. Repeat via `!command`.
   Add a matching explicit forbidden rule, start a fresh Run, and verify both
   paths refuse with the actual rule source. Do not rewrite the command.
5. Load an extension command that uses `api.getExecutionScope().invokeTool`.
   Run it concurrently in two Sessions, reload the extension while one runs,
   and cancel one Run. Only the owned work stops; future Runs use the new version.
6. Inject transient process cleanup failure. Stop must return an accepted but
   unconfirmed receipt, keep successors queued, and recover without executing the
   command again. Exhaust automatic retries, restore cleanup and replay the same
   request. Restart a dead owner with pending references and inspect the original
   Run again. Missing identity evidence must remain unknown, never trigger a bare
   PID kill. On POSIX, dead-owner cleanup without safe identity evidence remains
   unknown. Test ordinary short commands separately: natural completion must not
   wait forever for a Windows snapshot of a process that has already exited.

Workflow packaging/distribution as an extension is outside this release. The
scoped execution, progress, state and cancellation contracts are available for
that later migration. Legacy direct Node helpers remain trusted host utilities.

## Verification record (2026-09-12)

The final frozen-code `npm test` run exited successfully: 15,427 passed,
0 failed, 78 skipped and 21 todo (15,526 total). `npm run test:bundle` passed
all 24 tests. Skipped/todo cases retain their existing platform/feature status.

Windows validation passed `npm run build`, source/test type checking,
`npm run test:native`, `cargo fmt --check` and Git whitespace checks. Native
execution includes the real Windows transaction/binding and ASRT suites; Unix
execution remains a platform CI responsibility.

A focused V8 coverage run passed 114 tests across six files. Its measured source
scope was `tool-invocation.ts`, `execution-scope.ts`, `exec-policy.ts` and
`shell-executor.ts`: 89.45% lines/statements, 84.32% branches and 91.78% functions.
These figures describe those execution/policy files, not whole-repository coverage.
The measured regression files were the adjacent invocation, managed execution,
command lifecycle, Exec Policy and shell executor tests, plus
`src/sdk-runtime.tool-invocation.test.ts` for real shared transport and processes.

## Standards

Independent final review: 0 unresolved findings. Reviewed the patch against
AGENTS.md, package layering and the code-review smell baseline. Runtime ownership
uses non-serialized identities; ordered default restoration reuses one small
helper for the three existing tools/model/thinking cases. Checks found no
remaining lifecycle disposal or contribution ownership defect.

## Spec

Independent final review: 0 unresolved findings against FEATURE_299. The review
closed concrete gaps in Session Stop request fencing, natural terminal races,
paused/already-cancelled workflow signals, managed slash-command ownership,
Runtime/null-Runtime contribution isolation, and reload/default/disposer cleanup.
Each correction has a passing regression; the shared transport tests use actual
Session locks and real child processes.

## Daemon alignment verification — 2026-09-13

Windows follow-up validation passed 494 Runtime/Actor/daemon regression cases,
72 Bash cases, and the targeted real Shell, restart, registration-failure and
process-identity suites. `npm run build:packages`, `npm run typecheck` and both
repository/submodule whitespace checks passed. This is scoped regression
evidence, not a new full-repository or cross-platform release certification.

V8 line coverage intersected with executable lines added in this patch:

| Source | Covered / measured changed lines |
|---|---|
| Managed child registration/recovery | 67 / 67 |
| Windows process-tree identity merge | 35 / 35 |
| Explicit tool invocation | 4 / 4 |
| Bash cleanup (standalone and Runtime suites combined) | 94 / 106 |
| Runtime cleanup ownership/recovery | 149 / 167 |
| Daemon capability projection | 14 / 14 |

The measured patch scope is 363 / 393 lines (92.37%). These numbers are neither
whole-repository coverage nor branch coverage. Combined Bash file line coverage
is 81.81%; unrelated parts of the large Runtime/registry files were not the
coverage target of these focused suites.

### Standards

Independent final review: 0 unresolved hard violations and 0 actionable smells.
The patch reuses existing Run metadata, process registration and cancellation
paths; no additional daemon endpoint, configuration option or recovery scheduler
was introduced.

### Spec

Independent final review: 0 unresolved findings against FEATURE_299 sections 4
and 6. Review findings were fixed and retested: retained descendant identity,
bounded standalone failure, registration-plus-sandbox cleanup failure, and
natural completion winning a late cancellation signal. Unknown cleanup remains
unknown, accepted request frontiers remain fixed, and client disconnect behavior
is preserved.

## GLM review follow-up — 2026-09-13

Two verified gaps are covered by permanent regressions:

- Generic startup/exit cleanup preserves a Run's exact process registration and
  its verified cleanup result until the SDK clears its durable reference. The
  SDK restart test uses the actual registry and Runtime APIs, simulates only OS
  termination, and confirms that recovery releases the record before a successor
  Run completes. Missing or uncertain evidence still does not count as success.
- Read/write child execution carries the launch Run ID and cleanup callback.
  A real Node child driven by an offline Provider exercises SDK Session Stop,
  blocked cleanup, queued successor, same-request recovery and durable release.
  This integration test also caught owner cleanup arriving before the child
  AbortSignal: the cleanup callback now explicitly requests strict Stop cleanup,
  preserving the ordinary natural-completion path.

The existing Windows Shell CI gate includes the Run registry tests, child Shell
tests and both new SDK integration files. No new endpoint, configuration option
or retry scheduler was introduced.

Focused V8 coverage passed 149 tests. Intersecting added executable lines with
coverage measured 48/56 in managed-child registration, 5/5 in child execution and
4/4 in Bash: 57/65 (87.69%). These are changed-line figures, not whole-file or
whole-repository coverage.

The Runtime, Actor, shared-daemon and CLI exit regression group passed 387 tests;
the registry, Bash, child execution, Session Stop and recovery group passed 315.
The two child Shell cases and one real SDK Actor Shell case also passed, for
705 distinct passing cases across 19 files. Package, bundle and declaration
builds and source/test type checking passed on Windows. This is scoped
verification; the unchanged native backends and full repository suite were not
rerun for this follow-up.

### Standards

Independent review: 0 unresolved hard violations and 0 actionable smells.

### Spec

Independent review: 0 unresolved findings against FEATURE_299. The additional
owner-before-child-abort correction closes the observed SDK integration failure;
the review does not claim broader POSIX process-identity support.

## Windows exit performance correction — 2026-09-14

The reported delay occurred after `[Exiting KodaX...]`: 122 historical Run-owned
Shell records with absent owners and roots, incomplete root-only captures, and
unconfirmed cleanup caused 366 synchronous PowerShell invocations. An isolated
reproduction using the installed bundle's final-cleanup function took 85.8 seconds;
the event-loop timer could not interrupt the synchronous sweep.

The correction preserves the existing cleanup outcomes and durable-reference
protocol. A dead-owner Windows record may avoid tree queries only when its retained
root identity matches and every retained PID, including uncertain descendants, is
a positive safe integer definitively absent (`ESRCH`). It remains `unknown` at its
original location. Live targets, permission/query errors, complete captures and
current owned children retain their original cleanup paths.

For actual Windows termination, the same short-lived PowerShell invocation returns
a fresh post-termination snapshot. Only a complete, valid result accepted by the
existing identity/completeness predicate can finish verification early. A missing,
truncated or failed snapshot retains the original fresh-query and retry path;
completion of the termination phase remains independent of snapshot success.
No exit deadlines, public options, registry schema or package dependencies change.

Run the focused Windows regressions with:

```powershell
node node_modules/vitest/vitest.mjs run packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/process-tree.windows.test.ts packages/llm/src/cli-events/process-tree.windows.test.ts packages/agent/src/runtime/process-cleanup.windows.integration.test.ts packages/agent/src/runtime/process-tree.test.ts packages/agent/src/runtime/managed-child-processes.test.ts src/sdk-runtime.shell-registry-recovery.test.ts src/sdk-runtime.shell-recovery.test.ts src/kodax_cli.interactive-exit.test.ts --maxWorkers 1
```

The real-process regression checks repeated 122-record sweeps without PowerShell
or evidence changes, actual termination using the combined query, and a live
retained descendant whose old root has disappeared. Existing Windows tests retain
coverage for real nested processes and reused root identities. Deterministic tests
assert reduced query counts when the post-termination snapshot proves completion;
real-process tests permit additional queries when the OS legitimately needs more
time. The Windows Shell CI gate includes both the protocol and real-process tests.

Validation on Windows: the 16-file cleanup, registry, SDK recovery, CLI exit and
MCP/LSP regression group passed 196 tests, with two platform-specific skips.
The focused 96-test V8 coverage run covered all 96 added executable lines across
the three changed runtime source files (13/13, 44/44 and 39/39). This is changed-line
coverage; whole-file coverage in that focused run was 61.15%.

After rebuilding the packages, CLI bundle and SDK declarations, the installed
bundle's final-cleanup function processed the same shape of 122 isolated records
in 11.78 ms and 8.45 ms, with zero PowerShell invocations and all original record
bytes retained. The probe exposed the bundled function through an in-memory export
only; it did not replace the cleanup algorithm. Other resource-close callbacks
were idle, so this measures the historical-record bottleneck, not every possible
interactive exit. The user's registry was not modified.

Source and test type checking and `git diff --check` passed. Verification was
scoped to affected paths; the full repository suite and unchanged native backends
were not rerun. The CLI lifecycle test emitted a listener-count warning while
repeatedly loading the CLI; all its assertions passed.

### Standards

Independent final review: 0 unresolved hard violations or actionable smells.

### Spec

Independent final review: 0 unresolved findings against the approved performance
correction and FEATURE_299 cleanup/recovery requirements. Actual live descendants,
reused root identities, incomplete evidence and failed snapshot fallbacks remain
covered by regression tests.
