# Issue 340 — Interrupted Run recovery and ambiguous compacted history

- Baseline: SDK v0.7.96-rc.13.
- Candidate: current local source; no publication is claimed.
- Automated coverage exists for every step below; this guide covers the
  end-to-end checks a unit test cannot see.

## Preparation

Work only on copies. Copy the affected home (sessions, `runtime/runs`, page
cache) into a temporary directory and point KodaX at it. Never open a live
Session with the candidate while its owner is running. Record the source
revision and whether the candidate is a local link or a published package.

## Ambiguous compacted history

1. Open the copied Session that reported `compaction_boundary_invalid` /
   `compaction_predecessor_missing` with the baseline. Note the status and the
   partial assistant / empty user rows.
2. Open the same copy with the candidate. Expect status `resolved`, no issues,
   and the tool calls with their results on the active branch.
3. Confirm the Session file is byte-identical before and after (restoration is
   read-only).
4. Confirm an older page cache is rebuilt once: first open is slower, later
   opens reuse the v10 cache. Page through the whole conversation and compare it
   with the full history view; both must show the same rows in the same order.
5. Open a Session with a genuinely ambiguous fork (two diverging branches, no
   exact legacy reproduction). It must stay `ambiguous`, or `partial` with
   `compaction_history_truncated` when the fork sits behind a compaction and
   later epochs are proven.
6. Open a copied Session whose oldest compaction cannot be proven (the
   SDK-reported forked evidence chain). Expect `partial` with
   `compaction_history_truncated` naming that compaction. Rows before it are
   omitted, and no row appears twice with the same logical identity.

## Interrupted Run recovery

1. Use a copied Session whose last managed Run ended with `daemon_crashed` (or
   kill the Host after a known successful display checkpoint). Uncheckpointed
   tokens and old rc.14 event logs are not recovery sources in this branch.
2. Start a new managed Run in that Session. With provider logging enabled,
   confirm the first request contains `=== Interrupted Run Recovery ===`, names
   the source Run and terminal code, and lists recorded results separately
   from `Result unknown` operations.
3. If the interrupted Run streamed assistant text, confirm it appears under
   `Reply excerpts` as quoted, unconfirmed text. Text a child agent streamed
   must not appear there.
4. Confirm the saved Session does not contain the record.
5. Let the Run finish, then start another. The record repeats only for
   operations whose results history still lacks; it never duplicates.
6. Rewind or fork to a turn before the interrupted Run. The record must not
   appear on that branch.
7. Inject a failed Host display checkpoint and confirm public reads report the
   failure instead of silently returning older Session content. There is no
   events.jsonl replay or event-derived terminal repair in this branch.
8. Repeat steps 1–4 with coding-mode Runs (for example the SA agent mode).
   The record reaches the provider request but never the saved Session.

## Limits

Tool invocations do not receive the record because they make no model call.
Reply excerpts are unconfirmed notes, not restored conversation, and long
replies keep only their tail. Space checks need a rebuilt desktop package; a
source change does not update `out/win-unpacked`.
