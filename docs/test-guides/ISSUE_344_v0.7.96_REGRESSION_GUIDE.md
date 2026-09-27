# Issues 344–347: command feedback and history navigation/read boundaries

Baseline: `394d4134`. Date: 2026-09-27. Windows, owned Ink renderer.

## Automated reproduction

Use the external PTY dependencies documented in `FEATURE_298_v0.7.97_TEST_GUIDE.md`.
The harness creates a temporary HOME and Host, and uses only scripted localhost model responses.

```powershell
npm run build:packages
node tests/repl-pty-acceptance.mjs --source --model-notices-only ink
node tests/repl-pty-acceptance.mjs --source --prompt-scroll-only ink
node tests/repl-pty-acceptance.mjs --source --consumer-only ink
```

- Switch both provider and model; verify command echo and success survive another client's settings write.
- Query `/model`, trigger another Host view, and verify output and a new observer's notice agree.
- Submit an invalid provider and use Ctrl+T; each feedback remains after refresh.
- Verify notices are persisted as client-only lineage and absent from the next model request.
- Freeze history shorter than the viewport, append new content, then wheel down once: return to live without End.
- Browse a longer history to its top and wheel down to latest; preserve the unsubmitted draft.
- Load another Session and show its tree; feedback survives subsequent Host settings changes in that Session.

Before the fixes, model feedback failed after a Host refresh, the short-history wheel test timed out, and Ctrl+T feedback was missing. The Product adapter failure test also resolved successfully despite a null Host save receipt.

## Manual check

Restart `npm run dev` in the updated worktree. In a new Session, run `/model`, switch to a configured provider/model, and verify the command and result remain visible after another setting change. No model request is needed for those commands.

For actual write/edit work on KodaX itself, use the bundled entry instead: source
mode rejects native artifacts located under the same writable installation.
After `npm run build:packages` and `npm run build:bundle`, finish all work on the
source Host, exit the UI, then run `node scripts/kodax-bin.cjs daemon stop` followed
by `node scripts/kodax-bin.cjs`. Do not stop an active Host just to run these tests.

With just a few visible history entries, scroll up and then down. The live body should return without End. Repeat with enough content to require several screens; Ctrl+O transcript scrolling and End should continue to work. Draft text must survive browsing.

The fix changes TUI consumption of the existing notice and history contracts. It does not introduce new Product methods, an event journal, or a generic state machine. Query notices are display lineage; `readHistory` remains canonical conversation paging, not a new notification archive.

## Verification on 2026-09-27

- `npm run build:packages` and `npm run typecheck`: passed.
- Focused Vitest: 41 passed across pointer policy, saved-history windows, production Client binding, notice ordering, failed-write adapter and real Host notice/goal tests.
- `node tests/repl-pty-acceptance.mjs --source ink classic`: 50/50 passed (Ink 30, classic 20). Artifacts: `%TEMP%/kodax-repl-acceptance-Rh49S1`.
- Isolated model/shortcut regression: 3/3 passed; `%TEMP%/kodax-repl-acceptance-TnZMy6`.
- Isolated ordinary-history wheel regression: 5/5 passed; `%TEMP%/kodax-repl-acceptance-qxAGua`.
- `--source --consumer-only ink`: 8/8 passed, including load/rewind/tree feedback and resumed settings; `%TEMP%/kodax-repl-acceptance-H82EZv`. Its intentional terminal replacement emitted an external node-pty `AttachConsole failed` cleanup-helper diagnostic; the replacement terminal, Host assertions and final CLI exit all passed, with driver exit code zero.
- Tests ran against the source entry used by `npm run dev`, with rebuilt workspace packages. No paid provider or user's active Session was used. PTY checks remain explicit acceptance commands, not newly added CI jobs.

## Standards

Follow-up review after Issues 346/347: no actionable findings against the final production/test diff.

Independent review: no remaining findings; highest remaining severity: none.

## Spec

Follow-up review after Issues 346/347: no actionable findings. The Product methods and wire protocol are unchanged.

Independent review: no remaining findings after routing direct command callbacks and rejecting null notice-write receipts; highest remaining severity: none. This is not a claim of exhaustive absence of bugs.

## Follow-up: stalled reads and off-window canonical blocks

- Before repair, the hook stayed loading after advancing a stalled request beyond 15 seconds; the real Host returned null for the first tool in an 80 tool/text-pair canonical message even though history retained its result.
- One browse gesture now has a 15-second deadline across pages and body chunks. Cancellation ends the UI wait immediately; timeouts preserve the captured body and offer manual retry. Late responses cannot replace the retried page or start another chunk. Already-dispatched Host RPCs are not forcibly cancelled.
- Canonical item recovery uses complete projection. Identity assignment precedes the existing 50-round/150-item display policy. Tests retain observed IDs and check their exact committed bodies after rollover, plus early tool results and inputs.

Final candidate verification on 2026-09-27:

- `npm run build:packages`, `npm run typecheck`, `npm run build:bundle`, and `npm run build:dts`: passed. The declaration bundler emitted shared-type export warnings in unchanged SDK surfaces; its final Product Client consumer check without Node ambient types passed.
- Focused Vitest: **168 passed / 24 files**, covering Session views/ownership/notices, real Host history/item/search/input/compaction/rewind, MCP rollback, command binding, failed notice receipts, restoration, pointer policy, and browse reader/hook. Cancellation/deadline tests also assert timer cleanup, stale-result isolation and no subsequent chunk requests.
- `node tests/repl-pty-acceptance.mjs --source ink classic`: **50/50 passed** (Ink 30, classic 20); `%TEMP%/kodax-repl-acceptance-mSZmr4`.
- `node tests/repl-history-browse-acceptance.mjs --source --distinct`: passed with 160 real independent tools; `%TEMP%/kodax-repl-acceptance-PciuiP`.
- `node tests/repl-history-browse-acceptance.mjs`: passed against the rebuilt bundle with 250 tools including repeated calls; `%TEMP%/kodax-repl-acceptance-nCwVru`.
- Both large-history PTYs recovered the original query/preface/first tool, traversed intermediate history downward, retained the final answer and transcript history, and reflected live activity/completion while browsing. CLI exit and isolated Host cleanup passed.
- All model responses were local scripted fixtures; no user's active Host or Session was stopped. PTY wheel checks inject terminal mouse sequences and do not claim physical mouse hardware validation.
