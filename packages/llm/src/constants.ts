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
 * logical turn is issued with this value through request-scoped stream
 * options, so concurrent runs sharing a provider cannot affect each other.
 */
export const KODAX_ESCALATED_MAX_OUTPUT_TOKENS = 64000;

/**
 * Synthetic tool-result content injected by both provider families'
 * `repairToolCallHistory` when a replayed history carries a `tool_use` whose
 * result was never recorded (interrupted turn, session restored mid-run, or a
 * provider switch on a strict endpoint). Replaces the previous drop-the-call
 * behaviour: keeping the call and answering it with an explicit error keeps
 * the wire valid on strict endpoints (Anthropic, DeepSeek Anthropic-compat)
 * WITHOUT silently rewriting what the model issued. Wording mirrors the
 * incomplete-tool retry precedent in `coding/src/agent-runtime`.
 */
export const KODAX_INTERRUPTED_TOOL_RESULT_MARKER =
  '[Tool Error] No result was recorded for this tool call — its execution status is unknown (the turn may have been cancelled or the provider switched mid-run). Check whether the tool already produced side effects (files written, commits made) before re-issuing it.';

// ============== API 速率控制 ==============

export const KODAX_API_MIN_INTERVAL = 0.5;
