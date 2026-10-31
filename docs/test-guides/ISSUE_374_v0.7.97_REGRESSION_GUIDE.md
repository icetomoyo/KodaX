# Issue 374: Preserve unanswered interaction semantics

Observed on `aeb16fef`, 2026-10-29; first affected version unknown.

## Contract

For question, multi-question and input interactions, explicit `non_interactive`
must remain distinct from user `skipped`. A local UI timeout sends no response.
Only the Host settles a question deadline. The Runtime daemon facade rejects a
client-supplied timeout object with `invalid_input` rather than putting that
object into an answer field. Missing requests and mismatched Run/revision bindings
retain the existing `already_resolved` result. A rejected answer does not settle
the question or prevent a subsequent valid response. Permission decisions and
cancel/stop semantics are unchanged.

## Regression

The three REPL cases first failed because all reasons became bare `skip`.
Three facade cases first failed because timeout objects were sent as answers.
Run the existing public-boundary tests, including normal answers, abort cleanup,
permissions, skip reasons and stale binding checks:

```powershell
npx vitest run packages/repl/src/ui/client-plane.test.ts src/runtime-daemon/client.test.ts src/sdk-client.interactions.test.ts src/sdk-runtime.interactions.test.ts --maxWorkers=2
```

Tests use fake transports/dialogs and never attach to a user Host.

On 2026-10-29 the client-plane, daemon facade and in-process SDK interaction
suites passed. Production and test typechecks and the full package/native/bundle/
SDK-declaration build also passed. This change does not claim to resolve the
remaining historical first-read latency tracked in Issue 371.
