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

## Consolidated file tools and discovery

The follow-up against `351e8675` exposes builtin `edit(path, edits[])` and
`changed_diff(paths[])` to models, including single-item arrays. Legacy names
and parameters remain executable for SDK callers and existing histories.
Aliases disappear only when both builtin entries are available; extension
overrides and legacy-only surfaces retain their own contracts.

Single-item edits retain precise anchor diagnostics and automatic recovery.
Multi-item edits remain sequential in memory, with zero writes on match failure
and one trusted commit on success. The actual invoked tool name reaches host
authorization and diff metadata. Diff arrays retain untracked files, per-path
limits and continuation. No shell replacement or new patch grammar is added.

Search, descriptions and tool tables share the current executable inventory
and host ceiling, separate from model-only exposure. Keyword filtering precedes
ranking and limits. Discovery never grants execution permission. Lazy LSP
startup is not absence of capability. LSP schemas remain resident; full-schema
disclosure is separate future work.
`todo_get` returns existing owner provenance without assigning new owners.
Plans name concrete deliverables; descriptions clarify otherwise unclear scope
or constraints. This does not add an owner scheduler or recreate resumed plans.

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
Live resume was not evaluated. This historical evaluation did not capture a
complete Codex request. A subsequent zero-network CLI capture and the next
refinement plan are recorded in [the contract refinement design](first-turn-contract-refinement.md);
the products still differ in capabilities and protocol, so no strict task-efficiency ratio is claimed.
The historical shared evaluation ceiling was 35 logical calls,
including a 32-call generation ceiling and bounded smoke; no budget is reset.

The follow-up pilot used `kimi-code/kimi-for-coding` and
`zai-coding/glm-5.3`, explicitly requested routes, against the frozen `351e8675`
baseline. Three complete pairs produced two candidate preferences and one tie
(one response per arm). Kimi delivered a concrete pending plan immediately;
reading first in the baseline remains lawful, so this is next-response value,
not proof of full-task failure. GLM's candidate used unique function anchors;
the baseline's second bare return anchor became ambiguous after the first
replacement. Zero-network Runtime replay confirmed the baseline batch left the
file unchanged and the candidate edited both functions. GLM's plan pair stopped
on a connection error: one failed request, no second arm, no quality verdict.

Successful paired API inputs decreased by 4.67%–4.69%; latency did not improve
uniformly. Complete OpenAI Runtime request JSON decreased by a further 3,743
bytes for SA (4.6%) and 6,915 bytes for AMA (7.0%), including the final host
capability filter. Zero-network recapture of the committed implementation gives
78,015 bytes / 19,574 estimated tokens for SA and 91,963 bytes / 23,067 estimated
tokens for AMA in the OpenAI Runtime fixture. These estimates include JSON
framing and use the project heuristic, not a provider tokenizer.
Both candidate-only live
Runtime smokes completed read → one atomic edit → actual Node test → honest
final response, with exact file content and test output checked. These two
controlled four-response cases verify execution, not comparative task quality.
The new revision used 15/18 permitted calls, conservatively charged 244,264
tokens including one unknown-usage failure, and $0.00820 nominal reference cost
for coding plans; this is not a subscription bill. Historical charges remain
unchanged. These small samples cannot establish overall intelligence
non-inferiority; generation-length and latency variance remain relevant limits.

## Regression checks

Run the existing `tests/first-turn-*.test.ts` tests, including the contract E2E,
wire inventory, production replay, route preflight and evaluation support, plus
the adjacent tool and role contract tests. Production replay uses a real Runtime Host:
test-only mutation fallback and `result.success` do not certify file changes.
`npm run typecheck` includes the new tests and manual evaluation drivers.

Any future disclosure or interface consolidation must preserve error recovery,
capability/permission boundaries, SDK compatibility and child/resume behavior.
Discovery now applies the same host, exclusion and policy ceiling to tables,
search, descriptions and dispatch. Full-suite regression also caught and fixed
legacy incomplete-edit detection after introducing conditional schemas. The
evaluation worktree cleaner now validates a dedicated directory prefix, so it
cannot mistake `kodax-eval-dumps` for a worktree; its test preserves an evidence
sentinel. Raw evidence is additionally mirrored outside that namespace.
Exploration notes and transient data stay out
of the tracked documentation; evaluation raw belongs in OS temporary storage.
