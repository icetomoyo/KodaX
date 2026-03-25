/**
 * KodaX Agent
 *
 * Agent 主循环 - Core 层核心入口
 */

import {
  KodaXExecutionMode,
  KodaXEvents,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXTaskType,
  KodaXThinkingDepth,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
  SessionErrorMetadata,
} from './types.js';
import type { KodaXMessage } from '@kodax/ai';
import { KodaXClient } from './client.js';
import { resolveProvider } from './providers/index.js';
import { executeTool, KODAX_TOOLS } from './tools/index.js';
import { buildSystemPrompt } from './prompts/index.js';
import { generateSessionId, extractTitleFromMessages } from './session.js';
import { checkIncompleteToolCalls } from './messages.js';
import { compact as intelligentCompact, needsCompaction, type CompactionConfig } from '@kodax/agent';
import { loadCompactionConfig } from './compaction-config.js';
import { estimateTokens } from './tokenizer.js';
import { KODAX_MAX_INCOMPLETE_RETRIES, PROMISE_PATTERN, KODAX_TOOL_REQUIRED_PARAMS } from './constants.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ErrorCategory } from './error-classification.js';
import { withRetry } from './retry-handler.js';
import {
  createReasoningPlan,
  maybeCreateAutoReroutePlan,
  type ReasoningPlan,
} from './reasoning.js';
import { looksLikeActionableRuntimeEvidence } from './runtime-evidence.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import {
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  createEstimatedContextTokenSnapshot,
  rebaseContextTokenSnapshot,
  resolveContextTokenCount,
} from './token-accounting.js';
import { applyToolResultGuardrail } from './tools/tool-result-policy.js';

const execAsync = promisify(exec);
const CANCELLED_TOOL_RESULT_PREFIX = '[Cancelled]';
const CANCELLED_TOOL_RESULT_MESSAGE = `${CANCELLED_TOOL_RESULT_PREFIX} Operation cancelled by user`;
type AutoReroutePlan = Awaited<ReturnType<typeof maybeCreateAutoReroutePlan>>;
type RunnableToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
};
type MessageContentBlock = Exclude<KodaXMessage['content'], string>[number];

function isTypedContentBlock(block: unknown): block is MessageContentBlock {
  return block !== null && typeof block === 'object' && 'type' in block;
}

function isToolUseContentBlock(
  block: unknown,
): block is Extract<MessageContentBlock, { type: 'tool_use' }> {
  return isTypedContentBlock(block) && block.type === 'tool_use';
}

function isToolResultContentBlock(
  block: unknown,
): block is Extract<MessageContentBlock, { type: 'tool_result' }> {
  return isTypedContentBlock(block) && block.type === 'tool_result';
}

/**
 * 验证并修复整个工具调用历史 - Issue 072 enhanced fix
 *
 * 扫描整段消息历史，修复所有不合法的 tool_use/tool_result 配对：
 * 1. 删除空 id 的 tool_use 和 tool_result
 * 2. 删除孤立的 tool_result（没有匹配的前一个 tool_use）
 * 3. 删除孤立的 tool_use（没有匹配的后一个 tool_result）
 *
 * @param messages - 消息列表
 * @returns 修复后的消息列表
 */
function validateAndFixToolHistory(messages: KodaXMessage[]): KodaXMessage[] {
  // Debug: 打印校验前的状态
  if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
    console.error('[ToolHistory] Validating messages:', messages.length);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

      const toolUses = msg.content.filter(isToolUseContentBlock);
      const toolResults = msg.content.filter(isToolResultContentBlock);

      if (toolUses.length > 0 || toolResults.length > 0) {
        console.error(`  [${i}] ${msg.role}:`, {
          toolUses: toolUses.map((toolUse) => ({ id: toolUse.id, name: toolUse.name })),
          toolResults: toolResults.map((toolResult) => ({ tool_use_id: toolResult.tool_use_id }))
        });
      }
    }
  }

  const fixedMessages: KodaXMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // 只处理有 content 数组的消息
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      fixedMessages.push(msg);
      continue;
    }

    const content = msg.content;
    const fixedContent: typeof content = [];

    if (msg.role === 'assistant') {
      // 检查每个 tool_use 是否有匹配的 tool_result
      const nextMsg = messages[i + 1];
      const resultIds = new Set<string>();

      if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
        for (const block of nextMsg.content) {
          if (isToolResultContentBlock(block) && block.tool_use_id) {
            resultIds.add(block.tool_use_id);
          }
        }
      }

      // 过滤掉没有匹配 tool_result 的 tool_use
      for (const block of content) {
        if (!isTypedContentBlock(block)) {
          fixedContent.push(block as typeof content[number]);
          continue;
        }

        if (block.type === 'tool_use') {
          // 跳过空 id 或没有匹配 tool_result 的 tool_use
          if (!block.id || typeof block.id !== 'string' || block.id.trim() === '') {
            console.error('[ToolHistoryFix] Removed tool_use with empty id');
            continue;
          }

          if (!resultIds.has(block.id)) {
            console.error('[ToolHistoryFix] Removed orphaned tool_use:', block.id);
            continue;
          }

          fixedContent.push(block);
        } else {
          fixedContent.push(block);
        }
      }
    } else if (msg.role === 'user') {
      // 获取前一条 assistant 中的 tool_use id
      const prevMsg = messages[i - 1];
      const toolUseIds = new Set<string>();

      if (prevMsg?.role === 'assistant' && Array.isArray(prevMsg.content)) {
        for (const block of prevMsg.content) {
          if (isToolUseContentBlock(block) && block.id) {
            toolUseIds.add(block.id);
          }
        }
      }

      // 过滤掉孤立的或空 id 的 tool_result
      for (const block of content) {
        if (!isTypedContentBlock(block)) {
          fixedContent.push(block as typeof content[number]);
          continue;
        }

        if (block.type === 'tool_result') {
          // 跳过空 tool_use_id
          if (!block.tool_use_id || typeof block.tool_use_id !== 'string' || block.tool_use_id.trim() === '') {
            console.error('[ToolHistoryFix] Removed tool_result with empty tool_use_id');
            continue;
          }

          // 跳过孤立 tool_result（没有匹配的前一个 tool_use）
          if (!toolUseIds.has(block.tool_use_id)) {
            console.error('[ToolHistoryFix] Removed orphaned tool_result:', block.tool_use_id);
            continue;
          }

          fixedContent.push(block);
        } else {
          fixedContent.push(block);
        }
      }
    } else {
      // 其他角色（如 system）直接保留
      fixedContent.push(...content);
    }

    // 只有当 fixedContent 不为空时才添加消息
    if (fixedContent.length > 0) {
      fixedMessages.push({ ...msg, content: fixedContent });
    }
  }

  // Debug: 报告修复结果
  if (process.env.KODAX_DEBUG_TOOL_HISTORY && fixedMessages.length !== messages.length) {
    console.error('[ToolHistory] Fixed: removed', messages.length - fixedMessages.length, 'invalid messages');
  }

  return fixedMessages;
}

/**
 * 清理不完整的 tool_use 块 - Issue 072 fix
 *
 * 当流式中断时，assistant 消息可能包含 tool_use 但没有对应的 tool_result。
 * 这会导致下次请求时 API 报错 "tool_call_id not found"。
 *
 * 修复逻辑：
 * 1. 检查最后一条 assistant 消息是否包含 tool_use 块
 * 2. 检查是否有对应的 tool_result 块（应该在下一条 user 消息中）
 * 3. 如果没有对应的 tool_result，移除 tool_use 块，保留 text/thinking 块
 *
 * @param messages - 消息列表
 * @returns 清理后的消息列表
 */
function cleanupIncompleteToolCalls(messages: KodaXMessage[]): KodaXMessage[] {
  if (messages.length === 0) return messages;

  const lastMsg = messages[messages.length - 1];

  // 只处理 assistant 消息
  if (lastMsg?.role !== 'assistant') return messages;

  // 只处理数组形式的 content
  if (typeof lastMsg.content !== 'string' && Array.isArray(lastMsg.content)) {
    const content = lastMsg.content;

    // 提取所有 tool_use 的 id
    const toolUseIds = new Set<string>();

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'tool_use' && 'id' in block) {
          toolUseIds.add(block.id);
        }
      }
    }

    // 如果没有 tool_use 块，无需清理
    if (toolUseIds.size === 0) return messages;

    // 收集所有 tool_result 中出现的 tool_use_id（遍历所有消息）
    const toolResultIds = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;

      const userContent = msg.content;
      if (typeof userContent === 'string' || !Array.isArray(userContent)) continue;

      for (const block of userContent) {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'tool_result' && 'tool_use_id' in block) {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    }

    // 检查是否有孤立的 tool_use 块（没有对应的 tool_result）
    const orphanedToolUseIds = new Set<string>();
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        orphanedToolUseIds.add(id);
      }
    }

    // 如果有孤立的 tool_use 块，移除它们
    if (orphanedToolUseIds.size > 0) {
      // 过滤掉孤立的 tool_use 块，保留其他块（text, thinking, 以及有结果的 tool_use）
      const cleanedContent = content.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        if (!('type' in block)) return true;
        const typedBlock = block as { type: string; id?: string };
        if (typedBlock.type !== 'tool_use') return true;
        // 只保留有对应 tool_result 的 tool_use 块
        return !orphanedToolUseIds.has(typedBlock.id ?? '');
      });

      // 如果清理后内容为空，返回去掉最后一条消息
      if (cleanedContent.length === 0) {
        return messages.slice(0, -1);
      }

      // 否则返回修改后的消息
      return [
        ...messages.slice(0, -1),
        { ...lastMsg, content: cleanedContent },
      ];
    }
  }

  return messages;
}

/**
 * 检查 Promise 信号
 */
export function checkPromiseSignal(text: string): [string, string] {
  const match = PROMISE_PATTERN.exec(text);
  if (match) return [match[1]!.toUpperCase(), match[2] ?? ''];
  return ['', ''];
}

function hasQueuedFollowUp(events: KodaXEvents): boolean {
  return events.hasPendingInputs?.() === true;
}

function isToolResultErrorContent(content: string): boolean {
  return /^\[(?:Tool Error|Cancelled|Blocked|Error)\]/.test(content);
}

function isCancelledToolResultContent(content: string): boolean {
  return content.startsWith(CANCELLED_TOOL_RESULT_PREFIX);
}

async function getToolExecutionOverride(
  events: KodaXEvents,
  name: string,
  input: Record<string, unknown>,
  toolId?: string,
): Promise<string | undefined> {
  if (!events.beforeToolExecute) {
    return undefined;
  }

  const allowed = await events.beforeToolExecute(name, input, { toolId });
  if (allowed === false) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  return typeof allowed === 'string' ? allowed : undefined;
}

async function saveSessionSnapshot(
  options: KodaXOptions,
  sessionId: string,
  data: {
    messages: KodaXMessage[];
    title: string;
    gitRoot?: string;
    errorMetadata?: SessionErrorMetadata;
  },
): Promise<void> {
  if (!options.session?.storage) {
    return;
  }

  const gitRoot = data.gitRoot ?? (await getGitRoot()) ?? '';
  await options.session.storage.save(sessionId, {
    messages: data.messages,
    title: data.title,
    gitRoot,
    errorMetadata: data.errorMetadata,
  });
}

function createToolResultBlock(toolUseId: string, content: string): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isToolResultErrorContent(content) ? { is_error: true } : {}),
  };
}

async function maybeBuildAutoReroutePlan(
  provider: ReturnType<typeof resolveProvider>,
  options: KodaXOptions,
  prompt: string,
  reasoningPlan: ReasoningPlan,
  lastText: string,
  allowances: {
    allowDepthEscalation: boolean;
    allowTaskReroute: boolean;
  },
  toolEvidence?: string,
): Promise<AutoReroutePlan> {
  try {
    return await maybeCreateAutoReroutePlan(
      provider,
      options,
      prompt,
      reasoningPlan,
      lastText,
      allowances,
      toolEvidence ? { toolEvidence } : undefined,
    );
  } catch (rerouteError) {
    if (process.env.KODAX_DEBUG_ROUTING) {
      console.error('[AutoReroute] Failed, continuing without reroute:', rerouteError);
    }
    return null;
  }
}

async function maybeAdvanceAutoReroute(params: {
  provider: ReturnType<typeof resolveProvider>;
  options: KodaXOptions;
  prompt: string;
  reasoningPlan: ReasoningPlan;
  lastText: string;
  autoFollowUpCount: number;
  autoDepthEscalationCount: number;
  autoTaskRerouteCount: number;
  autoFollowUpLimit: number;
  events: KodaXEvents;
  isNewSession: boolean;
  retryLabelPrefix: string;
  toolEvidence?: string;
  onApply?: () => Promise<void> | void;
  persistSession?: {
    sessionId: string;
    messages: KodaXMessage[];
    title: string;
  };
}): Promise<{
  reasoningPlan: ReasoningPlan;
  currentExecution: Awaited<ReturnType<typeof buildReasoningExecutionState>>;
  autoFollowUpCount: number;
  autoDepthEscalationCount: number;
  autoTaskRerouteCount: number;
} | null> {
  if (
    params.reasoningPlan.mode !== 'auto'
    || params.autoFollowUpCount >= params.autoFollowUpLimit
    || (params.autoDepthEscalationCount > 0 && params.autoTaskRerouteCount > 0)
  ) {
    return null;
  }

  const followUpPlan = await maybeBuildAutoReroutePlan(
    params.provider,
    params.options,
    params.prompt,
    params.reasoningPlan,
    params.lastText,
    {
      allowDepthEscalation: params.autoDepthEscalationCount === 0,
      allowTaskReroute: params.autoTaskRerouteCount === 0,
    },
    params.toolEvidence,
  );

  if (!followUpPlan) {
    return null;
  }

  const autoFollowUpCount = params.autoFollowUpCount + 1;
  const autoDepthEscalationCount = params.autoDepthEscalationCount + (followUpPlan.kind === 'depth-escalation' ? 1 : 0);
  const autoTaskRerouteCount = params.autoTaskRerouteCount + (followUpPlan.kind === 'task-reroute' ? 1 : 0);
  const currentExecution = await buildReasoningExecutionState(
    params.options,
    followUpPlan,
    params.isNewSession,
  );

  await params.onApply?.();

  if (params.persistSession) {
    await saveSessionSnapshot(params.options, params.persistSession.sessionId, {
      messages: params.persistSession.messages,
      title: params.persistSession.title,
    });
  }

  params.events.onRetry?.(
    `${
      followUpPlan.kind === 'depth-escalation'
        ? `${params.retryLabelPrefix} depth escalation`
        : `${params.retryLabelPrefix} reroute`
    }: ${followUpPlan.decision.reason}`,
    autoFollowUpCount,
    params.autoFollowUpLimit,
  );

  return {
    reasoningPlan: followUpPlan,
    currentExecution,
    autoFollowUpCount,
    autoDepthEscalationCount,
    autoTaskRerouteCount,
  };
}

async function executeToolCall(
  events: KodaXEvents,
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  events.onToolUseStart?.({
    name: toolCall.name,
    id: toolCall.id,
    input: toolCall.input,
  });

  const override = await getToolExecutionOverride(
    events,
    toolCall.name,
    toolCall.input ?? {},
    toolCall.id,
  );
  if (override !== undefined) {
    return override;
  }

  return executeTool(toolCall.name, toolCall.input ?? {}, ctx);
}

/**
 * 运行 KodaX Agent
 * 核心入口函数 - 极简 API
 */
export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const provider = resolveProvider(options.provider);
  if (!provider.isConfigured()) {
    throw new Error(`Provider "${options.provider}" not configured. Set ${options.provider.toUpperCase().replace('-', '_')}_API_KEY`);
  }

  const maxIter = options.maxIter ?? 200;
  const events = options.events ?? {};

  // Load compaction config
  const compactionConfig = await loadCompactionConfig(options.context?.gitRoot ?? undefined);

  // Get contextWindow: user config > provider > default 200k
  const contextWindow = compactionConfig.contextWindow
    ?? provider.getContextWindow?.()
    ?? 200000;

  // 处理 autoResume/resume：自动加载当前目录最近会话
  let resolvedSessionId = options.session?.id;
  if ((options.session?.autoResume || options.session?.resume) && options.session?.storage && !resolvedSessionId) {
    const storage = options.session.storage;
    if (storage.list) {
      const sessions = await storage.list();
      if (sessions.length > 0) {
        resolvedSessionId = sessions[0]!.id;  // 最近会话
      }
    }
  }

  const sessionId = resolvedSessionId ?? await generateSessionId();

  // 加载或初始化消息
  let messages: KodaXMessage[] = [];
  let title = '';
  let errorMetadata: SessionErrorMetadata | undefined;

  // 优先使用 initialMessages（用于交互式模式的多轮对话）
  if (options.session?.initialMessages && options.session.initialMessages.length > 0) {
    messages = [...options.session.initialMessages];
    title = extractTitleFromMessages(messages);
  } else if (options.session?.storage && sessionId) {
    const loaded = await options.session.storage.load(sessionId);
    if (loaded) {
      messages = loaded.messages;
      title = loaded.title;
      errorMetadata = loaded.errorMetadata;
    }
  }

  // 防止消息重复推入：如果 initialMessages 的最后一条已经是当前 prompt，跳过 push
  const lastMsg = messages[messages.length - 1];
  const isDuplicate = lastMsg?.role === 'user' && lastMsg.content === prompt;
  if (!isDuplicate) {
    messages.push({ role: 'user', content: prompt });
  }
  if (!title) title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');

  const executionCwd = resolveExecutionCwd(options.context);

  // Simplified context - no permission fields (handled by REPL layer)
  const ctx: KodaXToolExecutionContext = {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    executionCwd,
    askUser: events.askUser, // Issue 069: Pass askUser callback from events
  };
  let contextTokenSnapshot = rebaseContextTokenSnapshot(
    messages,
    options.context?.contextTokenSnapshot,
  );

  let reasoningPlan = await createReasoningPlan(options, prompt, provider, {
    recentMessages: messages.slice(0, -1),
    sessionErrorMetadata: errorMetadata,
  });
  let currentExecution = await buildReasoningExecutionState(
    options,
    reasoningPlan,
    messages.length === 1,
  );
  let autoFollowUpCount = 0;
  let autoDepthEscalationCount = 0;
  let autoTaskRerouteCount = 0;
  const autoFollowUpLimit = 2;

  // 通知会话开始
  events.onSessionStart?.({ provider: provider.name, sessionId });

  let lastText = '';
  let incompleteRetryCount = 0;
  let limitReached = false; // Track if we exited due to iteration limit - 追踪是否因达到迭代上限而退出
  const emitIterationEnd = (
    iterNumber: number,
    snapshotOverride?: typeof contextTokenSnapshot,
  ): typeof contextTokenSnapshot => {
    contextTokenSnapshot = rebaseContextTokenSnapshot(
      messages,
      snapshotOverride ?? contextTokenSnapshot,
    );
    events.onIterationEnd?.({
      iter: iterNumber,
      maxIter,
      tokenCount: contextTokenSnapshot.currentTokens,
      tokenSource: contextTokenSnapshot.source,
      usage: contextTokenSnapshot.usage,
      contextTokenSnapshot,
    });
    return contextTokenSnapshot;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    try {
      events.onIterationStart?.(iter + 1, maxIter);

      // Compaction: 统一使用智能压缩，废除遗留的粗暴截断
      let compacted: KodaXMessage[];
      let didCompactMessages = false;

      // 判断是否需要压缩：只依据智能压缩阈值 (默认 75%)
      const currentTokens = resolveContextTokenCount(messages, contextTokenSnapshot);
      const needsIntelligentCompact =
        compactionConfig.enabled
        && needsCompaction(messages, compactionConfig, contextWindow, currentTokens);

      if (needsIntelligentCompact) {
        // Only trigger UI indicator right before the heavy lifting
        events.onCompactStart?.();
        // 统一走智能压缩（分块 LLM 摘要 + 保留最近 10% 上下文）
        try {
          const result = await intelligentCompact(
            messages,
            compactionConfig,
            provider,
            contextWindow,
            undefined, // customInstructions
            currentExecution.systemPrompt, // 传入 systemPrompt 以生成更好的摘要
            currentTokens,
          );

          if (result.compacted) {
            compacted = result.messages;
            didCompactMessages = true;
            events.onCompactStats?.({
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
            });
            events.onCompact?.(result.tokensBefore);
          } else {
            compacted = result.messages;
          }
        } catch (error) {
          // 改进的错误回退逻辑：告知用户并删除最老的10%消息
          console.error('[Compaction Error] LLM摘要失败，回退到简单截断:', error);

          // 确保至少删除1条，避免无限循环
          const removeCount = Math.max(1, Math.ceil(messages.length * 0.1));

          if (messages.length > removeCount + 1) {
            let startIndex = removeCount;
            let newCompacted: KodaXMessage[] = [];

            // 如果有总结消息（系统消息或包含特定文本的用户消息），始终保留
            const firstMsg = messages[0];
            const isSummary = firstMsg && (firstMsg.role === 'system' || firstMsg.role === 'user')
              && typeof firstMsg.content === 'string' && firstMsg.content.includes('[对话历史摘要]');

            if (isSummary) {
              newCompacted.push(firstMsg);
              // 我们不想删掉摘要，而是想要删掉摘要后面的 removeCount 条消息，所以从 1 + removeCount 开始切
              startIndex = 1 + removeCount;
            }

            // 避免截断包含 tool_result 的成对消息，如果切在了 tool_result 上就后移
            while (startIndex < messages.length) {
              const msgAtCut = messages[startIndex];
              if (!msgAtCut) break;
              if (msgAtCut.role === 'user' && Array.isArray(msgAtCut.content) &&
                msgAtCut.content.some(isToolResultContentBlock)) {
                startIndex++;
                continue;
              }
              break;
            }

            newCompacted.push(...messages.slice(startIndex));
            compacted = newCompacted;
            didCompactMessages = true;
            events.onCompactStats?.({
              tokensBefore: currentTokens,
              tokensAfter: estimateTokens(compacted),
            });
            console.warn(`[Compaction Fallback] 回退截断：删除了最旧的 ${startIndex - (isSummary ? 1 : 0)} 条消息，保留了 ${compacted.length} 条`);
            events.onCompact?.(estimateTokens(compacted)); // 使用新的 compacted 估算
          } else {
            // 消息太少，不删除
            compacted = messages;
            console.warn('[Compaction Fallback] 消息数量太少，跳过删除');
          }
        } finally {
          // 总是确保停止 UI 的转圈状态
          events.onCompactEnd?.();
        }
      } else {
        // 不需要压缩，直接使用原始消息
        compacted = messages;
      }

      // CRITICAL FIX: Always validate and fix tool history before sending to API
      // This prevents "tool_call_id is not found" errors caused by corrupted history
      compacted = validateAndFixToolHistory(compacted);

      // CRITICAL FIX: Update the global session messages to the compacted version!
      // This permanently applies the summary/truncation and prevents the session history from growing infinitely.
      messages = compacted;
      if (didCompactMessages) {
        contextTokenSnapshot = createEstimatedContextTokenSnapshot(messages);
        events.onCompactedMessages?.(messages);
      }

      // 流式调用 Provider - with automatic retry for transient errors
      // 注入 API 硬超时保护：防止大型 payload 导致 API 静默丢包引发无限等待
      const API_HARD_TIMEOUT_MS = 600_000; // Issue 084: 提升到 10 分钟硬超时
      const API_IDLE_TIMEOUT_MS = 60_000;  // Issue 084: 60 秒空闲/停滞超时，如果有 delta 刷新则重置

      const result = await withRetry(
        async () => {
          const retryTimeoutController = new AbortController();
          
          let hardTimer = setTimeout(() => {
            retryTimeoutController.abort(new Error("API Hard Timeout (10 minutes)"));
          }, API_HARD_TIMEOUT_MS);
          
          let idleTimer = setTimeout(() => {
            retryTimeoutController.abort(new Error("Stream stalled or delayed response (60s idle)"));
          }, API_IDLE_TIMEOUT_MS);

          const resetIdleTimer = () => {
            clearTimeout(idleTimer);
            if (!retryTimeoutController.signal.aborted) {
              idleTimer = setTimeout(() => {
                retryTimeoutController.abort(new Error("Stream stalled or delayed response (60s idle)"));
              }, API_IDLE_TIMEOUT_MS);
            }
          };

          const retrySignal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
            : retryTimeoutController.signal;

          try {
            return await provider.stream(compacted, KODAX_TOOLS, currentExecution.systemPrompt, currentExecution.providerReasoning, {
              onTextDelta: (text) => {
                resetIdleTimer();
                events.onTextDelta?.(text);
              },
              onThinkingDelta: (text) => {
                resetIdleTimer();
                events.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking) => {
                resetIdleTimer();
                events.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: (name, json) => {
                resetIdleTimer();
                events.onToolInputDelta?.(name, json);
              },
              onRateLimit: (attempt, max, delay) => {
                resetIdleTimer(); // 重试限制时也重置，因为底层 Provider 会自己等待
                events.onProviderRateLimit?.(attempt, max, delay);
              },
              modelOverride: options.modelOverride ?? options.model,
              signal: retrySignal,
            }, retrySignal);
          } catch (e) {
            // Issue 084 fix: Differentiate between user abort and our internal watchdog abort
            if (e instanceof Error && e.name === 'AbortError') {
              // If it's our internal watchdog that triggered the abort (idle or hard timeout)
              if (retryTimeoutController.signal.aborted && !options.abortSignal?.aborted) {
                const reason = retryTimeoutController.signal.reason?.message ?? "Stream stalled";
                // Convert internal timeout to network error so it triggers automatic retry
                const { KodaXNetworkError } = await import('@kodax/ai');
                throw new KodaXNetworkError(reason, true);
              }
            }
            throw e;
          } finally {
            clearTimeout(hardTimer);
            clearTimeout(idleTimer);
          }
        },
        // Default retry classification for provider calls
        {
          category: ErrorCategory.TRANSIENT,
          retryable: true,
          maxRetries: 2,
          retryDelay: 1000,
          shouldCleanup: true,
        },
        (attempt, maxRetries, delay) => {
          events.onRetry?.(
            `API error, retrying in ${Math.round(delay / 1000)}s (${attempt}/${maxRetries})`,
            attempt,
            maxRetries
          );
        }
      );

      // 流式输出结束，通知 CLI 层
      events.onStreamEnd?.();

      lastText = result.textBlocks.map(b => b.text).join(' ');
      const preAssistantTokenSnapshot = createContextTokenSnapshot(compacted, result.usage);

      // Promise 信号检测
      const [signal, _reason] = checkPromiseSignal(lastText);
      if (signal) {
        if (signal === 'COMPLETE') {
          emitIterationEnd(iter + 1, preAssistantTokenSnapshot);
          events.onComplete?.();
          return {
            success: true,
            lastText,
            signal: 'COMPLETE',
            messages,
            sessionId,
            contextTokenSnapshot,
            limitReached: false,
          };
        }
      }

      const assistantContent = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
      messages.push({ role: 'assistant', content: assistantContent });
      const completedTurnTokenSnapshot = createCompletedTurnTokenSnapshot(messages, result.usage);
      contextTokenSnapshot = completedTurnTokenSnapshot;

      if (result.toolBlocks.length === 0) {
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          return {
            success: true,
            lastText,
            messages,
            sessionId,
            contextTokenSnapshot,
            limitReached: false,
          };
        }

        if (
          reasoningPlan.mode === 'auto' &&
          autoFollowUpCount < autoFollowUpLimit &&
          (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0)
        ) {
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: messages.length === 1,
            retryLabelPrefix: 'Auto',
            onApply: () => {
              messages.pop();
            },
          });
          if (rerouteState) {
            ({
              reasoningPlan,
              currentExecution,
              autoFollowUpCount,
              autoDepthEscalationCount,
              autoTaskRerouteCount,
            } = rerouteState);
            contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
            continue;
          }
        }
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        events.onComplete?.();
        // limitReached 保持 false（初始值）
        break;
      }

      // 检测截断 + 自动重试
      const incomplete = checkIncompleteToolCalls(result.toolBlocks);
      if (incomplete.length > 0) {
        incompleteRetryCount++;
        if (incompleteRetryCount <= KODAX_MAX_INCOMPLETE_RETRIES) {
          events.onRetry?.(`Incomplete tool calls: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          messages.pop();
          let retryPrompt: string;
          if (incompleteRetryCount === 1) {
            retryPrompt = `Your previous response was truncated. Missing required parameters:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nPlease provide the complete tool calls with ALL required parameters.\nFor large content, keep it concise (under 50 lines for write operations).`;
          } else {
            retryPrompt = `⚠️ CRITICAL: Your response was TRUNCATED again. This is retry ${incompleteRetryCount}/${KODAX_MAX_INCOMPLETE_RETRIES}.\n\nMISSING PARAMETERS:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nYOU MUST:\n1. For 'write' tool: Keep content under 50 lines - write structure first, fill in later with 'edit'\n2. For 'edit' tool: Keep new_string under 30 lines - make smaller, focused changes\n3. Provide ALL required parameters in your tool call\n\nIf your response is truncated again, the task will FAIL.\nPROVIDE SHORT, COMPLETE PARAMETERS NOW.`;
          }
          messages.push({ role: 'user', content: retryPrompt });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          continue;
        } else {
          // 超过重试次数，过滤掉不完整的工具调用并添加错误结果
          events.onRetry?.(`Max retries exceeded for incomplete tool calls. Skipping: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          const incompleteIds = new Set<string>();
          for (const tc of result.toolBlocks) {
            const required = KODAX_TOOL_REQUIRED_PARAMS[tc.name] ?? [];
            const input = (tc.input ?? {}) as Record<string, unknown>;
            for (const param of required) {
              if (input[param] === undefined || input[param] === null || input[param] === '') {
                incompleteIds.add(tc.id);
                break;
              }
            }
          }
          // 直接添加错误结果，不执行不完整的工具调用
          const errorResults: KodaXToolResultBlock[] = [];
          for (const id of incompleteIds) {
            const tc = result.toolBlocks.find(t => t.id === id);
            if (tc) {
              const errorMsg = `[Tool Error] ${tc.name}: Skipped due to missing required parameters after ${KODAX_MAX_INCOMPLETE_RETRIES} retries`;
              events.onToolResult?.({ id: tc.id, name: tc.name, content: errorMsg });
              errorResults.push(createToolResultBlock(tc.id, errorMsg));
            }
          }
          messages.push({ role: 'user', content: errorResults });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          incompleteRetryCount = 0;
          continue;
        }
      } else {
        incompleteRetryCount = 0;
      }

      // 执行工具
      const toolResults: KodaXToolResultBlock[] = [];

      if (options.parallel && result.toolBlocks.length > 1) {
        // 分离 bash（顺序）和非 bash（并行）
        const bashTools = result.toolBlocks.filter(tc => tc.name === 'bash');
        const nonBashTools = result.toolBlocks.filter(tc => tc.name !== 'bash');
        const resultMap = new Map<string, string>();

        if (nonBashTools.length > 0) {
          const promises = nonBashTools.map(async tc => ({
            id: tc.id,
            content: (
              await applyToolResultGuardrail(
                tc.name,
                await executeToolCall(events, {
                  id: tc.id,
                  name: tc.name,
                  input: tc.input as Record<string, unknown> | undefined,
                }, ctx),
                ctx,
              )
            ).content,
          }));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
          const content = (
            await applyToolResultGuardrail(
              tc.name,
              await executeToolCall(events, {
                id: tc.id,
                name: tc.name,
                input: tc.input as Record<string, unknown> | undefined,
              }, ctx),
              ctx,
            )
          ).content;
          resultMap.set(tc.id, content);
        }

        for (const tc of result.toolBlocks) {
          const content = resultMap.get(tc.id) ?? '[Error] No result';
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push(createToolResultBlock(tc.id, content));
        }
      } else {
        for (const tc of result.toolBlocks) {
          const content = (
            await applyToolResultGuardrail(
              tc.name,
              await executeToolCall(events, {
                id: tc.id,
                name: tc.name,
                input: tc.input as Record<string, unknown> | undefined,
              }, ctx),
              ctx,
            )
          ).content;
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push(createToolResultBlock(tc.id, content));
        }
      }

      // Check if any tool was cancelled by user - 检查是否有工具被用户取消
      const hasCancellation = toolResults.some(r =>
        typeof r.content === 'string' && isCancelledToolResultContent(r.content)
      );

      if (hasCancellation) {
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        // User cancelled - add results and exit loop - 用户取消，添加结果并退出循环
        messages.push({ role: 'user', content: toolResults });
        // Tool results are already appended, so emit the post-tool rebased snapshot here.
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, contextTokenSnapshot);
        }
        events.onStreamEnd?.();
        return {
          success: true,
          lastText: 'Operation cancelled by user',
          messages,
          sessionId,
          contextTokenSnapshot,
          interrupted: !shouldYieldToQueuedFollowUp,
        };
      }

      messages.push({ role: 'user', content: toolResults });
      // Keep UI/context accounting aligned with the tool-result message we just appended.
      contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);

      const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
      if (shouldYieldToQueuedFollowUp) {
        emitIterationEnd(iter + 1, contextTokenSnapshot);
        return {
          success: true,
          lastText,
          messages,
          sessionId,
          contextTokenSnapshot,
          limitReached: false,
        };
      }

      if (
        reasoningPlan.mode === 'auto' &&
        autoFollowUpCount < autoFollowUpLimit &&
        (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0)
      ) {
        const toolEvidence = summarizeToolEvidence(result.toolBlocks, toolResults);
        if (toolEvidence) {
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: false,
            retryLabelPrefix: 'Post-tool auto',
            toolEvidence,
            persistSession: {
              sessionId,
              messages,
              title,
            },
          });

          if (rerouteState) {
            ({
              reasoningPlan,
              currentExecution,
              autoFollowUpCount,
              autoDepthEscalationCount,
              autoTaskRerouteCount,
            } = rerouteState);
            continue;
          }
        }
      }

      // 保存会话
      await saveSessionSnapshot(options, sessionId, { messages, title });

      // Notify UI of context usage after each iteration
      emitIterationEnd(iter + 1, contextTokenSnapshot);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // CRITICAL FIX: Always clean incomplete tool calls AND validate entire history
      // This prevents "tool_call_id not found" errors on next API call
      let cleanedMessages = cleanupIncompleteToolCalls(messages);
      cleanedMessages = validateAndFixToolHistory(cleanedMessages);

      // Update error metadata - increment consecutive error count
      const updatedErrorMetadata: SessionErrorMetadata = {
        lastError: error.message,
        lastErrorTime: Date.now(),
        consecutiveErrors: (errorMetadata?.consecutiveErrors ?? 0) + 1,
      };

      // Save session with error metadata
      await saveSessionSnapshot(options, sessionId, {
        messages: cleanedMessages,
        title,
        errorMetadata: updatedErrorMetadata,
      });
      contextTokenSnapshot = createEstimatedContextTokenSnapshot(cleanedMessages);

      // 检查是否为 AbortError（用户中断）
      // 参考 Gemini CLI: 静默处理中断，不报告为错误
      if (error.name === 'AbortError') {
        events.onStreamEnd?.();

        // Issue 072 fix: 清理不完整的 tool_use 块
        // 当流式中断时，assistant 消息可能包含 tool_use 但没有对应的 tool_result
        // 这会导致下次请求时 API 报错 "tool_call_id not found"
        return {
          success: true,  // 中断不算失败
          lastText,
          messages: cleanedMessages,
          sessionId,
          contextTokenSnapshot,
          interrupted: true,
          errorMetadata: updatedErrorMetadata,
        };
      }

      events.onError?.(error);
      return {
        success: false,
        lastText,
        messages: cleanedMessages,  // ✅ Use cleaned messages to prevent error loop
        sessionId,
        contextTokenSnapshot,
        errorMetadata: updatedErrorMetadata,
      };
    }
  }

  // 达到迭代上限 - 循环完成所有迭代没有提前退出
  // 如果代码执行到这里，说明循环正常结束（没有 COMPLETE、中断或错误）
  limitReached = true;

  // 最终保存
  await saveSessionSnapshot(options, sessionId, { messages, title });

  // 检查最终信号
  const [finalSignal, finalReason] = checkPromiseSignal(lastText);

  // 达到迭代上限 (循环正常结束但没有 COMPLETE 信号且没有提前退出)
  // 使用 limitReached 变量来准确判断
  return {
    success: true,
    lastText,
    signal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    signalReason: finalReason,
    messages,
    sessionId,
    contextTokenSnapshot,
    limitReached,
  };
}

async function buildReasoningExecutionState(
  options: KodaXOptions,
  reasoningPlan: ReasoningPlan,
  isNewSession: boolean,
): Promise<{
  effectiveOptions: KodaXOptions;
  systemPrompt: string;
  providerReasoning: {
    enabled: boolean;
    mode: KodaXReasoningMode;
    depth: KodaXThinkingDepth;
    taskType: KodaXTaskType;
    executionMode: KodaXExecutionMode;
  };
}> {
  const effectiveOptions: KodaXOptions = {
    ...options,
    reasoningMode: reasoningPlan.mode,
    context: {
      ...options.context,
      executionCwd: resolveExecutionCwd(options.context),
      promptOverlay: [
        options.context?.promptOverlay,
        reasoningPlan.promptOverlay,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  };

  return {
    effectiveOptions,
    systemPrompt: await buildSystemPrompt(effectiveOptions, isNewSession),
    providerReasoning: {
      enabled: reasoningPlan.depth !== 'off',
      mode: reasoningPlan.mode,
      depth: reasoningPlan.depth,
      taskType: reasoningPlan.decision.primaryTask,
      executionMode: reasoningPlan.decision.recommendedMode,
    },
  };
}

/**
 * 获取 Git 根目录
 */
function summarizeToolEvidence(
  toolBlocks: Array<{ id: string; name: string }>,
  toolResults: KodaXToolResultBlock[],
): string {
  const evidenceLines: string[] = [];

  for (const result of toolResults) {
    if (typeof result.content !== 'string') {
      continue;
    }

    const toolName = toolBlocks.find((tool) => tool.id === result.tool_use_id)?.name ?? 'tool';
    const content = result.content.replace(/\s+/g, ' ').trim();
    if (!content || !looksLikeToolRuntimeEvidence(content)) {
      continue;
    }

    const truncated =
      content.length > 220 ? `${content.slice(0, 217)}...` : content;
    evidenceLines.push(`- ${toolName}: ${truncated}`);
  }

  return Array.from(new Set(evidenceLines)).slice(0, 5).join('\n');
}

function looksLikeToolRuntimeEvidence(content: string): boolean {
  return looksLikeActionableRuntimeEvidence(content);
}

async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

// 导出 Client 类
export { KodaXClient } from './client.js';

// 导出工具函数
export { cleanupIncompleteToolCalls, validateAndFixToolHistory };
