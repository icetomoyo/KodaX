# First-turn model input

Implemented on 2026-10-14 against `bd4479d`. The accepted scope is tool-contract
correction, an incremental model-facing todo contract, and removal of repeated
Worker teaching. Runtime permissions and execution capabilities remain separate
from what the model sees.

## Contract and ownership

- `ask_user_question` accepts the existing single-question and questions-only
  branches. The handler validates the selected branch; a redundant top-level
  required question must not block a legal batch.
- The raw SDK registry retains legacy `todo_update` list seeding. Models see a
  stable-id patch interface without `op/items`. The private projection preserves
  other caller requirements and never mutates the original definition.
- Tool schemas own parameter semantics. Worker instructions own planning,
  scope, collaboration, resume and verification obligations. Parameter tutorials
  and call signatures need not be repeated in both places.
- Managed and standalone Worker instructions use their actual executable tool
  sets, including partial root/child capabilities. Missing skill-script runners
  are not advertised as executable abilities. This is capability information,
  not authorization; the existing execution and permission paths remain active.

The implementation is in `de3d8ff9`, `dcbe2b83` and `9055a4c1`; deterministic
capture, E2E and bounded evaluation support are in `be23099c`.

## Evidence and limits

The real provider SDK JSON capture covers four fixtures, SA/AMA, and
OpenAI/Anthropic (16 combinations), without external requests. The OpenAI
Runtime Host fixture decreased by 8,794 bytes for SA (9.7%) and 15,951 bytes for
AMA (13.9%). Bytes and the project token estimate are not server token usage.

Four existing provider routes produced 22 retained responses / 11 blinded
pairs, one response per arm and case. Combined API input reductions were
15.9%–16.4% on the sampled ZAI GLM-5.3, DeepSeek Flash and Kimi cases. ZAI plan
organization and some optional descriptions were slightly weaker; Kimi's
generation length and latency did not uniformly improve. These next-response
samples establish neither statistical non-inferiority nor full-task quality.

The original live low-level SDK smoke failed because its harness omitted the
production text mutation host; the baseline refused the same edit. Production
Runtime replay with the recorded read/edit and a scripted final response passed.
The corrected live Runtime smoke and live resume were not evaluated. Codex's
matching complete wire capture remains absent; no cross-product total ratio is
claimed. The historical shared evaluation ceiling was 35 logical calls,
including a 32-call generation ceiling and bounded smoke; no budget is reset.

## Regression checks

Run the existing `tests/first-turn-*.test.ts` tests, including the contract E2E,
wire inventory, production replay, route preflight and evaluation support, plus
the adjacent tool and role contract tests. Production replay uses a real Runtime Host:
test-only mutation fallback and `result.success` do not certify file changes.
`npm run typecheck` includes the new tests and manual evaluation drivers.

Any future disclosure or interface consolidation must preserve error recovery,
capability/permission boundaries, SDK compatibility and child/resume behavior.
General deferred search still has a known policy consistency gap; fix that
before hiding additional schemas. Exploration notes and transient data stay out
of the tracked documentation; evaluation raw belongs in OS temporary storage.
