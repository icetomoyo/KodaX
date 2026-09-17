# Provider credential redaction and child Agent failures

Investigation: 2026-09-17, workspace 0.7.96-rc.7, Node v22.23.1.

## Confirmed defects

1. `provider-credential-context.ts` cloned Error objects with
   `Object.create(Object.getPrototypeOf(value))`. DOMException's inherited
   `name`, `message`, and `code` accessors require internal constructor state.
   Reading the clone throws `TypeError: Value of "this" must be of DOMException`
   (`ERR_INVALID_THIS`), replacing the useful timeout/cancellation failure.
   Nested causes and repeated redaction use the same broken path.
2. Ordinary Error clones also lacked native Error identity, and the copier
   dropped lazy V8 `stack` accessors. This loses diagnostic evidence even where
   `instanceof Error` still succeeds.
3. A valid `TimeoutError("deadline exceeded")` could still terminate a child
   without recovery: the Provider base wrapper discarded its type, and the
   coding classifiers relied on timeout wording. A deterministic child Runner
   test reproduced this separately after fixing DOMException cloning.

## Fix and checked execution chain

Errors now get constructor-created storage (`DOMException` or `Error`) before
restoring their prototype and recursively copying own data descriptors. Native
DOMException names/messages and native lazy stacks are redacted; custom getters
are not executed. Causes, AggregateError members, cycles, shared references,
typed Provider fields and rejected-image evidence retain the existing copy path.
The source error is not edited.

The Provider base preserves top-level `TimeoutError` and identifies nested typed
timeouts through a bounded cause traversal, normalizing them to the existing
`KodaXNetworkError(isTimeout=true)`. This retains recovery semantics without
copying private upstream response bodies or raw causes into normalized Provider
errors. Both coding classifiers recognize the type independently of message
wording; resilience also recognizes typed timeouts inside its existing bounded
cause traversal.

Inspected chain:

- `actor-runtime.ts` derives and runs the child credential lease.
- `withProviderRequestCredential()` acquires one credential, combines signals,
  executes the Provider, and redacts the escaping failure.
- Both `run-substrate.ts` and the managed-task `llm-adapter.ts` read the error's
  name before classifying recovery. Their own timer-triggered AbortError becomes
  a transient network timeout; caller cancellation retains cancellation semantics.
- Runner/actor terminal reporting, runtime failure classification, diagnostics,
  verification and constructed-worker error reconstruction were inspected for
  the same invalid prototype-only clone. No additional occurrence was found in
  those paths. Worker reconstruction already constructs a real Error.

Regression coverage includes direct timeout/abort cloning, native Error identity,
stack preservation, throwing custom getters, cyclic nested causes and aggregates,
double redaction, derived child leases, and successful child retry after native
timeout, nested timeout and timer abort through the real `withRateLimit` wrapper.
Two-level nested timeout normalization also verifies private response bodies stay
excluded. User cancellation calls the Provider only
once and does not enter recovery. The existing cancellation matrix now covers
both ambient and leased credentials across built-in and custom Providers.

## Reproduction and validation

No real credentials or network requests are needed for these regressions.

```powershell
npx vitest run packages/llm/src/provider-credential-context.test.ts
npx vitest run packages/coding/src/provider-cancellation.test.ts packages/coding/src/task-engine/_internal/managed-task/llm-adapter.credential-errors.test.ts
npm run typecheck
npm run build:packages
npm run build:bundle
node --test tests/bundled-provider-credentials.test.mjs
```

The first two native DOMException tests failed with the reported exception before
the fix. The bundled regression likewise reproduced `ERR_INVALID_THIS` against
the previous build. Rebuild workspace packages before the root bundle: bundling
alone consumes existing workspace build output and can retain old code.

Final validation: 67 selected source suites / 1,144 tests passed, including the
complete default LLM test selection and the affected recovery suites; all 14
bundled credential tests passed. Credential-context coverage was 91.50% lines,
86.56% branches and 95.83% functions. Source/test typechecks and package/bundle
builds passed. These are targeted regression results, not a full repository or
live Provider integration run.

## Historical session uncertainty

The user reported four failures in `20260914_084034_oz884c2d160c23` involving
OpenRouter and cusQwen. That session was not replayed or its private logs read.
The code has a default 600-second request watchdog, consistent with the reported
roughly ten-minute gap, but timing alone cannot establish the original cause.
The local reproductions confirm the masking defect and recovery behavior, not
whether those four requests originally timed out, were cancelled, or failed for
another upstream reason. Previously overwritten exceptions cannot be recovered
from the replacement TypeError alone.
