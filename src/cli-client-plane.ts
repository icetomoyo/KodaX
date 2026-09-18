import { firstActiveRunId, type CommandCallbacks, type InkClientPlane, type SessionCommandBinding } from '@kodax-ai/repl';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';

/** CLI command adapters use the same product contract as external clients. */
export function createCliSessionCommands(client: KodaXProductClient): SessionCommandBinding {
  return {
    list: filter => client.sessions.list(filter),
    delete: sessionId => client.sessions.delete(sessionId),
    deleteAll: async ({ gitRoot }) => {
      const sessions = await client.sessions.list({
        ...(gitRoot !== undefined ? { projectRoot: gitRoot } : {}), limit: Number.MAX_SAFE_INTEGER,
      });
      for (const session of sessions) await client.sessions.delete(session.id);
    },
    setActiveEntry: async input => {
      await client.sessions.selectBranch(input.sessionId, input.selector,
        input.summarizeCurrentBranch === undefined ? undefined : { summarizeCurrentBranch: input.summarizeCurrentBranch });
      return true;
    },
    setLabel: async ({ sessionId, ...input }) => {
      await client.sessions.labelEntry(sessionId, input);
      return true;
    },
    fork: ({ sessionId, ...input }) => client.sessions.forkSession(sessionId, input).then(result => result.id),
    rewind: async ({ sessionId, ...input }) => {
      const expectedHead = input.expectedHead !== undefined ? input.expectedHead
        : (await client.sessions.readLineage(sessionId))?.activeEntryId ?? null;
      await client.sessions.rewindSession(sessionId, { ...input, expectedHead });
      return true;
    },
    recover: ({ sessionId, ...input }) => client.sessions.recoverSession(sessionId, input).then(result => result.id),
    create: input => client.sessions.create(input).then(() => undefined),
  };
}

/** Keep the REPL's existing workflow presentation shape without executing anything locally. */
export function createCliWorkflowControl(client: KodaXProductClient): NonNullable<CommandCallbacks['workflows']> {
  return {
    start: input => client.workflows.start(input),
    list: async () => (await client.workflows.list()).map(run => ({
      runId: run.runId, workflow: run.workflowName, status: run.status,
      totalSpawned: run.totalSpawned, eventCount: run.eventCount, runDir: run.runDir,
      startedAt: Date.parse(run.startedAt),
      ...(run.endedAt !== undefined ? { endedAt: Date.parse(run.endedAt) } : {}),
      ...(run.resultSummary !== undefined ? { resultText: run.resultSummary } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    })),
    get: runId => client.workflows.get(runId),
    subscribe: (filter, listener) => client.workflows.subscribe(filter, listener),
    pause: runId => client.workflows.pause(runId),
    resume: runId => client.workflows.resume(runId),
    stop: (runId, options) => client.workflows.stop(runId, options),
  };
}

/** The production binding shared by Ink and its product integration tests. */
export function createCliClientPlane(client: KodaXProductClient): InkClientPlane {
  return {
    updateSettings: (sessionId, patch) => client.sessions.updateSettings(sessionId, patch).then(() => undefined),
    executeTool: input => client.runs.startTool(input),
    cancelSession: input => client.sessions.cancel(input),
    submit: input => client.inputs.submit(input),
    readInput: (sessionId, inputId) => client.inputs.read(sessionId, inputId),
    withdraw: (sessionId, inputId) => client.inputs.withdraw(sessionId, inputId),
    awaitRun: (_sessionId, runId) => client.runs.await(runId),
    stop: runId => client.runs.stop(runId),
    activeRun: async sessionId => {
      let runId: string | undefined;
      const observation = await client.sessions.observe(sessionId, view => { runId = firstActiveRunId(view.runs); });
      try { return runId; }
      finally { observation.close(); }
    },
    observe: (sessionId, listener, options) => client.sessions.observe(sessionId, listener, options)
      .then(observation => () => observation.close()),
    readItem: (sessionId, itemId, options) => client.sessions.readItem(
      sessionId, itemId, typeof options === 'number' ? { offset: options } : options,
    ),
    readHistory: (sessionId, options) => client.sessions.readHistory(sessionId, options),
    readHistoryEntry: (sessionId, itemId, options) => client.sessions.readHistoryEntry(sessionId, itemId, options),
    respondInteraction: (requestId, response) => client.interactions.respond(requestId, response)
      .then(result => result.accepted),
  };
}
