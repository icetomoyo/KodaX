# Issue 334: Session startup and sequence recovery

Baseline: `5c6a18c0` / SDK `0.7.96-rc.3`. Fix: `0.7.96-rc.4`.

## Required behavior

- Creating and observing a new Session must not read unrelated Run event logs.
- An existing valid journal with a lost/corrupt sequence must recover its latest
  durable sequence, including when another live Runtime has a stale cached floor.
- Replacing a journal epoch must not reuse the old epoch's floor or skip new events.
- A valid durable sequence must retain its direct, constant-cost path.
- Full repository prewarm must serve later routing from the same complete result.

## Standards

No actionable findings in the reviewed SDK diff. The cache reuses the existing
RuntimeSessionCursor type; epoch checks are shared across real call sites. No
new cross-layer dependency or speculative abstraction was introduced.

## Spec

Review identified one existing gap in the required lost/corrupt-sequence recovery
behavior: a live Runtime's stale cached floor could take precedence over events
persisted by another Runtime. Four failing tests demonstrated cursor rollback or
duplicate sequence allocation. The final patch recovers the durable log maximum
when the cursor is invalid and compares it with the epoch-specific floor; all four
cases now pass. The new-journal fast path and Full-context semantics remain.

Standards: 0 findings. Spec: 1 finding corrected, 0 unresolved findings.

## Automated checks

```powershell
npx vitest run src/sdk-runtime.test.ts src/sdk-runtime.session-events.test.ts src/sdk-runtime.shared-daemon.test.ts packages/coding/src/repo-intelligence/runtime.test.ts packages/coding/src/repo-intelligence/runtime-prewarm.test.ts packages/coding/src/repo-intelligence/runtime-budget.test.ts --maxWorkers=2
npm run typecheck
npm run build
```

The focused sequence gate is:

```powershell
npx vitest run src/sdk-runtime.test.ts -t "recovers a .* sequence beyond another Runtime|sequence|unrelated Run event logs|replacement journal epoch|corrupt journal metadata"
```

The tests cover a 256 KiB unrelated log, two Runtime instances replacing an
epoch, missing/corrupt sequence files with a live reader caching sequence 1 while
another writer has reached sequence 3, observations and new writes after recovery,
and a five-second gap between Full prewarm and routing.

## Performance evidence

A diagnostic mapped reads of 924 real Run logs (1.89 GB total) into a temporary
Runtime. It never wrote the user's home. Baseline creation took 18,306ms and read
4.44 GB because tail windows repeatedly expanded. A concurrent strict read failed
with the original 15-second timeout. The startup repair took 362ms with zero
unrelated event reads; the concurrent read returned in 15ms. The built Space
candidate separately verified its packaged SDK at 326ms / zero unrelated reads.

These timings measure Session initialization, not model response time or a cold
Full repository index rebuild. Do not delete production logs or bypass existing
journal recovery to obtain a faster result.

## Final validation in the maintainer checkout — 2026-09-13

- The six suites above passed: **391 tests**, including the additional four
  live-cache lost/corrupt-cursor regressions.
- `npm run build` and `npm run typecheck` passed.
- `node scripts/release.mjs --skip-build --pack-only` passed the host-native
  artifact and sidecar audits; it did not publish anything.
- The freshly built `dist/sdk-runtime.js` passed the large-history diagnostic:
  creation 375ms, unrelated event reads 0 bytes, concurrent strict read 15ms,
  observation 97ms.
- `git diff --check` passed.

## Release handoff

The SDK source changes are in the normal KodaX checkout. Version bump and npm
publication remain maintainer actions. After publishing, update Space from its
local SDK candidate to the newly published version and rerun its installed-SDK
regression (`node --test scripts/test/kodax-fresh-session.test.mjs`) and normal
release packaging. Space's previous candidate does not include the additional
live-cache lost-cursor recovery fix discovered in this release review.
