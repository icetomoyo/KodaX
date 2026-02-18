/**
 * KodaX Core Constants
 *
 * 常量配置 - 所有核心模块共享的常量
 */

// ============== Token 和迭代限制 ==============

export const KODAX_MAX_TOKENS = 32768;
export const KODAX_DEFAULT_TIMEOUT = 60;
export const KODAX_HARD_TIMEOUT = 300;
export const KODAX_COMPACT_THRESHOLD = 100000;
export const KODAX_COMPACT_KEEP_RECENT = 10;

// ============== 重试配置 ==============

export const KODAX_MAX_RETRIES = 3;
export const KODAX_RETRY_BASE_DELAY = 2;
export const KODAX_MAX_INCOMPLETE_RETRIES = 2;

// ============== 并行 Agent 配置 ==============

export const KODAX_STAGGER_DELAY = 1.0;

// ============== API 速率控制 ==============

export const KODAX_API_MIN_INTERVAL = 0.5;

// ============== Promise 信号模式 ==============

export const PROMISE_PATTERN = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;

// ============== 长运行任务状态文件 ==============

export const KODAX_FEATURES_FILE = 'feature_list.json';
export const KODAX_PROGRESS_FILE = 'PROGRESS.md';

// ============== 工具必需参数 ==============

export const KODAX_TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'old_string', 'new_string'],
  bash: ['command'],
  glob: ['pattern'],
  grep: ['pattern', 'path'],
  undo: [],
};
