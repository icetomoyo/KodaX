import type { ProviderRecoveryEvent } from "@kodax/coding";
import type { CreatableHistoryItem } from "../types.js";

/**
 * Build the retry info history item shown during automatic provider retries.
 * Keeping this out of InkREPL makes the regression easy to test and avoids
 * falling back to console.log, which gets captured and deferred.
 */
export function createRetryHistoryItem(
  reason: string,
  attempt: number,
  maxAttempts: number,
): CreatableHistoryItem {
  const trimmed = reason.trim();
  const text = /\bretry\s+\d+\/\d+\b/i.test(trimmed) || /\b\d+\/\d+\b/.test(trimmed)
    ? trimmed
    : `${trimmed} · retry ${attempt}/${maxAttempts}`;

  return {
    type: "info",
    icon: "\u23F3",
    text,
  };
}

export function emitRetryHistoryItem(
  addHistoryItem: (item: CreatableHistoryItem) => void,
  reason: string,
  attempt: number,
  maxAttempts: number,
): void {
  addHistoryItem(createRetryHistoryItem(reason, attempt, maxAttempts));
}

/**
 * Build a recovery history item from a structured ProviderRecoveryEvent.
 */
export function createRecoveryHistoryItem(
  event: ProviderRecoveryEvent,
): CreatableHistoryItem {
  const { recoveryAction, attempt, maxAttempts, delayMs, stage, fallbackUsed } = event;
  const delaySec = Math.round(delayMs / 1000);

  if (recoveryAction === "manual_continue") {
    return {
      type: "info",
      icon: "\u26A0",
      text: 'Recovery exhausted. Type "continue" to retry or "stop" to cancel.',
    };
  }

  if (recoveryAction === "non_streaming_fallback" || fallbackUsed) {
    return {
      type: "info",
      icon: "\u23F3",
      text: "Stream unstable, switching to non-streaming mode",
    };
  }

  if (recoveryAction === "sanitize_thinking_and_retry") {
    // L3 self-heal: history violated the provider's thinking-mode
    // contract (deepseek "reasoning_content must be passed back" or
    // Anthropic "thinking signature invalid"). Strip thinking blocks
    // and retry once. v0.7.28.
    return {
      type: "info",
      icon: "⏳",
      text: "Provider rejected replay thinking, sanitizing history and retrying",
    };
  }

  let description: string;
  switch (stage) {
    case "before_first_delta":
    case "before_request_accepted":
      description = "Provider request timed out";
      break;
    case "mid_stream_text":
    case "mid_stream_thinking":
      description = "Stream interrupted after partial output";
      break;
    case "mid_stream_tool_input":
      description = "Stream interrupted during tool input";
      break;
    case "post_tool_execution_pre_assistant_close":
      description = "Stream interrupted after tool execution";
      break;
    default:
      description = "Stream interrupted";
      break;
  }

  const action = recoveryAction === "stable_boundary_retry" ? "recovering" : "retrying";
  const text = delaySec > 0
    ? `${description} · ${action} ${attempt}/${maxAttempts} in ${delaySec}s`
    : `${description} · ${action} ${attempt}/${maxAttempts}`;

  return {
    type: "info",
    icon: "\u23F3",
    text,
  };
}

export function emitRecoveryHistoryItem(
  addHistoryItem: (item: CreatableHistoryItem) => void,
  event: ProviderRecoveryEvent,
): void {
  addHistoryItem(createRecoveryHistoryItem(event));
}
