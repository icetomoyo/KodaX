# Runner iteration telemetry and terminal outcome

The managed Root retains its existing 500-iteration protection threshold;
native Actor children retain 200. Each counter belongs to one executor invocation.
A max value of 0 denotes no finite iteration cap. Consumers must use runtime values.

Public additive fields:
- RuntimeSessionLiveProjection.iterationsByRun[runId]: { current, max }.
- AgentTurn / AgentTurnSummary / AgentOutput: optional iteration and terminationReason.
- AgentProgressUpdate / AgentProgressItem: optional iteration.
- AgentExecutionResult: optional iteration and terminationReason: 'iteration_limit'.

Exhaustion is a failed Actor turn, not successful completion. The last permitted
iteration may finish its tools; no further iteration, output-repair request or
workflow digest is started. Partial output/artifacts/structured data are retained,
and the parent notification includes iteration_limit. A follow-up is explicit
and starts a new turn; there is no automatic retry loop. Reaching the numerical
limit while completing normally does not mark the turn failed.

Automated regression commands (from repository root):

    npx vitest run packages/agent/src/actors/controller.test.ts packages/coding/src/child-executor.test.ts packages/coding/src/agent-runtime/actor-runtime.test.ts
    npx vitest run src/sdk-runtime.test.ts -t "projects root iterations|keeps active live projection complete"
    npm run typecheck
    npm run build:packages
    npm run build:bundle
    npm run build:dts

Coverage includes progress before tool use, bounded progress batches, persisted
Actor restoration, partial results on exhaustion, parent notifications, a fresh
follow-up, actual iteration counts excluding inherited history, successful final
iteration, Root/child isolation and Runtime snapshot re-observation.

After SDK publication, update Space dependency and restart its daemon before
following the Space rc.6 Runner regression guide. Publication is a maintainer step.
