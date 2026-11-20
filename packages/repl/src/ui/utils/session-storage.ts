/**
 * Session Storage - Session storage abstraction layer
 *
 * Provides a shared persistence interface across memory and filesystem storage.
 */

import type {
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionNavigationOptions,
  KodaXSessionRuntimeInfo,
  SessionErrorMetadata,
} from "@kodax-ai/agent";
import {
  appendSessionLineageLabel,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  findPreviousUserEntryId,
  generateSessionId as generateCoreSessionId,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from "@kodax-ai/agent";

// Re-export SessionErrorMetadata for backward compatibility
export type { SessionErrorMetadata } from "@kodax-ai/agent";

/**
 * Session data structure.
 */
export type SessionData = KodaXSessionData;

/**
 * Session storage interface.
 */
export interface SessionStorage {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  getLineage?(id: string): Promise<KodaXSessionLineage | null>;
  loadFullLineage?(id: string): Promise<KodaXSessionLineage | null>;
  setActiveEntry?(
    id: string,
    selector: string,
    options?: KodaXSessionNavigationOptions,
  ): Promise<SessionData | null>;
  setLabel?(id: string, selector: string, label?: string): Promise<SessionData | null>;
  rewind?(id: string, selector?: string): Promise<SessionData | null>;
  fork?(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null>;
  list(gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionRuntimeInfo;
    createdAt?: string;
    lastMessageAt?: string;
  }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}

/**
 * In-memory session storage implementation.
 */
export class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, SessionData>();

  async save(id: string, data: SessionData): Promise<void> {
    const existing = this.sessions.get(id);
    this.sessions.set(id, {
      ...structuredClone(data),
      scope: data.scope ?? existing?.scope ?? 'user',
      uiHistory: data.uiHistory ?? existing?.uiHistory,
      extensionState: data.extensionState ?? existing?.extensionState,
      artifactLedger: data.artifactLedger ?? existing?.artifactLedger,
      actorSnapshot: data.actorSnapshot ?? existing?.actorSnapshot,
      extensionRecords: data.extensionRecords ?? existing?.extensionRecords,
      tag: data.tag ?? existing?.tag,
      lineage: createSessionLineage(
        data.messages,
        data.lineage ?? existing?.lineage,
      ),
    });
  }

  async load(id: string): Promise<SessionData | null> {
    return structuredClone(this.sessions.get(id) ?? null);
  }

  async getLineage(id: string): Promise<KodaXSessionLineage | null> {
    return structuredClone(this.sessions.get(id)?.lineage ?? null);
  }

  async loadFullLineage(id: string): Promise<KodaXSessionLineage | null> {
    return this.getLineage(id);
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: KodaXSessionNavigationOptions,
  ): Promise<SessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.lineage) {
      return null;
    }

    const lineage = setSessionLineageActiveEntry(current.lineage, selector, options);
    if (!lineage) {
      return null;
    }

    const next: SessionData = {
      ...structuredClone(current),
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, next);
    return structuredClone(next);
  }

  async setLabel(id: string, selector: string, label?: string): Promise<SessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.lineage) {
      return null;
    }

    const lineage = appendSessionLineageLabel(current.lineage, selector, label);
    if (!lineage) {
      return null;
    }

    const next: SessionData = {
      ...structuredClone(current),
      lineage,
    };
    this.sessions.set(id, next);
    return structuredClone(next);
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null> {
    const current = this.sessions.get(id);
    if (!current?.lineage) {
      return null;
    }

    const lineage = forkSessionLineage(current.lineage, selector);
    if (!lineage) {
      return null;
    }

    const sessionId = options?.sessionId ?? await generateCoreSessionId();
    const data: SessionData = {
      messages: getSessionMessagesFromLineage(lineage),
      title: options?.title ?? current.title,
      gitRoot: current.gitRoot,
      tag: current.tag,
      uiHistory: current.uiHistory
        ? current.uiHistory.map((item) => ({ ...item }))
        : undefined,
      extensionState: current.extensionState
        ? structuredClone(current.extensionState)
        : undefined,
      artifactLedger: current.artifactLedger
        ? structuredClone(current.artifactLedger)
        : undefined,
      extensionRecords: current.extensionRecords
        ? structuredClone(current.extensionRecords)
        : undefined,
      lineage,
    };
    this.sessions.set(sessionId, data);
    return {
      sessionId,
      data: structuredClone(data),
    };
  }

  async rewind(id: string, selector?: string): Promise<SessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.lineage) {
      return null;
    }

    const targetId = selector ?? findPreviousUserEntryId(current.lineage);
    if (!targetId) return null;

    const lineage = rewindSessionLineage(current.lineage, targetId);
    if (!lineage) {
      return null;
    }

    const data: SessionData = {
      ...current,
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, data);
    return structuredClone(data);
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number; tag?: string }>> {
    return Array.from(this.sessions.entries())
      .filter(([, data]) => (data.scope ?? 'user') === 'user')
      .map(([id, data]) => ({
        id,
        title: data.title,
        msgCount: data.lineage
          ? countActiveLineageMessages(data.lineage)
          : data.messages.length,
        ...(data.tag !== undefined ? { tag: data.tag } : {}),
      }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(_gitRoot?: string): Promise<void> {
    this.sessions.clear();
  }
}

export function createMemorySessionStorage(): SessionStorage {
  return new MemorySessionStorage();
}
