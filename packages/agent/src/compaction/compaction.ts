/**
 * @kodax/agent Compaction Core
 *
 * Progressive compaction with lightweight tool-result pruning and rolling
 * summarization to an internal low-water mark.
 */

import type { KodaXMessage, KodaXBaseProvider, KodaXContentBlock } from '@kodax/ai';
import type { CompactionConfig, CompactionResult } from './types.js';
import { countTokens, estimateTokens } from '../tokenizer.js';
import { extractFileOps } from './file-tracker.js';
import { generateSummary } from './summary-generator.js';

const DEFAULT_CONTEXT_WINDOW = 200000;
const STRUCTURED_PRUNE_MINIMUM_TOKENS = 20000;
const STRUCTURED_PRUNE_PROTECT_TOKENS = 40000;
const PRUNE_PROTECTED_TOOLS = new Set(['skill']);
const MAX_SUMMARIZATION_TOKENS_PER_CHUNK = 50000;
const SUMMARIZATION_RETRY_DELAY_MS = 2000;

interface ToolContextInfo {
  name: string;
  preview: string;
}

interface PruneDecision {
  idsToPrune: Set<string>;
  prunableTokens: number;
}

interface PruneResult {
  messages: KodaXMessage[];
  hasPruned: boolean;
}

interface SummaryAttemptResult {
  summary: string;
  summarizedMessages: number;
  failed: boolean;
}

export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW
): boolean {
  if (!config.enabled) return false;

  const tokens = estimateTokens(messages);
  const threshold = getTriggerTokens(config, contextWindow);
  return tokens > threshold;
}

export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string
): Promise<CompactionResult> {
  const tokensBefore = estimateTokens(messages);

  if (!needsCompaction(messages, config, contextWindow)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  let previousSummary: string | undefined;
  let remainingMessages = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === 'system' &&
      typeof msg.content === 'string' &&
      msg.content.startsWith('[对话历史摘要]')
    ) {
      previousSummary = msg.content.replace('[对话历史摘要]\n\n', '');
      remainingMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  const protectionPercent = config.protectionPercent ?? 20;
  const protectionTokens = Math.floor(contextWindow * (protectionPercent / 100));
  const protectCutIndex = findCutPoint(remainingMessages, protectionTokens);
  const toProcess = remainingMessages.slice(0, protectCutIndex);
  const toProtect = remainingMessages.slice(protectCutIndex);

  if (toProcess.length === 0) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  const totalFileOps = extractFileOps(toProcess);

  const pruningThresholdTokens = config.pruningThresholdTokens ?? 500;
  const toolContextMap = buildToolContextMap(toProcess);
  const structuredPrune = collectStructuredPruneIds(toProcess, toolContextMap);
  const pruneResult = pruneToolResults(
    toProcess,
    toolContextMap,
    structuredPrune,
    pruningThresholdTokens
  );

  const prunedMessages = pruneResult.messages;
  const prunedQueue = [...prunedMessages, ...toProtect];
  const triggerTokens = getTriggerTokens(config, contextWindow);

  if (pruneResult.hasPruned && estimateTokens(prunedQueue) <= triggerTokens) {
    const finalMessages = previousSummary
      ? [createSummaryMessage(previousSummary), ...prunedQueue]
      : prunedQueue;

    return {
      compacted: true,
      messages: finalMessages,
      summary: previousSummary,
      tokensBefore,
      tokensAfter: estimateTokens(finalMessages),
      entriesRemoved: 0,
      details: totalFileOps,
    };
  }

  const rollingSummaryPercent = config.rollingSummaryPercent ?? 10;
  const rollingSummaryTokens = Math.max(
    1,
    Math.floor(contextWindow * (rollingSummaryPercent / 100))
  );
  const targetTokens = getTargetTokens(config, contextWindow);

  let summary = previousSummary || '';
  let workingProcess = prunedMessages;
  let entriesRemoved = 0;

  while (workingProcess.length > 0) {
    const currentMessages = buildCompactedMessages(summary, workingProcess, toProtect);
    if (estimateTokens(currentMessages) <= targetTokens) {
      break;
    }

    const summarizeCutIndex = Math.max(
      1,
      findForwardCutPoint(workingProcess, rollingSummaryTokens)
    );
    const toSummarize = workingProcess.slice(0, summarizeCutIndex);
    if (toSummarize.length === 0) {
      break;
    }

    const summaryAttempt = await summarizeMessages(
      toSummarize,
      provider,
      customInstructions,
      systemPrompt,
      summary
    );

    if (summaryAttempt.summarizedMessages === 0) {
      break;
    }

    summary = summaryAttempt.summary;
    workingProcess = workingProcess.slice(summaryAttempt.summarizedMessages);
    entriesRemoved += summaryAttempt.summarizedMessages;

    if (summaryAttempt.failed) {
      break;
    }
  }

  const summaryChanged = summary !== (previousSummary || '');
  const didCompact = pruneResult.hasPruned || entriesRemoved > 0 || summaryChanged;
  if (!didCompact) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
      details: totalFileOps,
    };
  }

  const compactedMessages = buildCompactedMessages(summary, workingProcess, toProtect);

  return {
    compacted: true,
    messages: compactedMessages,
    summary: summary || undefined,
    tokensBefore,
    tokensAfter: estimateTokens(compactedMessages),
    entriesRemoved,
    details: totalFileOps,
  };
}

async function summarizeMessages(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  customInstructions: string | undefined,
  systemPrompt: string | undefined,
  previousSummary: string
): Promise<SummaryAttemptResult> {
  let summary = previousSummary;
  let summarizedMessages = 0;
  const chunks = chunkMessages(messages, MAX_SUMMARIZATION_TOKENS_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.length === 0) continue;

    try {
      summary = await generateSummary(
        chunk,
        provider,
        extractFileOps(chunk),
        customInstructions,
        systemPrompt,
        summary || undefined
      );
      summarizedMessages += chunk.length;
    } catch (error) {
      if (process.env.KODAX_DEBUG_COMPACTION) {
        console.warn('[Compaction] Summary chunk failed, keeping partial summary progress.', error);
      }
      return { summary, summarizedMessages, failed: true };
    }

    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, SUMMARIZATION_RETRY_DELAY_MS));
    }
  }

  return { summary, summarizedMessages, failed: false };
}

function buildCompactedMessages(
  summary: string,
  messages: KodaXMessage[],
  protectedMessages: KodaXMessage[]
): KodaXMessage[] {
  return summary
    ? [createSummaryMessage(summary), ...messages, ...protectedMessages]
    : [...messages, ...protectedMessages];
}

function createSummaryMessage(summary: string): KodaXMessage {
  return {
    role: 'system',
    content: `[对话历史摘要]\n\n${summary}`,
  };
}

function getTriggerTokens(config: CompactionConfig, contextWindow: number): number {
  return contextWindow * (config.triggerPercent / 100);
}

function getTargetTokens(config: CompactionConfig, contextWindow: number): number {
  const protectionPercent = config.protectionPercent ?? 20;
  const triggerPercent = config.triggerPercent;

  if (triggerPercent <= protectionPercent) {
    return getTriggerTokens(config, contextWindow);
  }

  const targetPercent = protectionPercent + 0.4 * (triggerPercent - protectionPercent);
  return Math.floor(contextWindow * (targetPercent / 100));
}

function buildToolContextMap(messages: KodaXMessage[]): Map<string, ToolContextInfo> {
  const toolContextMap = new Map<string, ToolContextInfo>();

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;

      const name = String(block.name || 'tool');
      const input = (block.input as Record<string, unknown>) || {};
      let preview = name;

      const command = input.command ?? input.CommandLine ?? input.command_line;
      if (typeof command === 'string' && command.trim()) {
        preview = `${name} ${command.trim().split(/\s+/)[0]}`;
      } else {
        const pathInfo = input.path ?? input.AbsolutePath ?? input.TargetFile ?? input.file;
        if (typeof pathInfo === 'string' && pathInfo.trim()) {
          const basename = pathInfo.split(/[\\/]/).pop() ?? pathInfo;
          preview = `${name} ${basename}`;
        }
      }

      toolContextMap.set(block.id, { name, preview });
    }
  }

  return toolContextMap;
}

function collectStructuredPruneIds(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>
): PruneDecision {
  // Match the opencode-style pruning shape:
  // skip the most recent user turn entirely, then keep walking backward while
  // preserving a recent budget of tool-result tokens before marking older ones for pruning.
  let protectedTurns = 0;
  let protectedToolTokens = 0;
  let prunableTokens = 0;
  const idsToPrune = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'user') {
      protectedTurns++;
    }

    if (protectedTurns < 2 || msg.role !== 'user' || !Array.isArray(msg.content)) {
      continue;
    }

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block?.type !== 'tool_result' || typeof block.content !== 'string') continue;

      const toolInfo = toolContextMap.get(block.tool_use_id);
      if (toolInfo && PRUNE_PROTECTED_TOOLS.has(toolInfo.name)) continue;

      const blockTokens = countToolResultTokens(block.content);
      protectedToolTokens += blockTokens;

      if (protectedToolTokens > STRUCTURED_PRUNE_PROTECT_TOKENS) {
        idsToPrune.add(block.tool_use_id);
        prunableTokens += blockTokens;
      }
    }
  }

  if (prunableTokens < STRUCTURED_PRUNE_MINIMUM_TOKENS) {
    return { idsToPrune: new Set<string>(), prunableTokens: 0 };
  }

  return { idsToPrune, prunableTokens };
}

function pruneToolResults(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>,
  structuredPrune: PruneDecision,
  pruningThresholdTokens: number
): PruneResult {
  let hasPruned = false;
  const prunedMessages = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      return msg;
    }

    let changed = false;
    const newContent = msg.content.map(block => {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') {
        return block;
      }

      const shouldStructuredPrune = structuredPrune.idsToPrune.has(block.tool_use_id);
      const shouldOversizePrune = countTokens(block.content) > pruningThresholdTokens;
      if (!shouldStructuredPrune && !shouldOversizePrune) {
        return block;
      }

      changed = true;
      hasPruned = true;
      const toolInfo = toolContextMap.get(block.tool_use_id);
      return {
        ...block,
        content: toolInfo ? `[Pruned: ${toolInfo.preview}]` : '[Pruned]',
      };
    });

    return changed ? { ...msg, content: newContent } : msg;
  });

  return { messages: prunedMessages, hasPruned };
}

function countToolResultTokens(content: string): number {
  return 4 + countTokens(content);
}

function getAtomicBlocks(messages: KodaXMessage[]): Array<{ start: number; end: number; tokens: number }> {
  const atomicBlocks: Array<{ start: number; end: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const hasToolUse = msg.role === 'assistant'
      && Array.isArray(msg.content)
      && msg.content.some((b: KodaXContentBlock) => b.type === 'tool_use');

    if (hasToolUse) {
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user'
        && Array.isArray(nextMsg.content)
        && nextMsg.content.some((b: KodaXContentBlock) => b.type === 'tool_result');

      if (hasNextToolResult) {
        atomicBlocks.push({
          start: i,
          end: i + 1,
          tokens: estimateTokens([msg, nextMsg]),
        });
        i++;
        continue;
      }
    }

    atomicBlocks.push({
      start: i,
      end: i,
      tokens: estimateTokens([msg]),
    });
  }

  return atomicBlocks;
}

function findCutPoint(messages: KodaXMessage[], keepRecentTokens: number): number {
  let tokenCount = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    if (tokenCount > keepRecentTokens) {
      return block.start;
    }
  }

  return 0;
}

function findForwardCutPoint(messages: KodaXMessage[], targetTokens: number): number {
  let tokenCount = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  if (atomicBlocks.length === 0) {
    return messages.length > 0 ? 1 : 0;
  }

  let cutEndIndex = 0;
  for (let i = 0; i < atomicBlocks.length; i++) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    cutEndIndex = block.end + 1;
    if (tokenCount >= targetTokens) {
      break;
    }
  }

  return Math.min(cutEndIndex, messages.length);
}

function chunkMessages(messages: KodaXMessage[], maxTokensPerChunk: number): KodaXMessage[][] {
  const chunks: KodaXMessage[][] = [];
  let currentChunk: KodaXMessage[] = [];
  let currentTokens = 0;

  const atomicBlocks = getAtomicBlocks(messages);

  for (const block of atomicBlocks) {
    const group = messages.slice(block.start, block.end + 1);
    const groupTokens = block.tokens;

    if (currentTokens + groupTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
      currentTokens = groupTokens;
      continue;
    }

    currentChunk.push(...group);
    currentTokens += groupTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
