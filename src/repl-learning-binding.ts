import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { LearningBinding } from '@kodax-ai/repl';

import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';

export function createReplLearningBinding(client: Pick<KodaXProductClient, 'learning'>): LearningBinding {
  return {
    getSnapshot: () => client.learning.getSnapshot(),
    list: (query) => client.learning.list(query),
    get: (nameOrSlug) => client.learning.get(nameOrSlug),
    subscribe(listener, options, onError) {
      const stream = client.learning.subscribe(options);
      const iterator = stream[Symbol.asyncIterator]();
      let active = true;
      void consumeLearningEvents(iterator, () => active, listener, onError);
      return {
        ready: stream.ready,
        close() {
          active = false;
          void iterator.return?.().catch((error: unknown) => {
            emitKodaXDiagnostic({ source: 'runtime:learning-binding', level: 'warn',
              message: 'Failed to close Learning Center observation.',
              detail: error instanceof Error ? error.message : String(error) });
          });
        },
      };
    },
    acknowledge: (nameOrSlug) => client.learning.acknowledge(nameOrSlug),
    snooze: (nameOrSlug, until) => client.learning.snooze(nameOrSlug, until),
    reject: (nameOrSlug) => client.learning.reject(nameOrSlug),
    disable: (nameOrSlug) => client.learning.disable(nameOrSlug),
    rollback: (nameOrSlug) => client.learning.rollback(nameOrSlug),
    promote: (nameOrSlug, scope) => client.learning.promote(nameOrSlug, scope),
    review: (nameOrSlug) => client.learning.review(nameOrSlug),
    trust: (nameOrSlug) => client.learning.trust(nameOrSlug),
  };
}

async function consumeLearningEvents(
  iterator: AsyncIterator<Awaited<ReturnType<KodaXProductClient['learning']['events']>>[number]>,
  isActive: () => boolean,
  listener: Parameters<LearningBinding['subscribe']>[0],
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    while (isActive()) {
      const next = await iterator.next();
      if (next.done || !isActive()) return;
      listener(next.value);
    }
  } catch (error: unknown) {
    if (!isActive()) return;
    emitKodaXDiagnostic({
      source: 'runtime:learning-binding',
      level: 'warn',
      message: 'Learning Center event subscription stopped.',
      detail: error instanceof Error ? error.message : String(error),
    });
    onError?.(error);
  }
}
