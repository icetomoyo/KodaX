import fs from 'node:fs/promises';
import {
  ContextCapacityError, calculateMaxContextInputTokens, countTokens, estimateTokens,
  exceedsContextCapacity, reclaimReservedResponseTokens, RESERVE_SHRINK_FLOOR_TOKENS,
  PROTECTED_TOOL_NAMES,
  emitKodaXDiagnostic,
  retryContextPersistence,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';
import type { KodaXEvents, KodaXToolExecutionContext } from './types.js';
import { applyToolResultGuardrail, TOOL_RESULT_INCOMPLETE_MARKER } from './tools/tool-result-policy.js';
import { toolResultText } from './tools/tool-result-content.js';
import { persistToolOutput } from './tools/truncate.js';
import { cleanupUserInputDegradationCache, createUserInputDegradationCache,
  degradeIrreducibleUserInputs } from './capacity-recovery.js';

export interface HistoryCapacityRecoveryInput {
  readonly messages: readonly KodaXMessage[];
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  /** True only when the active tool set can retrieve saved originals. */
  readonly canReadPagedContent?: boolean;
  readonly executionContext?: KodaXToolExecutionContext;
  readonly persist?: KodaXEvents['onCompactedMessages'];
}

/** Judge terminal capacity only after reclaiming the response reserve. */
export function needsHistoryCapacityRelief(input: {
  readonly contextWindow: number; readonly currentTokens: number; readonly reservedResponseTokens: number;
}): boolean {
  return exceedsContextCapacity({ ...input, reservedResponseTokens: reclaimReservedResponseTokens(input) });
}

async function trustedOutputPath(block: KodaXToolResultBlock, ctx: KodaXToolExecutionContext): Promise<string | undefined> {
  const metadata = block.metadata;
  const outputPath = typeof metadata?.outputPath === 'string'
    && (metadata.truncated === true || metadata.capacityFallback === true)
    ? metadata.outputPath : undefined;
  if (!outputPath) return undefined;
  try {
    return (await retryContextPersistence(() => fs.stat(outputPath), {
      operation: 'artifact stat', signal: ctx.abortSignal,
    })).isFile() ? outputPath : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function persistHistoryArtifact(tool: string, content: string, ctx: KodaXToolExecutionContext): Promise<string> {
  return retryContextPersistence(() => persistToolOutput(tool, content, ctx), {
    operation: 'artifact save', signal: ctx.abortSignal,
  });
}

function canReadSavedArtifact(outputPath: string, ctx: KodaXToolExecutionContext): boolean {
  try {
    ctx.assertReadablePath?.(outputPath);
    return true;
  } catch {
    emitKodaXDiagnostic({ source: 'coding:capacity-recovery', level: 'warn',
      message: 'Read policy denied a saved history artifact; retaining the complete inline history.' });
    return false;
  }
}

async function shrinkResult(
  block: KodaXToolResultBlock, toolName: string, excess: number, ctx: KodaXToolExecutionContext,
): Promise<KodaXToolResultBlock> {
  const outputPath = await trustedOutputPath(block, ctx);
  // A legacy or forged marker alone cannot establish ownership of full evidence.
  if (!outputPath && (block.metadata?.truncated === true
    || toolResultText(block.content).includes(TOOL_RESULT_INCOMPLETE_MARKER))) return block;
  const contentTokens = typeof block.content === 'string'
    ? countTokens(block.content)
    : estimateTokens([{ role: 'user', content: [block] }])
      - estimateTokens([{ role: 'user', content: [{ ...block, content: '' }] }]);
  const guarded = await applyToolResultGuardrail(toolName, block.content, ctx, {
    existingOutputPath: outputPath,
    maxInlineTokens: Math.max(0, contentTokens - excess),
    persistOutput: (tool, content) => persistHistoryArtifact(tool, content, ctx),
  });
  ctx.abortSignal?.throwIfAborted();
  if (guarded.spillFailed || !guarded.outputPath || guarded.content === block.content) return block;
  if (!canReadSavedArtifact(guarded.outputPath, ctx)) return block;
  return { ...block, content: guarded.content, metadata: { ...block.metadata,
    truncated: true, capacityFallback: true, outputPath: guarded.outputPath } };
}

/** Persist artifacts and the replacement context before exposing any relief. */
async function measureUserInputRelief(input: HistoryCapacityRecoveryInput): Promise<number> {
  const cache = createUserInputDegradationCache();
  try {
    const wire = await degradeIrreducibleUserInputs(input.messages,
      input.executionContext ?? { backups: new Map() }, input.contextWindow, cache, input);
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
  const maxInput = calculateMaxContextInputTokens(input.contextWindow,
    Math.min(input.reservedResponseTokens, RESERVE_SHRINK_FLOOR_TOKENS));
  if (input.canReadPagedContent !== true) {
    if (needsHistoryCapacityRelief(input)) {
      throw new ContextCapacityError({ ...input, reservedResponseTokens: reclaimReservedResponseTokens(input) },
        'Context capacity recovery requires an authorized read tool');
    }
    return { messages, currentTokens, changed: false };
  }
  const toolNames = new Map<string, string>();
  const ctx: KodaXToolExecutionContext = input.executionContext ?? { backups: new Map() };
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
  // Last-resort paging of old assistant analysis. User instructions (including
  // compaction query ledgers), system policy, tool arguments and execution
  // receipts remain verbatim. Keep the newest assistant turn in working memory.
  // The original text is saved before a replacement can be committed or used.
  let lastAssistant = messages.length - 1;
  while (lastAssistant >= 0 && messages[lastAssistant]!.role !== 'assistant') lastAssistant -= 1;
  for (let index = 0; index < lastAssistant && currentTokens > maxInput; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || message._source === 'capacity-history') continue;
    const reduceText = async (text: string): Promise<string> => {
      if (text.includes(TOOL_RESULT_INCOMPLETE_MARKER)) return text;
      const guarded = await applyToolResultGuardrail('assistant_history', text, ctx, {
        maxInlineTokens: Math.max(0, countTokens(text) - (currentTokens - maxInput) - 100),
        persistOutput: (tool, content) => persistHistoryArtifact(tool, content, ctx),
      });
      ctx.abortSignal?.throwIfAborted();
      if (guarded.spillFailed || !guarded.outputPath) return text;
      if (!canReadSavedArtifact(guarded.outputPath, ctx)) return text;
      return '[Earlier assistant analysis paged out for context capacity. Read the saved original before relying on omitted details; this is not a new task or a request to repeat tools.]\n'
        + guarded.content;
    };
    const content = typeof message.content === 'string'
      ? await reduceText(message.content)
      : await Promise.all(message.content.map(async block => block.type === 'text'
        ? { ...block, text: await reduceText(block.text) } : block));
    const candidate: KodaXMessage = { ...message, content, _source: 'capacity-history' };
    if (estimateTokens([candidate]) >= estimateTokens([message])) continue;
    messages[index] = candidate;
    currentTokens = Math.max(0, input.currentTokens + estimateTokens(messages) - baseEstimate);
  }
  // User requirements are the last material paged out, after recoverable
  // evidence and old assistant analysis. Prefer keeping all constraints inline.
  const userInputRelief = currentTokens > maxInput
    ? await measureUserInputRelief({ ...input, messages, currentTokens }) : 0;
  const wireTokens = currentTokens - userInputRelief;
  if (needsHistoryCapacityRelief({ ...input, currentTokens: wireTokens })) {
    throw new ContextCapacityError({ ...input, currentTokens: wireTokens,
      reservedResponseTokens: reclaimReservedResponseTokens({ ...input, currentTokens: wireTokens }) }, 'Context capacity recovery');
  }
  const changed = currentTokens < input.currentTokens;
  if (changed) await input.persist?.(messages, { preCompactionMessages: input.messages });
  return { messages, currentTokens, changed };
}
