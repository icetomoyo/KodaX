# Nonblocking Shell cleanup regression

## Corrected user requirement

Incident: Session `20260928_160252_occb6cfe737bfa`, Run `run_mukzfa6u_14f4337c`.
Windows process-tree verification failed after timeout; exhausted cleanup retries
left the tool Promise pending forever. The initial fix aborted the whole Run and
blocked successors. The user rejected this because it prevented model recovery.

- Timeout is not user Stop: return the command, timeout, PID, cwd, observed exit,
  cleanup error and partial output (or recovery artifact paths) to the model.
  Do not automatically abort the Run; let the model choose its next action.
- Deliver queued interrupt input at the next normal safe point.
- Explicit Stop cancels model execution. After the tool returns, settle the Run
  and admit successors even if cleanup remains unknown. Accept after-turn input
  while Stop is settling instead of rejecting unknown as stale_run.
- Persist unresolved process identities with `deferred: true`. Keep the native
  registry and exact identity checks. Deferred cleanup must not block Session
  admission, Run completion or Runtime close.
- A terminal Run with unresolved cleanup has `effectOutcome: unknown`; do not
  claim verified process termination. Verified cleanup can remove the record.
- Recover valid unresolved references from dead owners as deferred cleanup,
  allowing the Session to reopen. Invalid records retain integrity checks.

This change does not make OS queries infallible. It prevents cleanup probe failure
from becoming a conversation lock. Never delete ambiguous process evidence or
blindly repeat a potentially unfinished command.

## Automated regression

```powershell
npm run build:packages
npm run typecheck
node node_modules/vitest/vitest.mjs run src/sdk-runtime.shell-timeout.test.ts src/sdk-runtime.shell-recovery.test.ts src/sdk-runtime.child-shell-cleanup.test.ts packages/coding/src/tools/bash-cleanup-liveness.test.ts packages/coding/src/tools/bash-registration-cleanup.test.ts packages/coding/src/tools/bash-cleanup.test.ts packages/coding/src/child-executor.shell-cleanup.test.ts packages/coding/src/child-executor.test.ts --maxWorkers=1
```

Tests use isolated homes, offline providers and injected unknown cleanup outcomes.
Verify provider continuation with diagnostics, queued interrupt delivery, no model
continuation after Stop, successor execution, honest terminal effects, retained
cleanup metadata, nonblocking close and dead-owner recovery.
Also inject one failed cleanup-status write followed by recovery, and native
stdin/start-attestation failures with unconfirmed termination. Both must retain
diagnostics and process identities without leaving a permanent cleanup fence.

SDK and Space must both be rebuilt and deployed; source commits do not update
an already running old daemon or installed application.
