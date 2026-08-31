import { isKodaXSessionUiHistoryItem } from '../interactive/json-guards.js';

const RESUMABLE_SESSION_SCAN_LIMIT = 1000;

export function countResumableSessionItems(
  activeMessageCount: number,
  uiHistory: unknown,
): number {
  const canonicalCount = Number.isInteger(activeMessageCount) && activeMessageCount >= 0
    ? activeMessageCount
    : 0;
  if (!Array.isArray(uiHistory)) return canonicalCount;
  const presentationOnlyCount = uiHistory.reduce((count, item) => {
    if (
      isKodaXSessionUiHistoryItem(item)
      && item.type !== 'tool_group'
      && item.presentationOnly === true
    ) {
      return count + 1;
    }
    return count;
  }, 0);
  return canonicalCount + presentationOnlyCount;
}

export async function findMostRecentResumableSession<
  T extends { readonly id: string; readonly msgCount: number },
>(
  storage: {
    list(
      gitRoot?: string,
      options?: { limit?: number },
    ): Promise<T[]>;
  },
  gitRoot?: string,
): Promise<T | undefined> {
  const sessions = await storage.list(gitRoot, {
    limit: RESUMABLE_SESSION_SCAN_LIMIT,
  });
  return sessions.find((session) => session.msgCount > 0);
}
