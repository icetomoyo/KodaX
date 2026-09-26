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

## Normal-view content check (2026-09-26)

The user clarified that ordinary mode may have retained only the screenshot's
tool block, rather than failing to process scroll input. Future reproduction
must capture the ordinary surface's item identities, complete row count and
viewport height at the live completion boundary. Notice-only scrolling tests
do not establish content retention.

Current code distinguishes three limits:

- Host observation retains the latest 150 items and bounded body previews.
  Replacing the ordinary view with that snapshot can remove older history;
  transcript browsing has a separate path to load earlier history.
- The ordinary surface folds thinking and tool summaries. Its `maxLines=12`
  does not truncate assistant text; assistant rows are wrapped from the supplied
  body. The ordinary 20-round and shared item caps did not explain this
  single-turn product view (mapped Host items are marked UI-only).
- In the default owned fullscreen renderer, the banner, finalized sections and
  current sections enter the complete row model before viewport slicing.
  Scroll height is calculated from that model, rather than just the painted
  rows. No confirmed default-path loss was found in this supplemental audit.

Read-only source: Session `20260924_081919_ilf5424e3d80e7`. A projection probe
using all 136 saved messages produced 150 retained items and 262 ordinary rows
at width 220, including the saved assistant fragment. This is one projection
input, not a claim about the exact live Host snapshot. Detailed tool/thinking
rendering of the same input produced 1,702 rows.

An isolated fixture kept the message/lineage and UI-history contents, assigned
a fresh Session identity and temporary project scope, and omitted the original
actor ownership metadata. The original Session and live Runtime were not
modified. The current built CLI in ConPTY + xterm/headless at 220×58 showed the
saved answer at the bottom, earlier content on PageUp/wheel, and the banner at
the top. Transcript PageUp moved as well. No model request was submitted.
Screens and ANSI are in `%TEMP%/kodax-repl-acceptance-a2MXNh`, with results in
`probe-results.json`; the local harness is `%TEMP%/kodax-normal-content-pty.mjs`.
Node-pty emitted `AttachConsole failed` during teardown after the screen
captures; this run is evidence for the recorded screen checks, not a clean
terminal-lifecycle test.

At this stage only restore checks had passed. The live A/B below subsequently
confirmed a branch regression; the exact original live snapshots remain absent.

## Live main-versus-branch reproduction (2026-09-26)

Both runs use source entry (the `npm run dev` bootstrap), owned renderer,
220×58 ConPTY, isolated profiles/projects and a deterministic localhost
OpenAI-compatible provider. The script creates read-only text-tool fixtures,
holds final streaming open, sends the same wheel/PageUp sequences before and
after completion, and captures normal/transcript screens. No paid provider or
original Session is used. Main is the clean `KodaX` checkout at `c447c0f3`;
the branch is `6e5d6298` with documentation-only local edits.

| Scenario / observation | Main | Branch |
| --- | --- | --- |
| 160 distinct reads: wheel during/after run | Moves / moves | Moves / moves |
| 160 reads: ordinary top retains original query/first tool | Yes / yes | No / no; starts at tool 11 |
| 100 distinct + 150 repeated reads: wheel during/after run | Moves / moves | Moves / does not move |
| Repeated-read case: ordinary top retains query/first tool | Yes / yes | No / no |
| Branch repeated-read case: Ctrl+O wheel, without Ctrl+E | — | Moves through expanded reasoning |
| Branch repeated-read case: Ctrl+E + sufficient PageUp | — | Retrieves original query |
| Final answer saved/displayed in these cases | Yes | Yes |

The repeated-read branch screen contains the banner, one `read … x148` summary,
collapsed thinking and the short final answer. Its complete ordinary view fits
inside the viewport. Main preserves the original query and first 100 distinct
tools, so ordinary history still spans multiple screens. This establishes a
content-retention regression, independently of the earlier output truncation.

Mechanism: `InkREPL` now calls `replaceHistoryItems` on every bounded Host view;
`SessionViewOwner` retains 150 individual items. Main accumulated local rounds
with grouped tools. The branch discards earlier entries before normal-mode
folding and never pages them back on ordinary scrolling. Transcript has both
reasoning expansion and a separate complete-history reader. The mouse runtime,
terminal mode sequences, `KeypressContext`, `AlternateScreen`, and pointer
action policy have identical Git blobs on main and the branch. Identical input
code therefore does not imply identical scrolling behavior.

Artifacts under `%TEMP%/kodax-repl-acceptance-`:

- `M8JzaW` / `iWj3Ai`: distinct-read branch / main.
- `deEk96` / `GSki2T`: folded-read branch / main.
- `fpkOa2`: repeated branch run additionally verifying Ctrl+O wheel before
  Ctrl+E; `probe-results.json` records `settledWheel=false` and
  `compactTranscriptWheel=true`.
- Local harnesses: `%TEMP%/kodax-scroll-live-ab.mjs` and
  `%TEMP%/kodax-scroll-folded-ab.mjs`; use `--source` and select the checkout
  with `KODAX_SCROLL_PROBE_REPO`.

Harness corrections: the main source UI needed a startup settle before input;
its streaming renderer also withholds the incomplete last line, so the readiness
check must use a completed line. Initial runs that never submitted or waited on
that incomplete line timed out and are not counted as product failures.
No mouse-enable sequences appeared in either captured ConPTY output, and
xterm reported mouse tracking as disabled in both. This downstream observation
does not establish what mode the application requested at the Windows console
boundary. Injected wheel sequences prove application behavior, not physical
Windows Terminal mouse delivery. Both versions were tested with the
same transport. The repeated case's PageUp failure and short complete screen
independently establish the history loss. Node-pty's post-capture teardown
warning remained; these are screen-behavior results, not clean-exit claims.

At the A/B baseline, Issue 342 was confirmed Open, with a production fix outstanding. The
regression gate must preserve old content in ordinary browsing after the live
snapshot rolls over, including the folded case; reloading the saved Session or
only checking notices/scroll keys is insufficient. Reuse Host history readers
and verify draft/position preservation, live updates, return-to-latest, Session
switches and changed lineage rather than widening the public contract blindly.

## Repair acceptance (2026-09-26)

The live reproduction is now retained as
`tests/repl-history-browse-acceptance.mjs`. After `npm run build`, run:

```powershell
node tests/repl-history-browse-acceptance.mjs --source
node tests/repl-history-browse-acceptance.mjs --source --distinct
node tests/repl-history-browse-acceptance.mjs
node tests/repl-history-browse-acceptance.mjs --distinct
node tests/repl-pty-acceptance.mjs
```

Use the existing external PTY dependencies described in the FEATURE_298 test
guide. Each scenario prints its isolated artifact directory. The first four
commands exercise folded and distinct tools through the source and bundle
entry points. They require the original query/first tool in ordinary history,
wheel navigation from the short settled view, final output after End, and
unchanged transcript full-history access. They also await the actual Host Run
terminal state and require the activity/prompt controls to update while the
body remains in browse mode.

The automated input is SGR wheel/PageUp, not a physical mouse. On Windows
Terminal, repeat the folded-tool case manually: scroll upward after completion,
verify the original question and first tool, scroll down through intervening
pages, then End to the final answer. Resize while reading a long user or
assistant paragraph and verify that the same words remain in view. During a
held Run, verify that activity, Stop and any approval dialog remain usable
while reading old content. Do not use a live personal Session for fault tests.
