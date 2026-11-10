# Issue 400: agent-home retention

Repaired 2026-11-10 on v0.7.97-beta.4 (unreleased). Decision: ADR-074. Path
list: DD §10 "Agent-home retention".

## Contract

- An idle Host expires only the allow-listed retired paths. Retired data must
  be untouched for 30 days. `.unresolved` child records are kept for 90 days.
- A busy Host does not expire anything. Busy means Runs, Workflows, Actor turns,
  pending interactions or background work.
- `daemon.log` rotates to `daemon.log.1` at 2 MiB and holds no `debug` lines.
- Deleting a Session through the Host removes only that Session's settings,
  order counter, empty pending-input file and execution facts. Run records,
  Session stops and other Sessions' files stay.

## Automated checks

```powershell
npx vitest run src/runtime-daemon/home-retention.test.ts src/runtime-daemon/maintenance-scheduler.test.ts
npx vitest run src/runtime-daemon/state.test.ts -t "daemon log"
npx vitest run src/runtime-daemon/host.test.ts -t "never debug diagnostics"
npx vitest run src/execution-facts.test.ts -t "deleted Session facts"
npx vitest run src/sdk-runtime.test.ts -t "deleted Session's own runtime state"
npm run typecheck
```

Before the change, every retention, rotation and delete test above failed.
Replacing `lstat` with `stat` in `home-retention.ts` fails the link test.
Setting the 30-day fence to 0 fails the fence test.

## Manual acceptance (after `npm run build`)

Use a throwaway home so real data is never at risk:
`$env:KODAX_HOME = "$env:TEMP\kodax-400"`. Copy your provider configuration
into it so `kodax` can start.

1. Create `runtime\profiles\default\runs\r1\events.jsonl` and
   `runtime\profiles\default\runs\r1\status.json`, and set both files'
   `LastWriteTime` to 40 days ago.
2. Start `kodax` and leave it idle for a minute. `events.jsonl` is gone.
   `status.json` and the `r1` directory remain. `daemon.log` has one
   `Unused agent-home state past its retention period was removed.` entry.
3. Repeat with `LastWriteTime` 10 days ago. The file stays.
4. Start a long Run, create another 40-day-old `events.jsonl`, and confirm it
   survives while the Run is active.
5. Create a Session, change a setting, delete the Session from the REPL, and
   confirm `runtime\profiles\<profile>\session-settings\<id>.json` is gone.
   Its `runs\<runId>` folders remain.
6. Append past 2 MiB to `runtime\daemon\<profile>\daemon.log`, then trigger any
   `info` diagnostic, for example a Host restart. `daemon.log.1` appears.
   `kodax daemon logs` still shows the newest lines.
