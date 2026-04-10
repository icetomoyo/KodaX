/**
 * KodaX Session
 *
 * 会话管理 - 重新导出 @kodax/agent 会话功能
 */

export {
  appendSessionLineageLabel,
  applySessionCompaction,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  generateSessionId,
  extractTitleFromMessages,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  setSessionLineageActiveEntry,
} from '@kodax/agent';
