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
4. Confirm the v6 page cache is rebuilt once: first open is slower, later opens
   reuse the v7 cache. Page through the whole conversation and compare it with
   the full history view; both must show the same rows in the same order.
5. Open a Session with a genuinely ambiguous fork (two diverging branches, no
   exact legacy reproduction). It must stay `ambiguous`.

## Interrupted Run recovery

1. Use a copied Session whose last managed Run ended with `daemon_crashed` (or
   kill the Runtime during a managed Run that is writing a file).
2. Start a new managed Run in that Session. With provider logging enabled,
   confirm the first request contains `=== Interrupted Run Recovery ===`, names
   the source Run and terminal code, and lists recorded results separately
   from `Result unknown` operations.
3. Confirm the saved Session does not contain the record.
4. Let the Run finish, then start another. The record repeats only for
   operations whose results history still lacks; it never duplicates.
5. Rewind or fork to a turn before the interrupted Run. The record must not
   appear on that branch.
6. Make the interrupted Run's `events.jsonl` unreadable. The next Run must start
   normally and log a `runtime.interrupted-run-recovery` warning.

## Limits

Coding-mode Runs and tool invocations do not receive the record. Assistant text
from the interrupted Run is not recovered; only journaled tool operations are.
