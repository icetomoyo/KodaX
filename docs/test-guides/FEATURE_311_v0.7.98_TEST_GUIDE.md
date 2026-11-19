# FEATURE_311 — Unified Prompt Chain

Date: 2026-11-20. Status: implemented on the local `KodaX` branch, unreleased.
[Design block](../features/v0.7.98.md#feature_311-unified-prompt-chain),
[ADR entry](../ADR.md#every-root-run-uses-one-worker-and-one-tool-text--2026-11-19-unreleased),
[migration](../SDK_MIGRATION.md#统一提示词链路未发布).

Every root Run uses the managed Worker, and every entry sends one tool text. This guide checks that
from the outside. Run all commands from the repository root after `npm run build:packages`.

## 1. Offline acceptance

| Check | Command | Expected |
|---|---|---|
| Entry matrix | `npx vitest run tests/f311-entry-matrix.test.ts` | 2 passed. Every root entry sends the Worker closing line and no `system.md` text; both child kinds are captured; the retired sources do not exist |
| Prompt snapshots | `npx vitest run packages/coding/src/prompts/rendered-prompts.test.ts tests/prompt-text.test.ts` | Pass; `static-text.json` matches the `.md` sources |
| Skill catalog on both modes | `npx vitest run tests/runtime-skill-catalog.test.ts` | Pass; the override root starts with the caller text and still carries `## Environment` |
| First-turn wire inventory | `npx vitest run tests/first-turn-wire-inventory.test.ts` | Pass |
| Type checks | `npx tsc -p tsconfig.check.json`, `npx tsc -p tsconfig.test.json`, `npx tsc -p packages/coding --noEmit` | No errors |

The entry matrix covers `runManagedTask` (default and `ama`), `runKodaX`, `startKodaX` (default and
`ama`), `KodaXClient`, `createKodaXTaskRunner` with `runOrchestration`, the Runner preset,
`authorWorkflowViaWorker`, persona, override and tool-visibility roots, Runtime `runs.start` with no
mode, `'coding'` and `'managed_task'`, and a write and a read-only child. If it fails, the message
names the entry; check whether that entry still calls the leaf executor (`runLeafAgent`).

## 2. Manual SDK check

Use any configured provider. In a scratch directory:

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
const result = await runKodaX({ provider: '<provider>', maxIter: 2, reasoningMode: 'off' }, 'Say ready.');
console.log(result.success, result.limitReached);
```

1. Record the first request with a provider registered through `registerModelProvider`, as
   `tests/f311-entry-matrix.test.ts` does. The system prompt does not contain "You are KodaX, a
   helpful multi-provider coding agent". It contains "Preserve any exact machine-readable closing
   contract" from the Worker termination section.
2. The first user message is the `=== Managed Run Context ===` envelope, followed by the task.
3. With `maxIter: 1` and a task that needs tools, the result is `success: true` with `limitReached: true`.
4. Abort the Run through `abortSignal`; the promise rejects with an `AbortError`.
5. Start a Runtime Run with `runs.start({ sessionId, mode: 'coding', prompt })`. A
   `runtime.runs.start` warning diagnostic appears and `runs.read(runId).mode` is `managed_task`.

## 3. Paid eval record

| Step | Harness | Calls | Cost | Result |
|---|---|---|---|---|
| 1 — one tool text | `tests/f311-unified-tool-text.eval.ts` | 48 | $0.062 | persona 2 candidate / 2 baseline / 1 mixed / 13 tie; ordinary root 2 / 0 / 0 / 4 |
| 2 — one Worker on persona and override roots | `tests/f311-worker-root.eval.ts` | 72 | $0.088 | persona 3 / 2 / 1 / 12; override 2 / 2 / 0 / 14; input per call −28% and −34% |
| 3 — SDK default root, direct engine vs managed Worker | `tests/f311-sdk-default-root.eval.ts` | 48 | $0.067 | 4 baseline / 1 candidate / 1 mixed / 18 tie; losing cells did not reproduce on re-sampling (provider noise); input per call −5.8% |

All three are L2 single-turn blind pairs on `glm-5.3-flash`, `kimi-for-coding` and `deepseek-flash`
with production request bytes from the real Runtime, reviewed blind in the main session. They measure
the next action at a checkpoint, not whole-task quality. To repeat step 3, capture both trees with
`KODAX_MANAGED_CAPTURE_ENTRY=sdk-default KODAX_MANAGED_CAPTURE_CATALOG=builtin` through
`tests/managed-first-turn.capture.ts`, then run the harness `prepare`, `run --phase pilot`,
`review`, `run --phase remaining`, `review --phase final` and `reveal`.
