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

### KodaX-next-dev integration acceptance (2026-10-22)

Merged main `8a74c87a` into the first-turn optimization branch based at
`061a4616`. Feature documentation retains both histories in submodule merge
`33bee08f`. The integration preserves AMA routing/dispatch, the internal direct
executor, SDK bindings and underlying tools.

Two compatibility fixes have failing/passing evidence. Capacity recovery now
publishes hidden-tool discovery on the retained `tool_search` when the duplicate
`tool_describe` entry is absent; its planner suite passes all 12 tests. AMA
compaction now applies the existing persistent-transcript projection before
saving either the replacement or its exact pre-compaction snapshot. Request-only
managed context stays outside the checkpoint, and the current input supplies the
turn boundary for subsequent messages when its execution copy lacks a turn ID.
Existing canonical input metadata remains unchanged.

The built Host-kill fixture uses AMA for print, scoped credentials, Ink and
classic, matching this branch's retired SA product selector. All four pass.
The test checks the saved lineage's active entry and SHA against the checkpoint,
the committed tool call's original turn, the complete unfiltered durable message
prefix after restart, one original input, one append, one Run, preserved protected
content, and renewed scoped credentials. The earlier AMA failure changed that
durable prefix; this was fixed in persistence rather than hidden by filtering
fields in the assertion. Live presentation context is not used as the durable
history oracle. Failure cleanup aborts remaining Runs in the isolated fixture.

Final frozen-production-source checks on Windows: full build and source/test
typechecks pass; default full suite passes 1,215 files and 17,074 tests, with
four files/90 tests skipped and 19 todo (773.29 seconds); the complete bundle
suite with explicit PTY acceptance passes 48 tests, zero skips/failures.
`git diff --check` passes. Local logs, including failures and the earlier full
run stopped for the persistence fix, are under
`%TEMP%/kodax-main-merge-20261022/`.

#### Standards

Independent read-only integration review: zero remaining findings.

#### Spec

Independent read-only integration review: zero remaining findings. This round
uses local scripted providers and makes no paid model requests. Earlier real-model
results retain their original source scope; these checks establish recovery and
execution contracts, not semantic equivalence of the merged revision on GLM/Kimi.

### Full mainline compatibility audit (2026-10-23)

The audit covers the entire difference from main `8a74c87a`, beyond the latest
merge's four incoming commits. At integration revision `db3d6299`, main has zero
missing commits. Of 172 differing tracked paths, both independent reviewers
checked all 57 production-file changes against the retained optimization contracts.
The sole main-only file is the previously retired SA selector helper,
`packages/repl/src/common/agent-mode.ts`. Public package exports, SDK bindings,
specialist roles, AMA planning/dispatch and the internal direct executor remain.
The source declaration inventory retains all 78 builtin entries with unchanged
side-effect/read-only/plan-mode metadata; this is not a model-visible tool count.

Four compatibility failures received failing regressions and minimal fixes:

- **Todo provenance:** only builtin `todo_update` receives the compact model
  schema. Extension/constructed definitions retain their independent required
  fields through active-tool publication, exact discovery and AMA publication.
  Direct SDK execution still reaches their handler. The pre-existing AMA Todo
  wrapper's builtin handler binding is outside this fix; these tests do not claim
  custom Todo handler execution through that wrapper.
- **Host prerequisites:** builtin workflow, skill, history and MCP requirements
  no longer hide independent same-name registrations. Actual AMA runnable tests
  verify their handlers; inventory, exclusions and visibility policy still apply.
- **Independent Agents:** the final adapter no longer infers tool provenance from
  a name. Only the coding factory's exact Agent object receives registry alias
  folding and capacity-driven bridge fitting. Caller-supplied Agents and spread
  copies retain their explicit contracts, including same-name tools. Factory
  construction already projects its builtin contracts, so the adapter avoids
  repeating that projection. Copies conservatively lose these optimization
  benefits rather than having their tool definitions rewritten.
- **Reliable capacity discovery:** when an independent `tool_search` coexists
  with builtin `tool_describe`, small-window fitting preserves the latter and
  places its recovery hint there. Without a builtin execution bridge and reliable
  discovery, fitting retains the original surface.

These changes retain native search/repository entries and all underlying handlers;
they introduce no new exposure mode or AMA policy. Ordinary factory-created AMA
continues to use the existing compact contracts. Targeted failures and passing
reruns, source inventories and review evidence are stored locally under
`%TEMP%/kodax-mainline-integration-audit-20261023/`.

An additional extension-scope progress probe found different diagnostic
`executionId` values for the same call. The fresh scope-call object already exists
on main; Host, SessionView and Ink route the exercised events by call/tool ID and
displayed progress and successful completion correctly. This is a pre-existing
diagnostic limitation, not a demonstrated integration regression; it was not
expanded into a runtime change.

The first full run passed 17,088 tests with one failure: the delayed-review fixture
observed two completed reviews instead of one. A single-case control passed;
whole-file tracing showed the preceding persisted-session review entering the
provider two cases late, after repeated five-second cleanup deadlines. That
unchanged mainline fixture used the shared default Memory inbox. Its new ownership
assertion failed deterministically before repair (expected two reviews completed
before leaving the persisted case, observed zero). The fixture now gives both
runs one isolated temporary home and waits for each run's persisted review receipt,
matched by session and review key, before resetting counters or disposing. All
seven extension integration tests pass, including the unchanged delayed-review
assertion. Production reviewer behavior, output and deadlines remain unchanged.
Both review axes confirmed this test-only repair; the failed full run and the
diagnostic/red/green logs remain in the same temporary evidence directory.

Frozen-production-source validation on Windows:

| Check | Result |
| --- | --- |
| `npm run build` | Passed, including bundled CLI and standalone SDK declarations |
| `npm run typecheck` | Source and test checks passed |
| Four directly affected regression files | 93 tests passed |
| Extension integration / persisted-review ownership | 7 tests passed |
| Default full suite after the fixture repair | 1,215 files / 17,089 tests passed; four files / 90 tests skipped, 19 todo; zero failures; 809.62 seconds |
| Scoped V8 coverage: model contracts, discovery, exposure planner | 94.41% statements, 88.95% branches, 95.91% functions, 95.48% lines |
| Complete bundle suite with explicit PTY acceptance | 48 passed, zero failures/skips, including all four actual Host-kill recovery modes |
| SDK-serialized first-request comparison against `db3d6299` | All 16 complete normalized request bodies identical |

The scoped coverage figure covers the three listed modules, not the entire
adapter or repository. A built-package factory probe also confirms that removing
the adapter's repeated projection leaves the ordinary compact tool definitions
identical; independent Agent contracts intentionally remain unprojected.
The wire comparison reuses the preceding merge's capture and this full run's
capture: OpenAI/Anthropic protocols, the two execution-mode test labels, and
empty/AGENTS/catalog/Runtime-Host scenarios. Only fixture-created paths, session
scratch identity and filesystem snapshot time are normalized by the existing
capture helper; descriptions, schemas and controls remain intact. Internal direct
execution tests do not restore the retired SA user selector. These are scripted
requests with synthetic usage, not provider-reported token measurements.
The second full run's independent wire capture again matches all 16 normalized
requests. Production source stayed frozen through both full runs, bundle checks
and the fixture-only repair. Source/test typechecks pass, including a fresh test
typecheck after that repair; `git diff --check` passes.

#### Standards

Independent full-difference review and focused re-review: zero remaining findings.

#### Spec

Independent full-difference review and focused re-review: zero remaining P1/P2.
No paid model requests are made for this integration. Historical GLM/Kimi results
retain their original revision and scope; offline contracts do not establish
model-quality equivalence for the integrated revision.


## 2026-11-06: Small-context document pipeline acceptance

日期：2026-11-06。关联：[容量可靠性方案](../designs/context-capacity-reliability-plan-2026-11-06.md)、[Eval Guidelines](../../benchmark/EVAL_GUIDELINES.md)。

### 离线集成验收

入口：`tests/small-context-document-recovery.test.ts`。运行：

```powershell
node node_modules/vitest/vitest.mjs run tests/small-context-document-recovery.test.ts --reporter=dot
```

矩阵为 8 / 16 / 32 / 64 / 96 Ki-token 模拟窗口，每个窗口分别返回完整摘要和明确 `max_tokens` 截断摘要。临时文档包含 2,000 行具名例外与可继续页码，不读取用户文档。

测试经过真实 Runner、原生 `read`、最终 tool-result batch guardrail、文件持久化、managed compaction hook、实际 `compact` 和摘要请求构造。主生成使用真实 `buildRunnerLlmAdapter` 的受控 stream seam；该适配器负责每次成功响应后的请求估算与快照重建。摘要提供者也是离线受控实现，无网络和付费调用。

固定调用图：并行读取三个文档页 → 注入一次 Provider 上下文拒绝 → 历史恢复并提交 → 用真实 read 读取已保存页的续读提示 → 确认提示出现在下一次模型输入 → 根据提示读取原文下一页 → 完成。断言已完成工具不重复执行、保存内容与实际 read 返回逐字相同、精确用户约束仍可见、截断摘要从未成为检查点。

本测试证明受控运行链路的工程行为，不证明模型理解或自主选择读取范围的能力。固定 system/schema 特意较小；8K/16K 通过不代表生产任意完整工具菜单均能容纳。Provider 计数、摘要正文和下一步工具选择均受控，不能作为真实模型准确率或吞吐量报告。PDF/OCR 使用 Extensions 独立测试，不由本矩阵代替。

### 真实模型 pilot：拟定，未执行

状态：**未执行，不计为通过**。当前阶段不启动付费调用。以下是 `small-context-document-pilot-r1` 的预算与协议冻结；实际模型 ID、价格核验、精确 fixture 字节/hash 与生产提示快照在执行前补齐 manifest，任何变更均建立新 revision，不能边跑边扩样本。

Layer 1 无法回答：摘要是否保存跨章节例外、纠正后的事实优先级、出处和未读范围，以及模型是否正确利用分页提示。pilot 只回答这些语义问题；容量分类、持久化和请求次数等工程行为由离线测试先验收。

| 项目 | 冻结值 |
| --- | --- |
| 模型 | 用户实际使用的最多 2 个模型；选定具有 ≤100K 窗口且固定请求可容纳的配置，逐个执行 |
| fixture | 2 个：中英混合技术文档；含相互冲突条款与后续纠正的长文档 |
| arms / 重复 | 修复前、修复后各 1 次；相同文档字节、生产 tool descriptions 和主任务 |
| 每 cell 调用图 | G1 阅读页 A；S1 压缩；G2 注入页 B 与纠正；S2 压缩；G3 注入页 C 后回答；禁止自由工具循环 |
| maxCallsPerCell / maxRoundsPerCell | 5 次 Provider 请求，其中 3 次主生成、2 次摘要；共 5 个预定义步骤，超过普通 3 轮的原因是必须分别观察两次压缩前后的证据传递 |
| maxProviderCalls | 40：2 模型 × 2 fixture × 2 arms × 5；所有 transport retry / repair / fallback 也计入，无额外复核模型 |
| maxOutputTokensPerCall | 2,048，包括可计入该上限的 reasoning；由请求参数强制，不靠文字要求 |
| 输入上限 | 每次完整 envelope ≤12,000 估算 tokens，且仍须满足所选模型的输入 + 输出 + 安全边际；否则不发送 |
| maxTotalTokens | 600,000，输入/缓存输入/输出/reasoning 不重叠核算；每次调用前预留最坏预算，之后用 usage 对账 |
| maxExternalSpendUsd | US$5；执行前按所选模型当时价格核验最坏成本，超过即缩小新 revision 或停止，不能自动加预算 |
| timeoutMs / 并发 | 每次 90,000 ms；每 provider 同时 1 请求；超时保留为失败，不自动重试 |
| 工具执行 | 模型提出的调用只记录；由固定 harness 注入预定页面，不能扩大阅读/执行范围 |

先运行 1 个模型 × 1 个 fixture × 2 arms，共最多 10 请求验证实验是否可区分；这 10 次计入总上限。实验无效、预算不足、输出截断或前一阶段无可用摘要时，终止该 cell 并保留原因，不伪造中间结果、不追加补救调用。任何硬上限到达即停止。

fixture 在 A/B/C 三处预置精确可引用事实，并包含一个跨章节例外、一处后续纠正和一段明确未读的章节。分别观测引用是否可追溯、例外是否保存、纠正是否覆盖旧事实、未读部分是否被误称已读、已完成动作是否被要求重复。正则/JSON 只记录机械表现；主会话盲化读取配对原文、摘要和回答，逐项给出保留/遗漏/错误增强/证据不足及理由，不能用总命中率代替判断。

原始请求/响应、usage、超时和预算账本保存在 OS 临时目录下的独立 revision 目录，记录绝对路径与 hash，不提交 raw。报告必须区分 `eval-design`、`provider-noise`、工程故障、模型语义遗漏与 `inconclusive`，给出任务有效性、收益/回退、建议及下一步最小成本。历史源码比较或本次离线通过均不能填充真实模型结果栏。

## 2026-11-07: Actor restart completion wait regression

### 原始失败与诊断边界

冻结核心快照 `58671f8dea75a0df2498ad553536b17ee2b04896` 的全量运行保留为：1,425 文件中 1,417 通过、1 失败、7 跳过；19,723 项中 19,635 通过、1 失败、87 跳过。唯一失败是 `sdk-runtime.generation-actors.test.ts` 中独立 Actor 的 depth=0 重启恢复：恢复请求已返回，等待 `agents.output(...).state` 为 `completed` 时仍为 `running`。不能将后续定向通过追记为那一次全量通过。

原场景串行 12 次、四 worker 并行 48 次均未重现失败。仅凭这些通过不足以排除实际恢复故障，因此在同一 SDK `agents.followup` / `agents.output` 边界增加受控慢落盘场景：恢复后的执行器返回完成结果后，将当前 Session 的一次真实文件 rename 延迟 1,200ms，不改 Runtime、Actor controller 或存储实现。

未修复内层等待时，受控场景两次均在同一 `running` / `completed` 断言失败。临时定向诊断记录：原内层等待结束时为 `running`；约 1,307ms 后变为 `completed`；再次关闭并重启 Host，仍能读到持久化的 `completed`；执行器调用合计两次，即原执行一次、恢复一次，没有重放。临时诊断代码已删除，原始诊断日志位于 OS 临时目录 `kodax-actor-restart-20261107`。

Vitest 4.1.11 的 `vi.waitFor` 默认 timeout 为 1,000ms；外层测试的 20,000ms 不会扩大这个内层期限。Actor 的终态须等待持久化提交，合法的异步落盘可能超过 1 秒。这确认了测试时限缺口；受控延迟复现不等于取得了原始全量失败的完整时序 trace，不能据此声称排除了所有其他恢复竞态。目前未重现终态丢失或恢复后重复执行的生产缺陷。

### 修复与回归

只将该文件的五处 Actor 完成等待显式设为 5,000ms，保留外层测试硬上限及原有状态、Turn identity、checkpoint、调用次数和 Stop 拒绝断言。新增 `slow-settlement` 场景验证慢落盘后完成、再次重启后终态仍存在，且没有额外执行器调用。所有普通场景继续使用真实存储，不注入延迟。没有增加生产配置或修改生产 deadline。

首轮完整文件验证：10/10 通过，其中慢落盘场景约 2 秒。随后以四 worker 运行 Actor controller、owner liveness、Runtime Actor facade、generation recovery、本文文件及小窗口文档恢复，共 6 文件 / 161 项全部通过。`npm run typecheck` 的 source / tests 均通过，`git diff --check` 通过。此次仅测试和验收记录变更，未重新运行全仓 1,425 文件或重新构建生产包；此前全量的原始失败继续保留，不改写为全量通过。

“首轮运行后锁定 work mode”由另一线程维护。本补丁不修改 Runtime、work-mode 授权、settings/storage 逻辑或其断言；若后续整合出现相关语义冲突，应暂停该部分处理，不能放宽模式锁定以使测试通过。
#### Standards

独立逐 hunk 评审：0 项发现，无严重级别。未发现新增成文规范违反或需要处理的基线坏味道。

#### Spec

独立需求评审：0 项发现，无严重级别。保留原 Turn、fresh authority、checkpoint 和 Stop 断言；真实 Session rename 延迟、第三次 Host 启动后的终态和调用次数检查覆盖持久化与不重放。受控复现与历史全量 trace 明确分开；未修改 work mode 锁定机制。

### 2026-11-07 后续调查：五秒缓解不构成完整修复

后续三路交叉审查和精确提交门控发现独立 Actor 的生产一致性缺口：`environment.release` 先提交 Run `completed`，Controller 随后才提交 Actor canonical terminal。门控时实际观测 Run 为 `completed`、Actor output 为 `running`、真实 save attempt 停在 `commit_inflight/rename`；硬终止该自建 Host worker 后，另一进程启动仍读到 Run `completed`，Actor Turn 却已 `interrupted`，恢复被拒。

这确认了需要修复的独立 Run 结算屏障，不能继续将 `64dab173a` 的五秒等待解释为完整生产修复；历史全量失败仍不能唯一归因为人工慢落盘。门控与硬崩溃 raw 位于 OS 临时目录 `kodax-actor-root-cause-20261107`，没有提交 raw 或一次性探针。

具体根因、证据边界、拟定的最小修复及验收门见 [Actor 重启结算分析](../designs/actor-restart-settlement-analysis-2026-11-07.md)。该方案尚未实施，验收门未计为通过。work mode 锁定机制及生产源码保持不变。
