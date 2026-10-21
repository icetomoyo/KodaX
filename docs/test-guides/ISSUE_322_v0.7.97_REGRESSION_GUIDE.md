# Issue 322: Preserve summary breaker history during oversized-input recovery

Date: 2026-10-21. Baseline: `87502cb9` (`v0.7.97-alpha.9`).
Fix: local implementation after that release; not published.

## Contract

An irreducible user input has its own request-only degradation path. A typed
capacity failure or still-over partial summary caused by that input must
preserve earlier summary failures. Ordinary failures still accumulate and
successful relief may reset the breaker. An open breaker must continue to
allow the existing bounded irreducible-input recovery attempt.

## Automated verification

```powershell
node node_modules/vitest/vitest.mjs run packages/coding/src/agent-runtime/__contract-tests__/cap-060-compact-orch.contract.test.ts packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts --maxWorkers=2
```

- Begin with two ordinary summary failures, then process irreducible input.
  Exercise both a typed capacity error and a still-over partial summary.
  The failure count remains two in both SA and AMA.
- A later ordinary summary failure raises the count to three. Subsequent
  ordinary hard pressure does not invoke the summary service again; existing
  reserve reclamation or history relief may still continue the run.
- With an already open SA breaker, an irreducible-input attempt remains
  available and preserves the open count. A following ordinary request
  cannot use that exception.
- A successful fitting summary resets two prior failures to zero. Existing
  zero-start oversized-input and managed cooldown/rearming tests remain green.

The SA cases both failed before the fix (`expected 2, received 0`). The AMA
partial-success case independently failed with the same counter reset; its
typed-capacity-error control already preserved the count.

The same matrix now covers string and mixed text/image encodings. Before the
follow-up, mixed user text was not recognized as irreducible: the SA error escaped,
and SA/AMA partial summaries counted it as an ordinary failure. The new recognition
and parity tests produced four failures, then all 56 focused tests passed after
counting only user text. Images, tool-result receipts and assistant content cannot
independently qualify for this breaker exception.

## Live capacity recovery contract

The follow-up is implemented locally, with broader acceptance still
incomplete. Exact user messages remain canonical. Recovery first reduces eligible
tool results, then old assistant analysis, then cumulative user text (including text blocks beside images) in the
request copy. Saved history remains readable; protected tool state, IDs, arguments,
images and completed receipts remain intact. Paging is disabled without an active
read tool; a saved artifact denied by the read policy cannot replace inline history.
A fixed request-only system notice explains the provenance of paged user text; its
tokens are budgeted and it never becomes canonical user history.

A confirmed rejection allows at most four generation recovery retries, each after
strict request reduction. Waiting is separate from retrying: the Host persists the
exact transcript and `contextRecovery`, then waits without provider calls. Changed
settings or accepted input wake the same execution; Stop prevents generation.
SDK callers without `onContextCapacityBlocked` retain typed capacity errors.
Managed child event construction does not forward the root wait callbacks, so
parallel children cannot overwrite its wake slot. Children retain their existing
failure path when bounded recovery is exhausted; this change does not yet give
each child an independently resumable capacity wait.

## Offline acceptance matrix

| Boundary | Regression assertion |
| --- | --- |
| Issue 322 / SA and AMA | Prior count 2 survives irreducible partial/error; ordinary failure reaches 3; fitting relief resets |
| 4096-token window | 100 input + 3000 output is accepted with scaled safety; neighboring budget boundaries agree |
| Cumulative ordinary history | Twelve ordinary dialogue pairs recover; all user constraints and latest execution receipts stay exact |
| Cumulative user messages | Aggregate and fixed envelope are budgeted; originals are retrievable; larger window restores full request |
| Read capability / policy | No read tool creates no user artifact; denied saved paths leave history inline and raise capacity |
| Native AMA integration | Real adapter, hook, Runner and `toolRead`; overflow then paging read then accepted generation; completed edit callback never runs |
| No-read native AMA | One rejected full request, no fabricated readable pointer, typed capacity reaches caller |
| Tool schema pressure | Existing bridge exposes reduced schemas; protected state and read remain resident; full authorized tools stay callable |
| Repeated rejection | Strictly decreasing requests advance; unchanged requests stop; only rejected generation is retried |
| Wait / model change | Exact history saved first; changed selection wakes; in-flight selection change is not missed |
| Wait / new input | Newly accepted constraints are consumed before the next generation |
| Wait / Stop | Wait rejects; no further generation or tool replay |
| Dead Host owner | Restart preserves the recovery fact; existing interrupted terminal does not silently replay work |
| Transient storage I/O | Session load/save and capacity artifact stat/save back off 1–30 seconds; Stop cancels; no false commit |
| Lost save acknowledgement | Real FileSessionStorage readback preserves newer title and avoids another save; reused old active entry cannot fake a committed replacement |
| Permanent persistence failure | Permission denial and other non-transient errors surface without discarding originals |
| Mixed user content | Only text pages out; image position, completed receipt, and short user constraints remain |

Run the capacity suites alongside `src/sdk-runtime.test.ts`. Relevant files include
`capacity-recovery`, `history-capacity-recovery`, `context-recovery-wait`, CAP-060,
CAP-100, substrate capacity accounting, managed compaction/context-capacity boundary,
Runner compaction hook, tool exposure planner and tool-result batch tests. Full-suite,
production/test TypeScript and build results must be recorded after the final edit.
The repository has no root lint script.

Coverage is measured for the changed capacity helpers and compaction persistence,
including the real FileSessionStorage lost-ack regression; the final numbers below
are scoped coverage, not repository-wide coverage.

Final focused coverage run: seven test files, 59 passed. The five measured modules
(`context-capacity`, `compaction-persistence`, `capacity-recovery`,
`history-capacity-recovery`, `context-recovery-wait`) have 94.88% statements,
84.05% branches, 93.33% functions and 97.47% lines. Production and test typechecks
and the full build passed after the mixed-input fix.

Final frozen-source verification on 2026-10-21, 20:20–20:32 Asia/Shanghai:
`npx vitest run --maxWorkers=4 --reporter=dot` passed with 1,178 test files and
16,788 tests; four files and 90 tests skipped, 19 tests remain todo. This is the
repository's default full suite; separately configured integration tiers and
other operating systems are not implied. `npm run typecheck` (source and tests),
`npm run build` and `git diff --check` passed. Standards and Spec reviews found
no open P1/P2 in the implemented paths, including the final mixed-input fix;
the broader acceptance gaps below remain open.

## Controlled model pilot — 2026-10-21

Baseline source: `87502cb9`; candidate: this working tree at each recorded revision.
Method: preregistered exact production system prompt and tool schemas, one fixed
fixture, full-input vs paged-input arms, randomized A/B labels, one repeat per alias,
DeepSeek and MiniMax coding aliases, at most two controlled rounds per cell. The
harness executes only owned transient reads; no mutation tool is executed. Each
revision caps calls at eight, output at 1200 tokens/call, aggregate tokens at 100k,
and a conservative USD 1 planning ceiling. These are caps, not billed-cost claims.
Semantic judgments were written to `semantic-review-blind.json` before reading the
arm map. This is a diagnostic pilot, not a powered non-regression benchmark.

The pilot wrote manifests, exact inputs, responses, read traces and blind reviews
to the system temporary directory, under
`kodax-eval-dumps/context-capacity-20261021-r1`, `-r2`, `-r3`. At final verification
these directories were missing: the existing orphan-worktree test called a global
cleanup matching every `kodax-eval-*` directory, including the eval dump root. The
cleanup now requires a worktree gitfile and successful repository-owned Git removal;
its regression uses an isolated temporary root and preserves an eval-dump sentinel.
The six harness tests pass after a failing preservation regression. Original pilot
dumps cannot be reconstructed. The following is the contemporaneous blind-review
summary, **not retained raw evidence or a reproducible quality qualification**:

- **r1:** four calls; both paged candidates requested paste/permission rather than
  retrieving. The fixture also conflicted with a historical edit. Revise the task
  fixture and make the legitimate local read contract explicit.
- **r2:** four calls; both candidates still refused retrieval. The new prompt used
  `file_path` while the production read schema requires `path`; preceding read
  evidence was also incomplete. This revision cannot establish paging quality.
- **r3:** five calls with corrected `path`, production read guidance and valid prior
  read/edit receipts. DeepSeek candidate made two read calls and showed retrieval
  progress but did not finish within the two-round cap. MiniMax candidate still
  requested confirmation/paste. Full-input DeepSeek preserved the hidden region,
  batch value and read-only verification next step; full-input MiniMax preserved
  region/batch but omitted the verification next step. No mutation was executed.

### Retained follow-up evidence: r4–r6

Raw manifests, inputs, outputs and main-session judgments are now retained locally
under `docs/research/context-capacity-20261021-r4`, `-r5` and `-r6` (ignored, not
committed). r5/r6 also preserve each request and controlled read result. The earlier
raw-loss record remains valid; new runs do not reconstruct or replace that evidence.

- **r4, five calls:** both full-input oracles returned the correct region, batch and
  read-only action. DeepSeek paged twice without reaching the hidden constraint;
  MiniMax refused the reference and proposed reverting the completed edit.
- **r5, six calls:** runtime provenance was added in the system channel and budgeted.
  Both paged candidates now read original text, with no re-paste request or mutation
  call. Neither finished within the preregistered two-round cap. Both full-input
  oracles retained the requested fields and completed-work awareness.
- **r6, four additional calls:** a separately preregistered bounded continuation
  reused r5 responses instead of regenerating them. Each alias could make at most
  two further requests; only owned text reads were served. MiniMax read lines
  131–200, recovered the correct JSON fields and both receipts, but added explanatory
  prose despite the JSON-only request. DeepSeek read an unhelpful slice, then proposed
  a bash command before seeing the binding constraint. The harness did not execute
  that command. No mutation or migration was rerun.

The full-input arm is a semantic oracle that exceeds the simulated 8192-token
window, **not an admissible old-version execution baseline**. r6 does not simulate
production compaction between reads, and later requests exceed that simulated
window. These are retrieval-semantic probes, not small-window end-to-end acceptance
or proof that this patch regresses relative to the old executable behavior.

**Decision: recommend-iterate; universal semantic non-regression remains unverified.**
The provenance change improves retrieval willingness in this sample. It does not
prove that every model reads all needed pages or obeys every omitted constraint.
Keep original evidence and completed work exact; do not substitute token reductions
or mock success for model-quality acceptance. Do not pool changed revisions as repeats.

## Outstanding acceptance

Automatic continuation across Host death and expired credential scopes is not
implemented. Persisting a recovery fact is not restoring an execution lease.
Independently resumable capacity waits for managed children are also outstanding.
Transient storage failures now recover in-process; permanent errors and process
death during an uncommitted transaction remain distinct boundaries. Text in mixed
image messages can page out, but arbitrary image/protected-state reconstruction
and model-independent reliable paging are not established. Therefore the complete self-recovery objective remains open.
See [the implementation record](../features/v0.7.97.md#proposed-context-capacity-self-recovery-after-feature_296)
and the dated ADR-067 follow-up for the exact delivery boundary.
