# Issue 362 startup review handoff regression

Source baseline: `21969792`, v0.7.97-alpha.3. This repair is unreleased.

## Failure and root cause

The original Linux ARM64 Release gate fails before cancellation at
`tests/bundled-memory-review-shutdown.test.mjs:286`: no startup-review HTTP
request arrives within the existing 10-second observation window. Windows
passes the same gate, including the existing 60-second provider retry wait.

A Run's terminal review can lose its scoped Provider authority after the Run
settles. `provider_unavailable` deliberately consumes no Provider attempt and
sets no backoff. Coding first drains the preferred just-persisted job, then
drains backlog. The old backlog pass can reclaim that same deferred job using
the old authority. A successor Run sees a live claim, skips its startup
review, and does not revisit the job during that startup drain. Faster process
and filesystem scheduling exposes the race.

Two deterministic public `drainCodingMemoryReviewInbox` tests fail against the
unchanged baseline: the old reviewer runs twice, and a successor reviewer runs
zero times while the duplicate claim remains held. After repair the old
reviewer runs once, and the successor writes exactly one recovery receipt.

## Repair and design boundaries

`EpisodeReviewDrainOptions.excludedJobId` is an optional internal selection
filter. Coding's backlog pass excludes the preferred job it already
considered; Agent applies the filter before claim acquisition. Subsequent
Runs can still recover that job with their own authority. The filter does not
change Provider retry classification, attempt counts, 60-second backoff,
claim fencing, branch revalidation, cancellation, or the two-entry drain cap.
An adjacent Agent regression verifies another backlog job remains eligible
while the excluded job retains claimEpoch=0.

This reuses the existing durable review inbox and Host-owned Memory work.
It adds no background retry service, persisted scheduler state, client option,
RPC payload, or capability-version change. SDK type declarations and Host
bundles need rebuilding together; existing Product Client callers need no
new arguments.

## Reproduction and verification

```powershell
node node_modules/vitest/vitest.mjs run packages/coding/src/memory-runtime.test.ts -t 'preferred review' --maxWorkers=1
node node_modules/vitest/vitest.mjs run packages/agent/src/memory-control/review-inbox.test.ts packages/coding/src/memory-runtime.test.ts packages/coding/src/learning-reviewer.test.ts src/sdk-runtime.memory-review.test.ts
node --test --test-name-pattern='bundled scoped daemon aborts' tests/bundled-memory-review-shutdown.test.mjs
npm run test:bundle
```

The original 10-second observation, 100-second outer deadline, actual HTTP
entry, primary/review disconnects, durable pending state, Provider retry
deadline, and exactly-once receipt assertions remain intact. No paid Provider
request is involved; HTTP requests use the loopback fixture.

Linux platform validation passed from repair snapshot `3e11b03c` in
[the scoped release-validation workflow](https://github.com/icetomoyo/KodaX/actions/runs/38066072854).
It uses both ARM64 and x64 Node 22, the release glibc 2.28 native builder,
the original bundle gate, two extra repetitions of the scoped startup gate,
and the original real POSIX sandbox concurrency gate. Each platform passes
169 ownership/usage checks, the original bundled gate (40 passed, one platform
skip), all three scoped startup/abort/recovery runs, and four real POSIX
concurrency tests. Each scoped run retains its actual roughly 60-second retry
wait. Windows rebuilt bundle passes all 41 tests; final fast tier passes 2269
tests with 32 existing skips. Issue 362 is resolved in the unreleased source.
The four-file Memory regression/coverage gate passes 119 tests. Scoped
coverage of review-inbox and memory-runtime is 88.37% lines, 86.1% statements,
92.08% functions and 81.04% branches; this is not repository-wide coverage.

## Standards

Independent review reports zero actionable findings. Selection precedes
claiming, the new filter serves an existing scheduling requirement, and
tests release their gates and await owned work in cleanup.

## Spec

Independent review confirms the duplicate-claim handoff race and the two
public regression tests. Other project identities/backlog jobs, drain caps,
unknown outcomes, cancellation, retry deadlines and branch fences remain.
Review summary: Standards 0; Spec 0. Platform acceptance is separate.
