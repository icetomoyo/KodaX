import fs from 'node:fs/promises';
import {
  ContextCapacityError, calculateMaxContextInputTokens, countTokens, estimateTokens,
  exceedsContextCapacity, reclaimReservedResponseTokens, RESERVE_SHRINK_FLOOR_TOKENS,
  PROTECTED_TOOL_NAMES,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';
import type { KodaXEvents, KodaXToolExecutionContext } from './types.js';
import { applyToolResultGuardrail, TOOL_RESULT_INCOMPLETE_MARKER } from './tools/tool-result-policy.js';
import { cleanupUserInputDegradationCache, createUserInputDegradationCache,
  degradeIrreducibleUserInputs, hasIrreducibleUserInput } from './capacity-recovery.js';

export interface HistoryCapacityRecoveryInput {
  readonly messages: readonly KodaXMessage[];
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly executionContext?: KodaXToolExecutionContext;
  readonly persist?: KodaXEvents['onCompactedMessages'];
}

/** Judge terminal capacity only after reclaiming the response reserve. */
export function needsHistoryCapacityRelief(input: {
  readonly contextWindow: number; readonly currentTokens: number; readonly reservedResponseTokens: number;
}): boolean {
  return exceedsContextCapacity({ ...input, reservedResponseTokens: reclaimReservedResponseTokens(input) });
}

async function trustedOutputPath(block: KodaXToolResultBlock): Promise<string | undefined> {
  const metadata = block.metadata;
  const outputPath = typeof metadata?.outputPath === 'string'
    && (metadata.truncated === true || metadata.capacityFallback === true)
    ? metadata.outputPath : undefined;
  if (!outputPath) return undefined;
  try {
    return (await fs.stat(outputPath)).isFile() ? outputPath : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function shrinkResult(
  block: KodaXToolResultBlock, toolName: string, excess: number, ctx: KodaXToolExecutionContext,
): Promise<KodaXToolResultBlock> {
  if (typeof block.content !== 'string') return block;
  const outputPath = await trustedOutputPath(block);
  // A legacy or forged marker alone cannot establish ownership of full evidence.
  if (!outputPath && (block.metadata?.truncated === true
    || block.content.includes(TOOL_RESULT_INCOMPLETE_MARKER))) return block;
  const guarded = await applyToolResultGuardrail(toolName, block.content, ctx, {
    existingOutputPath: outputPath,
    maxInlineTokens: Math.max(0, countTokens(block.content) - excess),
  });
  if (guarded.spillFailed || !guarded.outputPath || guarded.content === block.content) return block;
  return { ...block, content: guarded.content, metadata: { ...block.metadata,
    truncated: true, capacityFallback: true, outputPath: guarded.outputPath } };
}

/** Persist artifacts and the replacement context before exposing any relief. */
async function measureUserInputRelief(input: HistoryCapacityRecoveryInput): Promise<number> {
  if (!hasIrreducibleUserInput(input.messages, input.contextWindow)) return 0;
  const cache = createUserInputDegradationCache();
  try {
    const wire = await degradeIrreducibleUserInputs(input.messages,
      input.executionContext ?? { backups: new Map() }, input.contextWindow, cache);
    return estimateTokens([...input.messages]) - estimateTokens(wire);
  } finally {
    await cleanupUserInputDegradationCache(cache);
  }
}

/** Tool replacements are durable; oversized user text stays canonical and is reduced only on the wire. */
export async function recoverContextHistory(input: HistoryCapacityRecoveryInput): Promise<{
  messages: KodaXMessage[]; currentTokens: number; changed: boolean;
}> {
  const messages = [...input.messages];
  let currentTokens = input.currentTokens;
  const baseEstimate = estimateTokens(messages);
  const userInputRelief = await measureUserInputRelief(input);
  const maxInput = calculateMaxContextInputTokens(input.contextWindow,
    Math.min(input.reservedResponseTokens, RESERVE_SHRINK_FLOOR_TOKENS)) + userInputRelief;
  const toolNames = new Map<string, string>();
  const ctx = input.executionContext ?? { backups: new Map() };
  for (let index = 0; index < messages.length && currentTokens > maxInput; index += 1) {
    const message = messages[index]!;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
    if (message.role !== 'user') continue;
    const blocks = [...message.content];
    for (let offset = 0; offset < blocks.length && currentTokens > maxInput; offset += 1) {
      const block = blocks[offset]!;
      if (block.type !== 'tool_result' || !toolNames.has(block.tool_use_id)) continue;
      if (PROTECTED_TOOL_NAMES.has(toolNames.get(block.tool_use_id)!)) continue;
      const reduced = await shrinkResult(block, toolNames.get(block.tool_use_id)!, currentTokens - maxInput, ctx);
      if (reduced === block) continue;
      const candidate = { ...message, content: blocks.map((entry, at) => at === offset ? reduced : entry) };
      if (estimateTokens([candidate]) >= estimateTokens([messages[index]!])) continue;
      blocks[offset] = reduced;
      messages[index] = candidate;
      currentTokens = Math.max(0, input.currentTokens + estimateTokens(messages) - baseEstimate);
    }
  }
  const wireTokens = currentTokens - userInputRelief;
  if (needsHistoryCapacityRelief({ ...input, currentTokens: wireTokens })) {
    throw new ContextCapacityError({ ...input, currentTokens: wireTokens,
      reservedResponseTokens: reclaimReservedResponseTokens({ ...input, currentTokens: wireTokens }) }, 'Context capacity recovery');
  }
  const changed = currentTokens < input.currentTokens;
  if (changed) await input.persist?.(messages, { preCompactionMessages: input.messages });
  return { messages, currentTokens, changed };
}
