/**
 * @kodax/agent Session
 *
 * 会话管理 - Session ID 生成和消息处理
 */

import type { KodaXMessage } from '@kodax/ai';

const DEFAULT_SESSION_TITLE = 'Untitled Session';
const SESSION_TITLE_MAX_LENGTH = 50;

function extractPlainText(content: KodaXMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block != null
        && typeof block === 'object'
        && 'type' in block
        && block.type === 'text'
        && 'text' in block
        && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join(' ');
}

function formatSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return DEFAULT_SESSION_TITLE;
  }

  return normalized.length > SESSION_TITLE_MAX_LENGTH
    ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH)}...`
    : normalized;
}

/**
 * 生成会话 ID
 * 格式: YYYYMMDD_HHMMSS
 */
export async function generateSessionId(): Promise<string> {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
}

/**
 * 从消息中提取标题
 * 取第一条用户消息的前50个字符
 */
export function extractTitleFromMessages(messages: KodaXMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    return formatSessionTitle(extractPlainText(firstUser.content));
  }
  return DEFAULT_SESSION_TITLE;
}
