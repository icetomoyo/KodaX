# Issue 370: Saved history wheel return regression

Observed and fixed locally on Windows, 2026-10-28, after `ec442c75`
(v0.7.97-alpha.10; unreleased change). This does not resolve Issue 371's
intermittent startup latency or change memory finalization.

## Contract

In the ordinary owned terminal viewport, wheel upward through paged history
while the model streams. A newly persisted history revision must not trap the
reader when scrolling down. Wheel down must reach live output without End;
repeat after the Run is idle. Reading must preserve the visible message anchor,
draft and input count, and must never combine pages from different revisions.

## Automated checks

Prepare the existing PTY dependencies described in
[FEATURE_298's guide](FEATURE_298_v0.7.97_TEST_GUIDE.md), then run from the repository:

```powershell
npm run build:packages
npx vitest run packages/repl/src/ui/utils/prompt-history-browse.test.ts packages/repl/src/ui/hooks/usePromptHistoryBrowse.test.tsx packages/repl/src/ui/utils/transcript-surface.test.ts packages/repl/src/ui/utils/transcript-scroll-controller.test.ts packages/repl/src/ui/client-plane.test.ts
node tests/repl-pty-acceptance.mjs --source --streaming-scroll-only
```

The PTY fixture uses an isolated home, 90 saved user/assistant turns and a local
streaming HTTP model. It never resumes, stops or rewrites a user's real Session.
The source CLI imports compiled workspace packages; rebuild those packages before
running after a REPL source change. The normal packaged CLI additionally requires
`npm run build:bundle`; omit `--source` to verify that artifact.

Before the fix, three runs failed with
`Timed out: long saved history wheel returns to live without End`, stopping near
saved query 70 after 300 downward wheel events. A bounded temporary probe confirmed
`Saved history changed` on each newer-page read; all temporary probes were removed.
After the fix, source PTY startup, streaming/settled/idle wheel navigation and exit
passed; 100 focused tests across the five files above passed, including a
400-item stale-cursor case whose anchor lies more than four pages from live.
The packaged CLI also passed streaming/settled/idle wheel navigation and the
short-history/ordinary-prompt wheel checks. Production and test TypeScript checks,
workspace builds, bundle builds and all 14 SDK type bundles passed.

Each PTY run prints its temporary artifact directory. Inspect
`ink-streaming-scroll-wheel-return.txt` and `ink-idle-scroll-wheel-return.txt`.
An unavailable or ambiguous source still preserves the old content and requires
explicit recovery; resync has the original 15-second deadline and bounded memory,
with at most 128 page reads for the fresh anchor search. No startup timeout,
process ownership, recovery or execution permission policy changed.
