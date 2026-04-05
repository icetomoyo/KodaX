# FEATURE_057 Fullscreen TUI Smoke Test Guide

## Scope

Validate the fullscreen main REPL path after the local renderer substrate cutover.

Hosts to verify:
- Windows Terminal
- VS Code integrated terminal

## Preconditions

- Start KodaX in interactive fullscreen mode.
- Use a real project session with enough transcript history to scroll.
- Prefer a scenario that streams for at least 10-20 seconds so spinner/live feedback can be observed.

## Scenario 1: Live Activity

1. Start a request that produces streaming output or background work.
2. Confirm the UI shows clear live activity feedback.
3. Confirm the status bar remains visible and does not disappear after updates.

Expected:
- Spinner or equivalent live activity feedback is visible.
- Status bar remains stable.
- Banner is not pinned to the screen top.

## Scenario 2: Transcript Scroll

1. While output is still active, scroll upward with the mouse wheel.
2. Continue browsing older transcript content.
3. Scroll back down to the latest content.

Expected:
- Mouse wheel scrolls transcript history, not input history.
- Transcript browsing does not force the viewport back to the bottom.
- Returning to live bottom works normally.

## Scenario 3: Selection And Copy

1. While the session is active, drag across transcript text with the mouse.
2. Copy the selected text.
3. Paste it into another editor.

Expected:
- Selection works during live/spinner updates.
- Copied content matches the selected transcript text.
- Selection/copy does not require switching to classic mode.

## Scenario 4: Layout Stability

1. Open transcript browse/search flows if available.
2. Trigger prompt growth with multi-line input.
3. Trigger any footer/overlay/task bar surfaces that normally appear.

Expected:
- Top chrome stays compact and does not expand into a multi-line pinned help block.
- Prompt/footer changes do not make transcript jump unexpectedly.
- Status bar and bottom surfaces remain visible and stable.

## Pass Criteria

- Both Windows Terminal and VS Code integrated terminal pass all four scenarios.
- No loss of spinner/live feedback.
- No status bar disappearance during scroll or live updates.
- No regression to classic-mode-only usability.
