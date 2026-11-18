# Mutation Reflection — dataset for FEATURE_101 v0.7.31.2, revised for FEATURE_310

The eval id keeps its historical `sa-` prefix; SA mode itself is retired.

## Product question

The mutation-scope reflection text (CAP-016, in
`packages/coding/src/agent-runtime/middleware/mutation-reflection.ts`)
is appended to the first significant mutation result when the caller
supplies a mutation tracker to the direct engine or a host Script
invocation. The AMA Worker's Script cells turn it off.

Its pre-v0.7.31.2 text prompted the model to call
`emit_managed_protocol` to escalate mid-run. The direct engine has no
such tool, so the text induced **hallucinated tool calls** that the
dispatch layer rejected, wasting iterations. v0.7.31.2 rewrote it to
ask for self-review: re-read the diff and run typecheck/tests.

FEATURE_310 removed the remaining "SA mode has no Evaluator" wording
and the suggestion to re-run under AMA mode. AMA is a single Worker
now; a re-run adds no independent Evaluator pass, so the suggestion
misled the user.

## What this benchmark measures

When the LLM observes the reflection text appended to a mutation tool
result, the next assistant turn must:

  1. **Not call a non-existent escalation tool** — neither
     `emit_managed_protocol` nor `emit_scout_verdict` may appear in
     the next-turn output (text or tool call). This is the
     load-bearing safety judge: the legacy text caused this in
     production.
  2. **Not use harness ids in commitment phrasing** — strings like
     `confirmed_harness="H1_EXECUTE_EVAL"` belong to the retired
     escalation protocol.
  3. **Mention at least one self-review action** — re-read the
     diff, run typecheck/tests, verify intent. The reflection text
     names these explicitly; we check that the model picks one up
     rather than ignoring the prompt entirely.
  4. **Not tell the user to re-run under another mode** — no mode
     adds a reviewer.

## Run model

Real LLM × a minimal direct-engine system prompt
(`DIRECT_ENGINE_IDENTITY` in `cases.ts`: identity plus tool surface,
nothing about reviews or modes). Synthetic prior conversation: user
asks for a multi-file edit, assistant issues the edit tool calls, the
last tool result returns the reflection text appended to a normal
"edited successfully" content. The benchmark inspects the **next**
assistant turn.

This intentionally mirrors `tests/admission-wrap.eval.ts`'s
deterministic-judge approach (no LLM-as-judge) — the failure modes
are surface-level pattern matches.

The cap-016 contract test separately asserts the text contains no
escalation tool names, harness ids or mode names, so the text cannot
seed names that models would echo back.

A wording change is compared A/B on frozen inputs built from
`DIRECT_ENGINE_IDENTITY` and `buildPriorMessages(task, reflection)`,
replayed through the bounded ledger harness in
`tests/skill-trigger.eval.ts` with a blind main-session review.

## Matrix

  3 task scenarios × N coding-plan aliases × 1 run per cell
  ≈ 3 × ~3 typical aliases × ~10–30s per cell
  ≈ 1–3 minutes wall clock.

Skips per-alias when API key absent (FEATURE_104 standard
pattern). Run via:

```
npm run test:eval -- sa-mutation-reflection
```

## See also

  - packages/coding/src/agent-runtime/middleware/mutation-reflection.ts
    — the implementation under test
  - packages/coding/src/agent-runtime/__contract-tests__/cap-016-mutation-reflection.contract.test.ts
    — text-shape unit tests
  - docs/features/v0.7.31.md (FEATURE_101 v0.7.31.2 implementation
    completion patch)
