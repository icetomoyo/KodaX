/**
 * KodaX Session
 *
 * 会话管理 - Session ID 生成和消息处理
 */

import { KodaXMessage } from './types.js';

/**
 * 生成会话 ID
 */
export async function generateSessionId(): Promise<string> {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
}

/**
 * 从消息中提取标题
 */
export function extractTitleFromMessages(messages: KodaXMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const content = typeof firstUser.content === 'string'
      ? firstUser.content
      : '';
    return content.slice(0, 50) + (content.length > 50 ? '...' : '');
  }
  return 'Untitled Session';
}
