# Issue 296 / v0.7.92 Canonical-First Resume Restore Regression Guide

## Purpose

Verify that resumed TUI history is reconstructed from canonical Session
`messages`. A sparse, stale, or slash-command-only `uiHistory` cache may overlay
display metadata or append UI-only entries, but it cannot hide ordinary
conversation or evict the 150-item / 50-round canonical window.

## Automated gates

Run:

```text
npx vitest run packages/repl/src/ui/utils/restore-history.test.ts
npx vitest run packages/repl/src/ui/contexts/trim-history.test.ts
npx vitest run packages/repl/src/ui/utils/transcript-layout.test.ts
npx vitest run packages/repl/src/ui/InkREPL.managed-transcript.test.ts
```

Required assertions:

1. `messages=[question, answer]` plus `uiHistory=[/quit]` restores
   question, answer, then `/quit`.
2. A complete `uiHistory` cut to any suffix, or reduced to a stale unmatched
   assistant line, does not remove ordinary conversation that
   `trim(derive(messages))` would keep.
3. Canonical and UI-only windows are trimmed independently. Four `/quit`
   entries cannot evict a full 150-item canonical window.
4. Tool groups overlay by tool ID, stay idempotent across repeated
   resume/save projections, and do not duplicate after a UI-only quit suffix.
5. With `messages=[]` and a usable `uiHistory`, display-only items such as
   sidecar or persisted tool cards still restore.
   Persist a `sidecar` item through the real `FileSessionStorage.save()` and
   `load()` path, then quit and resume again; the item must remain present after
   both loads and must not be filtered by JSON validation.
    Also force a managed run to fail after it has rendered a final Assistant
    summary and Sidecar verdict. Persist and restore the Assistant summary,
    Sidecar, and terminal error in that exact order; this failure path bypasses
    normal round completion. Reject the first persistence attempt and let the
    run-end fallback retry it; UI history and the restored session must still
    contain exactly one copy of each item.
6. Unmatched ordinary user/assistant/thinking text from a stale cache is
   discarded whenever canonical messages exist.
7. A non-empty CLI `uiHistory` does not synthesize `agent-completed` or
   legacy `task-completed` presentation events that were absent from the
   cache. Headless/no-cache restore still derives those events from messages.

## Reported session replay

Session `20260816_202555_lw2ea48cf61259` has 297 canonical messages and a
four-item `/quit` `uiHistory`. Restore must yield 154 items: the bounded
150-item canonical tail plus the four UI-only `/quit` entries. It must not
render only the four `/quit` lines.

The 150-item / 50-round display bound is unchanged. This guide does not require
the full two-day review transcript to appear after resume.

## Manual check

1. `kodax -r 20260816_202555_lw2ea48cf61259` from the KodaX workspace.
2. Confirm the last review round is visible and the four `/quit` lines are at
   the tail.
3. `/quit` and resume again. Ordinary conversation must not shrink further.
