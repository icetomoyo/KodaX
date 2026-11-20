/**
 * ../index.js Session
 *
 * 会话管理 - Session ID 生成和消息处理
 */

import { randomBytes } from 'node:crypto';
import type { KodaXMessage } from '@kodax-ai/llm';

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
 * New session id: an RFC 9562 UUIDv7 (48-bit Unix ms timestamp + 74 random bits).
 *
 * The id is sent to providers as `X-Session-Id`, so it carries no local
 * date or time zone; it still sorts by creation and stays globally unique
 * across project folders (ADR-038 §7). Ids created before this format
 * (`YYYYMMDD_HHMMSS_<suffix>`) remain valid for resume and lookup.
 */
export function generateSessionIdSync(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Preserve the established async public API for existing consumers. */
export async function generateSessionId(): Promise<string> {
  return generateSessionIdSync();
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
