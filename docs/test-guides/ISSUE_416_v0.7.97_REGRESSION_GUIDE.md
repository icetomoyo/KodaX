# Issues 416-417: provider session header and session ids

Repaired 2026-11-17 after v0.7.97-beta.11 (unreleased). Decision: ADR-077.
Design: HLD §4 and DD (`promptCacheKey` / `X-Session-Id`).

## Contract

- Every provider HTTP request sends `X-Session-Id` with the root session id.
  Child agents, workflows, `/compact`, memory review and the capability probe
  use the root conversation's id.
- A configured `X-Session-Id` request header wins. An id that is not visible
  ASCII of 1-128 characters is left out.
- New session ids are UUIDv7. Legacy `YYYYMMDD_HHMMSS_<suffix>` sessions still
  list, load and resume.
- REPL `/clear` on a non-empty conversation saves it and continues under a new
  id. It prints `/resume <previous id>`. An empty conversation keeps its id.
- Host `create` / `fork` reject a new id outside `[A-Za-z0-9_-]{1,128}`, a
  Windows device name, or an `archived-` prefix with `invalid_params`.

## Automated checks

Run from the repository root after `npm run build:packages` and
`npm run build:native`:

```powershell
npx vitest run packages/llm/src/providers/session-header.test.ts packages/coding/src/session-header.wire.test.ts packages/coding/src/run-scoped-config.test.ts
npx vitest run packages/agent/src/session-lineage/session.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-044-session-id.contract.test.ts packages/coding/src/session-scratch.test.ts
npx vitest run packages/repl/src/interactive/compaction-command.test.ts packages/repl/src/commands/new-command.test.ts packages/repl/src/common/capability-probe.test.ts packages/repl/src/ui/SessionPicker.test.tsx packages/repl/src/session/recovery.test.ts
npx vitest run src/sdk-runtime.session-id.test.ts src/runtime-daemon/server.test.ts src/sdk-runtime.test.ts tests/interactive.test.ts tests/kodax_core.test.ts
npm run typecheck
```

## Manual acceptance

Use a throwaway home so real data is never at risk:
`$env:KODAX_HOME = "$env:TEMP\kodax-416"`.

1. Save this as `header-echo.mjs` and run `node header-echo.mjs`. It answers
   like an OpenAI-compatible endpoint and prints each request's
   `X-Session-Id`.

   ```js
   import http from 'node:http';
   const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'echo', object: 'chat.completion.chunk', model: 'echo',
     choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }], ...(extra.usage ? { usage: extra.usage } : {}) })}\n\n`;
   http.createServer((req, res) => {
     req.resume();
     req.on('end', () => {
       console.log(req.method, req.url, 'x-session-id =', req.headers['x-session-id']);
       res.writeHead(200, { 'content-type': 'text/event-stream' });
       res.end(chunk({ role: 'assistant', content: 'ok' })
         + chunk({}, { finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
         + 'data: [DONE]\n\n');
     });
   }).listen(8416, () => console.log('listening on 8416'));
   ```

2. Write `$env:KODAX_HOME\config.json`, and set `$env:ECHO_KEY = "x"`:

   ```json
   {
     "provider": "echo",
     "customProviders": [{ "name": "echo", "protocol": "openai",
       "baseUrl": "http://127.0.0.1:8416/v1", "apiKeyEnv": "ECHO_KEY", "model": "echo" }]
   }
   ```

3. Run `kodax -p "say ok"`. The echo server prints a UUIDv7
   (`xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`). `kodax -s list` shows the
   same id with a time column.
4. Run `kodax -r <that id> -p "again"`. The server prints the same id.
5. Start `kodax`, send one message, then run `/clear`. The REPL prints
   `Previous conversation: /resume <old id>`. Send another message: the
   server prints a different id. `/resume <old id>` restores the first
   conversation.
6. Start `kodax` and run `/clear` before sending anything. The REPL prints
   no `Previous conversation` line.
7. Through the SDK, `runtime.sessions.create({ sessionId: '../escape' })`
   fails with `invalid_params`, and no file appears outside
   `$env:KODAX_HOME\sessions`.
