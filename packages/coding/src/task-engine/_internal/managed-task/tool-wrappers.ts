

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  RunnableTool,
  RunnerToolContext,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { incrementManagedBudgetUsage } from './budget.js';
import { isToolResultErrorContent } from '../../../agent-runtime/tool-result-classify.js';
import { recordWrittenFile } from '../../../agent-runtime/written-files.js';
import { resolveExecutionCwd } from '../../../runtime-paths.js';
import type { ManagedTaskBudgetController } from './budget.js';
import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  ManagedMutationTracker,
} from '../../../types.js';
import { matchesShellPattern, SHELL_WRITE_PATTERNS } from './tool-policy.js';

// =============================================================================
// Tool wrapping: coding handler -> RunnableTool
// =============================================================================

/**
 * File-mutating tool names. MUST mirror every tool registered with
 * `sideEffect: 'mutates-fs'` in `tool-definitions.ts`; a Worker that uses any
 * of them contributes to managed-task mutation accounting.
 *
 * This is hardcoded rather than derived from `BUILTIN_TOOL_DEFINITIONS` at
 * module load. Importing that registry here pulls its handler chain, which has
 * a transitive cycle back through `construction/agent-resolver.ts` and leaves
 * `BUILTIN_TOOL_DEFINITIONS` uninitialised mid-load. The drift risk is closed
 * by a registry-parity unit test in `tool-wrappers.test.ts`.
 */
export const MUTATES_FS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
  'undo',
  'worktree_create',
  'worktree_remove',
  'stage_construction',
  'stage_agent_construction',
  'stage_self_modify',
]);

/**
 * The subset of `MUTATES_FS_TOOL_NAMES` whose mutated file path is not carried
 * in the tool input because the handler computes it internally. Each call bumps
 * `unattributedWriteOps` so managed-task accounting still sees the mutation.
 */
const UNATTRIBUTED_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'undo',
  'worktree_create',
  'worktree_remove',
  'stage_construction',
  'stage_agent_construction',
  'stage_self_modify',
]);

const SHELL_STATE_CHANGE_PATTERNS: readonly string[] = [
  '\\bchmod\\b',
  '\\bchown\\b',
  '\\bgit\\s+(?:add|commit|push|merge|rebase|reset|checkout\\s+[^-]|rm)\\b',
  '\\bnpm\\s+(?:install|publish|update|rm|add|remove)\\b',
  '\\bpnpm\\s+(?:install|publish|update|rm|add|remove)\\b',
  '\\byarn\\s+(?:add|publish|remove|install|upgrade)\\b',
];

const RISKY_SHELL_MUTATION_PATTERNS: readonly string[] = [
  ...SHELL_WRITE_PATTERNS,
  ...SHELL_STATE_CHANGE_PATTERNS,
];
const RISKY_SHELL_MUTATION_PATTERNS_LOWER: readonly string[] =
  RISKY_SHELL_MUTATION_PATTERNS.map((pattern) => pattern.toLowerCase());

function lineCount(text: unknown): number {
  return typeof text === 'string' ? text.split('\n').length : 0;
}

function matchesRiskyShellMutation(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return (
    matchesShellPattern(trimmed, RISKY_SHELL_MUTATION_PATTERNS)
    || matchesShellPattern(trimmed.toLowerCase(), RISKY_SHELL_MUTATION_PATTERNS_LOWER)
  );
}

/**
 * Estimated touched lines for a mutation, not net delta. An 80-line function
 * rewritten into another 80-line function touches about 80 lines, not 0.
 */
function estimateTouchedLines(input: Record<string, unknown>): number {
  if (typeof input.content === 'string') return lineCount(input.content);
  if (Array.isArray(input.edits)) {
    const sum = input.edits.reduce((acc: number, raw) => {
      const edit = raw as { old_string?: unknown; new_string?: unknown };
      return acc + Math.max(lineCount(edit.old_string), lineCount(edit.new_string));
    }, 0);
    return sum || 1;
  }
  return Math.max(lineCount(input.old_string), lineCount(input.new_string)) || 1;
}

export function recordMutationForTool(
  tracker: ManagedMutationTracker | undefined,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!tracker) return;
  const normalized = toolName.toLowerCase();
  if (MUTATES_FS_TOOL_NAMES.has(normalized)) {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : undefined;
    if (filePath) {
      tracker.files.set(filePath, (tracker.files.get(filePath) ?? 0) + estimateTouchedLines(input));
    } else if (UNATTRIBUTED_WRITE_TOOL_NAMES.has(normalized)) {
      tracker.unattributedWriteOps = (tracker.unattributedWriteOps ?? 0) + 1;
    }
    tracker.totalOps += 1;
  } else if (normalized === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (matchesRiskyShellMutation(cmd)) {
      tracker.totalOps += 1;
      tracker.riskyShellOps = (tracker.riskyShellOps ?? 0) + 1;
    }
  }
}

export function wrapCodingToolAsRunnable(
  definition: KodaXToolDefinition,
  handler: (
    input: Record<string, unknown>,
    ctx: KodaXToolExecutionContext,
  ) => Promise<RunnerToolResult['content']>,
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...definition,
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      recordMutationForTool(baseCtx.mutationTracker, definition.name, input);
      const toolCallId = runnerCtx?.toolCallId;
      let outputPath: string | undefined;
      const toolResultCapacityTokens = runnerCtx?.transcript
        ? baseCtx.resolveToolResultCapacityTokens?.(runnerCtx.transcript)
        : undefined;
      const { createContextForToolCall } = await import('../../../agent-runtime/tool-dispatch.js');
      const call = runnerCtx?.toolCall ?? { id: toolCallId ?? definition.name, name: definition.name, input };
      const ctxForCall = createContextForToolCall(events ?? {}, call, {
        ...baseCtx,
        ...(baseCtx.visualObservationOwner ? { visualSource: { ...baseCtx.visualSource, imageOrdinal: 0,
          runId: baseCtx.runtimeRunId, callOrdinal: runnerCtx?.toolCallIndex } } : {}),
        ...(runnerCtx?.abortSignal ? { abortSignal: runnerCtx.abortSignal } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolResultCapacityTokens !== undefined ? { toolResultCapacityTokens } : {}),
        ...(runnerCtx?.transcript && baseCtx.visualOutputReservations ? {
          reserveVisualOutput: (tokens: number) => baseCtx.visualOutputReservations!.reserve(
            runnerCtx.transcript!, toolResultCapacityTokens ?? 0, tokens),
        } : {}),
        ...(toolCallId
          ? {
              recordToolResultArtifact: (recordedToolCallId, recordedOutputPath) => {
                if (recordedToolCallId === toolCallId) outputPath = recordedOutputPath;
                baseCtx.recordToolResultArtifact?.(recordedToolCallId, recordedOutputPath);
              },
            }
          : {}),
      });
      if (baseCtx.invokeCheckedTool) {
        ctxForCall.invokeCheckedTool = (name, parameters) => baseCtx.invokeCheckedTool!(name, parameters, runnerCtx);
      }
      try {
        const execute = () => handler(input, ctxForCall);
        // Lazy import avoids the registry -> construction -> AMA module cycle.
        const content = ctxForCall.invokeCheckedTool && toolCallId
          ? await (await import('../../../agent-runtime/tool-dispatch.js')).executeInExtensionScope(
            { id: toolCallId, name: definition.name, input }, ctxForCall, runnerCtx?.abortSignal,
            events ?? {}, execute)
          : await execute();
        recordWrittenFile(baseCtx.writtenFiles, { name: definition.name, input }, content, resolveExecutionCwd(ctxForCall));
        return {
          content,
          ...(isToolResultErrorContent(content) ? { isError: true } : {}),
          ...(outputPath
            ? { metadata: { truncated: true, capacityFallback: true, outputPath } }
            : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `[Tool Error] ${definition.name}: ${message}`, isError: true };
      }
    },
  };
}
