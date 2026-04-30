# SA Mutation Reflection — dataset for FEATURE_101 v0.7.31.2

## Product question

The SA-mode mutation-scope reflection text (CAP-016, in
`packages/coding/src/agent-runtime/middleware/mutation-reflection.ts`)
was inherited from the pre-FEATURE_106 era when the substrate
attempted to escalate from SA to AMA mid-stream by prompting the
model to call `emit_managed_protocol`. Per ADR-003 (Single-Agent
First, Harness On Demand) that escalation path does not exist:
SA mode is direct execution; the LLM running `defaultCodingAgent`
has **no** `emit_managed_protocol` / `emit_scout_verdict` tool in
its surface, and harness selection is committed up-front when the
user invokes AMA mode, not switchable mid-run.

The legacy text therefore induced **hallucinated tool calls** —
the model would attempt to invoke a tool that does not exist on
the SA tool surface, the call would be rejected by the dispatch
layer, and the run wasted iterations.

v0.7.31.2 rewrote the reflection text to be SA-self-review oriented:
re-read the diff, run typecheck/tests, and (if the task turns out
to be multi-stage) suggest the user re-invoke under AMA mode for
an independent Evaluator pass.

## What this benchmark measures

When the LLM observes the **new** reflection text appended to a
mutation tool result, the next assistant turn must:

  1. **Not call a non-existent AMA tool** — neither
     `emit_managed_protocol` nor `emit_scout_verdict` may appear in
     the next-turn output (text or tool call). This is the
     load-bearing safety judge: the legacy text caused this in
     production.
  2. **Not name AMA harness ids in commitment phrasing** — strings
     like `confirmed_harness="H1_EXECUTE_EVAL"` belong to the AMA
     escalation protocol; they have no meaning in SA. (We do allow
     the LLM to *describe* H1/H2 conceptually when telling the user
     "you may want to re-run this under AMA" — that's what the new
     text invites — but it must not phrase the description as an
     escalation tool call.)
  3. **Mention at least one self-review action** — re-read the
     diff, run typecheck/tests, verify intent. The reflection text
     names these explicitly; we check that the model picks one up
     rather than ignoring the prompt entirely.

## Run model

Real LLM × the SA `defaultCodingAgent` system prompt (simplified:
just the mutation-reflection scenario without the full coding
substrate's prologue, since this benchmark targets one specific
text fragment's behavior, not the entire SA prompt). Synthetic
prior conversation: user asks for a multi-file edit, assistant
issues 3 edit tool calls, tool result returns the rewritten
reflection text appended to a normal "edited successfully"
content. The benchmark inspects the **next** assistant turn.

This intentionally mirrors `tests/admission-wrap.eval.ts`'s
deterministic-judge approach (no LLM-as-judge) — the failure
modes are surface-level pattern matches, no need for a second
model.

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
  - packages/coding/src/agent-runtime/middleware/scope-aware-harness-guardrail.ts
    — AMA-side equivalent (FEATURE_106), unchanged
  - packages/coding/src/agent-runtime/__contract-tests__/cap-016-mutation-reflection.contract.test.ts
    — text-shape unit tests (asserts the AMA tool names are absent)
  - docs/features/v0.7.31.md (FEATURE_101 v0.7.31.2 implementation
    completion patch)
