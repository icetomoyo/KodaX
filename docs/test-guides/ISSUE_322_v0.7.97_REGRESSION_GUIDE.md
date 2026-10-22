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

The follow-up is implemented locally; the 2026-10-22 extension below records restart,
authority and model acceptance. Exact user messages remain canonical. Recovery first reduces eligible
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
Managed children forward capacity events with their own identity, worker checkpoint
and session control. The Host stores separate wake slots, so one child cannot
overwrite another child or the root. Nested recovery follows direct parent edges.

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

## 2026-10-22 restart and authority acceptance

The later implementation supersedes the incomplete delivery statements above;
earlier failed model observations remain historical evidence.

| Boundary | Regression |
| --- | --- |
| New SA and AMA executor | Exact checkpoint history and original turn; no repeated prompt or completed edit dispatch |
| Host shutdown/restart | Recovering checkpoint survives; same Run ID resumes after verified dead-owner claim |
| Independent Actor tree | Depth 0/1/2 resumes original worker Sessions and Actor turns exactly once per new executor |
| Concurrent Hosts | Exactly one revision claim succeeds and one executor launches |
| Stop and changed history | Stop wins; digest/lineage mismatch refuses execution |
| Fresh daemon authorization | Public `run.recover` with new scoped credential and Host-tool leases executes under the original principal |
| Pending user constraints | Complete body restored under fresh authority; enqueue/withdraw persistence failures leave prior state intact |
| Restore admission | Capacity and conflicting intents checked before taking ownership |
| Goal budget | Each extraction call is charged; exhaustion stops before another chunk or main generation |
| Parent mailbox wait | Real AMA `spawn_agent` and `run_workflow` followed by `wait_agent`: close commits the wait receipt, restart resumes parent and original leaf |
| Workflow reconstruction | Original native leaf/bundle/result identity; verification repair still runs, including a second restart during repair; completed receipt reaches the live ancestor |
| Worktree isolation | Pin precedes checkpoint publication; terminal/stale sweeps retain it; restore checks repository, registered checkout and checkpoint |
| Input ownership | Foreign principals remain unbound across multiple restarts; subsequent inputs cannot bypass their constraints |
| Cross-Host persistence | Stale queue writes fail before memory changes; failed queue storage does not claim the recovering Run |
| Session isolation | Identical Actor paths/turn IDs in two Sessions retain separate recovery records |
| Original input intent | Omitted/immediate/after-turn/redirect delivery and target identity survive restart and fresh binding |
| Mixed-Session shutdown | Ordinary Run completion/Stop persists synchronously while another Session prepares its checkpoint |

Root recovery uses `runtime.runs.recover({ runId, options?, authorization? })` through
the daemon client, or the equivalent trusted embedded binding. Independent Actors use
`runtime.agents.followup(sessionId, actorPath, '', { resumeCheckpoint: true, ...freshAuthority })`.
The recovery request references saved work; it is not a new user turn. Required
callbacks must be supplied again and satisfy the original tool/provider ceilings.
No credential value or executable callback is serialized into the recovery file.

Product clients call `client.runs.recover({ sessionId, runId })`; the trusted
`authorizeExecution` callback receives `kind: 'recovery'` and binds fresh leases.
The request cannot inject its own authority. This adds the callable Product API;
it does not change the REPL's existing fork-oriented `/recover` command.

Native Workflow recovery resumes the checkpointed leaf, not an arbitrary JavaScript
stack. Its original result and verification survive, and the live parent receives
the completed leaf receipt so it can continue from evidence. Custom executors still
require their original executable binding; no generic Actor substitutes for one.

Focused coverage (2026-10-22, seven recovery modules, Vitest/V8, 54 tests): statements
92.48%, branches 84.16%, functions 94.89%, lines 95.79%. This is scoped coverage,
not a claim that every repository file meets those percentages.

## Final local validation (2026-10-22)

Validated the final implementation on Windows after `163918e5`, with source frozen
during the final full run. No version bump or release was performed.

| Check | Result |
| --- | --- |
| `npm test` | 1,185 files passed, 4 skipped; 16,845 tests passed, 90 skipped, 19 todo; zero failures; 703.03 seconds |
| `npm run typecheck` | Source and test TypeScript checks passed |
| `npm run build` | Configuration templates, packages, native build, bundles and standalone SDK declarations passed |
| `npm run test:bundle` | 44 tests passed; zero failures/skips, including daemon compaction, credentials, shutdown and shared Host recovery |
| Standards review | Independent read-only review; no remaining P1/P2 findings |
| Spec review | Independent read-only review; no remaining P1/P2 findings |

The repository defines no lint script. Earlier validation failures were retained
and repaired: live cross-client input idempotency, loss of delivery/target metadata
in pending-input snapshots, and synchronous close settlement (including a mixed
Session checkpoint wait). These have red/green regressions. A daemon launcher
rejected a source revision changed during an earlier test run; the final frozen
run passed that same test without disabling its stale-build protection.

Local logs and red/green evidence are retained in ignored
`docs/research/context-recovery-validation-20261022/`. The real-model evidence and
its narrower semantic scope are recorded separately below; offline test counts
are not model-quality scores.

## Retained model evidence: r7–r11

Manifests, each exact request, extraction/read output, final response and usage are
retained under ignored `docs/research/context-capacity-20261021-r7` through `-r11`.
These are bounded production-helper acceptance probes, not a full autonomous task
benchmark or a claim about all models. They use production system/read/edit/bash
definitions; mutation handlers never execute. Different revisions are not pooled.

- r7/r8 exposed request-budget and retrieved-page eviction problems; neither is a
  semantic pass. r7 full-input outputs are semantic oracles outside the 8K limit.
- r9 kept requests within 8K and read all pages, yet MiniMax lost the earlier binding
  constraint after its page was evicted. DeepSeek reached the round cap. Reading alone
  therefore did not satisfy retention.
- r10 introduced production verbatim memory extraction. DeepSeek returned only JSON,
  with `eu-north-1`, batch size `7`, and read-only verification of completed `MIG-042`;
  it did not repeat `EDIT-019` or call a mutation. Estimated final request plus output
  reserve: 6329 tokens. MiniMax over-retained repetitive background and entered the
  capacity wait; this was not counted as a pass.
- r11 clarified selection of repeated background and reran only the affected MiniMax
  cell, reusing prior raw evidence. MiniMax returned only JSON with the same correct
  values, explicitly prohibited file modification/commands and migration replay.
  Estimated final request plus reserve: 6356 tokens. No additional tool call occurred.

The main-session semantic review inspected the complete final outputs and selected
quotations, not just numeric scores: both accepted cells obeyed the hidden constraints,
retained completed-work awareness, and required no re-paste or reauthorization of old
work. Ordinary fitting input bypasses the new memory path. This is scoped evidence;
lossless original storage and exact quote validation cannot prove that every future
model will select every relevant clause.

## Recovery boundaries

### CLI/REPL automatic continuation follow-up (2026-10-22)

The follow-up after `a860105e` connects print CLI, Ink, classic and the Product
ensure launcher to the existing recovery contract. A live launcher keeps its
authenticated principal across Host replacement; observed/awaited checkpoints
request fresh trusted authorization. Passive connect remains passive. No input,
tool, command or other business mutation receives generic transport retries.
Explicit exit cancels connection backoff and cannot claim an unacknowledged Host
exit succeeded. A second Host loss during recovery or observation setup retries
connection and rereads Host facts before deciding whether continuation is valid.

Run the built-process regression with:

```powershell
npm run build
node --test tests/bundled-cli-host-recovery.test.mjs
$env:KODAX_RECOVERY_PTY='1'
node --test --test-force-exit tests/bundled-cli-host-recovery.test.mjs
Remove-Item Env:KODAX_RECOVERY_PTY
```

The PTY variants require the external node-pty, @xterm/headless and
@xterm/addon-unicode11 installation described in FEATURE_298's acceptance guide.
Node 22's `--test-force-exit` closes the test driver after test completion because
node-pty 1.1.0 retains ConPTY worker ports after natural child exit on Windows;
the tests independently require the actual REPL process to exit before passing.
Default `test:bundle` includes the print and scoped-authorization cases; PTY
acceptance is explicit so machines without native terminal dependencies do not
silently skip a purported terminal check. All fixtures use local HTTP, no model
account or paid request.

Each case executes an append, reaches a real durable generation checkpoint,
kills the actual Host process, and waits for automatic replacement and the same
Run's completion. Assertions check the entire pre-restart canonical message
prefix, one original user input, the original constraint and tool receipt in the
resumed provider request, unchanged protected content, one append and one Run.
The scoped case confirms a new Host and new lease, with the resumed HTTP request
using that new credential. Both terminal cases wait for a usable prompt and
successfully submit `/exit` after recovery.

The first built-process run exposed a canonical digest mismatch: file storage
preserves lineage metadata which the Runner request transcript may omit. The fix
hashes committed lineage messages and continues to reject a subsequently changed
history. Other red/green cases cover two consecutive Host losses, reconnect-time
exit, Stop/cancel, missing checkpoint/authority, invalid frames, no mutation replay,
late old-connection deliveries and closing an in-flight observation.

This is transport/process regression evidence. The real-model semantic evidence
above is unchanged and is not replaced by scripted-provider results. Client process
death with a lost identity/secret and uncommitted or ambiguous effects are outside
this automatic continuation contract.

#### Standards review

Independent read-only review found one P2: recovery preparation was outside the
transport-loss catch. It was fixed and a second-loss regression added. Re-review
confirmed no remaining P1/P2 or actionable standards violations.

#### Spec review

Independent read-only review found the same await gap plus observation reattach
loss and exit/backoff deadlock. All three received failing regressions and fixes;
the focused suite passed after repair. Re-review confirmed no remaining P1/P2
and no scope expansion. Standards: 0 remaining findings; Spec: 0 remaining findings.

Follow-up validation on Windows with production source frozen during the full run:

| Check | Result |
| --- | --- |
| Focused recovery tests | 33 passed across 3 files |
| Scoped V8 coverage (connection recovery + durable compaction) | 94.68% statements, 89.80% branches, 97.87% functions, 99.05% lines |
| Built CLI / scoped / Ink / classic Host-kill acceptance | 4 passed; both REPL processes exited normally after recovered work |
| `npm run test:bundle` | 46 passed, zero failures/skips |
| `npm run typecheck` | Source and test checks passed |
| `npm run build` | Full build and standalone SDK declarations passed |
| `npm test` | 1,187 files passed, 4 skipped; 16,869 tests passed, 90 skipped, 19 todo; zero failures; 804.12 seconds |

The repository has no lint script. Test logs are retained locally under ignored
`docs/research/cli-host-recovery-validation-20261022/`.

Continuation requires available storage, a usable model window and valid authority.
Missing conditions preserve a verified generation checkpoint and wait; they do not
authorize blind retries. Stop, explicit budgets, unresolved effects and corrupt or
changed canonical history remain fences. A crash before any durable commit cannot
be represented as a committed operation. Images/protected state remain intact and
wait for sufficient capacity. SDK users without Host callbacks receive typed errors.
See [the implementation record](../features/v0.7.97.md#proposed-context-capacity-self-recovery-after-feature_296)
and ADR-067 for the ownership and persistence contract.
