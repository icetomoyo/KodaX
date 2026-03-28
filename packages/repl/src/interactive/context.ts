/**
 * KodaX Interactive Context Management - 交互式上下文管理
 */

import type {
  KodaXContextTokenSnapshot,
  KodaXMessage,
  KodaXSessionUiHistoryItem,
} from '@kodax/coding';

// Interactive mode - 交互模式
export type InteractiveMode = 'code' | 'ask';

// Interactive session context - 交互式会话上下文
export interface InteractiveContext {
  messages: KodaXMessage[];
  uiHistory?: KodaXSessionUiHistoryItem[];
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  sessionId: string;
  title: string;
  gitRoot?: string;
  createdAt: string;
  lastAccessed: string;
  // Note: mode moved to CurrentConfig to avoid scattered state - 注意：mode 已移至 CurrentConfig 管理，避免状态分散
}

// Create interactive context - 创建交互式上下文
export async function createInteractiveContext(options: {
  sessionId?: string;
  gitRoot?: string;
  existingMessages?: KodaXMessage[];
  existingUiHistory?: KodaXSessionUiHistoryItem[];
}): Promise<InteractiveContext> {
  return {
    messages: options.existingMessages ?? [],
    uiHistory: options.existingUiHistory?.map((item) => ({ ...item })),
    sessionId: options.sessionId ?? generateSessionId(),
    title: '',
    gitRoot: options.gitRoot,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  };
}

// Generate session ID - 生成会话 ID
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0]!.replace(/-/g, '');
  const time = now.toTimeString().split(' ')[0]!.replace(/:/g, '');
  return `${date}_${time}`;
}

// Update context access time - 更新上下文访问时间
export function touchContext(context: InteractiveContext): void {
  context.lastAccessed = new Date().toISOString();
}
