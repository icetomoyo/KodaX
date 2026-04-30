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

Real LLM × a simplified SA system prompt (`SA_IDENTITY` in
`cases.ts`) that names the SA mode contract and explicitly states
that `emit_managed_protocol` / `emit_scout_verdict` are NOT
available. Synthetic prior conversation: user asks for a
multi-file edit, assistant issues 3 edit tool calls, tool result
returns the rewritten reflection text appended to a normal
"edited successfully" content. The benchmark inspects the **next**
assistant turn.

This intentionally mirrors `tests/admission-wrap.eval.ts`'s
deterministic-judge approach (no LLM-as-judge) — the failure
modes are surface-level pattern matches, no need for a second
model.

### Caveat on the safety-pass-rate claim

The `SA_IDENTITY` system prompt names the forbidden tools by name,
and the safety judges check for those same names. So a 100% safety
pass rate proves **system prompt + judge are in agreement** — i.e.
when the SA contract says "no AMA tools", real models honour that
when prompted by the new reflection text. It does **NOT** prove
the new reflection text alone (without the SA_IDENTITY) suppresses
the hallucination; production `defaultCodingAgent` instructions
phrase the SA contract differently and don't enumerate forbidden
tools by name. The full assurance therefore comes from two
sources, not one:

  - The cap-016 contract test asserts the new text contains no
    `emit_managed_protocol` / `emit_scout_verdict` / harness-id
    strings — so the text isn't *seeding* the names that production
    models could echo back.
  - This benchmark adds the real-LLM lane that says: when an SA
    contract is in scope, real models honour the new prompt text
    instead of trying to escalate.

Future work (if a regression of the legacy text ever shows up):
re-run this benchmark with the production `defaultCodingAgent`
instructions verbatim — the simplified `SA_IDENTITY` is a
benchmark stand-in chosen to isolate the reflection-text variable
from the rest of the production prompt's behaviour.

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
