/**
 * KodaX AI Constants
 *
 * AI 层常量配置 - Provider 模块共享的常量
 */

// ============== Token 限制 ==============

export const KODAX_MAX_TOKENS = 32768;

/**
 * Capped default output token budget for long-output-prone providers
 * (e.g. zhipu-coding). Providers using this value request a modest budget
 * on every turn so generation finishes well under server-side kill
 * windows (Zhipu reportedly terminates streams around 8 minutes). If
 * the model hits `stop_reason: max_tokens` at this cap, the agent loop
 * escalates the same turn once to `KODAX_ESCALATED_MAX_OUTPUT_TOKENS`
 * (see `coding/src/agent.ts` max_tokens handler).
 */
export const KODAX_CAPPED_MAX_OUTPUT_TOKENS = 32000;

/**
 * One-shot escalated budget used by the agent loop when a capped turn
 * returns `stop_reason: max_tokens`. The next stream call in the same
 * logical turn is issued with this value. Set once per turn via the
 * provider's public `setMaxOutputTokensOverride`; auto-cleared on the
 * next successful response in `base.ts withRateLimit`.
 */
export const KODAX_ESCALATED_MAX_OUTPUT_TOKENS = 64000;

// ============== API 速率控制 ==============

export const KODAX_API_MIN_INTERVAL = 0.5;
