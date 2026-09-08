import { firstActiveRunId, type InkClientPlane } from '@kodax-ai/repl';
import type { KodaXRuntime } from './sdk-runtime.js';

/** The production binding shared by Ink and its runtime integration tests. */
export function createCliClientPlane(runtime: KodaXRuntime): InkClientPlane {
  return {
    updateSettings: (sessionId, patch) => runtime.sessions.updateSettings(sessionId, patch).then(() => undefined),
    submit: input => runtime.runs.acceptInput(input),
    readInput: (sessionId, inputId) => runtime.runs.getInput(sessionId, inputId),
    withdraw: (sessionId, inputId) => runtime.runs.withdrawInput(sessionId, inputId).then(result => result.text),
    awaitRun: async (_sessionId, runId) => {
      const outcome = await runtime.runs.await(runId);
      return {
        phase: outcome.phase,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error.message } : {}),
      };
    },
    stop: runId => runtime.runs.abort(runId),
    activeRun: sessionId => runtime.runs.list({ sessionId }).then(firstActiveRunId),
    observe: (sessionId, listener) => runtime.sessions.observeView(sessionId, listener)
      .then(observation => () => observation.close()),
    readItem: (sessionId, itemId, options) => runtime.sessions.readViewItem(
      sessionId, itemId, typeof options === 'number' ? { offset: options } : options,
    ),
    readHistory: (sessionId, options) => runtime.sessions.readHistory(sessionId, options),
    readHistoryEntry: (sessionId, itemId, options) => runtime.sessions.readHistoryEntry(sessionId, itemId, options),
    respondInteraction: (requestId, response) => runtime.interactions.respond(requestId, response)
      .then(result => result.accepted),
  };
}
