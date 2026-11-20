# FEATURE_291 v0.7.85 Human Test Guide

## Purpose

Verify that independent Sessions sharing one KodaX project/home no longer
contend on a Runtime-global event lock, while same-Session replay remains
ordered and resumable.

## Automated baseline

Run:

```powershell
npx vitest run src/sdk-runtime.session-events.test.ts src/runtime-event.test.ts src/runtime-daemon/schema.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/server.test.ts src/sdk-runtime.shared-daemon.test.ts src/a2a/a2a.test.ts src/a2a/task-store.test.ts src/a2a/task-migration.test.ts
npm run build
```

Both commands must exit successfully.

## Two-process smoke test

1. In one project directory, start two terminals.
2. Run `npm run dev` in both and start work in different Sessions.
3. Confirm both Runs stream and finish without
   `RuntimeStatusLockTimeoutError` for `event-sequence.lock`.
4. Inspect `.kodax/runtime/session-events/`. Confirm each Session has its own
   encoded directory, `journal.json`, and `sequence`; confirm no new
   `.kodax/runtime/event-sequence` is created.

## Replay and failure boundaries

1. Subscribe or replay with a Session or Run scope and retain the last complete
   cursor.
2. Resume with `after: cursor`; confirm only later events are returned.
3. Attempt replay in another Session using that cursor; confirm
   `resync_required`.
4. Leave a synthetic stale `sequence.lock` in Session A, then run Session B;
   confirm B remains operational. Remove only the synthetic test lock when
   finished.
5. Delete and recreate one Session ID. Confirm its sequence restarts at `1`,
   its `journalEpoch` changes, and the earlier cursor returns `resync_required`.
6. Supply a malformed cursor or a mismatched `sessionId` + `runId`; confirm the
   embedded and daemon APIs reject it with `invalid_argument`.
7. Corrupt a v2 watermark for Session A. Confirm A fails closed while a cursor
   replay for Session B remains available.
8. In a Run containing managed-child Session events, remove the retained child
   rows and corrupt the Run watermark. Confirm the child cursor still requires
   resync using `event-journals.json`, while an unrelated Session remains
   available. Then remove or corrupt the index and confirm the ambiguous legacy
   state also fails closed rather than silently returning an incomplete replay.

## A2A check

Create two A2A Tasks in different contexts. Confirm they use distinct Runtime
Session IDs (Tasks in one context share a Session since Issue 418), recover
after server restart, and do not publish token/tool progress as A2A task
updates. Confirm progress changes the small `runtime-cursors/` checkpoint but
does not rewrite `tasks.json`; input-required/resolved and terminal transitions
must still arrive.
Inject a `tasks.json` save failure for an input-required event and then complete
the Runtime Run. Confirm the A2A Task remains non-terminal at its earlier cursor
until restart can replay the failed semantic event.

## Legacy data check

On a disposable test home containing old `.kodax/runtime/event-sequence` and
legacy event rows without a Session cursor, start a new Session. Confirm its
first event uses a fresh journal/sequence and legacy files remain untouched.
