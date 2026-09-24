# Issues 340–343: Completed Session output and scrolling

Test in an isolated fixture or after restarting the development application to
load the new code. Do not copy a live actor owner into another runtime or alter
the original Session to bypass ownership checks.

1. Resume a long tool-heavy Session whose recent message page starts mid-turn.
   Its final answer should follow the preceding tools in both ordinary and
   Ctrl+O transcript views. Every tool call should remain visible once, including
   calls from a saved group that straddles the message-page boundary.
2. With a scripted provider, return an answer quoting `Tool policy:` or
   `[Managed Task Protocol Retry]` inline, followed by a final sentence. Check
   the complete live text, committed Session text and `runs.await` result in SA
   and AMA. A real control header on its own line must still be filtered.
3. With more history than the viewport, type an unsent draft. In ordinary mode,
   scroll with the wheel and PageUp, then use End to return to the bottom.
   The viewport should move and the draft should remain. Repeat in Ctrl+O mode.
   If ordinary mode fails, record which input fails, terminal dimensions and
   `KODAX_FULLSCREEN`; Issue 342 remains unconfirmed.
4. Append enough Host client notices to fill the viewport, then start a new
   response. Its text must appear below those notices, remain visible while
   streaming, and permit Stop followed by another input. Reloading the Session
   must not duplicate the checkpointed notices or move them past later messages.

Automated checks:

```powershell
npx vitest run src/session-view.output-ownership.test.ts src/session-view.notices-order.test.ts src/sdk-client.streaming.test.ts packages/repl/src/ui/utils/restore-history.test.ts packages/coding/src/task-engine/_internal/managed-task/llm-adapter-output.test.ts packages/coding/src/task-engine/_internal/managed-task/sanitize.test.ts --maxWorkers=2
npm run build
npm run typecheck
node tests/repl-pty-acceptance.mjs --prompt-scroll-only
```

The reported Run completed at 08:37:15 Asia/Shanghai on 2026-09-24. Its canonical
answer contains only 1,680 characters and ends inside a quoted marker. Reordering
can restore the saved fragment's position; it cannot recover unpersisted text.

Independent review:

- **Standards**: No hard violations or substantiated smell findings after
  reviewing the initial patch and final group/notice alignment increments.
- **Spec**: One P2 in the first fix: anchoring a whole mixed group discarded
  unknown sibling calls. A failing public-view regression confirmed it; splitting
  mixed groups fixed it. Independent follow-up found no remaining findings in
  that increment. The reviewer also checked 33,348 three-chunk filter splits.
  A separate review of notice ordering found missing anchors for visible tools
  outside the message page. That regression was reproduced and corrected using
  call IDs; independent final revalidation found no remaining issues.

Verification: 383 focused tests pass, along with full build and source/test type
checks. The final rebuilt bundle passes all 48 Ink/Classic PTY checks, including
the previously failing output-after-notices sequence, Stop and Session resume.
Isolated replay of a copy of the affected Session supports the history
ordering fix; wheel and PageUp passed before and after, so the reported scrolling
failure is not independently reproduced.
