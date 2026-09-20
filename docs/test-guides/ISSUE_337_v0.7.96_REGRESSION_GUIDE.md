# Windows startup ownership handoff

## Agreed implementation scope

Issue 337 fixes a Windows startup candidate that outlives its launcher before
it becomes a public shared service. Ordinary daemon persistence and client
close semantics remain unchanged. Issue 336 separately fixes fixture teardown.

The existing detached Node wrapper and the daemon arbitrate once by exclusively
creating one random private decision file. This applies only to newly spawned
Windows daemons. There is no new process, background timer, process scan, or
handshake on existing-owner reuse.

- The daemon captures and removes the internal decision environment variable
  before extension initialization can spawn children. One idempotent commit
  closure runs before the first public listen, whether hosted A2A or daemon RPC.
- Daemon creates first: publication is allowed. Launcher disconnect, explicit
  startup cancellation and health-check timeout cannot kill the committed owner.
  Its own initialization failures still follow normal cleanup and process exit.
- Wrapper creates first: publication is denied, and the wrapper terminates its
  exact PowerShell child; the Job contains the daemon and its descendants.
- An abort marker remains until the child exits. A commit marker may be removed
  only after the wrapper irreversibly records persistent ownership. Repeated
  events cannot recreate the decision. Unexpected file errors are reported and
  never interpreted as permission to kill an already committed service.
- The wrapper owns fallback cleanup of its PowerShell script and readiness
  record if the launcher dies before low-level readiness. Abort cleanup checks
  the recorded target's exit after the Job owner exits; uncertain cleanup keeps
  the abort marker and reports the failure. PowerShell spawn errors must exit
  promptly even when no child `exit` event will arrive.
- A retained termination result detaches the launcher without waiting for an
  intentionally persistent process to exit. Competing startup cleanup must not
  falsely report a retained candidate as reclaimed.

## Implementation and acceptance sequence

1. RED/GREEN at real Windows Job launch/termination and daemon-publication seams.
   Include launcher death, pre-commit abort, post-commit explicit termination,
   marker lifecycle, env capture and file errors. Preserve legacy generic Job
   behavior when handoff is not requested.
2. Wire one commit through CLI, manager and host; exercise hosted A2A and RPC.
   Prove a second client's running stream completes after the first launcher
   dies or cancels, and prove the losing election candidate exits.
3. Run lifecycle, exact-owner shutdown, Shell descendants/registry, runtime Stop,
   and CLI smoke regressions, then full tests, typecheck/lint where configured,
   and build. Keep unrelated user changes out of the commit and classify any
   unrelated failures explicitly.
4. Compare archived baseline and candidate installations using fresh isolated
   Homes, the same fixed dependencies and alternating order. Start with one
   pilot pair to validate the harness, then ten pairs, three warm attaches each.
   Record cold-to-SDK-ready, warm attach, client close and verified stop. Local
   fake provider only; external model calls and spend are zero. Raw outputs live
   under the OS temporary directory. No performance load runs in parallel.
   A repeatable slowdown or added wait on warm/early-failure paths blocks
   acceptance; noisy results remain inconclusive rather than "zero regression".
5. Independent Standards and Spec review; address correctness findings before
   committing the scoped changes. No old process residue is cleaned by this fix.

The pre-design experiments and their limitations are retained in the
[Issue 336 guide](ISSUE_336_v0.7.96_REGRESSION_GUIDE.md). Formal results follow
after implementation; prototype measurements are not production acceptance.

## Validation environment

The shared development worktree had other concurrent source edits. The first
execution regression run passed 175 cases and failed four CLI cases with the
existing `launcherBuild` guard ("This launcher loaded an earlier build"). A full
run begun in that same changing tree was stopped and its own process tree
reclaimed. Neither run is accepted as stable final evidence. Final source tests
and paired performance measurements use frozen trees; the two performance arms
share all other inputs and differ only in this issue's five existing production
files. Raw initial logs are retained under the OS temporary directory.

The frozen candidate contains all tracked root files, design documents and the
required built/native assets, but has no root `.git`. Ten Git-dependent test
files were therefore verified in a separate `git-checks` copy with its own local
initial commit, no remote and no copied Git metadata. `docs/features` is ordinary
content there, not a link to the development repository. All 46 cases passed;
that repository ended clean with no extra worktrees or surviving test processes.
This verifies the environment-dependent cases without changing the frozen
candidate during its full run. Log: `kodax-337-isolated-git-checks.log` in Temp.

## Standards review

Independent review found no production standards violations or blocking code
smells. One unused helper in the newly tracked question probe was removed.
The new handoff acceptance script was also shortened and its cleanup now
aggregates response/client termination errors while still stopping the daemon;
all four acceptance cases passed again after that review fix.
Final count: zero outstanding findings. `git diff --check` and script syntax
checks pass. This is static review, not performance or execution acceptance.

## Spec review

Independent review found no blocking deviation from Issues 336/337: the same
commit guards A2A and RPC, retained startup cancellation releases the launcher,
conflicting committed candidates report identity mismatch, and abort-marker
cleanup requires target exit proof. The wrapper also covers launcher loss before
readiness and PowerShell spawn failure. Final count: zero outstanding findings;
remaining acceptance is recorded separately from these static conclusions.

## Full-suite result and follow-up classification

The frozen default suite completed: 1,085 files passed, 32 failed and one was
skipped; 16,149 tests passed, 51 failed, 77 were skipped and 21 were todo.
It also reported a client-close unhandled rejection and a Vitest worker
`onTaskUpdate` RPC timeout. Duration was 3,161 seconds with two workers. This
run was **not green**; raw log: `kodax-337-frozen-full-tests.log` in Temp.

- Twenty-one failures required root Git metadata. The independent Git-copy
  run described above passed all 46 cases in those ten files. A further storage
  mismatch-warning failure also depended on Git identity; its exact case passed
  in `git-checks` (one passed, 19 filtered out).
- The initial frozen repository was inside `os.tmpdir()`. Plan mode deliberately
  permits temporary-directory writes, invalidating tests that expected writes
  below that checkout to be blocked. Setting **both TEMP and TMP** for the test
  process to a sibling directory outside the checkout's ancestry fixes that
  test precondition without changing source. The four-file permission follow-up
  passed 28 selected cases, including all nine original failures in that group.
  Log: `kodax-337-permission-environment-rerun.log`.
- Three output/display assertions failed identically in candidate and baseline:
  ACP bounded-body reads, AMA continuation output ownership, and frozen-draft
  invalidation. Both arms contain the same concurrently edited output sources;
  these are not established failures of the released baseline. Matching input
  hashes and exact-case comparison are in `kodax-337-output-input-proof.json`
  and the `kodax-337-output-*-isolated-temp.log` files. These unrelated edits are
  excluded from this fix's commit and were not modified to make tests pass.

- The SDK follow-up passed 63/65 cases across nine files in the original
  environment. Only two Plan-policy assertions remained; baseline reproduced
  both, and the candidate passed both complete files (6/6) with corrected
  TEMP/TMP. Thus all 65 cases have passing follow-up evidence. Original
  client-close rejection, topology-read, EBUSY, streaming and capability/MCP
  timeout failures did not recur. Logs: `kodax-337-sdk-client-candidate.log`,
  `kodax-337-sdk-client-candidate-corrected-temp.log` and
  `kodax-337-sdk-client-baseline-original-temp.log`.
- The five-file lifecycle/timeout follow-up passed all 77 assertions unchanged:
  worktree 35, Skill policy 25, extension runtime seven, original-owner exit four
  and LSP six. It still exited one because Vitest reported an `onTaskUpdate`
  RPC timeout; this is not a green runner result. Baseline reproduced the same
  runner error with the same 77/77 assertions passing. Both commands exited one.
  Vitest's 60-second result-report ACK is distinct from KodaX lifecycle deadlines;
  the existing worktree mock's synchronous Windows process queries are a plausible
  cause, not a proven profile result. Logs: `lifecycle-timeouts-candidate.log` and
  `lifecycle-timeouts-baseline.log` under `kodax-handoff-paired-LJnj8p` in Temp.
  No timeout or assertion was weakened.

All 51 original failed assertions are accounted for: 48 have passing follow-up
evidence, while three output assertions fail identically in the shared candidate
and baseline inputs. No newly introduced assertion failure was found. The
original full run and the two lifecycle runner invocations remain non-green;
their errors are preserved, not suppressed or reclassified as successful runs.

The remaining three output assertions are outside this patch's commit. A final
`commit-scope` checkout was exported from `1df3afe2` and overlaid with only this
fix's 19 files. All four packages were rebuilt from that checkout's source;
source/test typechecks, bundle build, four startup-handoff tests and 20 Windows
supervisor tests passed. All four built lifecycle acceptance cases passed there
too. This confirms the committed code does not need the concurrently edited
output implementation or its compiled artifacts. Source/hash/build evidence:
`kodax-337-commit-scope-qnehDg/proof.json`; built acceptance log:
`kodax-337-commit-scope-acceptance.log` in Temp. Report-only documentation updates
after that export do not alter its tested source.

## Focused implementation evidence

Re-run from a stable checkout after `npm run build`; provider traffic is local:

```powershell
node node_modules/vitest/vitest.mjs run src/runtime-daemon/windows-job-supervisor.test.ts src/runtime-daemon/startup-handoff.test.ts src/runtime-daemon/host.test.ts src/runtime-daemon/process.test.ts src/runtime-daemon/process.cleanup.test.ts --maxWorkers 2
node tests/windows-daemon-handoff.mjs
node --test tests/repl-fixture-daemon.test.mjs
node tests/repl-question-gate-probe.mjs
node tests/repl-pty-parity-probe.mjs
npm run typecheck
node node_modules/vitest/vitest.mjs run --maxWorkers 2
```

The PTY tool prerequisite is documented in the Issue 336 guide. The full default
suite excludes paid real-provider integration tests. Do not edit source during
daemon tests: the existing launcher-build guard intentionally rejects that.

- Windows supervisor: 20 real-process tests pass, including both launcher-death
  phases, five commit/disconnect races, repeated cancellation, denied filesystem
  access, inherited authority isolation, natural IPC close, descendants, early
  launcher death and PowerShell ENOENT.
- Initial host/claim/startup-process group: 27 tests pass. Lifecycle/owner/stop
  group: 72 tests pass. Both source and test TypeScript checks pass after building
  the existing workspace package declarations.
- Built lifecycle acceptance: four cases pass (`tests/windows-daemon-handoff.mjs`):
  normal SDK launch, launcher killed during B's SSE Run, launcher cancelled while
  B executes and A2A serves, and abort-before-A2A-publication. Surviving Runs verify
  their completed output; teardown verifies exact daemon and Job-owner exit.
- New `startup-handoff.ts`: V8 coverage is 100% statements/lines/functions and
  90.9% branches. This is scoped module coverage, not a whole-repository claim;
  quoted wrapper code is also exercised by the real Windows process tests.
- Frozen built acceptance passed: handoff 4/4, fixture teardown 4/4, question
  1/1, Ink parity 10/10 and Classic parity 9/9. Their unique test Homes had no
  surviving processes after teardown. The existing external node-pty
  `AttachConsole failed` teardown diagnostic still appeared for the PTY probes;
  their own exit codes and daemon cleanup verifications all succeeded.
- The frozen candidate passed both supported source and test typechecks and
  declaration bundling. The repository has no configured lint script; scoped
  diff whitespace and JavaScript syntax checks were used in addition to tsc.

The full run emitted `Managed child cleanup is unverified` in
`packages/coding/src/tools/bash.node-env.test.ts`. A separate frozen-baseline
run passed all 11 cases and reproduced the same warning for every case. Its
17 retained root PID records were no longer live at inspection, but incomplete
process-tree identity prevents proving that no unknown descendants remain.
The relevant Shell/registry sources match baseline and do not call the daemon
handoff path. Records were preserved; no unknown process was killed. This is
an existing verification limitation, not a claim of complete Shell cleanup.
Baseline log: `kodax-handoff-paired-LJnj8p/shell-node-env-baseline.log` in Temp.

## Frozen production performance comparison

Node v22.23.1 on Windows; one pilot pair excluded, followed by ten alternating
pairs. Each sample creates a fresh isolated Home, loads that arm's own SDK and
CLI, performs three warm attaches to the same owner, closes the client, then
stops and verifies the daemon/Job owner. SDK module import is outside the cold
measurement; cold means `ensureKodaXRuntime` through a usable returned client.
All 22 samples, including the pilot, passed shutdown verification. No test load
from this task ran concurrently with these measurements. No provider calls.

| Metric | Baseline | Candidate |
|---|---:|---:|
| Cold median (10 samples) | 3158.69 ms | 3172.84 ms |
| Cold mean | 3240.50 ms | 3172.00 ms |
| Cold range | 3116–3924 ms | 3017–3327 ms |
| Warm mean (30 attaches) | 42.018 ms | 41.985 ms |
| Client close mean | 0.354 ms | 0.354 ms |
| Verified stop mean | 566.73 ms | 550.39 ms |

Conclusion: no repeatable regression was observed in this bounded comparison.
Cold median increased 14.15 ms (0.45%), while mean moved in the other direction
because of baseline variability. Neither acceleration nor absolute zero impact
is established. Existing-owner reuse has no added handoff I/O or process launch.

Reproducible artifacts (OS temporary directory, not committed):

- `kodax-handoff-paired-LJnj8p/comparison-proof.json`: common frozen inputs,
  exactly five changed existing production files, build logs, input/output hashes
  and esbuild metafile checks. The new handoff module exists in both trees but is
  unused by baseline. Internal dependencies resolve to each frozen tree, not the
  changing development worktree; third-party dependency versions are shared.
- `kodax-handoff-validation-4fb08f01/formal-1789874297586/raw.json` and
  `summary.json`: all samples, including the pilot and raw paired differences.
- `kodax-handoff-validation-4fb08f01/formal-performance.mjs`: bounded runner;
  `baseline-worker.mjs`: per-sample timings and verified cleanup.
