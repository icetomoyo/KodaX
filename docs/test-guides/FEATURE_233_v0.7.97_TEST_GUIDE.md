# Effort chain regression — v0.7.97

## Contract

Built-in roots inherit selected effort through configuration, Session settings,
live controls, resume and compaction. A role default must not silently replace
high/xhigh/max with medium. Physical protocol aliases and acquired-identity
rejection learning remain independent of the selected intent.

AgentReasoningProfile/AgentReasoningRef use native effort strings. Legacy
SDK declarations and persisted profiles normalize at their intake boundaries:
off→none, quick→low, balanced→medium, deep→high. Native/custom efforts pass
through. Inputs and saved artifacts are not rewritten. Explicit specialist
policies remain explicit; retired escalateOnRevise is accepted for compatibility
without activating an escalation path. Built-in roots have no such profile.

Explicit child auto means provider default; omission inherits parent effort.
Specialist locks retain their conflict checks. Specialist profiles reach both
read/write executors: omission uses the declared default within the parent
selection, explicit dispatch wins over that default, and a declared maximum
cannot be exceeded. Conflicting explicit selections fail before model execution.
Parent legacy mode/thinking inputs reach the tool→Actor/workflow→child path,
with native effort taking precedence. Live Session controls affect later child
requests too: AMA does not retain an old options copy, and SA reads its current
runtime selection rather than the initial plan. Tool-context selection getters
do not add persistence, credential resolution or provider calls.
AMA uses the existing per-Run extension frame. Session hydration, runtime
setThinkingLevel and provider:before therefore share the current model/effort
selection with the next request, tool/child inheritance and the compaction
prefix. Each request captures its selection before invocation; later controls
apply to subsequent requests. Provider hooks retain their block semantics.
An in-memory selection revision fences asynchronous hook writeback, including
an ABA control update back to the original value. Session controls, extension
controllers and Skill model selection advance it. It is neither persisted nor
part of Client settings/Provider payloads. SA and AMA exercise delayed hooks
while effort/provider/model change, rather than only synchronous hook cases.
The existing shared Actor budget is bound before Actor attachment, so this
selection change cannot create an uncharged child admission path.

CLI help now recommends native effort. The shared dim-label printing extraction
was checked against its immediate built precursor (after the thinking-topic
wording update): eight topics with FORCE_COLOR 0/1 yielded 16 byte-identical
stdout renders. This does not claim all wording is unchanged from the pre-fix
branch. The original strict CLI budget test remains required and unmodified.
Self-modification compares
native efforts using the same ordering as explicit specialist constraints.

Client activity.reasoning is an optional primary-request fact, not a setting:
provider/model, request ID, requested/sent effort, fallbacks and verified:false.
Missing sentEffort does not mean disabled thinking. New requests clear this
fact; stale, child and workflow requests cannot replace it. Older Hosts may
omit the fact. Neither settings nor sent parameters prove service execution.
Normal aliases and cached fallbacks stay quiet; new rejections remain visible.

## Executable regressions

- packages/coding/src/agent.managed-effort.test.ts drives the real managed
  entry for all eight standard efforts with conflicting legacy input; actual
  SA/AMA runs also change high→max before a tool executes and check both the
  next Provider request and the parent selection visible inside that tool.
  Loaded extension hydration/runtime controls and provider hooks exercise the
  same paths. A real native Actor admission checks the shared budget charge.
- src/sdk-client.live-settings.test.ts drives real Client/Host requests across
  high→none→max→auto→legacy quick→off, provider/model changes and compaction.
- src/sdk-client.capabilities.test.ts uses an offline native HTTP endpoint:
  both SA/AMA request high, receive a real protocol rejection, learn medium,
  preserve settings, expose the actual result and stay quiet on the next Run.
- src/session-view.reasoning.test.ts covers request attribution and quiet
  profile/cached resolutions. Existing status/CLI tests retain selected labels.
- Agent primitive, construction admission/resolution, scaffold and self-modify
  tests cover canonical declarations and legacy inputs without input mutation.
- Child executor tests cover read/write explicit auto and specialist selection.
- Skill Creator assessment helpers use native medium for their independent
  requests, accept effort/--effort and preserve explicit legacy inputs. Their
  public API and real script entries have 15 offline SDK-boundary cases.
  ModelHint fast/balanced/deep remains a separate model-routing contract.
- tests/bundled-session-crash-recovery.test.mjs drives three distinct real
  Hosts through the published SDK: failed high requests, retained settings and
  credential fencing, history reads without execution, then successful max.

The real bundled test was RED on the prior artifact: medium !== high. It uses
only owned temporary homes and an offline local HTTP endpoint. It does not
restart a user's Host or use personal credentials.

## Acceptance

Run source/type checks, the full build and existing bundle suite. The strict
CLI startup size/input budgets remain unchanged. Include startup recovery
fixtures to check the previous per-record process-probe regression. Actual
remote service acceptance and model reasoning depth are outside offline proof.

### Source acceptance — 2026-10-31

The final source result is a whole-file composite, not a claim that one full
invocation passed: 1,373 files, 18,884 passed, 73 conditional skips, 0 failed
and 0 TODO. The full invocation had 18,864 passes and five failures: four
new delayed-hook regressions against the earlier implementation and one
Windows EBUSY in an owned Script fixture's final directory removal. Final
complete affected paths (302 files / 2,957 cases), declaration/construction
files (8 / 107), Script boundary file (1 / 6) and helper files (3 / 43) all
passed; these replace entire files in the full result, without counting the
same case twice. The fixture cleanup now uses bounded filesystem retries;
production timeouts and recovery limits were not increased.

All 23 public managed-effort cases pass, including asynchronous selection/ABA
changes, real Actor budget charging and loaded extension controls. The helper
boundary cases were RED (15) before their implementation and GREEN afterward.
Source and test TypeScript checks pass. Scoped coverage of Agent declaration,
effort ordering, self-modification and runtime selection state is 97.56% lines,
97.64% statements, 92.63% branches and 100% functions (100 passing tests).
These percentages describe four modules, not repository-wide coverage.

The 73 remaining skips require platform/manual conditions (41 POSIX/Linux,
25 real Windows V2 sandbox, seven manual); the available Chrome cases were
enabled. Remote keys, real OAuth refresh and service reasoning execution are
not established by these offline tests. Main artifact checks are recorded
separately below after the guarded local integration.

### Local Main artifact acceptance

Functional commit `9e3147da47536b1ed3fb8817c0e351b8923776c3` was safely
fast-forwarded into local KodaX. The actual Main workspace passed the full
build, all 14 self-contained SDK declarations, source/test type checks and
six complete public execution/SDK/projection files (192 cases).
CLI size is 5,177,060 bytes against the unchanged strict 5,177,344-byte limit;
the existing published manual/input budget tests pass.

The full Main bundle invocation ran 86 cases: 85 passed, one failed because
an ASRT test required exactly two binds despite a legitimate additional OS
port collision. The production five-attempt bound and sandbox policy were
already correct. Test-only commit `19aa6a3c3cfb0ff82974d7a931d33ee71403373d`
adds a deterministic EACCES-plus-EADDRINUSE case and checks successful attempts
within that same bound; exhausted/fatal attempts, distinct candidates and
ports outside the permit range remain strict. The added case was RED before
the assertion fix. After guarded integration, the complete eight-case ASRT
file passed against Main's real SDK. Replacing that entire file in the bundle
result yields 87 passes, zero failures/skips/TODO. This is a file-level
composite, not a second all-green full invocation.

The real bundle covered three-Host effort/authorization recovery, credential
migration/account selection, offline OAuth refresh/revocation, startup/process
recovery, memory-review shutdown, Responses/WebSocket, MCP/Skills and actual
npm tarball Script execution. On Main, 512 mixed historical records became
ready in 2,066 ms and 1,468 ms on restart; 220 exited trees were ready in
2,584 ms, first concurrent history reads took 51 ms, restart 1,399 ms.
These are bounded offline fixtures, not a promise about all user sessions.
Issue 371's separately tracked historical Session-read latency remains open.

The peer thread's untracked tmp_diffstat.txt was retained byte-for-byte;
no tracked Main changes were overwritten. The design subrepository remains
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`. Space remains independent at
`codex/provider-credentials-space@7b37e1c8ddf0d72d8674d521f1e8e0298d3341a2`.
No user credential files, user Host processes, package versions or release pins
were changed; nothing was pushed or published.

### Effort shortcut feedback — 2026-11-01

Ctrl+T no longer appends a successful Host-default/Session receipt to the
conversation. Its existing Host save/apply operations remain authoritative:
the existing toast surface shows a shared-clock spinner while waiting, then
a compact confirmed effort for approximately two seconds. The status bar
continues showing the selected effort. The timer begins after success, not
at keypress; a newer operation replaces the toast and gets its own full grace.
Errors and partial success keep the detailed durable feedback. Explicit
`/effort` commands retain their previous receipts and query behavior.

Rapid keypresses execute serially and calculate each next selection from the
preceding confirmed state. Only the latest result becomes a success toast.
Session changes, unmount and the start of graceful exit cancel queued work
and suppress late UI/receipt updates, including while exit is still waiting
for persistence. A canceled shortcut does not poison the shared settings
write queue. These changes add no Host polling, protocol fields, preferences,
credential operations or Space product changes.

The real React hook/toast regression was RED when success still called the
durable reporter, then GREEN. Ten hook cases cover the two-second timer,
pending animation beyond two seconds, burst ordering, returned/thrown errors,
empty model ladders, replacement TTL and Session/unmount/closing cleanup.
The closing-window case was added after Spec review found cancellation had
initially happened only at unmount. The complete hook/toast test files pass
12 cases, with scoped coverage of 100% lines/statements/functions and 94.11%
branches across those two modules; this is not repository-wide coverage.

CLI budget was kept at 5,177,344 bytes. The initial implementation exceeded
it at 5,178,294 bytes. Reusing seven identical option descriptions and the
existing bold-heading output shape reduces the final CLI to 5,176,989 bytes.
Twenty root/topic/ACP help renders (color off/on) are byte-identical before
and after extraction. Full build, SDK declarations and source/test type checks
pass; the unchanged four published size/manual gates and two real cold-Host
session/effort/credential-fencing recovery cases also pass.

The final complete REPL suite plus SDK catalog/CLI option/daemon-smoke files
passes in one invocation: 261 files, 3,108 passed, one POSIX-only conditional
skip, zero failures and zero TODO. This is the final shortcut/exit/budget tree;
the earlier 3,030-case REPL result is not substituted for this acceptance.

Functional commit `306eafdfa8ec3242abeead9e1fdf56ee3763b45e` is also in local
KodaX. The actual Main checkout was rebuilt and passed source/test type checks,
four complete feedback/shortcut/SDK catalog files (42 tests), all six published
budget/cold-recovery tests and the same twenty byte-identical help comparisons.
Its CLI is also 5,176,989 bytes. The peer's untracked audit document changed
during work; integration rechecked the current files, confirmed disjoint paths
and preserved both that document and tmp_diffstat.txt. No user Host was stopped
for deployment. Space/design revisions, package versions and release pins are
unchanged; nothing was pushed or published.

Historical follow-up outside the UI change: an attempted broader help probe found
that daemon management `--help` can dispatch an operation instead of only
printing help. In the isolated temporary home, start/stop dispatched and
restart returned an operational failure. The fixture Host has a successful
shutdown receipt and no active ownership; no user's Host was targeted.
The first affected version is unknown (observed in 0.7.97-alpha.11 with the
unchanged pre-extraction CLI code). At that checkpoint it remained unfixed;
the twenty passing output comparisons above deliberately excluded those
entry points. The repair and independent acceptance are recorded below.

### Daemon help dispatch repair — 2026-11-01

The root `--help [topic]` is an ordinary Commander option. Root parsing consumes
it before dispatch, so a nested command no longer sees the flag and can execute
its management action. A real daemon command-tree regression replaced only the
management callbacks with counters and was RED: start's action ran once for
`daemon start --help`. A second nested/alias regression proved the same shared
root cause outside the daemon family.

Root's `preSubcommand` boundary now honors the consumed help option before
nested argument validation or actions. It follows the registered command
prefix, including aliases, and prints the target help. Root topic help remains
compatible. Plain commands still execute normally; an option value such as
`--profile=--help` or a literal after the end-of-options delimiter is not promoted to a help
request. Existing excess-argument validation remains intact.

The six daemon registrations were moved unchanged into their own constructor
for the real-tree tests; a byte comparison confirms all six action bodies and
options are identical. Main invokes this constructor at the original location.
No Host shutdown policy, SDK protocol, credential selection, package version
or release pin changes are involved.

Acceptance on the independent final runtime tree:

- Ten affected CLI source test files: 191 passed, zero failed/skipped/TODO. The real
  command-options file has 67 cases; option helpers add 42 targeted cases.
- The full published bundle invocation: 89 passed, zero failed/skipped/TODO,
  covering the new help cases plus normal CLI/Host recovery, credentials,
  OAuth, memory-review shutdown, Responses, MCP/Skills and tarball execution.
- Final help fixture file: two cases passed after its failure cleanup was
  strengthened. Its 26 real help subprocesses cover long/short flags for all
  six leaves and group help. With tracing enabled, an absent Host's directory
  tree and configuration stay unchanged; a live independent Host keeps its
  runtime identity and ownership/state/token hashes. No user Host is targeted.
  Cleanup attempts shutdown, disconnect, exact-owner verification and current
  fixture-owner cleanup separately; failures retain evidence and aggregate
  errors. This final two-case rerun is not added again to the 89-case count.
- Full build and source/test type checks pass. CLI is 5,177,260 bytes within
  the unchanged 5,177,344-byte limit. Twenty existing root/topic/ACP help
  renders remain byte-identical in both color modes.
- Coverage for only the new root dispatch barrier: 11/11 statements, 6/6
  branches and 2/2 functions. This is not whole-file or repository coverage.

The public management entry points are now safe to use for help. Ordinary
management actions remain intentional operations and are exercised separately.
Functional commit `8a8bd445e6f62f899fb850b757ce78879abcde65` was safely
fast-forwarded into local KodaX. The actual Main checkout was rebuilt and
passed source/test type checks, 109 targeted command/option tests, eight
published help/budget/cold-recovery cases and twenty unchanged help renders.
Main's CLI is also 5,177,260 bytes. The peer's three untracked review/scratch
files were preserved and not staged or pushed.

GitHub refs were independently verified after push: Root `origin/KodaX`
contains that functional commit; design `origin/main` contains the pinned
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`, pushed before Root so its gitlink
is reachable. This includes the previously local Root/design integration
history. Space was not pushed; no package, version tag or release was created.
The push receipt also reported 30 default-branch dependency alerts (eight
high, twenty moderate, two low). This task did not investigate those alerts;
these counts are the remote receipt, not a security-audit result.

## Standards

Independent review against AGENTS.md and the Fowler smell baseline: zero
remaining rule violations and zero actionable smells. Follow-up review covered
the test cleanup, helper-script migration and synchronized declarations/examples.
The subsequent ASRT test-only increment also has zero remaining findings.
The 2026-11-01 shortcut feedback and budget-preserving extraction also have
zero remaining rule violations or actionable smells.
The daemon help repair has zero remaining findings after fixing the native
fixture's failure cleanup chain.

## Spec

Independent review against this contract and the user's effort/SDK/compatibility
requirements: zero remaining findings. Earlier findings on specialist propagation,
legacy parent inputs, AMA extension controls, shared Actor budget and asynchronous
hook writeback were fixed and covered by public execution regressions.
The subsequent ASRT test-only increment also has zero remaining findings.
The 2026-11-01 shortcut feedback increment has zero remaining findings after
closing-window cancellation was added.
The daemon help repair has zero remaining findings.
