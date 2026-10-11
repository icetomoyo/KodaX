import {
  appendGoalEntry,
  createSessionLineage,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import { buildGoalRuntimeBinding, type GoalRuntimeBinding } from './runtime-wiring.js';

/** Bind a Run to its Host-owned journal without replacing transcript or UI state. */
export async function buildSessionGoalRuntimeBinding(input: {
  readonly storage: Pick<KodaXSessionStorage, 'load' | 'mutateLineage'>;
  readonly sessionId: string;
  readonly hasPendingUserInput: () => boolean;
  readonly getPermissionMode: () => string | undefined;
  readonly assertWritable: () => void;
}): Promise<GoalRuntimeBinding | undefined> {
  const mutateLineage = input.storage.mutateLineage;
  if (!mutateLineage) return undefined;
  const initial = await input.storage.load(input.sessionId);
  if (!initial) throw new Error('Session unavailable while binding goal tools.');
  let lineage = initial.lineage ?? createSessionLineage(initial.messages);
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    // Continue the queue after a failed operation; its own promise still rejects to the caller.
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const refresh = async (): Promise<void> => {
    const current = await input.storage.load(input.sessionId);
    if (!current) throw new Error('Session unavailable while reading goal state.');
    lineage = current.lineage ?? createSessionLineage(current.messages);
  };
  const binding = buildGoalRuntimeBinding({
    getLineage: () => lineage,
    persistGoal: async (goal, event) => {
      input.assertWritable();
      let committed = lineage;
      const found = await mutateLineage.call(input.storage, input.sessionId, current => {
        input.assertWritable();
        const next = appendGoalEntry(current, goal, event);
        committed = next;
        return next;
      });
      if (!found) throw new Error('Session unavailable while persisting goal state.');
      lineage = committed;
    },
    getLatestUsage: () => undefined,
    getTurnStartMs: () => undefined,
    hasPendingUserInput: input.hasPendingUserInput,
    getPermissionMode: input.getPermissionMode,
  });
  return {
    refresh,
    lifecycleCtx: binding.lifecycleCtx,
    goalContext: {
      readGoal: () => exclusive(async () => { await refresh(); return binding.goalContext.readGoal(); }),
      createGoal: goal => exclusive(async () => { await refresh(); return binding.goalContext.createGoal(goal); }),
      requestComplete: () => exclusive(async () => { await refresh(); return binding.goalContext.requestComplete(); }),
      requestBlocked: kind => exclusive(async () => { await refresh(); return binding.goalContext.requestBlocked(kind); }),
    },
  };
}
