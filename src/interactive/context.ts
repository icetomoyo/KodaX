/**
 * KodaX 交互式上下文管理
 */

import { KodaXMessage } from '../core/index.js';

// 交互模式
export type InteractiveMode = 'code' | 'ask';

// 交互式会话上下文
export interface InteractiveContext {
  messages: KodaXMessage[];
  sessionId: string;
  title: string;
  gitRoot?: string;
  createdAt: string;
  lastAccessed: string;
  // 注意：mode 已移至 CurrentConfig 管理，避免状态分散
}

// 创建交互式上下文
export async function createInteractiveContext(options: {
  sessionId?: string;
  gitRoot?: string;
  existingMessages?: KodaXMessage[];
}): Promise<InteractiveContext> {
  return {
    messages: options.existingMessages ?? [],
    sessionId: options.sessionId ?? generateSessionId(),
    title: '',
    gitRoot: options.gitRoot,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  };
}

// 生成会话 ID
function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0]!.replace(/-/g, '');
  const time = now.toTimeString().split(' ')[0]!.replace(/:/g, '');
  return `${date}_${time}`;
}

// 更新上下文访问时间
export function touchContext(context: InteractiveContext): void {
  context.lastAccessed = new Date().toISOString();
}
