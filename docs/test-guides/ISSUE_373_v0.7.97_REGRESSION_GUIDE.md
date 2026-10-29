# Issue 373: Consistent token units for streaming progress

Observed in v0.7.97-alpha.10 after `53925835`, 2026-10-29; fixed locally,
unreleased. The reported row was `Receiving spawn_agent (2169 chars)`.

## Contract

User-facing model streaming counters use approximate tokens, visibly marked
with `~`. Thinking and tool-argument reception must not mix token and character
labels. Characters remain valid raw transport/debug metadata; they must not be
relabelled as actual tokens or added to Provider usage, billing or the context
baseline. Pasted-text lengths remain character counts because they measure text
size rather than model progress.

The follow-up audit also covers legacy transcript thinking spinners and the
completed-iteration thinking/response summary counters. Those surfaces use the
same visibly approximate fallback as other character-only legacy paths.
Character-based selection sizes, pasted text, file content sizes and hard text
truncation limits retain their actual units; they are not model usage counters.

The Host estimates each identified call's complete received argument text using
the same `countTokens` estimator used for live thinking. Estimate once per
coalesced Session view, not on every incoming fragment. Preserve CJK and split
Unicode characters, keep interleaved call IDs independent, ignore child output,
and reset at request boundaries. Release temporary argument text on tool start,
stream end, terminal Run refresh and Session release/close. Do not persist or
publish that temporary text as new Session display data.

Tool-input `estimatedTokenCount` is additive and optional. Old Hosts and calls
without a tool ID render the activity label without an invented cumulative
count. Ink and Classic use the same Host activity formatter. Legacy local
spinner paths that only have character totals retain the existing coarse
characters/4 estimate, now consistently marked `~`; this fallback is less
accurate for multilingual text and is not the Host's multilingual estimate.
These progress estimates do not promise agreement with a model-specific
tokenizer or Provider-reported usage.

## Cause and correction

The Host activity contract only exposed a token estimate for thinking. Tool
input exposed UTF-16 length, and Ink/Classic explicitly formatted that length
as `chars`. Legacy busy labels and the CLI event spinner also retained character
labels. This was inconsistent progress presentation and missing tool-input
estimation, not evidence that billing or saved token usage used characters.

The Host now retains pending input fragments only until their existing stream
lifecycle ends and computes a multilingual estimate at the coalesced view
boundary. The UI shares one formatter and preserves absent-count compatibility.
Legacy character-only labels share their existing coarse estimator, including
the stats tail; all estimated counters explicitly show `~`.

## Automated acceptance

```powershell
npm run build:packages
npx vitest run src/session-view.test.ts packages/repl/src/interactive/classic-plane-display.test.ts packages/repl/src/ui/view-models/status-bar.test.ts packages/repl/src/ui/view-models/surface-liveness.test.ts packages/repl/src/ui/components/SpinnerStatsTail.test.ts packages/repl/src/ui/components/SpinnerStatsTail.render.test.tsx packages/repl/src/ui/utils/tool-display.test.ts packages/repl/src/ui/cli-events.test.ts
npm run typecheck
node tests/repl-pty-acceptance.mjs --source --streaming-tokens-only ink
npm run build:bundle
node tests/repl-pty-acceptance.mjs --streaming-tokens-only ink
```

The unit regression first failed because the tool-input estimate was missing.
Classic display and legacy spinner regressions also failed on the old character
labels. The initial focused eight-file suite passed 150 cases after correction.
The argument fixture `Hello 世界` estimates 4 tokens, extending it with an emoji
split across UTF-16 fragments estimates 5; the separate call `12345` estimates
2. Existing Provider usage remains 6,000 tokens independently of those counters.
Repeated call IDs in a new request start afresh; late input after tool admission
cannot revive streaming progress.

The PTY fixture uses an isolated HOME and local scripted OpenAI-compatible
server, never a user's Session. It pauses the tool input at `{"path":` and then
`{"path":"note.txt"}`. Ink must display `Receiving read (~2 tokens)` and then
`Receiving read (~5 tokens)`, with no `chars` label. A harmless fixture read then
completes and the terminal exits normally. Source PTY startup, both streaming
counter states and exit passed. The fixture supports an explicit Classic mode;
Classic prints its existing single snapshot per phase rather than continuously
updating every fragment. Packaged Ink and Classic startup, token progress and
normal exit all passed.

Independent review identified a legacy retry counter boundary before release:
same-iteration replacement requests may reuse a tool ID without an intervening
stream-end callback. A regression went RED, then passed after clearing on root
segment request changes and keying by both request and call ID. A second RED
case covers older adapters that omit segment-start events but supply request
metadata. Late previous-request and child deltas cannot inflate the current
identified request. No retry, model-call or permission behavior is changed.

Final validation: 211 cases passed across nine focused files; source Ink and
packaged Ink/Classic PTY startup/progress/exit passed. Production/test typechecks,
workspace and bundle builds, and all 14 SDK declaration bundles passed. The
Issue 371 concurrent cold-resume/verified-shutdown/restart fixture also passed
against the rebuilt bundle. Standards and Spec review have no open findings.

## Follow-up audit (2026-10-29)

The initial focused suite missed legacy transcript thinking and iteration
summary labels. New regressions failed on `42 chars`, `120 chars total` and
`240 chars total`, then passed with `~11 tokens`, `~30 tokens total` and
`~60 tokens total`. Managed-role prefixes and round labels remain intact.
The older StatusBar component assertions and one thinking-state golden row
also needed the new unit; no unrelated golden output changes are expected.

The audit also found that importing the token formatter through the status-bar
module made lightweight transcript helpers load permission/coding runtime
modules. The existing narrowly mocked transcript suite could no longer collect.
The formatter now lives in a dependency-free common module, and the original
status-bar export remains available. This corrects the dependency rather than
expanding mocks to hide it.

Follow-up validation passed: all 256 REPL test files (2,995 cases passed,
one skipped); production and test typechecks; workspace, executable bundle and
14 SDK declaration builds; packaged Ink and Classic token-stream startup,
display and normal exit. The rebuilt-bundle cold-resume fixture also passed:
220 exited records, ready in 2,705 ms, concurrent history reads in 48 ms and
verified shutdown/restart in 1,527 ms. These fixture measurements do not resolve
Issue 371's historical, un-attributed 16-second read. Independent Standards and
Spec follow-up review each have zero open findings.

```powershell
npx vitest run packages/repl/src --maxWorkers=2
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
node tests/repl-pty-acceptance.mjs --streaming-tokens-only
node --test tests/bundled-startup-recovery.test.mjs
```

The later whole-repository run also found stale `chars` assertions in
`src/sdk-client.repl-activity.test.ts`, outside the REPL package suite. A focused
RED run confirmed that the actual Host-to-Ink output already used `~2 tokens`.
The bridge fixture now requires token snapshots for both Ink and Classic, the
updated cumulative `~3 tokens` for Ink, and no character-unit receiving line.
Classic retains its existing one-snapshot-per-phase behavior; the test does not
require repeated count lines or change production behavior.
Two other root fixtures (`sdk-client.streaming.test.ts` and
`session-view.streaming.test.ts`) still required the old tool-input object without
`estimatedTokenCount`. Independent RED runs confirmed that only the additive
estimate field broke those assertions. They retain exact object comparisons and
private-text checks, now including explicit token estimates. All 30 cases across
the four files below then passed; no production change was needed.

```powershell
npx vitest run src/sdk-client.repl-activity.test.ts src/sdk-client.streaming.test.ts src/session-view.streaming.test.ts packages/repl/src/interactive/classic-plane-display.test.ts --maxWorkers=2
```
