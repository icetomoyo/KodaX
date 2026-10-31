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

## Standards

Independent review against AGENTS.md and the Fowler smell baseline: zero
remaining rule violations and zero actionable smells. Follow-up review covered
the test cleanup, helper-script migration and synchronized declarations/examples.
The subsequent ASRT test-only increment also has zero remaining findings.

## Spec

Independent review against this contract and the user's effort/SDK/compatibility
requirements: zero remaining findings. Earlier findings on specialist propagation,
legacy parent inputs, AMA extension controls, shared Actor budget and asynchronous
hook writeback were fixed and covered by public execution regressions.
The subsequent ASRT test-only increment also has zero remaining findings.
