# Issue 412/413 v0.7.97 Regression Guide

## Goal

Verify that Stop always reaches a final outcome when Actor settlement cannot be
confirmed, and that the Session stays fenced until the Actor tree is
confirmed. Covers GitHub icetomoyo/KodaX#2 ("正在修复并停止" never ends) and
the `actorSettlementConvergence:3` capability.

## Automated gates

Run from the KodaX repository root (package-directory runs give false failures):

```powershell
npx vitest run packages/agent/src/actors
npx vitest run src/sdk-runtime.actor-stop-late-commit.test.ts src/sdk-runtime.actor-stop-late-commit-workflow.test.ts
npx vitest run src/sdk-runtime.test.ts -t "owner was unconfirmed at startup|Actor settlement convergence|live foreign Actor owner"
npx vitest run src/runtime-capability-facts.test.ts src/runtime-daemon/server.test.ts src/sdk-runtime-daemon-upgrade.test.ts
npx vitest run src/runtime-daemon/host.test.ts -t "fenced Actor trees"
npx vitest run src/sdk-runtime.test.ts -t "never returns"
```

Required observations:

- Two child Actors whose Stop save commits after its 5-second deadline end
  `interrupted` with Stop `confirmed`, without a second Stop.
- A save that rejects but commits is adopted after a revision and owner read
  back; the next save is not treated as an owner takeover.
- An owner takeover whose storage reload never settles still fences with
  `actor_owner_conflict` within the settlement deadline.
- A repair that fails deterministically ends the Run `failed` /
  `actor_settlement_not_persisted` / `effectOutcome: unknown` with Stop
  `confirmed`; `runs.start` then rejects and history mutation returns
  `conflict`.
- A repair that later succeeds lifts the fence and starts the queued Run.
- After a deterministic repair error, once the foreign owner exits, the Session
  accepts a new Run without a restart and the old children are `interrupted`.
  A live foreign owner is never taken over and causes no Actor save.
- After `runtime.close()` returns, including a rejected close, no Session
  storage work continues.
- While a Session stays fenced after its Run failed, `status.preflight()`
  reports `canStop: true` with no `activeAgentTurns`. `daemon.stop` over the
  protocol succeeds and releases the profile lock. `runtime.close()` rejects
  with `AgentShutdownPersistenceError`, but the Runtime agent home is
  already released.
- A workflow-owned Run reaches the same final outcome.
- A Run or Workflow whose executor ignores abort stays unconfirmed after Stop,
  but `status.preflight()` reports `canStop: true`. After close, the next
  Runtime reports the Run `interrupted`.
- Stop on a Run whose owner was unconfirmed at startup interrupts it once the
  owner is dead, returns `conflict` for a live owner, and returns a retryable
  `conflict` while the owner stays unconfirmed. The status file is unchanged
  in the last two cases.
- A client requiring `actorSettlementConvergence:3` rejects a v2 daemon and
  connects to a v3 daemon.

## Manual check (packaged Host, Windows)

1. Install the package built from this fix in an isolated `KODAX_HOME`. Confirm
   `initialize` reports `actorSettlementConvergence: { version: 3 }`.
2. Start a managed Run that spawns two parallel child Actors. While both run,
   slow the disk, for example with a large antivirus scan of the Session
   directory or a held file lock, so that saving the Actor snapshot takes more
   than 5 seconds.
3. Press Stop. Within about 10 seconds of the save completing, the Run ends
   `cancelled`/`interrupted`. The UI must not stay on "正在修复并停止".
4. Repeat, but keep the save blocked. Within about 5 minutes the Run ends
   `failed` with `actor_settlement_not_persisted`. The client shows a
   recovering Session rather than a model error, and a new prompt in the same
   Session is refused.
5. Release the disk. Without restarting, a queued or new prompt in that Session
   runs within the background repair interval (at most 30 seconds).
6. Repeat step 4. Without releasing the disk, quit KodaX Space normally, or
   run `kodax daemon restart`. The Host process exits; Space shows no
   "仍有任务正在运行" prompt for the fenced Session. Release the disk and start
   Space again: the Session accepts work and the old Run stays `failed`.

## Pass criteria

All automated gates pass from the repository root. In the manual check, no
Stop stays in progress past the 5-minute budget, no Run emits two terminal
events, and no successor Run starts while the Session is fenced.
