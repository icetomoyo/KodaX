# Output recovery and historical test failure — 2026-11-09

Status: confirmed Shell output defects corrected and independently reviewed;
full deterministic and package regressions passed.
**The original intermittent failure remains unclassified.** Work
is directly on `KodaX` in `C:/Works/GitProj/KodaX-AI/KodaX`, starting at
`f1c20b420`. No new integration branch/worktree, publication or Space upgrade.
The durable recurrence record is [Issue 395](../KNOWN_ISSUES.md#issue-395-intermittent-oversized-output-runtime-test-failure-has-no-captured-cause),
which remains `needs-info` independently of the confirmed Shell fixes below.

## Historical evidence and limits

The original next-dev fast run started at **14:10:47**, as did a concurrent
three-file storage/migration run (175 tests). The fast run's oversized-output
case failed after **5,058 ms** with `AssertionError: Provider request failed.`;
the enclosing run finished 3,721 passed / 1 failed / 57 skipped. The original
callback exception and individual tool receipts were not printed, and test
cleanup removed the fixture. This establishes a wrapped local assertion,
not a Vitest timeout; it does not identify which receipt violated the assertion.

On current main, the unchanged scenario passed **121** baseline/repeated
executions: 1 baseline, 24 independent-process repetitions, 48 repetitions in
four workers, and 48 more under the original concurrent 175-test workload.
The latter used pristine `f1c20b420` Bash source via an OS-temporary, in-memory
Vite transform; no production file was swapped. Both original-load suites
again started in the same second and passed. A separate delayed-grep probe
also passed. These passes neither establish a historical failure rate nor
prove that contention caused the original failure.

The permanent-cleanup-failure reproduction below consumes a seven-second
retry budget, whereas the historical test took about five seconds. It is a
confirmed related production defect, **not established as the cause of that
historical occurrence**. Missing recovery paths can throw a plain Error;
snapshot I/O failures can also be wrapped, but neither is evidence of the
specific historical AssertionError. Do not label that incident timing-only,
fixed, or reproduced without a matching captured cause.

## Confirmed product defect and required behavior

After real child `close`, `toolBash` waits for owner cleanup settlement. If the
owner's release callback fails through its existing retries, the old catch
branch called `disposeCollectors()` before decoding. Disposal clears memory,
spool paths and final buffers: already captured stdout/stderr disappeared.

The corrected branch prepares output before disposal. Small output retains
both streams. Oversized output reuses the normal sealed-recovery path and
returns references rather than materializing the complete streams inline.
The cleanup remains Unknown; child registration, deferred retry and the
no-replay contract remain intact. A capture/delivery failure gets an explicit
warning without replacing the original cleanup diagnosis or hanging settlement.

The public `toolBash` regressions use a real child, real streams and a real
collector. Only the owner's cleanup-release callback fails four times; the
fifth explicit retry drains it. Fake timers start after the real child closes.
Encoded sentinels prevent the echoed command from satisfying output assertions.

- Inline: RED on lost stdout/stderr, then GREEN after decoding before disposal.
- Oversized: the first, byte-preserving intermediate fix returned **1,229,358
  characters**; the next RED required a receipt below 4,096 characters, sealed
  stdout/stderr files and original start/end sentinels. Final correction passes.
  That oversized inline result belonged to the intermediate fix, not the
  original historical implementation.
- Archive-registration callback failure: the receipt remains bounded and reports
  registration and cleanup failures and includes both actual stream references;
  the command is not replayed, and explicit owner retry can drain cleanup.
- Recovery directory unavailable: an actual ordinary file occupies the output
  directory path. The receipt reports each unavailable stream and incomplete
  capture without claiming sealed files or inlining the complete output.

Independent review caught both latter cases before commit: the first version
of the registration-failure test inspected mock-call arguments instead of the
returned receipt, and failed recovery creation still fell through to raw text.
Stricter tests reproduced both errors, then passed after correcting the shared
oversize helper. Two additional normal-completion tests use actual output and
an execution marker. Against pristine `f1c20b420` via an in-memory transform,
both fail on roughly **615 KB** inline responses; the corrected source passes.
These are original production oversize-fallback defects, independently of the
earlier intermediate byte-restoration result and the historical incident.

## Test failure attribution and retained evidence

The oversized natural Runtime test previously asserted receipt contents inside
its scripted provider. A local mismatch became a generic provider error. Its
semantic assertions now run after the real Run; the script stops safely when
an expected, in-scope recovery reference is absent. Exit status, recovery
reference, successful fixture write, exact grep result, outside-read denial,
private-sentinel exclusion,
four requests and unchanged protected files remain required.

On assertion failure the test retains its OS-temporary fixture, including
`result.json`, `runtime-live.json` and actual stream artifacts, and names that
directory in assertion diagnostics. Success still removes the fixture.

A controlled no-match transport probe was used only to verify attribution:
before the test change it produced the same outer `AssertionError: Provider
request failed.` signature; after the change the Runtime completed with no
callback error, and the direct post-Run grep assertion failed at its own line.
After cleanup, the retained real stdout still contained the failure sentinel
and `KODAX_CAPTURE_COMPLETE`. This validates diagnostics and preservation;
it deliberately does **not** identify the historical cause.

## Untracked cache experiments

The obsolete cache unit script manually stripped context, so it did not exercise
current production retention. It is replaced with one real two-Run runner /
LLM-adapter / OpenAI-compatible serialization regression. Run two consumes the
actual first Run messages and retention slot. It asserts exact wire-message
prefix preservation, unchanged tools, and appended changed facts. Disabling
retention in memory makes the prefix assertion RED; normal source is GREEN.
This proves a protocol-content invariant, not real provider cache hits.

The untracked paid eval was removed from the checkout, with its original kept
in OS temporary storage. Its arms simulated obsolete behavior, its cache metric
double-counted cached input, and declared spending/token limits were not the
limits actually enforced by its reused budget helper. It also omitted original
model outputs and used simplified tools. No paid evaluation was run to answer
this mechanism question. Historical raw evidence is not rewritten.

## Validation

- Initial changed-seam suite: 4 files, **91 passed**, before the third
  archive-callback-failure case was added. Bash line coverage **81.05%**;
  statements **78.05%**, branches **66.36%**, functions **79.67%** on Windows.
  This is a scoped measurement, not repository-wide coverage or an assertion
  that all coverage metrics meet 80%.
- All four cleanup cases and both normal-completion cases passed their targeted runs.
- Built SDK: all three tests in `tests/bundled-text-recovery.test.mjs` passed,
  including actual standalone child execution for both oversize fallback errors.
- Source/test type checks and complete build passed. CLI reserve remains 49 KiB.
- Complete deterministic root suite: **1,493 files passed / 8 skipped;
  20,442 tests passed / 93 skipped / 0 failed**, 1,481.16 seconds, four workers.
  This includes the real runner wire regression, all 81 Bash tests, and all 41
  Natural Runtime tests. Credential-dependent integration tests are excluded.
- The same full run measured only `bash.ts`: statements **83.78%**, lines
  **85.77%**, functions **83.06%**, branches **75.44%**. This is neither a
  repository-wide measurement nor a claim that branch coverage reaches 80%.
- All 32 bundled Node test files passed: **107 main + 3 serial = 110 tests**,
  no failures or skips. This includes the two new public built-SDK regressions.
- Actual npm tarball Host cutover: **3 passed**, including both historical
  owner policies, concurrent first startup, profile aliases and rollback fences.
  Published beta.3-to-current busy Host upgrade: **1 passed**, using the already
  provisioned, integrity-checked beta.3 archive; no implicit download.
- CLI: current Windows **5,164,273 bytes**; five-manifest Windows and Linux
  compositions **5,165,285 bytes**, leaving **27,419 bytes** below the unchanged
  `5 MiB - 49 KiB` gate. The audit uses the current main Windows manifest and
  four cached foreign-platform manifests with actual native/legal file hashes
  verified. It measures composition, not Linux/macOS native execution.
- Fresh verified-Bun Windows build and extracted ZIP with the exact 15-entry
  release inventory passed. The work-mode gate completed **11 scenarios**,
  **18 loopback model requests**, **0 external model calls**; cancellation,
  partial effects and restart assertions passed. The same extracted binary
  passed all **3** lazy-CLI tests with Node/Bun absent from the child PATH.
  Neither the npm tarball nor the ZIP was published.

## Standards

Independent review of the seven-file candidate against repository rules and
the 12-smell baseline found **0 hard violations / 0 actionable smells**.
The final built-SDK test addition was included in the follow-up review.

## Spec

Independent review initially found **2 P2 issues**: the registration-failure
test did not prove references were in the returned receipt, and recovery-file
creation failure could still inline oversized data. Both were reproduced and
corrected before commit. Follow-up review of source, normal/deferred cleanup
tests, retained-failure diagnostics and final built-SDK tests found **0 remaining
actionable findings**. This does not classify the original historical failure.

Raw controls, backups and reports are under the OS temporary directory
`kodax-historical-output-diagnosis-20261109`. They are not committed. Permanent
work-mode locking and Actor settlement implementations are outside this patch.
