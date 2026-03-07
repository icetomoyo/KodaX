/**
 * KodaX Agent
 *
 * Agent 主循环 - Core 层核心入口
 */

import { KodaXOptions, KodaXResult, KodaXToolResultBlock, KodaXToolExecutionContext, SessionErrorMetadata } from './types.js';
import type { KodaXMessage } from '@kodax/ai';
import { KodaXClient } from './client.js';
import { getProvider } from './providers/index.js';
import { executeTool, KODAX_TOOLS } from './tools/index.js';
import { buildSystemPrompt } from './prompts/index.js';
import { generateSessionId, extractTitleFromMessages } from './session.js';
import { compactMessages, checkIncompleteToolCalls } from './messages.js';
import { compact as intelligentCompact, needsCompaction, type CompactionConfig } from '@kodax/agent';
import { loadCompactionConfig } from './compaction-config.js';
import { estimateTokens } from './tokenizer.js';
import { KODAX_MAX_INCOMPLETE_RETRIES, PROMISE_PATTERN, KODAX_TOOL_REQUIRED_PARAMS } from './constants.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ErrorCategory } from './error-classification.js';
import { withRetry } from './retry-handler.js';

const execAsync = promisify(exec);

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

    // 收集所有 tool_result 中出现的 tool_use_id（在后续的 user 消息中）
    const toolResultIds = new Set<string>();
    for (let i = messages.length - 1; i < messages.length; i++) {
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

/**
 * 运行 KodaX Agent
 * 核心入口函数 - 极简 API
 */
export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const provider = getProvider(options.provider);
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

  messages.push({ role: 'user', content: prompt });
  if (!title) title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');

  // Simplified context - no permission fields (handled by REPL layer)
  const ctx: KodaXToolExecutionContext = {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
  };

  const systemPrompt = await buildSystemPrompt(options, messages.length === 1);

  // 通知会话开始
  events.onSessionStart?.({ provider: provider.name, sessionId });

  let lastText = '';
  let incompleteRetryCount = 0;
  let limitReached = false; // Track if we exited due to iteration limit - 追踪是否因达到迭代上限而退出

  for (let iter = 0; iter < maxIter; iter++) {
    try {
      events.onIterationStart?.(iter + 1, maxIter);

      // Compaction: use new intelligent compaction if enabled, otherwise fall back to legacy
      let compacted: KodaXMessage[];

      if (compactionConfig.enabled && needsCompaction(messages, compactionConfig, contextWindow)) {
        // Use new intelligent compaction
        try {
          const result = await intelligentCompact(
            messages,
            compactionConfig,
            provider,
            contextWindow,
            undefined, // customInstructions
            systemPrompt // 传入 systemPrompt 以生成更好的摘要
          );

          if (result.compacted) {
            compacted = result.messages;
            events.onCompact?.(result.tokensBefore);
          } else {
            compacted = result.messages;
          }
        } catch (error) {
          // 改进的错误回退逻辑：告知用户并删除最老的10%消息
          console.error('[Compaction Error] LLM摘要失败，回退到简单截断:', error);

          // 计算删除10%的消息
          const removeCount = Math.ceil(messages.length * 0.1);
          if (removeCount > 0 && messages.length > removeCount) {
            compacted = messages.slice(removeCount);
            console.warn(`[Compaction Fallback] 删除了最老的 ${removeCount} 条消息，保留 ${compacted.length} 条`);
            events.onCompact?.(estimateTokens(messages));
          } else {
            // 消息太少，不删除
            compacted = messages;
            console.warn('[Compaction Fallback] 消息数量太少，跳过删除');
          }
        }
      } else {
        // Use legacy compaction
        compacted = compactMessages(messages);
        if (compacted !== messages) {
          events.onCompact?.(estimateTokens(messages));
        }
      }

      // 流式调用 Provider - with automatic retry for transient errors
      const result = await withRetry(
        () => provider.stream(compacted, KODAX_TOOLS, systemPrompt, options.thinking, {
          onTextDelta: (text) => events.onTextDelta?.(text),
          onThinkingDelta: (text) => events.onThinkingDelta?.(text),
          onThinkingEnd: (thinking) => events.onThinkingEnd?.(thinking),
          onToolInputDelta: (name, json) => events.onToolInputDelta?.(name, json),
          signal: options.abortSignal,
        }, options.abortSignal),
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

      // Promise 信号检测
      const [signal, _reason] = checkPromiseSignal(lastText);
      if (signal) {
        if (signal === 'COMPLETE') {
          events.onComplete?.();
          return {
            success: true,
            lastText,
            signal: 'COMPLETE',
            messages,
            sessionId,
            limitReached: false,
          };
        }
      }

      const assistantContent = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
      messages.push({ role: 'assistant', content: assistantContent });

      if (result.toolBlocks.length === 0) {
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
              errorResults.push({ type: 'tool_result', tool_use_id: tc.id, content: errorMsg, is_error: true });
            }
          }
          messages.push({ role: 'user', content: errorResults });
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
          const promises = nonBashTools.map(async tc => {
            // Permission hook - allow REPL layer to control execution
            if (events.beforeToolExecute) {
              const allowed = await events.beforeToolExecute(tc.name, tc.input as Record<string, unknown>);
              if (!allowed) {
                return { id: tc.id, content: '[Cancelled] Operation cancelled by user' };
              }
            }
            const r = await executeTool(tc.name, tc.input, ctx);
            return { id: tc.id, content: r };
          });
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
          // Permission hook - allow REPL layer to control execution
          if (events.beforeToolExecute) {
            const allowed = await events.beforeToolExecute(tc.name, tc.input as Record<string, unknown>);
            if (!allowed) {
              resultMap.set(tc.id, '[Cancelled] Operation cancelled by user');
              continue;
            }
          }
          const content = await executeTool(tc.name, tc.input, ctx);
          resultMap.set(tc.id, content);
        }

        for (const tc of result.toolBlocks) {
          const content = resultMap.get(tc.id) ?? '[Error] No result';
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      } else {
        for (const tc of result.toolBlocks) {
          events.onToolUseStart?.({ name: tc.name, id: tc.id });
          // Permission hook - allow REPL layer to control execution
          let content: string;
          if (events.beforeToolExecute) {
            const allowed = await events.beforeToolExecute(tc.name, tc.input as Record<string, unknown>);
            if (!allowed) {
              content = '[Cancelled] Operation cancelled by user';
            } else {
              content = await executeTool(tc.name, tc.input, ctx);
            }
          } else {
            content = await executeTool(tc.name, tc.input, ctx);
          }
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      }

      // Check if any tool was cancelled by user - 检查是否有工具被用户取消
      const hasCancellation = toolResults.some(r =>
        typeof r.content === 'string' && r.content.startsWith('[Cancelled]')
      );

      if (hasCancellation) {
        // User cancelled - add results and exit loop - 用户取消，添加结果并退出循环
        messages.push({ role: 'user', content: toolResults });
        events.onStreamEnd?.();
        return {
          success: true,
          lastText: 'Operation cancelled by user',
          messages,
          sessionId,
          interrupted: true,
        };
      }

      messages.push({ role: 'user', content: toolResults });

      // 保存会话
      if (options.session?.storage) {
        const gitRoot = await getGitRoot();
        await options.session.storage.save(sessionId, { messages, title, gitRoot: gitRoot ?? '' });
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // CRITICAL FIX: Always clean incomplete tool calls on ANY error
      // This prevents "tool_call_id not found" errors on next API call
      const cleanedMessages = cleanupIncompleteToolCalls(messages);

      // Update error metadata - increment consecutive error count
      const updatedErrorMetadata: SessionErrorMetadata = {
        lastError: error.message,
        lastErrorTime: Date.now(),
        consecutiveErrors: (errorMetadata?.consecutiveErrors ?? 0) + 1,
      };

      // Save session with error metadata
      if (options.session?.storage) {
        const gitRoot = await getGitRoot();
        await options.session.storage.save(sessionId, {
          messages: cleanedMessages,
          title,
          gitRoot: gitRoot ?? '',
          errorMetadata: updatedErrorMetadata,
        });
      }

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
        errorMetadata: updatedErrorMetadata,
      };
    }
  }

  // 达到迭代上限 - 循环完成所有迭代没有提前退出
  // 如果代码执行到这里，说明循环正常结束（没有 COMPLETE、中断或错误）
  limitReached = true;

  // 最终保存
  if (options.session?.storage) {
    const gitRoot = await getGitRoot();
    await options.session.storage.save(sessionId, { messages, title, gitRoot: gitRoot ?? '' });
  }

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
    limitReached,
  };
}

/**
 * 获取 Git 根目录
 */
async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

// 导出 Client 类
export { KodaXClient } from './client.js';

// 导出工具函数
export { cleanupIncompleteToolCalls };
