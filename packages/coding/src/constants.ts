/**
 * KodaX Core Constants
 */

export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from '@kodax-ai/agent';

/**
 * Empty-completion retry budget for the managed-task LLM adapter.
 *
 * When a provider returns a syntactically-complete turn (finish_reason
 * received — so NOT a stream-incomplete error) that carries no text, no
 * tool calls, and no thinking, the adapter re-streams the same turn up to
 * this many times before falling through to the runner's terminal
 * no-tool branch. Without it, a degraded/empty completion — common on
 * budget OpenAI-compatible providers under load or right after a 429 — is
 * misread by the runner as a clean text-only task completion and the task
 * exits silently. A genuine text-only termination (text present, no tool)
 * is unaffected: the guard only fires on the fully-empty turn.
 */
export const KODAX_MAX_EMPTY_COMPLETION_RETRIES = 2;
/** Base backoff (ms) between empty-completion re-streams; scales by attempt. */
export const KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS = 500;

/**
 * Mechanical fuse for one uninterrupted managed `Runner.run` tool loop.
 *
 * Each idle-yield resume starts a fresh Runner invocation and resets this
 * counter. Reaching 500 therefore indicates a runaway prompt/tool loop; it is
 * not a cumulative task budget and does not limit legitimate long-running
 * work that progresses through child completions and context compaction.
 */
export const MANAGED_RUNNER_PANIC_ITERATIONS = 500;

/** Managed tasks may resume after arbitrarily many idle-yield wake events. */
export const MANAGED_TASK_IDLE_YIELD_ITERATIONS = Number.POSITIVE_INFINITY;

/** Prefix used to detect user-cancelled tool results in the agent loop. */
export const CANCELLED_TOOL_RESULT_PREFIX = '[Cancelled]';
/** Standard cancellation message returned when a tool is cancelled by the user. */
export const CANCELLED_TOOL_RESULT_MESSAGE = `${CANCELLED_TOOL_RESULT_PREFIX} Operation cancelled by user`;
/** The result of a tool call that needs a person's approval where nobody can be asked. The model reads it and goes on. */
export function approvalUnavailableToolResult(toolName: string): string {
  return `[Tool Error] ${toolName}: This call needs a person's approval, but this host cannot ask for it.`;
}
/**
 * The result of a call that changes something, where the host set no approval
 * callback. The model may pass the fix on to the person, who can pass it on to
 * whoever built the host.
 */
export function approvalMissingToolResult(toolName: string): string {
  return `[Tool Error] ${toolName}: This host runs only tools that read, because it sets no approval callback. `
    + 'Any other tool that changes something gets the same answer. '
    + 'Keep working with tools that read, and tell the user what you would have changed. '
    + 'To allow this tool, the program that embeds KodaX passes events.beforeToolExecute, or allowAll to run every tool.';
}
