# REPL fixture cleanup and Windows startup handoff review

Date: 2026-09-20. Fixture fix: Issue 336. Production handoff: Issue 337.
Scope: `codex/product-client-refactor`, the worktree that contains the probes.

## Fixture contract and verification

A probe exclusively owns its fresh temporary Home. On completion or assertion
failure, terminate its terminal, abort unfinished fixture Runs, stop the daemon
through the existing SDK and verify its exact daemon / Job-owner exit. A terminal
cleanup error must not bypass daemon cleanup. Keep the local provider available
until cancellation / shutdown finish; then close all provider connections.
Never auto-start a daemon during cleanup or stop a replacement owner.

The owner is retained after startup because `daemon.json` can disappear before
the CLI completes its final cleanup. A missing state file is not exit proof.
The existing `KODAX_INTERNAL_DAEMON_TEST_PARENT_PID` watches the probe process,
not an individual terminal: intentional `/exit` and resume remain valid.
The watcher is a test-only fallback, not a production lifetime policy. It does
not replace the separate candidate / admission problem described below.

Run from this worktree using its existing bundle:

```powershell
node --test tests/repl-fixture-daemon.test.mjs
node tests/repl-question-gate-probe.mjs
node tests/repl-pty-parity-probe.mjs
node node_modules/vitest/vitest.mjs run src/kodax_cli.daemon-smoke.test.ts -t 'explicitly watched parent' --reporter=dot
```

PTY probes require the existing node-pty / xterm tools at
`KODAX_ACCEPTANCE_TOOLS` or the documented temporary tools directory. Provider
traffic is local and scripted; no paid LLM calls are required. Screen artifacts
and daemon logs remain in each printed temporary artifact directory.

Evidence from this change: ordinary teardown failed with its daemon still alive
before the fix; a second test reproduced state-file removal while the real daemon
was still in final cleanup. Both passed after the corresponding fixes. The
unfinished provider-stream cancellation and never-started Home cases passed.
Both renderers passed all 19 parity scenarios, including queue, Stop, exit,
resume and questions. The standalone question probe and existing parent-watch
process regression also passed. Repeat affected checks after further edits.

The installed node-pty version printed `AttachConsole failed` from its auxiliary
console-list process during forced PTY disposal. The probes still exited zero
after successful daemon verification; this third-party diagnostic is retained
rather than suppressed. An already-exited PTY is no longer killed again on resume.

## Production review and pre-design evidence

This section preserves the initial review. The authorized implementation and
final acceptance are tracked in the [Issue 337 guide](ISSUE_337_v0.7.96_REGRESSION_GUIDE.md).

Three agents independently reviewed lifecycle design, performance history and
execution regressions, then challenged each other's proposals. All rejected
unconditional `disconnect => kill`:

- `host.ts` opens its server before publishing ready; `server.ts` currently
  admits initialized clients without a handoff gate.
- The original launcher releases only after observing healthy ready state.
  Another client may already be executing in the interval.
- Killing the candidate on the original launcher's disconnect can therefore
  kill another client's work, violating the earlier shared-daemon fixes.

The original proposal used a private commit / ACK channel; no existing
daemon-to-wrapper Node IPC channel is available because PowerShell creates the
daemon. Subsequent experiments support a smaller candidate: both daemon and
wrapper attempt exclusive creation (`open(..., 'wx')`) of one random private
decision file. Daemon wins: allow service publication and preserve it on launcher
disconnect. Wrapper wins: refuse publication and reclaim the exact PowerShell
ChildProcess / Job. Local state makes repeated events idempotent. Do not remove
an abort marker until the target exits, or a late daemon can incorrectly win too.
Unexpected filesystem errors must be reported, not interpreted as permission to
kill a potentially committed service.

Commit means permission to publish a service, not health-check completion. All
public entry points must obey it: hosted A2A currently listens inside createRuntime
before the daemon socket. A launcher timeout / explicit terminate after commit
must preserve the shared owner; daemon initialization failures remain the daemon's
responsibility. The prototype does not implement these complete production paths.

## Pre-design experiments, 2026-09-20

No production source or bundle was changed. Temporary copies of the existing
Windows Job wrapper and a preload hook at the daemon named-pipe listen boundary
ran the real bundled CLI and SDK against isolated Homes and a local SSE provider.
Artifacts: `C:/Users/ADMIN/AppData/Local/Temp/kodax-handoff-validation-4fb08f01/`.

| Experiment | Observation |
|---|---|
| Launcher killed before publication | Original leaves target alive; naive kill and atomic prototype reclaim it |
| Normal SDK B has a running provider stream; A dies before releasing its startup handle | Original and atomic prototype allow B to complete; naive disconnect-kill kills B's daemon |
| Independent two-process atomic decision | 32/32 normal rounds pass, including 30 near-simultaneous rounds and repeated decisions |
| Negative control: delete abort marker before target exit | Both parties can win; confirms marker lifetime is essential |
| Normal shutdown after the stream experiment | Baseline and atomic prototype pass durable shutdown and process-exit verification |

The initial stream mock also held subsequent memory-review requests open. Both
baseline and prototype reached the existing 15-second memory-drain boundary and
the 15-second verifier returned `unverified: daemon_active`. These attempts were
retained in `race-results.json`. Answering subsequent requests made both pass
(`race-complete-provider-results.json`, two provider requests per surviving case).
Do not treat state-file removal or this initial verification timeout as success.

Five sequential pairs alternated baseline/prototype ordering, using identical
temporary-launcher and preload scaffolding. Every sample made three warm attaches
to the same runtime and completed verified shutdown. No paid model requests.

| Metric | Baseline mean | Atomic prototype mean |
|---|---:|---:|
| Cold start through SDK connection | 2294.82 ms | 2317.25 ms |
| Warm ensure/attach, 15 samples each | 32.67 ms | 33.22 ms |
| Explicit stop through verified exit | 305.48 ms | 305.28 ms |

Cold ranges: baseline 2209–2444 ms, prototype 2232–2387 ms. Prototype cold mean
was 22.42 ms / 0.98% higher; five pairs cannot establish equivalence or rule out a
small regression. Actual daemon exclusive-create/close averaged 0.166 ms. The
separate unmodified SDK baseline measured cold 2532–2780 ms, warm 31.6–39.0 ms,
stop 368–397 ms; do not compare that different launch path directly to the paired
prototype. Raw timings: `baseline-results.json`, `paired-results.json`; atomic
worker results: `atomic/results.json`.

All captured race-experiment target, Job-owner and wrapper PIDs exited. The
original 30 parity-local daemons were left untouched. This validates a narrow
candidate design, not full integration: A2A, post-commit explicit termination,
file failures, concurrent election, tool descendants and the complete existing
regression suite remain gates before production acceptance.

## Required non-regression gates for Issue 337

| Boundary | Required evidence |
|---|---|
| Candidate creation through commit | Kill launcher at each stage; exact candidate and descendants exit; no control-file residue |
| Commit vs disconnect, duplicate events and marker cleanup | Deterministic ownership; no public business admission followed by candidate kill |
| A2A and daemon socket admission | The first public endpoint commits once; every later entry observes the same phase |
| B attaches / executes while A leaves | B keeps its stream and result; no replay, cancellation or loss of durable output |
| A's post-commit health timeout / cancellation | Does not kill B or the shared service |
| Concurrent starters | Only loser candidate reclaimed; winner remains usable |
| Existing owner reuse | No extra process, IPC handshake, polling or scans on the hot path |
| Early exit / timeout / abort | Prompt error; no extra poll delay or serial timeout budget |
| Explicit stop / restart | Preserve exact identity, durable outcome and Job-empty verification |
| Stopping / draining owner | Preserve a72f's owner-generation wait before replacement |
| Natural IPC close before exit event | Preserve a72f's real-exit verification; no false cleanup failure |
| Ordinary client close / optional orphan exit | Persistent default unchanged; opt-in grace, generation and work blockers preserved |
| Tool execution and descendants | Real Shell child cleanup remains correct; Stop does not double-terminate |

Historical constraints: Issue 169 fixed waiting a full 60 seconds after startup
failure; Issue 219 distinguished reachable from ready; Issues 145/183 preserved
shared ownership after first-client exit. Issue 297 fixed long waits after failed
shutdown (its old exit-settlement implementation is absent from a72f; do not copy
the older branch over newer lifecycle work).

The FEATURE_299 regression guide records a Windows cleanup case with 122 old
Shell records causing 366 synchronous PowerShell calls and 85.8-second exit;
the corrected case took about 8–12 ms without PowerShell. Those are historical
measurements, not measurements of this patch. Do not add WMI/CIM traversal or
registry scans to recover the new startup candidate.

Before shipping the production fix, compare old/new cold-start, warm reuse,
normal-stop and early-failure timings on the same host with bounded paired
samples, retaining raw measurements. Require no new production process or
steady-state timer; only the new-owner Windows startup may gain a bounded
handoff. No zero-regression performance claim can be made from static review.
