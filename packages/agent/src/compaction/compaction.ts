/**
 * @kodax/agent Compaction Core
 *
 * 核心压缩逻辑 - 检测并执行上下文压缩
 */

import type { KodaXMessage, KodaXBaseProvider, KodaXContentBlock } from '@kodax/ai';
import type { CompactionConfig, CompactionResult } from './types.js';
import { estimateTokens } from '../tokenizer.js';
import { extractFileOps } from './file-tracker.js';
import { generateSummary } from './summary-generator.js';

/**
 * 默认上下文窗口大小
 *
 * Claude 3.5 Sonnet: 200,000 tokens
 */
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * 检查是否需要压缩
 *
 * 触发条件: contextTokens > contextWindow * triggerPercent / 100
 *
 * @param messages - 消息列表
 * @param config - 压缩配置
 * @param contextWindow - 上下文窗口大小（默认 200k）
 * @returns 是否需要压缩
 */
export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW
): boolean {
  if (!config.enabled) return false;

  const tokens = estimateTokens(messages);
  const threshold = contextWindow * (config.triggerPercent / 100);
  return tokens > threshold;
}

/**
 * 执行压缩 (V2 渐进式滚动压缩架构)
 *
 * @param messages - 消息列表
 * @param config - 压缩配置
 * @param provider - LLM Provider
 * @param contextWindow - 上下文窗口大小
 * @param customInstructions - 自定义指令（可选）
 * @param systemPrompt - 项目的系统提示（可选，用于生成更好的摘要）
 * @returns 压缩结果
 */
export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string
): Promise<CompactionResult> {
  const tokensBefore = estimateTokens(messages);

  // 检查是否需要压缩
  if (!needsCompaction(messages, config, contextWindow)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  // Phase 0: 寻找并分离已有的系统摘要
  let previousSummary: string | undefined;
  let remainingMessages = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[对话历史摘要]')) {
      previousSummary = msg.content.replace('[对话历史摘要]\n\n', '');
      remainingMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  // Phase 1: 绝对保护区
  const protectionPercent = config.protectionPercent ?? 20;
  const protectionTokens = Math.floor(contextWindow * (protectionPercent / 100));
  const protectCutIndex = findCutPoint(remainingMessages, protectionTokens);

  const toProcess = remainingMessages.slice(0, protectCutIndex);
  const toProtect = remainingMessages.slice(protectCutIndex);

  // 如果待处理区为空（比如消息都特别长或者都挤在保护区），直接返回
  if (toProcess.length === 0) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  // 全局收集文件操作跟踪（恢复：在修剪前收集，确保追踪不丢失任何工具调用意图）
  const totalFileOps = extractFileOps(toProcess);

  // Phase 2: 静默修剪 (Silent Pruning)
  const PRUNING_THRESHOLD = config.pruningThresholdTokens ?? 500;
  let hasPruned = false;
  const prunedMessages: KodaXMessage[] = [];

  // 构建 tool_use_id -> 简短上下文摘要 的映射
  const toolContextMap = new Map<string, string>();
  for (const msg of toProcess) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          const name = String(block.name || 'tool');
          const input = (block.input as Record<string, unknown>) || {};
          let preview = name;

          // 尝试提取最具代表性的短参数 (如执行的具体命令，或读写的文件名)
          const cmdLine = input.command ?? input.CommandLine ?? input.command_line;
          if (typeof cmdLine === 'string') {
            const cmd = cmdLine.split(' ')[0]; // 只提取程序名，如 'ls', 'git'
            preview = `${name} ${cmd}`;
          } else {
            const pathInfo = input.path ?? input.AbsolutePath ?? input.TargetFile ?? input.file;
            if (typeof pathInfo === 'string') {
               const file = pathInfo.split(/[\\/]/).pop(); // 仅保留文件 basename
               preview = `${name} ${file}`;
            }
          }
          toolContextMap.set(block.id, preview);
        }
      }
    }
  }

  for (const msg of toProcess) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasToolResult = msg.content.some((b: KodaXContentBlock) => b.type === 'tool_result');
      if (hasToolResult) {
        const newContent = msg.content.map((block: KodaXContentBlock) => {
          if (block.type === 'tool_result' && 'content' in block && typeof block.content === 'string') {
            // 快速估算 (1 token ~ 4 chars)
            if (block.content.length > PRUNING_THRESHOLD * 4) {
              hasPruned = true;
              const toolId = ('tool_use_id' in block && typeof block.tool_use_id === 'string') ? block.tool_use_id : undefined;
              const hint = toolId ? toolContextMap.get(toolId) : undefined;
              
              const replacement = hint ? `[Pruned: ${hint}]` : '[Pruned]';
              return {
                ...block,
                content: replacement
              };
            }
          }
          return block;
        });
        prunedMessages.push({ ...msg, content: newContent });
        continue;
      }
    }
    prunedMessages.push(msg);
  }

  const prunedQueue = [...prunedMessages, ...toProtect];
  const tokensAfterPrune = estimateTokens(prunedQueue);
  const thresholdToken = contextWindow * (config.triggerPercent / 100);

  // 如果仅仅通过修剪就回落到安全水位，无损提前收工
  if (hasPruned && tokensAfterPrune <= thresholdToken) {
    const finalMessages = previousSummary 
       ? [{ role: 'system', content: `[对话历史摘要]\n\n${previousSummary}` } as KodaXMessage, ...prunedQueue] 
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

  // Phase 3: 滚动摘要 (Rolling Summarization)
  const rollingSummaryPercent = config.rollingSummaryPercent ?? 10;
  const ROLLING_SUMMARIZE_TOKENS = Math.floor(contextWindow * (rollingSummaryPercent / 100));
  // 确保至少切出1条可压缩
  const summarizeCutIndex = Math.max(1, findForwardCutPoint(prunedMessages, ROLLING_SUMMARIZE_TOKENS));
  
  const toSummarize = prunedMessages.slice(0, summarizeCutIndex);
  const stillKeptFromProcess = prunedMessages.slice(summarizeCutIndex);

  let summary = previousSummary || '';
  if (toSummarize.length > 0) {
    const MAX_TOKENS_PER_CHUNK = 50000;
    const chunks = chunkMessages(toSummarize, MAX_TOKENS_PER_CHUNK);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length === 0) continue;
      
      const chunkFileOps = extractFileOps(chunk);
      summary = await generateSummary(
        chunk,
        provider,
        chunkFileOps,
        customInstructions,
        systemPrompt,
        summary !== '' ? summary : undefined
      );
      
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  const summaryMessage: KodaXMessage = {
    role: 'system',
    content: `[对话历史摘要]\n\n${summary}`,
  };

  const compactedMessages = [summaryMessage, ...stillKeptFromProcess, ...toProtect];
  
  return {
    compacted: true,
    messages: compactedMessages,
    summary,
    tokensBefore,
    tokensAfter: estimateTokens(compactedMessages),
    entriesRemoved: toSummarize.length,
    details: totalFileOps,
  };
}

/**
 * 提取原子块的核心逻辑（复用）
 * 保证 tool_use + tool_result 不被切散
 */
function getAtomicBlocks(messages: KodaXMessage[]): Array<{ start: number; end: number; tokens: number }> {
  const atomicBlocks: Array<{ start: number; end: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const hasToolUse = msg.role === 'assistant' &&
      Array.isArray(msg.content) &&
      msg.content.some((b: KodaXContentBlock) => b.type === 'tool_use');

    if (hasToolUse) {
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user' &&
        Array.isArray(nextMsg.content) &&
        nextMsg.content.some((b: KodaXContentBlock) => b.type === 'tool_result');

      if (hasNextToolResult) {
        const tokens = estimateTokens([msg, nextMsg]);
        atomicBlocks.push({ start: i, end: i + 1, tokens });
        i++;
        continue;
      }
    }

    const tokens = estimateTokens([msg]);
    atomicBlocks.push({ start: i, end: i, tokens });
  }

  return atomicBlocks;
}

/**
 * 找到绝对保护区的切割点（逆向查找记录的最老位置）
 */
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

/**
 * 从前往后寻找原子块切分点（用于提取最老的 X% tokens）
 */
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
    if (!block) continue;
    
    const group = messages.slice(block.start, block.end + 1);
    const groupTokens = block.tokens;

    if (currentTokens + groupTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
      currentTokens = groupTokens;
    } else {
      currentChunk.push(...group);
      currentTokens += groupTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
