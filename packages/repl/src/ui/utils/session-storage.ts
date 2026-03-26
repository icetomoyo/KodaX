/**
 * Session Storage - Session storage abstraction layer
 *
 * Provides a shared persistence interface across memory and filesystem storage.
 */

import type {
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionNavigationOptions,
  SessionErrorMetadata,
} from "@kodax/coding";
import {
  appendSessionLineageLabel,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  generateSessionId as generateCoreSessionId,
  getSessionMessagesFromLineage,
  setSessionLineageActiveEntry,
} from "@kodax/coding";

// Re-export SessionErrorMetadata for backward compatibility
export type { SessionErrorMetadata } from "@kodax/coding";

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
  setActiveEntry?(
    id: string,
    selector: string,
    options?: KodaXSessionNavigationOptions,
  ): Promise<SessionData | null>;
  setLabel?(id: string, selector: string, label?: string): Promise<SessionData | null>;
  fork?(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null>;
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
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
      extensionState: data.extensionState ?? existing?.extensionState,
      extensionRecords: data.extensionRecords ?? existing?.extensionRecords,
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
      extensionState: current.extensionState
        ? structuredClone(current.extensionState)
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

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      title: data.title,
      msgCount: data.lineage
        ? countActiveLineageMessages(data.lineage)
        : data.messages.length,
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
