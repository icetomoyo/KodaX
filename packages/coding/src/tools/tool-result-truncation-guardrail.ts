/**
 * Adapter: wrap `applyToolResultGuardrail` (the existing per-tool truncation
 * policy) as a Layer A `ToolGuardrail.afterTool`.
 *
 * FEATURE_085 (v0.7.26): the tri-layer Guardrail runtime lives in
 * `@kodax/core`. The existing truncation logic in `tool-result-policy.ts`
 * predates that runtime and targets `KodaXToolExecutionContext`. Rather
 * than merge the two, we expose an adapter that coding consumers can
 * register when driving a Runner through the generic path — the adapter
 * preserves byte-exact truncation behaviour while participating in the
 * new Guardrail lifecycle (Span emission, declaration-order composition).
 *
 * **Not** registered by default. Consumers opt in via
 * `Runner.run(agent, input, { guardrails: [createToolResultTruncationGuardrail(ctx)] })`.
 * The built-in `runKodaX` preset dispatcher continues to call
 * `applyToolResultGuardrail` directly — no behavioural change there.
 */

import type {
  RunnerToolCall,
  RunnerToolResult,
  ToolGuardrail,
  GuardrailContext,
  GuardrailVerdict,
} from '@kodax/core';

import type { KodaXToolExecutionContext } from '../types.js';
import { applyToolResultGuardrail } from './tool-result-policy.js';

export const TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME = 'tool-result-truncation';

/**
 * Create a `ToolGuardrail` that delegates to `applyToolResultGuardrail` in
 * its `afterTool` hook. The returned guardrail does not touch the call
 * going in (no `beforeTool`).
 *
 * @param ctx The coding-layer execution context that
 * `applyToolResultGuardrail` needs (mutation tracker, persistence dir,
 * etc.). Typically created alongside the `KodaXOptions` for the run.
 */
export function createToolResultTruncationGuardrail(
  ctx: KodaXToolExecutionContext,
): ToolGuardrail {
  return {
    kind: 'tool',
    name: TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME,
    afterTool: async (
      call: RunnerToolCall,
      result: RunnerToolResult,
      _guardrailCtx: GuardrailContext,
    ): Promise<GuardrailVerdict> => {
      // Only truncate successful results. Errors carry their own messages
      // and are already short; wrapping them in policy text would leak
      // infra detail into LLM context.
      if (result.isError) {
        return { action: 'allow' };
      }
      const guarded = await applyToolResultGuardrail(call.name, result.content, ctx);
      if (!guarded.truncated) {
        return { action: 'allow' };
      }
      const rewritten: RunnerToolResult = {
        content: guarded.content,
        isError: result.isError,
        metadata: {
          ...(result.metadata ?? {}),
          truncated: true,
          outputPath: guarded.outputPath,
          policy: guarded.policy,
        },
      };
      return {
        action: 'rewrite',
        payload: rewritten,
        reason: `Truncated to ${guarded.policy.maxLines} lines / ${guarded.policy.maxBytes} bytes`,
      };
    },
  };
}
