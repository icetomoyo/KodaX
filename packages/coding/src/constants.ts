/**
 * KodaX Core Constants
 */

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

export const KODAX_FEATURES_FILE = 'feature_list.json';
export const KODAX_PROGRESS_FILE = 'PROGRESS.md';

/** Prefix used to detect user-cancelled tool results in the agent loop. */
export const CANCELLED_TOOL_RESULT_PREFIX = '[Cancelled]';
/** Standard cancellation message returned when a tool is cancelled by the user. */
export const CANCELLED_TOOL_RESULT_MESSAGE = `${CANCELLED_TOOL_RESULT_PREFIX} Operation cancelled by user`;
