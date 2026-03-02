/**
 * KodaX Core Constants
 *
 * 常量配置 - 重新导出 @kodax/agent 常量 + Coding 特定常量
 */

// ============== Re-export from @kodax/agent ==============

export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_COMPACT_THRESHOLD,
  KODAX_COMPACT_KEEP_RECENT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from '@kodax/agent';

// ============== Coding-specific: 长运行任务状态文件 ==============

export const KODAX_FEATURES_FILE = 'feature_list.json';
export const KODAX_PROGRESS_FILE = 'PROGRESS.md';

// ============== Coding-specific: 工具必需参数 ==============
// 这个常量是 Coding Agent 特定的，不放在通用 agent 包中

export const KODAX_TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'old_string', 'new_string'],
  bash: ['command'],
  glob: ['pattern'],
  grep: ['pattern', 'path'],
  undo: [],
};
