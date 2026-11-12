# FEATURE_305 private side chat — test guide

`/side` (alias `/btw`) opens a private side chat seeded from the parent session. Only an explicit
`send_to_parent` letter reaches the parent. Design record: `docs/designs/side-chat-plan.md`.

## Automated checks

```powershell
npx tsc -p tsconfig.check.json
npx tsc -p tsconfig.test.json
node node_modules/vitest/vitest.mjs run packages/repl/src/ui/components/SideChatPanel.test.ts packages/repl/src/interactive/side-command.test.ts packages/repl/src/interactive/storage.side-snapshot.test.ts src/side-chat.test.ts src/sdk-client.lineage.test.ts
cd packages/repl; npx tsc -b; cd ../..          # the PTY script loads packages/repl/dist
node tests/repl-pty-acceptance.mjs --source --side-chat-only
```

Run vitest from the repository root; package directories give false failures.

## Intent eval (needs provider keys; spends calls)

Pre-registered budget: 54 calls (3 aliases x 6 cells x 3 samples), see plan §8.1.

```powershell
node tests/repl-pty-acceptance.mjs --source --side-chat-only   # leaves ink-requests.json with the production side prompt and tools
npx tsx benchmark/side-chat-intent.eval.ts <path-to-ink-requests.json> ark/v4flash,zhipu/glm52,ark/k27
```

Scoring is structural (`benchmark/side-chat-intent.cases.ts`): mis-send, miss, wake-error. Then read
every `zh-selected` and `zh-wake` `text` field in the dump and confirm the letter holds only cause B.
Baseline 2026-11-12: v4flash 15/18, glm52 17/18, k27 18/18; the only failures are `zh-ambiguous` mis-sends.

## Manual checklist

Use a real terminal (fullscreen UI, not `KODAX_FORCE_CLASSIC_REPL`). Parent history should mention two
causes, A and B, so a selective letter is visible.

1. **Busy parent.** Start a long parent turn, then `/side what do you think of cause B?`. Hold two private rounds,
   then ask "tell the parent only about cause B". Expect: the parent receives one letter containing only B; the
   panel shows `To parent (delivered|queued): …`; the private rounds never appear in the parent transcript.
2. **Idle parent, resume.** Idle `/side`, chat, leave with Esc, quit, restart with `--resume`. Expect: `/side` reopens the same side chat with its history.
3. **Classic mode.** With `KODAX_FORCE_CLASSIC_REPL` set, `/side` prints "Side chat needs the fullscreen UI" and
   does nothing else.
4. **Side tool approval.** Blocked: the panel's `/allow` and `/deny` path is not reachable today (owner decision
   pending, see the plan). Skip until decided.
5. **Esc.** While the side agent runs, Esc stops it and the panel stays open; with it idle, Esc closes the panel
   and returns to the parent with the draft kept.
6. **Branch change.** After a letter is queued, rewind or switch the parent branch. Expect the receipt
   `To parent (parent branch changed…)` and no letter in the new branch.
7. **Two windows.** Open the same side chat from two terminals on one parent. Expect both show the same items;
   a letter sent from one is delivered once.
8. **Delete parent.** Delete the parent session. Expect the side chat is removed with it and no orphan remains.
9. **Marker and end.** While the parent is focused and the side agent runs, the footer shows a one-line side
   marker; when a new reply lands it changes to "new reply" and clears after the panel is opened. The marker never
   enters the parent transcript or the next provider request. `/side end` (panel or parent) discards the side chat;
   a second `/side end` from the parent says "There is no side chat to end."; a new `/side` starts clean and does
   not inherit the ended chat.
