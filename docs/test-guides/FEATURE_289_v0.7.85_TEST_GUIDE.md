# FEATURE_289 — Memory Review Drain Reliability — Human Regression Test Guide

> Version: `v0.7.85`
> Feature: FEATURE_289 (Memory Review Drain Reliability + Pipeline Observability)
> Prerequisite: `npm run build` green; at least one LLM provider configured
> (`ZAI_CODING_API_KEY` / `ANTHROPIC_API_KEY` / etc. in env or `~/.kodax/config.json`).

---

## Runtime shutdown follow-up (0.7.96 source, 2026-09-22)

This follow-up is not in the published rc.9 package. It covers the SDK Runtime
ownership of background episode review, including startup backlog and terminal
drains in both `coding` and `managed_task` execution.

Required behavior:

- Run completion, Stop and successor admission do not wait for background review.
- Closing Runtime A cancels and settles only A's reviews; it does not cancel or
  wait for Runtime B's reviewer. Concurrent close calls share the same attempt.
- No new review factory starts after closing begins. Cancellation reaches the
  production review request, not merely a timer that abandons its promise.
- A decision cancelled by Runtime close returns its job to pending, releases its
  claim and keeps frozen input without consuming a provider-failure attempt.
  Revoking a Run-scoped credential lease is a separate existing cancellation
  path: its provider failure/backoff policy is unchanged.
- Already-started durable effects finish and retain their action receipt before
  close returns. Recovery must not execute a completed action again.
- After successful close, review code performs no further Memory/Skill/session
  writes. Restart with the same home can process the unfinished job.
- Legacy single-argument reviewers remain accepted. Custom reviewers that perform
  asynchronous work should honor the optional signal and settle after cleanup;
  arbitrary callbacks that ignore cancellation cannot be forcibly terminated.
  Owned reviews wait for actual settlement. Existing unowned timeout behavior is
  retained. Close also waits for already-started filesystem operations.

Automated verification:

```sh
npx vitest run src/sdk-runtime.memory-review.test.ts packages/agent/src/memory-control/review-inbox.test.ts packages/agent/src/memory-control/memory-control.test.ts packages/coding/src/memory-runtime.test.ts packages/coding/src/learning-reviewer.test.ts --maxWorkers=1
npm run build
node --test tests/bundled-memory-review-shutdown.test.mjs
```

The public Runtime test uses actual review jobs with an offline reviewer gate;
the built acceptance uses a loopback HTTP provider with synthetic credentials.
Verify the actual Worker/daemon shutdown and released owner, not just acceptance
of `management.stop`. The default Worker shutdown budget must remain unchanged;
force-terminating a timed-out Worker is a failure. Tests must clean up only their
own profiles and processes and must not inspect customer credentials.

The built scoped-credential case follows Stop before daemon quit. It establishes
a pending job, starts its review under the next Run's active credential lease,
aborts that Run, verifies both HTTP requests disconnect and the owner exits,
then waits the existing retry backoff and verifies exactly one recovery receipt.
The ambient-credential cases instead cancel terminal review through Runtime
close and verify zero provider attempts and immediate recovery.

Original RED evidence: `%TEMP%/kodax-memory-exit-20260922-171632/runtime-red.log`
shows `Runtime.close()` returning while the real background review signal remains
unaborted. Follow-up aggregate results are recorded in `docs/KNOWN_ISSUES.md`.

---

## Test 1: `/memory doctor` on a fresh project (zero-state)

**Steps:**

1. Start a new KodaX session in an empty or fresh project directory.
2. Run `/memory doctor` in the REPL.

**Expected:**

- Memory directory: `0 entries` (or absent).
- This-session pipeline: `digests: 0, receipts: 0, notices: 0`.
- Current-project, cross-session pending: `0 pending`; jobs owned by another
  project under the same `~/.kodax` home are not advertised as locally drainable.
- Reviewer: `auto-installed (production)` or `MISSING` (if no provider configured).
- Diagnosis: `capture segment: no memory outcome digests recorded in this session yet`.

**Pass criterion:** renders without error; all sections present even with zeros.

---

## Test 2: `/memory doctor` on a populated project

**Prerequisite:** at least one completed coding episode (a session that ran tools
and ended normally, producing a `memory_outcome_digest`).

**Steps:**

1. Run a short coding session (e.g., `kodax -c "read README.md and summarize"`).
2. Start a new session in the same project.
3. Run `/memory doctor`.

**Expected:**

- This-session digests and receipts are both `0`; the previous Session's
  lineage is intentionally not reported as current-Session activity.
- Cross-session pending is at least `1` (the captured job waiting for review).
- Diagnosis: `pending reviews from earlier sessions are waiting` at the review
  segment, not a false capture-segment warning.

**Pass criterion:** diagnosis correctly identifies the review-segment break.

---

## Test 2a: Inspect the internal episode-review backlog (advanced diagnostics)

**Prerequisite:** at least one pending review job from Test 2.

**Steps:**

1. Run the hidden diagnostic `/memory reviews 20`.
2. Compare its total with the `pending` count from `/memory doctor`.
3. Run `/memory decisions`; use the compatibility aliases `/memory proposals`
   and `/memory pending` only to verify migration behavior.
4. Run `/learn ready`, then `/learn pending`.

**Expected:**

- `/memory reviews 20` shows up to 20 oldest jobs and includes status,
  review key, owner Session, age, attempt counts, provider/apply/completion
  retry timestamps, and last error when those fields exist. Its total matches
  `/memory doctor`.
- Both surfaces split the total into the automatic queue, jobs that need
  operator attention, and jobs with unknown persisted state. `review-drain`
  is suggested only when the automatic queue is non-empty; `attention` and
  `unknown` jobs are never presented as automatically drainable.
- `/memory decisions` lists actionable exceptional Memory changes, not internal
  review jobs. `/memory proposals` and `/memory pending` identify themselves as
  compatibility aliases.
- `/learn ready` lists ready learned capabilities. `/learn pending` produces
  the same query and labels itself as a compatibility alias; it does not claim
  to show the episode-review inbox.
- Every empty result prints `(none)` or an explicit empty-state message; no
  command silently returns a blank Ink history entry.

**SDK parity:**

```ts
import {
  listPendingEpisodeReviewSummaries,
} from '@kodax-ai/kodax/experimental-memory';
import {
  deriveCodingMemoryIdentity,
  deriveCodingMemoryReviewIdentities,
} from '@kodax-ai/kodax/coding';

const identity = options.context?.memoryIdentity
  ?? deriveCodingMemoryIdentity(options, executionCwd, sessionId);
const owners = deriveCodingMemoryReviewIdentities(options, identity, executionCwd);
const reviews = (await Promise.all(owners.map((owner) =>
  listPendingEpisodeReviewSummaries({
    configHome: owner.configHome,
    tenantId: owner.tenantId,
    agentId: owner.agentId,
    projectId: owner.projectId ?? null,
  })))).flat();
```

Using the same owner identities as the production drain makes the SDK result
contain the same persisted review keys shown by `/memory reviews`. Learned
capabilities remain available through
`runtime.learning.list({ lifecycle: 'ready' })`.

---

## Test 3: Turn-end drain with bounded await

**Prerequisite:** a pending review job in the inbox (from Test 2 or pre-existing).

**Steps:**

1. Start a new session in the project (triggers startup drain, then turn-end
   drain on session end).
2. End the session normally (type `exit` or Ctrl-C).

**Expected:**

- The turn-end drain runs with a 15 s deadline (`deadlineAtMs = Date.now() + 15_000`).
- If a review completes within 15 s: `decision.json` written, receipt appears in
  the owner session's lineage.
- If the review's decide phase takes > 15 s: the claim is released via
  `deferEpisodeReview` (job returns to `pending`, not stuck in `processing`).
- On the next run, the startup drain (no deadline) picks up the deferred job and
  completes it.

**Pass criterion:** no job left stuck in `processing` after process exit; the
next run recovers it.

**Verification command:**

```powershell
# After ending a session, check for processing fossils:
Get-ChildItem "$env:USERPROFILE\.kodax\memory-review-inbox" -Recurse -Filter "state.json" |
  ForEach-Object { Get-Content $_.FullName | ConvertFrom-Json } |
  Where-Object { $_.status -eq 'processing' }
# Expected: zero or only very recent (< 5 min old) entries.
```

---

## Test 4: `kodax memory review-drain` foreground command

**Prerequisite:** pending review jobs in the inbox; provider configured.

**Steps:**

1. Run a small batch to verify the pipeline works:

   ```powershell
   node dist\kodax_cli.js memory review-drain --max 5
   ```

2. Observe the output: `reviewed / discarded / failed / deferred` summary.
3. Check `/memory doctor` (in a REPL session) or re-run `review-drain` to see
   pending count decrease.

**Expected:**

- `reviewed ≥ 1` if any job's digest produces a memory proposal.
- `discarded ≥ 0` if any job is an eligibility discard.
- `failed = 0` if the reviewer LLM is reachable.
- `deferred` for jobs in backoff or fenced by own-session.
- Exit code 0 if `failed == 0`; exit code 1 if `failed > 0`.

**Pass criterion:** pending count decreases; `decision.json` files appear under
`~/.kodax/memory-review-inbox/<tenant>/<session>/jobs/<jobId>/`; receipts are
written to owner session lineages.

**Full backlog clearing:**

```powershell
node dist\kodax_cli.js memory review-drain
```

Loops until a pass yields zero reviewed + zero discarded (deferred-only or
failed-only pass terminates). Re-run after the v2 backoff window (1-30 min) to
retry deferred/failed jobs.

---

## Test 5: Drain failure notice visibility

**Prerequisite:** a review job that will fail (e.g., temporarily unset the
provider API key, or use an invalid model).

**Steps:**

1. Unset `ZAI_CODING_API_KEY` (or misconfigure the provider).
2. Run a coding session that produces a digest and triggers turn-end drain.
3. Observe the REPL output.

**Expected:**

- A `[memory]` line appears in the REPL with failure wording:
  `Memory review failed: ...` (not `Memory updated:`).
- The notice appears on the **current visible session** (not silently dropped).
- `/memory doctor` shows `notices: ≥ 1` in the this-session section.

**Pass criterion:** the failure is visible to the user in the same session —
not silent. This is the core observability fix of §3.6.

---

## Test 6: Defer does not consume drain budget (§3.2)

**Prerequisite:** an autoResume session whose own oldest job defers (the
pre-F289 head-of-line deadlock condition).

**Steps:**

1. Have ≥ 3 pending jobs from different sessions in the inbox.
2. Start a session that auto-resumes (its own job will defer).
3. Check the drain result (via `emitResilienceDebug` log or `review-drain`).

**Expected:**

- The session's own job defers (does not consume the `maxEntries: 2` budget).
- Other sessions' eligible jobs are reached and processed in the same drain pass.

**Pass criterion:** `reviewed + discarded > 0` in a single drain pass even when
the session's own job defers. (Pre-F289, this was always zero.)

---

## Fault diagnosis quick reference

| Symptom | Diagnosis | Action |
|---|---|---|
| `digests: 0` | Capture segment broken — no outcome digests being produced | Check `memory-runtime.ts` wiring; verify session ended normally |
| `digests > 0, receipts: 0` | Review segment broken — reviewer never ran | Run `kodax memory review-drain` to clear backlog |
| `pending` growing over time | Backlog accumulating — drains not completing | Run `kodax memory review-drain`; check provider config |
| `reviewer: MISSING` | No production reviewer installed | Check provider config; ensure `installProductionLearningReviewer` runs |
| Jobs stuck in `processing` | Claim not released after process exit | Wait 5 min for lease expiry; next run's startup drain recovers |
| `failed > 0` on review-drain | Reviewer LLM errors (timeout, bad response, etc.) | Check API key; re-run after backoff window; check `attention` jobs after 4 failures |
