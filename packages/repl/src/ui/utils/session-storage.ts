/**
 * Session Storage - 会话存储抽象层
 *
 * 提供会话持久化接口，支持内存和文件系统存储
 * 从 InkREPL.tsx 提取以改善代码组织
 */

import type { KodaXMessage } from "@kodax/core";

/**
 * 会话数据结构
 */
export interface SessionData {
  messages: KodaXMessage[];
  title: string;
  gitRoot: string;
}

/**
 * 会话存储接口
 */
export interface SessionStorage {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(): Promise<void>;
}

/**
 * 内存会话存储实现
 *
 * 用于开发和测试，会话数据保存在内存中
 * 进程退出后数据丢失
 */
export class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, SessionData>();

  async save(id: string, data: SessionData): Promise<void> {
    this.sessions.set(id, data);
  }

  async load(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      title: data.title,
      msgCount: data.messages.length,
    }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(): Promise<void> {
    this.sessions.clear();
  }
}

/**
 * 创建默认的内存会话存储
 */
export function createMemorySessionStorage(): SessionStorage {
  return new MemorySessionStorage();
}
