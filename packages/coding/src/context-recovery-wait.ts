import { ContextCapacityError } from '@kodax-ai/agent';
import { KodaXContextOverflowError, type KodaXMessage } from '@kodax-ai/llm';
import type { KodaXEvents } from './types.js';

/** Suspend only at the next-generation boundary, after exact history is durable. */
export async function waitForContextRecovery(
  error: unknown, messages: readonly KodaXMessage[], events: KodaXEvents | undefined,
  signal?: AbortSignal,
  configurationRevision?: number,
): Promise<boolean> {
  if (!(error instanceof ContextCapacityError || error instanceof KodaXContextOverflowError)
    || !events?.onContextCapacityBlocked) return false;
  signal?.throwIfAborted();
  await events.onCompactedMessages?.([...messages], { preCompactionMessages: messages });
  signal?.throwIfAborted();
  await events.onContextCapacityBlocked({
    ...(error instanceof ContextCapacityError
      ? { requiredTokens: error.requiredTokens, availableTokens: error.availableTokens } : {}),
    ...(configurationRevision !== undefined ? { configurationRevision } : {}),
  }, signal);
  signal?.throwIfAborted();
  return true;
}
