# Shell cleanup exhaustion regression

## Incident and accepted scope

Session `20260928_160252_occb6cfe737bfa`, Run `run_mukzfa6u_14f4337c`:
the foreground Shell timed out, Windows process-tree verification could not
confirm quiescence, and the cleanup retries exhausted without settling the
foreground Promise. The Run continued to look active and queued input never
reached a safe delivery point. Stop correctly retained the cleanup fence, but
Space misrepresented its unknown outcome.

Required behavior:

- Exhausted cleanup retries settle the tool with an unknown result and notify
  the Run owner. Root and child execution propagate the same notification.
- The owner aborts further execution and publishes `unknown` with
  `failureKind: runtime_cleanup`, rather than claiming the user cancelled it.
- Retain durable Shell ownership and block successor execution until cleanup
  is verified. Never manufacture a successful stop or erase the registry.
- Retrying the same Stop request verifies cleanup and releases the original
  fence without cancelling successors submitted after that request.

This fix does not replace Windows process launching with Job-object containment.
Legacy registrations with incomplete descendant identity may remain unknown;
deploying new code alone cannot prove those old processes have exited.

## Automated checks

Run from the SDK root:

```powershell
npm run build:packages
npm run typecheck
node node_modules/vitest/vitest.mjs run src/sdk-runtime.shell-timeout.test.ts src/sdk-runtime.shell-recovery.test.ts src/sdk-runtime.child-shell-cleanup.test.ts packages/coding/src/tools/bash-cleanup-liveness.test.ts packages/coding/src/tools/bash-registration-cleanup.test.ts packages/coding/src/tools/bash-cleanup.test.ts packages/coding/src/child-executor.test.ts --maxWorkers=1
```

The new tests use isolated temporary runtime homes, offline providers, short
real child processes and injected unknown/verified cleanup outcomes. They cover
retry exhaustion, notification failure, direct and managed Run interruption,
no additional provider iteration, durable ownership, successor fencing and
same-request recovery. Existing tests cover Shell registration and child Stop.

## Desktop integration

Build and package the SDK fix, then consume that build in Space using its local
SDK test-build workflow. A normal build using a previously published SDK does
not include this fix. Verify the Space regression guide together with this one.
