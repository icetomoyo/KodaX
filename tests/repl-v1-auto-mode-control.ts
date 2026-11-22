/**
 * The REPL's auto-mode settings sync over the v1 product Client. The REPL now
 * runs on v2; this stays as a v1 test driver until v1 is removed.
 */
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import type { ReplRuntimeAutoModeControl } from '@kodax-ai/repl';

export function createReplRuntimeAutoModeControl(
  client: KodaXProductClient,
): ReplRuntimeAutoModeControl {
  const pendingSettingsUpdates = new Map<string, Promise<unknown>>();
  const enqueueSettingsUpdate = <T>(
    sessionId: string,
    update: () => Promise<T>,
  ): Promise<T> => {
    const previous = pendingSettingsUpdates.get(sessionId) ?? Promise.resolve();
    const next = previous.then(update, update);
    let tracked: Promise<T>;
    tracked = next.finally(() => {
      if (pendingSettingsUpdates.get(sessionId) === tracked) {
        pendingSettingsUpdates.delete(sessionId);
      }
    });
    pendingSettingsUpdates.set(sessionId, tracked);
    return tracked;
  };
  return {
    async syncSettings(sessionId, permissionMode, settings) {
      return enqueueSettingsUpdate(sessionId, async () => {
        try {
          await client.sessions.read(sessionId);
        } catch (error: unknown) {
          if (
            error instanceof Error &&
            error.message.startsWith('Session not found:')
          ) {
            return;
          }
          throw error;
        }
        await client.sessions.updateSettings(sessionId, {
          permissionMode,
          autoModeClassifierModel: settings.classifierModel ?? null,
        });
      });
    },
  };
}
