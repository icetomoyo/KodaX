/**
 * KodaX Agent
 *
 * Agent 主循环 - Core 层核心入口
 */

import { KodaXOptions, KodaXResult, KodaXMessage, KodaXToolResultBlock, KodaXToolExecutionContext } from './types.js';
import { KodaXClient } from './client.js';
import { getProvider } from './providers/index.js';
import { executeTool, KODAX_TOOLS } from './tools/index.js';
import { computeConfirmTools } from './tools/permission.js';
import { buildSystemPrompt } from './prompts/index.js';
import { generateSessionId, extractTitleFromMessages } from './session.js';
import { compactMessages, checkIncompleteToolCalls } from './messages.js';
import { estimateTokens } from './tokenizer.js';
import { KODAX_MAX_INCOMPLETE_RETRIES, PROMISE_PATTERN, KODAX_TOOL_REQUIRED_PARAMS } from './constants.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  const maxIter = options.maxIter ?? 50;
  const events = options.events ?? {};

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

  // 优先使用 initialMessages（用于交互式模式的多轮对话）
  if (options.session?.initialMessages && options.session.initialMessages.length > 0) {
    messages = [...options.session.initialMessages];
    title = extractTitleFromMessages(messages);
  } else if (options.session?.storage && sessionId) {
    const loaded = await options.session.storage.load(sessionId);
    if (loaded) {
      messages = loaded.messages;
      title = loaded.title;
    }
  }

  messages.push({ role: 'user', content: prompt });
  if (!title) title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');

  const permissionMode = options.permissionMode ?? 'default';
  const ctx: KodaXToolExecutionContext = {
    permissionMode,
    confirmTools: options.confirmTools ?? computeConfirmTools(permissionMode),
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    onConfirm: events?.onConfirm,
    beforeToolExecute: options.beforeToolExecute,
  };

  const systemPrompt = await buildSystemPrompt(options, messages.length === 1);

  // 通知会话开始
  events.onSessionStart?.({ provider: provider.name, sessionId });

  let lastText = '';
  let incompleteRetryCount = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    try {
      events.onIterationStart?.(iter + 1, maxIter);

      const compacted = compactMessages(messages);
      if (compacted !== messages) {
        events.onCompact?.(estimateTokens(messages));
      }

      // 流式调用 Provider
      const result = await provider.stream(compacted, KODAX_TOOLS, systemPrompt, options.thinking, {
        onTextDelta: (text) => events.onTextDelta?.(text),
        onThinkingDelta: (text) => events.onThinkingDelta?.(text),
        onThinkingEnd: (thinking) => events.onThinkingEnd?.(thinking),
        onToolInputDelta: (name, json) => events.onToolInputDelta?.(name, json),
        signal: options.abortSignal,
      }, options.abortSignal);

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
          };
        }
      }

      const assistantContent = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
      messages.push({ role: 'assistant', content: assistantContent });

      if (result.toolBlocks.length === 0) {
        events.onComplete?.();
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
          const promises = nonBashTools.map(tc => executeTool(tc.name, tc.input, ctx).then(r => ({ id: tc.id, content: r })));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
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
          const content = await executeTool(tc.name, tc.input, ctx);
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      // 保存会话
      if (options.session?.storage) {
        const gitRoot = await getGitRoot();
        await options.session.storage.save(sessionId, { messages, title, gitRoot: gitRoot ?? '' });
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // 检查是否为 AbortError（用户中断）
      // 参考 Gemini CLI: 静默处理中断，不报告为错误
      if (error.name === 'AbortError') {
        events.onStreamEnd?.();
        return {
          success: true,  // 中断不算失败
          lastText,
          messages,
          sessionId,
          interrupted: true,
        };
      }

      events.onError?.(error);
      return {
        success: false,
        lastText,
        messages,
        sessionId,
      };
    }
  }

  // 最终保存
  if (options.session?.storage) {
    const gitRoot = await getGitRoot();
    await options.session.storage.save(sessionId, { messages, title, gitRoot: gitRoot ?? '' });
  }

  // 检查最终信号
  const [finalSignal, finalReason] = checkPromiseSignal(lastText);

  return {
    success: true,
    lastText,
    signal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    signalReason: finalReason,
    messages,
    sessionId,
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
