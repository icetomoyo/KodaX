# FEATURE_299 v0.7.96 regression guide

Use disposable Sessions, projects and policy files. The implementation does not
repair a user's Session by deleting Actor snapshots or changing its bytes.

## Automated acceptance

```powershell
npm run build:packages
npm run typecheck
npx vitest run src/sdk-runtime.stop-admission.test.ts src/sdk-runtime.tool-invocation.test.ts src/sdk-conversation-history.test.ts packages/repl/src/interactive/storage.conversation-page-admission.test.ts
npx vitest run packages/coding/src/extensions/managed-execution.test.ts packages/coding/src/extensions/session-isolation.test.ts packages/coding/src/extensions/command-lifecycle.test.ts packages/repl/src/interactive/commands-extension.test.ts
npx vitest run packages/coding/src/permissions/exec-policy.test.ts packages/repl/src/permission/standalone-shell-boundary.test.ts src/exec-policy-cli.test.ts src/windows-text-transaction.test.ts
npm test
npm run test:native
npm run build
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
| Extension isolation | Separate Sessions and Runtime instances, same-name tools, null Runtime, combined Runtime, reload during admission, delayed cleanup, default restoration and command unregister/override restoration |
| Workflow | Session-owned stop only; no global enumeration/optimistic stopped state; paused and already-cancelled owner signals propagate; confirmation follows cleanup |
| Text transactions | Full Access edits ordinary .git metadata and external temporary targets through native host authority; protected controls, unsafe paths, link identity, stale revisions and atomicity still enforced; protocol 5 capability required |

## Manual client check

1. Open two disposable Sessions. Run a slow parent with child work and a slow
   Shell tool. Queue two follow-ups, then Stop from Space or Ctrl+C in CLI.
2. Observe accepted/pending cleanup, followed by the actual terminal outcome.
   The sibling Session continues. Submit another explicit message after Stop;
   it must remain available. Repeat Stop with the original request ID.
3. Try a client with observe-only scope and a mismatched expected Run. Verify a
   structured scope/binding rejection and that no cancellation was delivered.
4. In Full Access with no custom policy, use a temporary file and
   `Remove-Item -LiteralPath <temporary-file> -Force`. Repeat via `!command`.
   Add a matching explicit forbidden rule, start a fresh Run, and verify both
   paths refuse with the actual rule source. Do not rewrite the command.
5. Load an extension command that uses `api.getExecutionScope().invokeTool`.
   Run it concurrently in two Sessions, reload the extension while one runs,
   and cancel one Run. Only the owned work stops; future Runs use the new version.

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
