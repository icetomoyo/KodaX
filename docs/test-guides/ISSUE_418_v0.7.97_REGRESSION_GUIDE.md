# Issue 418: A2A Tasks in one context share a Runtime Session

Repaired 2026-11-18 after v0.7.97-beta.11 (unreleased). Decision: ADR-077
item 7, which amends ADR-061 item 7. Design: DD §13.

## Contract

- A2A Tasks with the same `contextId` from the same principal run in one
  Runtime Session, `a2a-<64 hex>`. A follow-up Task sees the earlier exchanges.
- Another `contextId`, or another principal with the same `contextId`, gets a
  separate Session.
- A Task sent while another Task of the context runs waits for that run, then
  sees its answer.
- Each Task keeps its own cursor. Restart recovery and subscription are
  unchanged.
- Tasks created before the fix keep their own Sessions.

## Automated checks

Run from the repository root after `npm run build:packages` and
`npm run build:native`:

```powershell
npx vitest run src/a2a/context-session.test.ts
npx vitest run src/a2a/ src/kodax_cli.daemon-smoke.test.ts
npm run typecheck
```

## Manual acceptance

The CLI has no A2A serve command, so use an embedding Host built on
`createKodaXA2AServer` (see the embedder guide, section 22).

1. Send `SendMessage` with `contextId: "trip"` and the text
   `My name is Ada.` Wait for `TASK_STATE_COMPLETED`.
2. Send a second `SendMessage` with `contextId: "trip"` and the text
   `What is my name?` The answer names Ada.
3. In the server `dataDir`, `tasks.json` shows the same `sessionId` for both
   Tasks, and it matches `a2a-` plus 64 hex characters.
4. Send `What is my name?` with `contextId: "other"`. The model does not know
   the name, and `tasks.json` shows a different `sessionId`.
5. With the Issue 416 echo server as the provider, both requests from steps 1
   and 2 print the same `X-Session-Id`.
