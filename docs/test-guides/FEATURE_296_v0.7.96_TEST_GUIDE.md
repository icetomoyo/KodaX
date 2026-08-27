# FEATURE 296 v0.7.96 Test Guide

## Purpose

Verify that a local context-capacity shortfall no longer aborts a Run after
tools have executed. Executed `tool_use`/`tool_result` pairs must commit;
capacity shortfalls record debt that the next iteration's compaction relieves;
capacity terminals classify as the structured, unmasked `context_capacity`
failure kind; and an irreducibly oversized fresh input degrades to a preview
plus a durable pointer instead of killing the Run.

## Prerequisites

- A v0.7.96 development CLI (`npm run dev` or a packaged build).
- A provider with a known context window (Anthropic claude-sonnet, 200k, is
  the reference configuration).
- A scratch workspace outside the KodaX Runtime/config home.
- The automated suites green first:
  `npx vitest run packages/coding/src/capacity-recovery.test.ts packages/coding/src/tools/tool-result-policy.test.ts packages/coding/src/tools/envelope-budget.test.ts packages/coding/src/task-engine/runner-tool-result-batch.test.ts packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-100-capacity-debt-admission.contract.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-079-final-tool-result-capacity.contract.test.ts packages/coding/src/agent-runtime/__contract-tests__/p3.4-compaction-flow.contract.test.ts src/sdk-runtime.test.ts src/runtime-daemon/schema.test.ts`

## Debt admission and recovery checks

1. Fill a session toward the context limit (long file reads work well), then
   ask the agent to run several `read`/`grep` calls in one batch that exceed
   the remaining budget. The Run must NOT fail with
   `ToolResultBatchCapacityError`. The tool results commit with
   `KODAX_RESULT_INCOMPLETE` markers and artifact pointers, and the next
   model turn continues normally after compaction.
2. While the transcript is over capacity, confirm the run keeps making
   progress instead of looping: compaction diagnostics appear, and after
   relief the conversation resumes without user action.
3. Force a transient compaction-summarizer failure (e.g. revoke the provider
   key briefly at pressure). The Run must fail open — history stays intact
   and the run continues or fails with the provider's own error — never a
   local "Managed history compaction" capacity abort.

## Structured failure-kind checks

4. Configure a run-scoped credential (daemon managed run). Produce a genuine
   capacity terminal (e.g. a model whose window is smaller than system prompt
   plus tool definitions). The Run result must report
   `terminal.failureKind: "context_capacity"` and a
   `failureDetail.contextTokens` pair; the error message must NOT be the
   generic "Provider run failed while using a run-scoped credential."
5. Resume the session after such a terminal: the failure detail survives the
   resume round-trip with its `contextTokens` intact.

## Input degradation checks

6. Submit an irreducibly oversized fresh input (a single paste larger than
   the model window) through the SDK `submitInput` path. The Run must
   continue: the request carries a preview head plus a
   `Full output saved to:` pointer with a read-with-offset/limit hint, and
   the model can page through the artifact in slices.
7. Repeat with a merely large (but window-fitting) paste: it must be
   delivered verbatim, never degraded.

## Regression guardrails

8. Provider-side errors whose message merely contains the word "capacity"
   must still classify into the provider taxonomy (`rate_limit`/`upstream`),
   never `context_capacity`.
9. Ordinary in-budget tool results are byte-identical to pre-feature
   behavior (the Issue 158 verbatim reproduction in the automated suite is
   the canonical check).
