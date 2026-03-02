/**
 * @kodax/agent Constants
 *
 * 通用 Agent 常量配置
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
