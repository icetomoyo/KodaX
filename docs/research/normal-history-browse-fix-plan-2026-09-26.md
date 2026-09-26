# Issue 342: Ordinary history browsing fix design

Status: implemented; see [repair acceptance](contract-browse-fix-verification-2026-09-26.md). Evidence and the source-entry
main/branch reproductions are in
[the regression guide](../test-guides/ISSUE_340_v0.7.96-rc.11_REGRESSION_GUIDE.md).

## Decision

Keep the bounded Host observation as the authority for current output and
execution state. Give the ordinary owned Ink surface an on-demand saved-history
browse window using the existing `readHistory` and item readers. Keep ordinary
formatting; users should not need Ctrl+O to recover earlier conversation.

Do not increase the 150-item limit as the fix, accumulate successive views into
a permanent client-owned history, or read the whole conversation on every view.
Those approaches respectively postpone the loss, retain stale/deleted facts, or
add repeated I/O and reconciliation races.

## Browsing behavior

1. Upward wheel/PageUp is an intent to browse even when the current rendered
   document is shorter than the viewport. Capture the current visible content
   and position before any read. Do not depend on an offset-change callback to
   discover this intent: clamping can leave the offset at zero.
2. Browse already available rows immediately. At their older boundary, fetch
   saved-history pages on demand, with one request chain at a time. A repeated
   wheel gesture must not start parallel scans. Read preview pages first;
   hydrate missing text only when needed for viewing/expansion/copy.
3. A successful transition uses a saved-history window from one revision.
   Locate the reading position by source identity and position within the
   content, not by array index or wrapped row number. Keep the entry display
   available until the new window and position can be committed together.
4. Never prepend pages from a newly read revision to a frozen live-view suffix
   and call the result one canonical snapshot. The current view does not carry
   a history revision. Use identities for navigation, not as proof that two
   independently read surfaces share a revision. If navigation cannot be
   resolved safely, preserve the screen and provide a refresh/retry affordance.
5. End, explicit return-to-latest, or user-directed scrolling to the live edge
   returns to the newest observed view. Programmatic clamping to zero during
   loading/resize must not exit browsing. Submitting new input also returns to
   live without changing the draft or submitting twice.

Only the transcript content region is frozen. Run status, Stop, questions,
permissions, queued input, connection state and the editable prompt stay live.
Show that the user is browsing saved content and how to return to current output.
Unsaved streaming text remains in the captured entry display/current view; it
must not be presented as part of a saved-history revision.

## Consistency and resource boundaries

- Each browse request belongs to a Session, surface and local generation.
  End, mode/session changes, local clear/rewind and new submission invalidate
  the request. Check these again before applying results, even after abort:
  the underlying RPC need not support cancellation.
- Every page and body read used for a committed browse window must belong to
  its revision. `resync_required`, changed revision, missing identity or invalid
  body ranges leave the previous screen intact. At most one automatic restart
  from the newest page; further attempts require another user action. Never
  append a new-revision page onto an old-revision window.
- Another client may rewind while this UI is browsing. Already displayed
  content is explicitly a frozen historical view, not a claim about the latest
  branch. Failed/expired reads do not silently reattach it to the new branch.
  End returns to the latest Host facts. Current `observe` has no history
  revision, so immediate remote-rewind detection is not promised.
- Prefer existing `inputId`, tool `callId`, and output identity. The current
  history projection does not preserve assistant `outputId`; investigate
  carrying that existing field through its projection, with source-identity
  tests. Missing/ambiguous identities must not be inferred from matching text
  or timestamps. Tool summaries may represent several call IDs.
- Do not call the existing complete-history helper for every wheel gesture:
  it traverses all pages and hydrates oversized bodies. Introduce only the
  page-level consumer logic needed here, reusing the existing range validator.
  Explicitly bound retained page/body data and concurrent reads, and retain the
  page containing the visible anchor. Paging budgets must not silently delete
  the user's currently viewed content or claim the beginning has been reached.
- Keep the first fix scoped to ordinary owned Ink browsing. Preserve existing
  native-scrollback and transcript semantics; shared helper changes require
  their regressions. No global event log, generic state machine or new public
  API is proposed.

The existing cursor expires when conversation history changes, including an
append. Therefore this proposal guarantees no silent loss or cross-version
splicing, not uninterrupted pagination through arbitrary concurrent writes.
If uninterrupted immutable-history browsing during continuous writes becomes
required, evaluate a Host-retained history snapshot separately; adding a version
number to `observe` alone would not provide that capability.

## Implementation and acceptance sequence

Prerequisite: the [contract re-audit](product-contract-assurance-2026-09-26.md)
reproduced oversized chunk decoding, single-message history clipping, and
out-of-window user-body lookup defects in the public readers. Correct and
regression-test those existing reader guarantees before relying on them for
ordinary browsing. A UI fallback must not hide a failed or incomplete reader.

1. Promote the live differential reproductions into failing retention tests:
   160 distinct tools, then 100 distinct plus 150 repeated tools. Check the
   original query and first tool can be reached in ordinary mode after
   completion, including the zero-height first upward gesture.
2. Test the page consumer with controlled reads before UI wiring: revision
   change, expired cursor, no/ambiguous anchor, huge body, network failure,
   repeated gestures, and results arriving after invalidation. Failures must
   preserve the displayed content and draft and must not retry forever.
3. Wire the existing ordinary scroll input to the browse window. Test anchor
   preservation across prepending, resize, folding and body hydration; test
   End/downward return and submission without accidental double delivery.
4. Run source-entry and rebuilt-bundle ConPTY checks through live output,
   completion, Stop, permission/question dialogs, disconnect/reconnect and
   session/lineage changes. Check scrolling in both surfaces and existing
   native-scrollback behavior. Injected terminal input alone does not verify
   physical Windows Terminal mouse reporting; keep that limitation explicit.
5. Review the final diff against these invariants and run affected type/build
   checks. Only mark Issue 342 fixed after the original retention tests pass;
   a successful restore or notice-only scroll test is insufficient.

The previous Session's unpersisted answer suffix is not recoverable by this
display fix and remains separate from browsing correctness.
