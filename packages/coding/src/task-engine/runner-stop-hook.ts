import type { StopHookFn } from '@kodax-ai/agent';
import { createExtensionTurnCompleteStopHook } from '../agent-runtime/middleware/extension-queue.js';

/** An idle yield with child work or undelivered results is not a completed turn. */
export function buildRunnerStopHook(options: {
  readonly getSessionId: () => string | undefined;
  readonly getCollaborationState: () => {
    readonly activeDescendantTurns: number;
    readonly hasPendingRootTaskNotifications: boolean;
  };
}): StopHookFn {
  const extensionHook = createExtensionTurnCompleteStopHook(options.getSessionId);
  return async context => {
    const state = options.getCollaborationState();
    if (state.activeDescendantTurns > 0 || state.hasPendingRootTaskNotifications) return undefined;
    return extensionHook(context);
  };
}
