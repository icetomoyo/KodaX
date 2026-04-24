/**
 * KodaX Agent
 *
 * Agent 主循环 - Core 层核心入口
 */

import {
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExecutionMode,
  KodaXEvents,
  KodaXJsonValue,
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXRepoIntelligenceCarrier,
  KodaXRepoIntelligenceMode,
  KodaXReasoningMode,
  KodaXResult,
  KodaXTaskType,
  KodaXThinkingDepth,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
  SessionErrorMetadata,
} from './types.js';
import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';
import { createCostTracker, recordUsage, getSummary, formatCostReport, KODAX_ESCALATED_MAX_OUTPUT_TOKENS, type CostTracker } from '@kodax/ai';
import path from 'path';
import fsSync from 'fs';
// FEATURE_093 (v0.7.24): `KodaXClient` is only re-exported from this module
// for backward compatibility. Importing it here creates a cycle
// (agent ↔ client, since client imports `runKodaX` from this file). The
// public barrel `index.ts` re-exports `KodaXClient` directly from
// `./client.js` instead — see line ~592.
import { resolveProvider } from './providers/index.js';
import {
  executeTool,
  filterMcpToolNames,
  filterRepoIntelligenceWorkingToolNames,
  getRequiredToolParams,
  inspectEditFailure,
  listToolDefinitions,
  parseEditToolError,
} from './tools/index.js';
import {
  isManagedProtocolToolName,
  mergeManagedProtocolPayload,
  getManagedBlockNameForRole,
  hasManagedProtocolForRole,
  textContainsManagedBlock,
  MANAGED_PROTOCOL_TOOL_NAME,
} from './managed-protocol.js';
import { buildSystemPrompt } from './prompts/index.js';
import { generateSessionId, extractTitleFromMessages } from './session.js';
import { checkIncompleteToolCalls } from './messages.js';
// FEATURE_076 Q4: load-time normalization for pre-v0.7.25 session messages.
import { normalizeLoadedSessionMessages } from './task-engine/_internal/round-boundary.js';
import { compact as intelligentCompact, needsCompaction, microcompact, DEFAULT_MICROCOMPACTION_CONFIG, buildPostCompactAttachments, buildFileContentMessages, injectPostCompactAttachments, DEFAULT_POST_COMPACT_CONFIG, POST_COMPACT_TOKEN_BUDGET, type CompactionConfig, type CompactionUpdate } from '@kodax/agent';
import { loadCompactionConfig } from './compaction-config.js';
import { estimateTokens } from './tokenizer.js';
import { KODAX_MAX_INCOMPLETE_RETRIES, KODAX_MAX_MAXTOKENS_RETRIES, PROMISE_PATTERN, CANCELLED_TOOL_RESULT_PREFIX, CANCELLED_TOOL_RESULT_MESSAGE } from './constants.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { waitForRetryDelay } from './retry-handler.js';
import {
  resolveResilienceConfig,
  classifyResilienceError,
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from './resilience/index.js';
import {
  buildPromptMessageContent,
  extractComparableUserMessageText,
} from './input-artifacts.js';
import {
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  maybeCreateAutoReroutePlan,
  reasoningModeToDepth,
  type ReasoningPlan,
} from './reasoning.js';
import {
  buildProviderPolicyPromptNotes,
  evaluateProviderPolicy,
} from './provider-policy.js';
import { looksLikeActionableRuntimeEvidence } from './runtime-evidence.js';
import { resolveExecutionCwd, resolveExecutionPath } from './runtime-paths.js';
import { buildRepoIntelligenceContext } from './repo-intelligence/index.js';
import {
  getImpactEstimate,
  getModuleContext,
  getRepoPreturnBundle,
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
} from './repo-intelligence/runtime.js';
import {
  renderImpactEstimate,
  renderModuleContext,
} from './repo-intelligence/query.js';
import { createRepoIntelligenceTraceEvent } from './repo-intelligence/trace-events.js';
import {
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  createEstimatedContextTokenSnapshot,
  rebaseContextTokenSnapshot,
  resolveContextTokenCount,
} from './token-accounting.js';
import { applyToolResultGuardrail } from './tools/tool-result-policy.js';
import {
  emitActiveExtensionEvent,
  getActiveExtensionRuntime,
  runActiveExtensionHook,
  setActiveExtensionRuntime,
  KodaXExtensionRuntime,
} from './extensions/runtime.js';

const execAsync = promisify(exec);
type AutoReroutePlan = Awaited<ReturnType<typeof maybeCreateAutoReroutePlan>>;
type RunnableToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
};
type MessageContentBlock = Exclude<KodaXMessage['content'], string>[number];

interface RuntimeSessionState {
  queuedMessages: KodaXMessage[];
  extensionState: Map<string, Map<string, KodaXJsonValue>>;
  extensionRecords: KodaXExtensionSessionRecord[];
  activeTools: string[];
  editRecoveryAttempts: Map<string, number>;
  blockedEditWrites: Set<string>;
  lastToolErrorCode?: string;
  lastToolResultBytes?: number;
  modelSelection: {
    provider?: string;
    model?: string;
  };
  thinkingLevel?: KodaXReasoningMode;
}

interface ProviderPrepareState {
  provider: string;
  model?: string;
  reasoningMode?: KodaXReasoningMode;
  systemPrompt: string;
  blockedReason?: string;
}

/** FEATURE_067 v3: Filter tools excluded for child agents at API level. */
function filterExcludedTools(
  tools: string[],
  excludeTools: readonly string[] | undefined,
): string[] {
  if (!excludeTools || excludeTools.length === 0) return tools;
  const excluded = new Set(excludeTools);
  return tools.filter((name) => !excluded.has(name));
}

function shouldEmitRepoIntelligenceTrace(options: KodaXOptions): boolean {
  return options.context?.repoIntelligenceTrace === true
    || process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1';
}

function emitRepoIntelligenceTrace(
  events: KodaXEvents | undefined,
  options: KodaXOptions,
  stage: 'routing' | 'preturn' | 'module' | 'impact',
  carrier: KodaXRepoIntelligenceCarrier | null | undefined,
  detail?: string,
): void {
  if (!events?.onRepoIntelligenceTrace || !shouldEmitRepoIntelligenceTrace(options) || !carrier) {
    return;
  }
  const traceEvent = createRepoIntelligenceTraceEvent(stage, carrier, detail);
  if (traceEvent) {
    events.onRepoIntelligenceTrace(traceEvent);
  }
}

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
 * Graceful compact degradation: drop oldest atomic blocks (tool_use + tool_result pairs)
 * one at a time from the front until tokens are below the target threshold.
 * Preserves summary messages, message structure integrity, and recent context.
 */
function gracefulCompactDegradation(
  messages: KodaXMessage[],
  contextWindow: number,
  config: CompactionConfig,
): KodaXMessage[] {
  const targetTokens = Math.floor(contextWindow * (config.triggerPercent / 100) * 0.8);

  // Find the first non-summary message index
  let startIdx = 0;
  const firstMsg = messages[0];
  if (firstMsg && (firstMsg.role === 'system' || (
    firstMsg.role === 'user' && typeof firstMsg.content === 'string'
    && firstMsg.content.includes('[对话历史摘要]')
  ))) {
    startIdx = 1;
  }

  let dropIdx = startIdx;
  while (dropIdx < messages.length && estimateTokens(messages) > targetTokens) {
    const msg = messages[dropIdx];
    if (!msg) break;

    const hasToolUse = msg.role === 'assistant' && Array.isArray(msg.content)
      && msg.content.some((b: unknown) => isTypedContentBlock(b) && b.type === 'tool_use');
    const hasToolResult = msg.role === 'user' && Array.isArray(msg.content)
      && msg.content.some(isToolResultContentBlock);

    // Forward pair: assistant(tool_use) followed by user(tool_result) → drop both
    if (hasToolUse) {
      const nextMsg = messages[dropIdx + 1];
      const nextHasResult = nextMsg?.role === 'user' && Array.isArray(nextMsg.content)
        && nextMsg.content.some(isToolResultContentBlock);
      if (nextHasResult) {
        messages = [...messages.slice(0, dropIdx), ...messages.slice(dropIdx + 2)];
        continue;
      }
      // No paired tool_result follows — skip to preserve tool pairing invariant
      dropIdx++;
      continue;
    }

    // Backward pair: user(tool_result) preceded by assistant(tool_use) → drop both
    if (hasToolResult) {
      const prevMsg = messages[dropIdx - 1];
      const prevHasUse = prevMsg?.role === 'assistant' && Array.isArray(prevMsg.content)
        && prevMsg.content.some((b: unknown) => isTypedContentBlock(b) && b.type === 'tool_use');
      if (prevHasUse) {
        messages = [...messages.slice(0, dropIdx - 1), ...messages.slice(dropIdx + 1)];
        continue;
      }
      // No paired assistant precedes — skip to preserve tool pairing invariant
      dropIdx++;
      continue;
    }

    // Non-tool message — safe to drop individually
    messages = [...messages.slice(0, dropIdx), ...messages.slice(dropIdx + 1)];
  }

  return messages;
}

function normalizeQueuedRuntimeMessage(message: string | KodaXMessage): KodaXMessage {
  return typeof message === 'string'
    ? { role: 'user', content: message }
    : message;
}

function normalizeRuntimeModelSelection(
  next: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  const normalized: { provider?: string; model?: string } = {};
  if (next.provider?.trim()) {
    normalized.provider = next.provider.trim();
  }
  if (next.model?.trim()) {
    normalized.model = next.model.trim();
  }
  return normalized;
}

export function describeTransientProviderRetry(error: Error): string {
  const message = error.message.toLowerCase();
  if (error.name === 'StreamIncompleteError' || message.includes('stream incomplete')) {
    return 'Stream interrupted before completion';
  }
  if (message.includes('stream stalled') || message.includes('delayed response') || message.includes('60s idle')) {
    return 'Stream stalled';
  }
  if (message.includes('hard timeout') || message.includes('10 minutes')) {
    return 'Provider response timed out';
  }
  if (
    message.includes('socket hang up')
    || message.includes('connection error')
    || message.includes('econnrefused')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || message.includes('network')
  ) {
    return 'Provider connection error';
  }
  if (message.includes('timed out') || message.includes('timeout') || message.includes('etimedout')) {
    return 'Provider request timed out';
  }
  if (message.includes('aborted')) {
    return 'Provider stream aborted';
  }
  return 'Transient provider error';
}

function createRuntimeExtensionState(
  persisted?: KodaXExtensionSessionState,
): Map<string, Map<string, KodaXJsonValue>> {
  const state = new Map<string, Map<string, KodaXJsonValue>>();
  if (!persisted) {
    return state;
  }

  for (const [extensionId, values] of Object.entries(persisted)) {
    state.set(extensionId, new Map(Object.entries(values)));
  }

  return state;
}

function snapshotRuntimeExtensionState(
  state: RuntimeSessionState['extensionState'],
): KodaXExtensionSessionState | undefined {
  const snapshot: KodaXExtensionSessionState = {};

  for (const [extensionId, values] of state.entries()) {
    if (values.size === 0) {
      continue;
    }

    snapshot[extensionId] = Object.fromEntries(values.entries());
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function getExtensionStateBucket(
  state: RuntimeSessionState['extensionState'],
  extensionId: string,
): Map<string, KodaXJsonValue> {
  const existing = state.get(extensionId);
  if (existing) {
    return existing;
  }

  const next = new Map<string, KodaXJsonValue>();
  state.set(extensionId, next);
  return next;
}

function createSessionRecordId(): string {
  return `extrec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createExtensionRuntimeSessionController(
  state: RuntimeSessionState,
) {
  return {
    queueUserMessage: (message: KodaXMessage) => {
      state.queuedMessages.push(normalizeQueuedRuntimeMessage(message));
    },
    getSessionState: <T = KodaXJsonValue>(extensionId: string, key: string) =>
      state.extensionState.get(extensionId)?.get(key) as T | undefined,
    setSessionState: (extensionId: string, key: string, value: KodaXJsonValue | undefined) => {
      const bucket = getExtensionStateBucket(state.extensionState, extensionId);
      if (value === undefined) {
        bucket.delete(key);
        if (bucket.size === 0) {
          state.extensionState.delete(extensionId);
        }
        return;
      }
      bucket.set(key, value);
    },
    getSessionStateSnapshot: (extensionId: string) =>
      Object.fromEntries((state.extensionState.get(extensionId) ?? new Map()).entries()),
    appendSessionRecord: (
      extensionId: string,
      type: string,
      data?: KodaXJsonValue,
      options?: { dedupeKey?: string },
    ) => {
      const normalizedType = type.trim();
      const dedupeKey = options?.dedupeKey?.trim() || undefined;
      const record: KodaXExtensionSessionRecord = {
        id: createSessionRecordId(),
        extensionId,
        type: normalizedType,
        ts: Date.now(),
        ...(data === undefined ? {} : { data }),
        ...(dedupeKey ? { dedupeKey } : {}),
      };

      if (dedupeKey) {
        const existingIndex = state.extensionRecords.findIndex((entry) =>
          entry.extensionId === extensionId
          && entry.type === normalizedType
          && entry.dedupeKey === dedupeKey,
        );
        if (existingIndex >= 0) {
          state.extensionRecords.splice(existingIndex, 1, record);
          return record;
        }
      }

      state.extensionRecords.push(record);
      return record;
    },
    listSessionRecords: (extensionId: string, type?: string) =>
      state.extensionRecords
        .filter((record) =>
          record.extensionId === extensionId
          && (type === undefined || record.type === type),
        )
        .map((record) => ({ ...record })),
    clearSessionRecords: (extensionId: string, type?: string) => {
      const before = state.extensionRecords.length;
      state.extensionRecords = state.extensionRecords.filter((record) =>
        record.extensionId !== extensionId
        || (type !== undefined && record.type !== type),
      );
      return before - state.extensionRecords.length;
    },
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (toolNames: string[]) => {
      state.activeTools = Array.from(
        new Set(toolNames.map((name) => name.trim()).filter(Boolean)),
      );
    },
    getModelSelection: () => ({ ...state.modelSelection }),
    setModelSelection: (next: { provider?: string; model?: string }) => {
      state.modelSelection = normalizeRuntimeModelSelection(next);
    },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level: KodaXReasoningMode) => {
      state.thinkingLevel = level;
    },
  };
}

function getActiveToolDefinitions(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  allowManagedProtocolTool = false,
  hasCapabilityRuntime = false,
): ReturnType<typeof listToolDefinitions> {
  const allTools = listToolDefinitions();
  if (activeToolNames.length === 0) {
    return [];
  }

  const allowed = new Set(
    getRuntimeActiveToolNames(activeToolNames, repoIntelligenceMode, hasCapabilityRuntime),
  );
  return allTools.filter((tool) => (
    allowed.has(tool.name)
    && (allowManagedProtocolTool || !isManagedProtocolToolName(tool.name))
  ));
}

function getRuntimeActiveToolNames(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  hasCapabilityRuntime = false,
): string[] {
  let result = resolveKodaXAutoRepoMode(repoIntelligenceMode) === 'off'
    ? filterRepoIntelligenceWorkingToolNames(activeToolNames)
    : activeToolNames;
  if (!hasCapabilityRuntime) {
    result = filterMcpToolNames(result);
  }
  return result;
}

function appendQueuedRuntimeMessages(
  messages: KodaXMessage[],
  runtimeSessionState: RuntimeSessionState,
): boolean {
  if (runtimeSessionState.queuedMessages.length === 0) {
    return false;
  }

  messages.push(...runtimeSessionState.queuedMessages.splice(0));
  return true;
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
      // Guard: after tool_use removal + microcompaction clearing thinking text,
      // an assistant message might only contain cleared thinking blocks (thinking: '')
      // and/or empty text blocks (text: ''). Providers like Kimi reject these as
      // "empty" (400 error). Inject minimal placeholder to preserve message alternation
      // — dropping the message would orphan adjacent tool_result blocks.
      if (msg.role === 'assistant') {
        const hasSubstantiveContent = fixedContent.some((block) => {
          if (!block || typeof block !== 'object' || !('type' in block)) return false;
          const b = block as { type: string; text?: string; thinking?: string };
          if (b.type === 'tool_use') return true;
          if (b.type === 'text') return !!b.text;
          if (b.type === 'thinking') return !!b.thinking;
          return true; // preserve unknown block types
        });
        if (!hasSubstantiveContent) {
          fixedMessages.push({ ...msg, content: [{ type: 'text', text: '...' }] });
          continue;
        }
      }
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

const MUTATION_TOOL_NAMES = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'delete', 'remove', 'rename']);
const SCOPE_REFLECTION_FILE_THRESHOLD = 3;
const SCOPE_REFLECTION_LINES_THRESHOLD = 100;

function isMutationTool(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(name.toLowerCase());
}

function isMutationScopeSignificant(tracker: NonNullable<KodaXToolExecutionContext['mutationTracker']>): boolean {
  if (tracker.files.size >= SCOPE_REFLECTION_FILE_THRESHOLD) return true;
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
  return totalLines >= SCOPE_REFLECTION_LINES_THRESHOLD;
}

function buildMutationScopeReflection(tracker: NonNullable<KodaXToolExecutionContext['mutationTracker']>): string {
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
  const fileList = [...tracker.files.entries()]
    .map(([file, lines]) => `  - ${file} (~${lines} lines)`)
    .join('\n');
  return [
    '',
    `[Scope: ${tracker.files.size} files modified, ~${totalLines} lines]`,
    fileList,
    'A senior engineer would ask: does this change need review before shipping?',
    '→ Need review: call emit_managed_protocol({role:"scout", payload:{confirmed_harness:"H1_EXECUTE_EVAL", summary:"...", blocking_evidence:["..."]}})',
    '→ Need planning: call emit_managed_protocol with H2_PLAN_EXECUTE_EVAL',
    '→ Confident this is fine: continue working.',
  ].join('\n');
}

async function getToolExecutionOverride(
  events: KodaXEvents,
  name: string,
  input: Record<string, unknown>,
  toolId?: string,
  executionCwd?: string,
  gitRoot?: string,
): Promise<string | undefined> {
  if (events.beforeToolExecute) {
    const allowed = await events.beforeToolExecute(name, input, { toolId });
    if (allowed === false) {
      return CANCELLED_TOOL_RESULT_MESSAGE;
    }

    if (typeof allowed === 'string') {
      return allowed;
    }
  }

  const extensionOverride = await runActiveExtensionHook('tool:before', {
    name,
    input,
    toolId,
    executionCwd,
    gitRoot,
  });
  if (extensionOverride === false) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  return typeof extensionOverride === 'string' ? extensionOverride : undefined;
}

export async function saveSessionSnapshot(
  options: KodaXOptions,
  sessionId: string,
  data: {
    messages: KodaXMessage[];
    title: string;
    gitRoot?: string;
    errorMetadata?: SessionErrorMetadata;
    runtimeSessionState?: RuntimeSessionState;
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
    scope: options.session.scope ?? 'user',
    errorMetadata: data.errorMetadata,
    extensionState: data.runtimeSessionState
      ? snapshotRuntimeExtensionState(data.runtimeSessionState.extensionState)
      : undefined,
    extensionRecords: data.runtimeSessionState?.extensionRecords.map((record) => ({ ...record })),
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

function isVisibleToolName(name: string): boolean {
  return !isManagedProtocolToolName(name);
}

function shouldDebugResilience(): boolean {
  return process.env.KODAX_DEBUG_STREAM === '1' || process.env.KODAX_DEBUG_RESILIENCE === '1';
}

export function emitResilienceDebug(label: string, payload: Record<string, unknown>): void {
  if (!shouldDebugResilience()) {
    return;
  }
  console.error(label, payload);
}

function extractStructuredToolErrorCode(content: string): string | undefined {
  const match = /^\[Tool Error\]\s+[^:]+:\s+([A-Z_]+):/.exec(content.trim());
  return match?.[1];
}

function resolveToolTargetPath(
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
): string | undefined {
  const pathValue = toolCall.input?.path;
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    return undefined;
  }
  return resolveExecutionPath(pathValue, ctx);
}

function clearEditRecoveryStateForPath(
  runtimeSessionState: RuntimeSessionState,
  resolvedPath: string | undefined,
): void {
  if (!resolvedPath) {
    return;
  }
  runtimeSessionState.editRecoveryAttempts.delete(resolvedPath);
  runtimeSessionState.blockedEditWrites.delete(resolvedPath);
}

function maybeBlockExistingFileWrite(
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
  runtimeSessionState: RuntimeSessionState,
): string | undefined {
  if (toolCall.name !== 'write') {
    return undefined;
  }

  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  if (!resolvedPath || !runtimeSessionState.blockedEditWrites.has(resolvedPath)) {
    return undefined;
  }

  if (!fsSync.existsSync(resolvedPath)) {
    runtimeSessionState.blockedEditWrites.delete(resolvedPath);
    return undefined;
  }

  return `[Tool Error] write: BLOCKED_AFTER_EDIT_FAILURE: Refusing to rewrite existing file ${resolvedPath} while edit anchor recovery is in progress. Retry with edit using a smaller unique anchor or use insert_after_anchor.`;
}

async function buildEditRecoveryUserMessage(
  toolCall: RunnableToolCall,
  toolResult: string,
  runtimeSessionState: RuntimeSessionState,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  const code = parseEditToolError(toolResult);
  if (!code) {
    return undefined;
  }

  const pathValue = typeof toolCall.input?.path === 'string' ? toolCall.input.path : undefined;
  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  if (!pathValue || !resolvedPath) {
    return undefined;
  }

  runtimeSessionState.blockedEditWrites.add(resolvedPath);
  const attempt = (runtimeSessionState.editRecoveryAttempts.get(resolvedPath) ?? 0) + 1;
  runtimeSessionState.editRecoveryAttempts.set(resolvedPath, attempt);
  runtimeSessionState.lastToolErrorCode = code;

  if (code === 'EDIT_TOO_LARGE') {
    emitResilienceDebug('[edit:recovery]', {
      code,
      path: resolvedPath,
      attempt,
      action: 'split-edit',
    });
    return [
      `The previous edit for ${resolvedPath} failed with ${code}.`,
      'Do not use write to replace the existing file.',
      'Split the change into smaller edit calls, or use insert_after_anchor when you are appending a new section after a unique heading.',
    ].join('\n');
  }

  if (attempt > 2) {
    emitResilienceDebug('[edit:recovery]', {
      code,
      path: resolvedPath,
      attempt,
      action: 'stop-auto-recovery',
    });
    return [
      `The previous edit for ${resolvedPath} failed with ${code}, and automatic anchor recovery is exhausted.`,
      'Do not escalate to a whole-file write.',
      'Choose a smaller unique anchor manually, or switch to insert_after_anchor if this is a section append.',
    ].join('\n');
  }

  const windowLines = attempt === 1 ? 120 : 400;
  const diagnostic = await inspectEditFailure(pathValue, String(toolCall.input?.old_string ?? ''), ctx, windowLines);
  const primary = diagnostic.candidates[0];
  const alternates = diagnostic.candidates.slice(1, 3);

  emitResilienceDebug('[edit:recovery]', {
    code,
    path: resolvedPath,
    attempt,
    windowLines,
    candidateCount: diagnostic.candidates.length,
  });

  const lines: string[] = [
    `The previous edit for ${resolvedPath} failed with ${code}.`,
    'Do not use write to rewrite the existing file.',
    'Retry with edit using a smaller unique old_string, or use insert_after_anchor when you are appending a new section.',
  ];

  if (primary) {
    lines.push('');
    lines.push(`Best nearby anchor window (${primary.startLine}-${primary.endLine}):`);
    lines.push('```text');
    lines.push(primary.excerpt);
    lines.push('```');
  }

  if (alternates.length > 0) {
    lines.push('');
    lines.push('Other nearby candidate anchors:');
    for (const candidate of alternates) {
      lines.push(`- lines ${candidate.startLine}-${candidate.endLine}: ${candidate.preview}`);
    }
  }

  return lines.join('\n');
}

function updateToolOutcomeTracking(
  toolCall: RunnableToolCall,
  toolResult: string,
  runtimeSessionState: RuntimeSessionState,
  ctx: KodaXToolExecutionContext,
): void {
  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  runtimeSessionState.lastToolResultBytes = Buffer.byteLength(toolResult, 'utf8');
  runtimeSessionState.lastToolErrorCode = extractStructuredToolErrorCode(toolResult);

  if (toolCall.name === 'edit') {
    if (!parseEditToolError(toolResult)) {
      clearEditRecoveryStateForPath(runtimeSessionState, resolvedPath);
    }
    return;
  }

  if (toolCall.name === 'insert_after_anchor' && !isToolResultErrorContent(toolResult)) {
    clearEditRecoveryStateForPath(runtimeSessionState, resolvedPath);
  }
}

export function estimateProviderPayloadBytes(messages: KodaXMessage[], systemPrompt: string): number {
  return Buffer.byteLength(JSON.stringify({
    systemPrompt,
    messages,
  }), 'utf8');
}

export function bucketProviderPayloadSize(bytes: number): string {
  if (bytes < 16 * 1024) {
    return 'small';
  }
  if (bytes < 64 * 1024) {
    return 'medium';
  }
  if (bytes < 192 * 1024) {
    return 'large';
  }
  return 'xlarge';
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

function looksLikeReviewProgressUpdate(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    'now let me',
    'let me look',
    'let me check',
    'let me inspect',
    'now i will',
    '现在让我',
    '让我看看',
    '让我检查',
    '我现在来',
    '接下来我',
    '下面我来',
  ].some((prefix) => normalized.startsWith(prefix));
}

function isReviewFinalAnswerCandidate(
  prompt: string,
  reasoningPlan: ReasoningPlan,
  lastText: string,
): boolean {
  if (reasoningPlan.decision.primaryTask !== 'review') {
    return true;
  }

  const normalizedPrompt = prompt.toLowerCase();
  const normalizedText = lastText.trim();
  if (!normalizedText || looksLikeReviewProgressUpdate(normalizedText)) {
    return false;
  }

  if (normalizedText.length >= 600) {
    return true;
  }

  return /\b(must fix|finding|optional improvements|final assessment|verdict)\b/i.test(normalizedText)
    || /(必须修复|问题|建议|结论|评审报告|最终评审)/.test(normalizedText)
    || /^\s*(?:[-*]|\d+\.)\s+/m.test(normalizedText)
    || /\b(must[- ]fix|strict review|pr review|code review)\b/i.test(normalizedPrompt);
}

function hasStrongToolFailureEvidence(toolEvidence: string): boolean {
  return /\b(fail(?:ed|ure)?|error|blocked|exception|traceback|assert|regression|not found|timeout|console error|permission denied)\b/i
    .test(toolEvidence);
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
  allowTaskReroute?: boolean;
  onApply?: () => Promise<void> | void;
  persistSession?: {
    sessionId: string;
    messages: KodaXMessage[];
    title: string;
    runtimeSessionState?: RuntimeSessionState;
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
      allowTaskReroute: (params.allowTaskReroute ?? true) && params.autoTaskRerouteCount === 0,
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
      runtimeSessionState: params.persistSession.runtimeSessionState,
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

async function applyProviderPrepareHook(
  state: ProviderPrepareState,
): Promise<ProviderPrepareState> {
  const mutableState: ProviderPrepareState = { ...state };

  await runActiveExtensionHook('provider:before', {
    provider: mutableState.provider,
    model: mutableState.model,
    reasoningMode: mutableState.reasoningMode,
    systemPrompt: mutableState.systemPrompt,
    block: (reason) => {
      mutableState.blockedReason = reason;
    },
    replaceProvider: (provider) => {
      mutableState.provider = provider;
    },
    replaceModel: (model) => {
      mutableState.model = model;
    },
    replaceSystemPrompt: (systemPrompt) => {
      mutableState.systemPrompt = systemPrompt;
    },
    setThinkingLevel: (level) => {
      mutableState.reasoningMode = level;
    },
  });

  return mutableState;
}

async function settleExtensionTurn(
  sessionId: string,
  lastText: string,
  runtimeSessionState: RuntimeSessionState,
  options: {
    hadToolCalls: boolean;
    success: boolean;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  },
): Promise<void> {
  await runActiveExtensionHook('turn:settle', {
    sessionId,
    lastText,
    hadToolCalls: options.hadToolCalls,
    success: options.success,
    signal: options.signal,
    queueUserMessage: (message) => {
      runtimeSessionState.queuedMessages.push(normalizeQueuedRuntimeMessage(message));
    },
    setModelSelection: (next) => {
      runtimeSessionState.modelSelection = normalizeRuntimeModelSelection(next);
    },
    setThinkingLevel: (level) => {
      runtimeSessionState.thinkingLevel = level;
    },
  });
}

async function executeToolCall(
  events: KodaXEvents,
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
  runtimeSessionState: RuntimeSessionState,
  activeToolNames?: string[],
  abortSignal?: AbortSignal,
): Promise<string> {
  // Issue 088: Check abort signal before executing each tool
  if (abortSignal?.aborted) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  const visibleTool = isVisibleToolName(toolCall.name);
  if (visibleTool) {
    await emitActiveExtensionEvent('tool:start', {
      name: toolCall.name,
      id: toolCall.id,
      input: toolCall.input,
    });
    events.onToolUseStart?.({
      name: toolCall.name,
      id: toolCall.id,
      input: toolCall.input,
    });
  }

  const override = await getToolExecutionOverride(
    events,
    toolCall.name,
    toolCall.input ?? {},
    toolCall.id,
    ctx.executionCwd,
    ctx.gitRoot,
  );
  if (override !== undefined) {
    return override;
  }

  if (activeToolNames && !activeToolNames.includes(toolCall.name)) {
    return `[Tool Error] ${toolCall.name}: Tool is not active in the current runtime.`;
  }

  const blockedWrite = maybeBlockExistingFileWrite(toolCall, ctx, runtimeSessionState);
  if (blockedWrite) {
    return blockedWrite;
  }

  // FEATURE_067 v2: Inject reportToolProgress for long-running tools (dispatch_child_tasks)
  const ctxWithProgress: KodaXToolExecutionContext = events.onToolProgress
    ? {
        ...ctx,
        reportToolProgress: (message: string) => {
          events.onToolProgress?.({ id: toolCall.id, message });
        },
      }
    : ctx;

  const result = await executeTool(toolCall.name, toolCall.input ?? {}, ctxWithProgress);

  // MCP fallback: when a built-in tool fails, try to find a same-name MCP tool.
  if (result.startsWith('[Tool Error]') && ctx.extensionRuntime) {
    const fallbackResult = await tryMcpFallback(
      toolCall.name,
      toolCall.input ?? {},
      ctx,
    );
    if (fallbackResult !== undefined) {
      return fallbackResult;
    }
  }

  return result;
}

// Only allow MCP fallback for read-only / network-fetch tools.
// Write, edit, bash, and other mutating tools must never silently
// redirect to a remote MCP capability.
const MCP_FALLBACK_ALLOWED_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'glob',
  'grep',
  'read',
  'code_search',
  'semantic_lookup',
]);

async function tryMcpFallback(
  toolName: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  if (!MCP_FALLBACK_ALLOWED_TOOLS.has(toolName)) {
    return undefined;
  }
  try {
    const hits = await ctx.extensionRuntime!.searchCapabilities('mcp', toolName, {
      kind: 'tool',
      limit: 1,
    });
    if (hits.length === 0) {
      return undefined;
    }
    const hit = hits[0] as { id?: string; name?: string };
    // Only fallback when the MCP tool name exactly matches the built-in name.
    if (!hit?.id || (hit.name !== toolName && !hit.id.endsWith(`:${toolName}`))) {
      return undefined;
    }
    const mcpResult = await ctx.extensionRuntime!.executeCapability('mcp', hit.id, input);
    const content = typeof mcpResult.content === 'string'
      ? mcpResult.content
      : JSON.stringify(mcpResult.structuredContent ?? mcpResult, null, 2);
    return `[MCP Fallback via ${hit.id}]\n${content}`;
  } catch (error) {
    if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
      // eslint-disable-next-line no-console
      console.debug(`[tryMcpFallback] ${toolName} failed:`, error instanceof Error ? error.message : error);
    }
    return undefined;
  }
}

/**
 * 运行 KodaX Agent
 * 核心入口函数 - 极简 API
 */
export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const previousActiveRuntime = getActiveExtensionRuntime();
  // FEATURE_093 (v0.7.24): `options.extensionRuntime` is typed as the narrow
  // `ExtensionRuntimeContract` in `types.ts` to break the types↔runtime
  // cycle, but agent internals consume the full class surface. Cast here at
  // the single entry point rather than at every call site.
  const runtime = (options.extensionRuntime as KodaXExtensionRuntime | undefined) ?? previousActiveRuntime;
  if (runtime && runtime !== previousActiveRuntime) {
    setActiveExtensionRuntime(runtime);
  }
  let releaseRuntimeBinding: (() => void) | undefined;
  try {
  const maxIter = options.maxIter ?? 200;
  const events = options.events ?? {};
  const runtimeDefaults = runtime?.getDefaults();
  let currentProviderName = runtimeDefaults?.modelSelection.provider ?? options.provider;
  let currentModelOverride = runtimeDefaults?.modelSelection.model ?? options.modelOverride ?? options.model;
  let runtimeThinkingLevel = runtimeDefaults?.thinkingLevel;

  // Load compaction config
  const compactionConfig = await loadCompactionConfig(options.context?.gitRoot ?? undefined);
  const initialProvider = resolveProvider(currentProviderName);
  if (!initialProvider.isConfigured()) {
    throw new Error(
      `Provider "${currentProviderName}" not configured. Set ${initialProvider.getApiKeyEnv()}`,
    );
  }

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
  let loadedExtensionState: KodaXExtensionSessionState | undefined;
  let loadedExtensionRecords: KodaXExtensionSessionRecord[] | undefined;

  // 优先使用 initialMessages（用于交互式模式的多轮对话）
  if (options.session?.initialMessages && options.session.initialMessages.length > 0) {
    messages = [...options.session.initialMessages];
    title = extractTitleFromMessages(messages);
  } else if (options.session?.storage && sessionId) {
    const loaded = await options.session.storage.load(sessionId);
    if (loaded) {
      // FEATURE_076 Q4: sessions saved before v0.7.25 persisted messages
      // in worker-execution-trace shape. Normalize on load: drop trailing
      // role-prompt-shaped worker pairs, keep preceding clean user dialog.
      messages = normalizeLoadedSessionMessages(loaded.messages);
      title = loaded.title;
      errorMetadata = loaded.errorMetadata;
      loadedExtensionState = loaded.extensionState;
      loadedExtensionRecords = loaded.extensionRecords;
    }
  }

  // 防止消息重复推入：如果 initialMessages 的最后一条已经是当前 prompt，跳过 push
  const lastMsg = messages[messages.length - 1];
  const isDuplicate = extractComparableUserMessageText(lastMsg) === prompt;
  if (!isDuplicate) {
    messages.push({
      role: 'user',
      content: buildPromptMessageContent(prompt, options.context?.inputArtifacts),
    });
  }
  if (!title) title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');

  const executionCwd = resolveExecutionCwd(options.context);
  let emittedManagedProtocolPayload = options.context?.managedProtocolEmission?.enabled
    ? mergeManagedProtocolPayload(undefined, undefined)
    : undefined;

  // Simplified context - no permission fields (handled by REPL layer)
  const ctx: KodaXToolExecutionContext = {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    executionCwd,
    extensionRuntime: runtime ?? undefined,
    askUser: events.askUser, // Issue 069: Pass askUser callback from events
    askUserInput: events.askUserInput, // Issue 112: Pass askUserInput callback from events
    // FEATURE_074: only forward the new exit_plan_mode callback.
    // set_permission_mode is NOT forwarded — it was broken before this feature
    // (callback never wired), and a corpus of sessions shows LLMs occasionally
    // call it in auto-in-project too, not just plan mode. Activating it now would
    // silently widen permissions (auto-in-project's path scope → accept-edits's
    // no-scope) on any misfire. Keep it failing until removal in v0.7.21+.
    exitPlanMode: events.exitPlanMode,
    abortSignal: options.abortSignal, // Issue 113: Pass abort signal to tool handlers
    managedProtocolRole: options.context?.managedProtocolEmission?.enabled
      ? options.context.managedProtocolEmission.role
      : undefined,
    emitManagedProtocol: options.context?.managedProtocolEmission?.enabled
      ? (payload: Partial<KodaXManagedProtocolPayload>) => {
          emittedManagedProtocolPayload = mergeManagedProtocolPayload(
            emittedManagedProtocolPayload,
            payload,
          );
        }
      : undefined,
    registerChildWriteWorktrees: options.context?.registerChildWriteWorktrees,
    mutationTracker: options.context?.mutationTracker,
    // FEATURE_074: forward parent's plan-mode predicate so dispatch_child_task
    // can enforce plan mode on child tool calls using live parent state.
    planModeBlockCheck: options.context?.planModeBlockCheck,
    parentAgentConfig: {
      provider: options.provider,
      model: options.model,
      reasoningMode: options.reasoningMode,
    },
    // FEATURE_067: onChildProgress removed — it fired onManagedTaskStatus with
    // activeWorkerId='child', which triggered a foreground worker transition in the
    // REPL and cleared all live tool calls. Progress is now handled entirely via
    // reportToolProgress → onToolProgress, which updates both the tool block and spinner.
    onChildProgress: undefined,
  };
  const finalizeManagedProtocolResult = (result: KodaXResult): KodaXResult => {
    const payload = mergeManagedProtocolPayload(
      result.managedProtocolPayload,
      emittedManagedProtocolPayload,
    );
    return payload
      ? {
          ...result,
          managedProtocolPayload: payload,
        }
      : result;
  };
  let contextTokenSnapshot = rebaseContextTokenSnapshot(
    messages,
    options.context?.contextTokenSnapshot,
  );
  const runtimeSessionState: RuntimeSessionState = {
    queuedMessages: [],
    extensionState: createRuntimeExtensionState(loadedExtensionState),
    extensionRecords: loadedExtensionRecords?.map((record) => ({ ...record })) ?? [],
    activeTools: filterExcludedTools(
      runtimeDefaults?.activeTools ?? listToolDefinitions().map((tool) => tool.name),
      options.context?.excludeTools,
    ),
    editRecoveryAttempts: new Map(),
    blockedEditWrites: new Set(),
    modelSelection: {
      provider: currentProviderName,
      model: currentModelOverride,
    },
    thinkingLevel: runtimeThinkingLevel,
  };
  releaseRuntimeBinding = runtime?.bindController(
    createExtensionRuntimeSessionController(runtimeSessionState),
  );

  await runtime?.hydrateSession(sessionId);

  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      autoRepoMode !== 'off' && (options.context?.executionCwd || options.context?.gitRoot)
        ? await getRepoRoutingSignals({
          executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: autoRepoMode,
        }).catch(() => null)
        : null
    );
  emitRepoIntelligenceTrace(
    events,
    options,
    'routing',
    repoRoutingSignals,
    repoRoutingSignals?.activeModuleId
      ? `active_module=${repoRoutingSignals.activeModuleId}`
      : undefined,
  );

  let reasoningPlan = await createReasoningPlan({
    ...options,
    provider: currentProviderName,
    modelOverride: currentModelOverride,
  }, prompt, initialProvider, {
    recentMessages: messages.slice(0, -1),
    sessionErrorMetadata: errorMetadata,
    repoSignals: repoRoutingSignals ?? undefined,
  });
  let currentExecution = await buildReasoningExecutionState(
    {
      ...options,
      provider: currentProviderName,
      modelOverride: currentModelOverride,
      reasoningMode: runtimeThinkingLevel ?? options.reasoningMode,
    },
    runtimeThinkingLevel
      ? {
        ...reasoningPlan,
        mode: runtimeThinkingLevel,
        depth: reasoningModeToDepth(runtimeThinkingLevel),
      }
      : reasoningPlan,
    messages.length === 1,
  );
  let autoFollowUpCount = 0;
  let autoDepthEscalationCount = 0;
  let autoTaskRerouteCount = 0;
  const autoFollowUpLimit = 2;
  let preAnswerJudgeConsumed = false;
  let postToolJudgeConsumed = false;

  let lastText = '';
  let incompleteRetryCount = 0;
  let maxTokensRetryCount = 0;
  let limitReached = false; // Track if we exited due to iteration limit - 追踪是否因达到迭代上限而退出
  // Max-tokens escalation state. When a capped-budget turn returns
  // stop_reason:max_tokens we set `pendingMaxOutputOverride` to
  // KODAX_ESCALATED_MAX_OUTPUT_TOKENS and `continue` the iter loop — the
  // next iter re-enters the same logical turn with the larger budget.
  // `hasEscalatedForCurrentLogicalTurn` prevents a second escalation in
  // the same turn; it resets when the turn commits (assistant pushed)
  // so subsequent turns (including L5 continuations) can escalate again.
  let pendingMaxOutputOverride: number | undefined = undefined;
  let hasEscalatedForCurrentLogicalTurn = false;
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
  const currentRoutingDecision = () => reasoningPlan.decision;
    events.onSessionStart?.({ provider: initialProvider.name, sessionId });
    await emitActiveExtensionEvent('session:start', { provider: initialProvider.name, sessionId });

    // Cost tracking — lightweight session-scoped tracker
    let costTracker: CostTracker = createCostTracker();
    if (events.getCostReport) {
      events.getCostReport.current = () => formatCostReport(getSummary(costTracker));
    }

    let managedProtocolContinueAttempted = false;
    let compactConsecutiveFailures = 0;
    const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;
    for (let iter = 0; iter < maxIter; iter++) {
    try {
      currentProviderName = runtimeSessionState.modelSelection.provider ?? options.provider;
      currentModelOverride = runtimeSessionState.modelSelection.model ?? options.modelOverride ?? options.model;
      runtimeThinkingLevel = runtimeSessionState.thinkingLevel;
      const provider = resolveProvider(currentProviderName);
      if (!provider.isConfigured()) {
        throw new Error(
          `Provider "${currentProviderName}" not configured. Set ${provider.getApiKeyEnv()}`,
        );
      }
      const contextWindow = compactionConfig.contextWindow
        ?? provider.getContextWindow?.()
        ?? 200000;
      const effectiveReasoningPlan = runtimeThinkingLevel
        ? {
          ...reasoningPlan,
          mode: runtimeThinkingLevel,
          depth: reasoningModeToDepth(runtimeThinkingLevel),
        }
        : reasoningPlan;
      currentExecution = await buildReasoningExecutionState(
        {
          ...options,
          provider: currentProviderName,
          modelOverride: currentModelOverride,
          reasoningMode: runtimeThinkingLevel ?? options.reasoningMode,
        },
        effectiveReasoningPlan,
        messages.length === 1,
      );

      await emitActiveExtensionEvent('turn:start', {
        sessionId,
        iteration: iter + 1,
        maxIter,
      });
      events.onIterationStart?.(iter + 1, maxIter);

      // Microcompaction: lightweight cleanup each turn (no LLM calls)
      // Clears old tool results, thinking blocks, and image blocks
      messages = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG) as KodaXMessage[];

      // Compaction: 统一使用智能压缩，废除遗留的粗暴截断
      let compacted: KodaXMessage[];
      let didCompactMessages = false;
      let compactionUpdate: CompactionUpdate | undefined;

      // 判断是否需要压缩：只依据智能压缩阈值 (默认 75%)
      const currentTokens = resolveContextTokenCount(messages, contextTokenSnapshot);
      const needsCompact =
        compactionConfig.enabled
        && needsCompaction(messages, compactionConfig, contextWindow, currentTokens);

      // Circuit breaker: only disables LLM-based summarization, NOT the fallback
      const circuitBreakerTripped = compactConsecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT;

      if (needsCompact && !circuitBreakerTripped) {
        // LLM-based intelligent compaction path
        events.onCompactStart?.();
        try {
          const result = await intelligentCompact(
            messages,
            compactionConfig,
            provider,
            contextWindow,
            undefined, // customInstructions
            currentExecution.systemPrompt,
            currentTokens,
          );

          if (result.compacted) {
            compacted = result.messages;

            // Post-compact reconstruction: inject artifact ledger summary + file content
            // FEATURE_072: `postCompactAttachmentsForLineage` captures the flat
            // attachment messages so they can also be routed via
            // `compactionUpdate.postCompactAttachments` for REPL-side native
            // storage on the CompactionEntry. Agent.ts still inlines them into
            // local `messages` for consumers that continue to read flat messages.
            let postCompactAttachmentsForLineage: readonly KodaXMessage[] = [];
            if (result.artifactLedger && result.artifactLedger.length > 0) {
              const freedTokens = result.tokensBefore - result.tokensAfter;
              const attachments = buildPostCompactAttachments(
                result.artifactLedger,
                freedTokens,
              );

              // Read recently modified files and inject content (async I/O)
              // Budget = total post-compact budget minus ledger tokens, capped by absolute budget.
              // Aligns with Claude Code's POST_COMPACT_TOKEN_BUDGET (fixed cap, not proportional).
              const totalPostCompactBudget = Math.min(
                Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
                POST_COMPACT_TOKEN_BUDGET,
              );
              const fileBudget = Math.max(0, totalPostCompactBudget - attachments.totalTokens);
              const fileMessages = fileBudget > 0
                ? await buildFileContentMessages(result.artifactLedger, fileBudget)
                : [];

              const fullAttachments = {
                ...attachments,
                fileMessages,
                totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
              };

              if (fullAttachments.totalTokens > 0) {
                compacted = injectPostCompactAttachments(compacted, fullAttachments);
                // Flat list for compactionUpdate: preserves [ledgerMessage, ...fileMessages] order
                postCompactAttachmentsForLineage = [
                  ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
                  ...fullAttachments.fileMessages,
                ];
              }
            }

            didCompactMessages = true;
            // Only reset the circuit-breaker counter when compaction actually
            // reduced context below trigger. "Partial success" (pruning only,
            // with silent summary failure) would otherwise keep the counter
            // at zero forever and prevent graceful degradation from ever running.
            const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
            const postCompactTokens = estimateTokens(compacted);
            if (postCompactTokens < triggerTokens) {
              compactConsecutiveFailures = 0;
            } else {
              compactConsecutiveFailures++;
              console.warn(`[Compaction] Partial success: still above trigger (${postCompactTokens} > ${Math.floor(triggerTokens)}) — attempt ${compactConsecutiveFailures}/${COMPACT_CIRCUIT_BREAKER_LIMIT}`);
            }
            compactionUpdate = {
              anchor: result.anchor,
              artifactLedger: result.artifactLedger,
              memorySeed: result.memorySeed,
              postCompactAttachments: postCompactAttachmentsForLineage.length > 0
                ? postCompactAttachmentsForLineage
                : undefined,
            };
            events.onCompactStats?.({
              tokensBefore: result.tokensBefore,
              tokensAfter: postCompactTokens,
            });
            events.onCompact?.(result.tokensBefore);
          } else {
            compacted = result.messages;
          }
        } catch (error) {
          compactConsecutiveFailures++;
          console.error(`[Compaction Error] LLM summary failed (attempt ${compactConsecutiveFailures}/${COMPACT_CIRCUIT_BREAKER_LIMIT}):`, error);

          // Fall through to graceful degradation below
          compacted = messages;
        } finally {
          events.onCompactEnd?.();
        }
      } else {
        compacted = messages;
      }

      // Graceful degradation: runs when:
      //   - LLM compact threw (compacted === messages because catch set it)
      //   - Circuit breaker tripped (needsCompact && circuitBreakerTripped → else branch)
      //   - LLM compact "partial success" left context still above trigger (new ref, tokens still high)
      // Gating by remaining tokens instead of reference equality catches the third case,
      // which is the root cause of monotonic context growth observed in 0.7.18+.
      //
      // Pass `compacted` (not `messages`) so we keep any pruning work done by
      // intelligentCompact and let graceful do additional atomic-block removal
      // on top, rather than discarding the pruning and starting over.
      if (needsCompact) {
        const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
        const gapRatio = compactionConfig.pruningGapRatio ?? 0.8;
        const stillOverTrigger = estimateTokens(compacted) > triggerTokens * gapRatio;
        if (stillOverTrigger) {
          const degraded = gracefulCompactDegradation(compacted, contextWindow, compactionConfig);
          if (degraded !== compacted) {
            compacted = degraded;
            didCompactMessages = true;
            events.onCompactStats?.({
              tokensBefore: currentTokens,
              tokensAfter: estimateTokens(compacted),
            });
            events.onCompact?.(estimateTokens(compacted));
          }
        }
      }

      // CRITICAL FIX: Always validate and fix tool history before sending to API
      // This prevents "tool_call_id is not found" errors caused by corrupted history
      compacted = validateAndFixToolHistory(compacted);

      // CRITICAL FIX: Update the global session messages to the compacted version!
      // This permanently applies the summary/truncation and prevents the session history from growing infinitely.
      messages = compacted;
      if (didCompactMessages) {
        contextTokenSnapshot = createEstimatedContextTokenSnapshot(messages);
        events.onCompactedMessages?.(messages, compactionUpdate);
      }

      const preparedProviderState = await applyProviderPrepareHook({
        provider: currentProviderName,
        model: currentModelOverride,
        reasoningMode: effectiveReasoningPlan.mode,
        systemPrompt: currentExecution.systemPrompt,
      });
      if (preparedProviderState.blockedReason) {
        throw new Error(preparedProviderState.blockedReason);
      }
      currentProviderName = preparedProviderState.provider;
      currentModelOverride = preparedProviderState.model;
      runtimeSessionState.modelSelection.provider = currentProviderName;
      runtimeSessionState.modelSelection.model = currentModelOverride;
      runtimeThinkingLevel = preparedProviderState.reasoningMode;
      runtimeSessionState.thinkingLevel = runtimeThinkingLevel;
      const effectiveProviderReasoningMode = runtimeThinkingLevel ?? effectiveReasoningPlan.mode;
      const effectiveProviderReasoning = {
        ...currentExecution.providerReasoning,
        enabled: effectiveProviderReasoningMode !== 'off',
        mode: effectiveProviderReasoningMode,
        depth: reasoningModeToDepth(effectiveProviderReasoningMode),
      };

      const streamProvider = resolveProvider(currentProviderName);
      // Apply a pending max_tokens escalation staged by the previous iter's
      // stop_reason:max_tokens branch. `resolveProvider` always returns a
      // fresh instance, so we can't carry state on the provider across
      // iters — we bridge the value through a closure-local variable and
      // re-apply it here on the new instance. Consumed once; the
      // provider's `withRateLimit` clears it after the next successful
      // response, so normal turns (no escalation) start fresh.
      if (pendingMaxOutputOverride !== undefined) {
        streamProvider.setMaxOutputTokensOverride(pendingMaxOutputOverride);
        pendingMaxOutputOverride = undefined;
      }
      const providerPolicy = evaluateProviderPolicy({
        providerName: currentProviderName,
        model: currentModelOverride,
        provider: streamProvider,
        prompt,
        options: currentExecution.effectiveOptions,
        context: currentExecution.effectiveOptions.context,
        reasoningMode: effectiveProviderReasoningMode,
        taskType: effectiveReasoningPlan.decision.primaryTask,
        executionMode: effectiveReasoningPlan.decision.recommendedMode,
      });
      if (providerPolicy.status === 'block') {
        throw new Error(`[Provider Policy] ${providerPolicy.summary}`);
      }
      const effectiveSystemPrompt = providerPolicy.issues.length > 0
        ? [
          preparedProviderState.systemPrompt,
          buildProviderPolicyPromptNotes(providerPolicy).join('\n'),
        ].join('\n\n')
        : preparedProviderState.systemPrompt;
      if (!streamProvider.isConfigured()) {
        throw new Error(
          `Provider "${currentProviderName}" not configured. Set ${streamProvider.getApiKeyEnv()}`,
        );
      }

      await emitActiveExtensionEvent('provider:selected', {
        provider: currentProviderName,
        model: currentModelOverride,
      });

      // 流式调用 Provider - with automatic retry for transient errors
      // 注入 API 硬超时保护：防止大型 payload 导致 API 静默丢包引发无限等待
      // Feature 045: resilience config replaces hardcoded timeouts
      const resilienceCfg = resolveResilienceConfig(currentProviderName);
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs; // Issue 084: 提升到 10 分钟硬超时
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;  // Issue 084: 60 秒空闲/停滞超时，如果有 delta 刷新则重置
      let providerMessages = compacted;
      let result!: KodaXStreamResult;
      let attempt = 0;
      const boundaryTracker = new StableBoundaryTracker();
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback:
          resilienceCfg.enableNonStreamingFallback && streamProvider.supportsNonStreamingFallback(),
      });
      const activeToolDefinitions = getActiveToolDefinitions(
        runtimeSessionState.activeTools,
        options.context?.repoIntelligenceMode,
        options.context?.managedProtocolEmission?.enabled === true,
        !!runtime,
      );

      while (true) {
        attempt += 1;
        boundaryTracker.beginRequest(
          currentProviderName,
          currentModelOverride ?? streamProvider.getModel(),
          providerMessages,
          attempt,
          false,
        );
        telemetryBoundary(boundaryTracker.snapshot());

        const retryTimeoutController = new AbortController();
        let hardTimer = setTimeout(() => {
          retryTimeoutController.abort(new Error("API Hard Timeout (10 minutes)"));
        }, API_HARD_TIMEOUT_MS);

        // Stream idle timer: disabled by default (API_IDLE_TIMEOUT_MS === 0).
        // When enabled, aborts the stream if no content events arrive within
        // the timeout window.  The hard timeout above is always active.
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`));
          }, API_IDLE_TIMEOUT_MS);
        }

        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`));
            }, API_IDLE_TIMEOUT_MS);
          }
        };

        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, effectiveSystemPrompt);
        emitResilienceDebug('[resilience:request]', {
          provider: currentProviderName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
          lastToolErrorCode: runtimeSessionState.lastToolErrorCode,
          lastToolResultBytes: runtimeSessionState.lastToolResultBytes,
        });

        try {
          result = await streamProvider.stream(
            providerMessages,
            activeToolDefinitions,
            effectiveSystemPrompt,
            effectiveProviderReasoning,
            {
              onTextDelta: (text) => {
                resetIdleTimer();
                boundaryTracker.markTextDelta(text);
                void emitActiveExtensionEvent('text:delta', { text });
                events.onTextDelta?.(text);
              },
              onThinkingDelta: (text) => {
                resetIdleTimer();
                boundaryTracker.markThinkingDelta(text);
                void emitActiveExtensionEvent('thinking:delta', { text });
                events.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking) => {
                resetIdleTimer();
                void emitActiveExtensionEvent('thinking:end', { thinking });
                events.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: (name, json, meta) => {
                resetIdleTimer();
                boundaryTracker.markToolInputStart(meta?.toolId ?? `pending:${name}`);
                events.onToolInputDelta?.(name, json, meta);
              },
              onRateLimit: (rateAttempt, max, delay) => {
                resetIdleTimer();
                void emitActiveExtensionEvent('provider:rate-limit', {
                  provider: currentProviderName,
                  attempt: rateAttempt,
                  maxRetries: max,
                  delayMs: delay,
                });
                events.onProviderRateLimit?.(rateAttempt, max, delay);
              },
              onHeartbeat: (pause) => {
                if (pause) {
                  // Between content blocks: server may be silent while generating
                  // the next block.  Clear idle timer but do NOT restart it — the
                  // hard request timeout (10 min) still guards against stuck connections.
                  clearTimeout(idleTimer);
                } else {
                  resetIdleTimer();
                }
              },
              modelOverride: currentModelOverride,
              signal: retrySignal,
            },
            retrySignal,
          );

          messages = providerMessages;
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (error.name === 'AbortError' && retryTimeoutController.signal.aborted && !options.abortSignal?.aborted) {
            const reason = retryTimeoutController.signal.reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax/ai');
            error = new KodaXNetworkError(reason, true);
          }

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          events.onProviderRecovery?.({
            stage: decision.failureStage,
            errorClass: decision.reasonCode,
            attempt,
            maxAttempts: resilienceCfg.maxRetries,
            delayMs: decision.delayMs,
            recoveryAction: decision.action,
            ladderStep: decision.ladderStep,
            fallbackUsed: decision.shouldUseNonStreaming,
            serverRetryAfterMs: decision.serverRetryAfterMs,
          });

          if (!events.onProviderRecovery && decision.action !== 'manual_continue') {
            events.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming) {
            const fallbackBytes = estimateProviderPayloadBytes(providerMessages, effectiveSystemPrompt);
            emitResilienceDebug('[resilience:fallback]', {
              provider: currentProviderName,
              attempt,
              payloadBytes: fallbackBytes,
              payloadBucket: bucketProviderPayloadSize(fallbackBytes),
            });

            try {
              const fallbackTimeoutController = new AbortController();
              const fallbackSignal = options.abortSignal
                ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
                : fallbackTimeoutController.signal;
              const fallbackHardTimer = setTimeout(() => {
                fallbackTimeoutController.abort(new Error("API Hard Timeout (10 minutes)"));
              }, API_HARD_TIMEOUT_MS);
              try {
                clearTimeout(idleTimer);
                clearTimeout(hardTimer);
                boundaryTracker.beginRequest(
                  currentProviderName,
                  currentModelOverride ?? streamProvider.getModel(),
                  providerMessages,
                  attempt,
                  true,
                );
                telemetryBoundary(boundaryTracker.snapshot());
                result = await streamProvider.complete(
                  providerMessages,
                  activeToolDefinitions,
                  effectiveSystemPrompt,
                  effectiveProviderReasoning,
                  {
                    onTextDelta: (text) => {
                      boundaryTracker.markTextDelta(text);
                      void emitActiveExtensionEvent('text:delta', { text });
                      events.onTextDelta?.(text);
                    },
                    onThinkingDelta: (text) => {
                      boundaryTracker.markThinkingDelta(text);
                      void emitActiveExtensionEvent('thinking:delta', { text });
                      events.onThinkingDelta?.(text);
                    },
                    onThinkingEnd: (thinking) => {
                      void emitActiveExtensionEvent('thinking:end', { thinking });
                      events.onThinkingEnd?.(thinking);
                    },
                    modelOverride: currentModelOverride,
                    signal: fallbackSignal,
                  },
                  fallbackSignal,
                );
                messages = providerMessages;
                break;
              } finally {
                clearTimeout(fallbackHardTimer);
              }
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            }
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            messages = providerMessages;
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;

          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
        }
      }

      // 流式输出结束，通知 CLI 层
      events.onStreamEnd?.();
      await emitActiveExtensionEvent('stream:end', undefined);

      // Record cost for this LLM call
      if (result.usage) {
        costTracker = recordUsage(costTracker, {
          provider: currentProviderName,
          model: currentModelOverride ?? 'unknown',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        });
      }

      lastText = result.textBlocks.map(b => b.text).join(' ');
      const preAssistantTokenSnapshot = createContextTokenSnapshot(compacted, result.usage);
      const visibleToolBlocks = result.toolBlocks.filter((block) => isVisibleToolName(block.name));

      // Promise 信号检测
      const [signal, _reason] = checkPromiseSignal(lastText);
      if (signal) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
          signal: signal as 'COMPLETE' | 'BLOCKED' | 'DECIDE',
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(messages, runtimeSessionState);
        if (appendedQueuedMessages) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: signal as 'COMPLETE' | 'BLOCKED' | 'DECIDE',
          });
          continue;
        }
        if (signal === 'COMPLETE') {
          emitIterationEnd(iter + 1, preAssistantTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: 'COMPLETE',
          });
          events.onComplete?.();
          await emitActiveExtensionEvent('complete', { success: true, signal: 'COMPLETE' });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
            signal: 'COMPLETE',
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }
      }

      // L1 escalation: when a capped-budget turn returns stop_reason:max_tokens
      // we retry the SAME logical turn with KODAX_ESCALATED_MAX_OUTPUT_TOKENS
      // instead of committing the (often truncated) assistant message to
      // history. This must run BEFORE `messages.push(assistant)` so a partial
      // tool_use JSON — already dropped by the Anthropic provider when
      // `content_block_stop` never arrived — does not pollute the turn.
      // Mirrors Claude Code's `max_output_tokens_escalate` path (query.ts).
      // Skipped when the user set KODAX_MAX_OUTPUT_TOKENS (explicit intent
      // beats auto-ladder) or when the effective budget already meets the
      // escalated threshold.
      if (
        result.stopReason === 'max_tokens'
        && !hasEscalatedForCurrentLogicalTurn
        && !process.env.KODAX_MAX_OUTPUT_TOKENS
        && streamProvider.getEffectiveMaxOutputTokens() < KODAX_ESCALATED_MAX_OUTPUT_TOKENS
      ) {
        hasEscalatedForCurrentLogicalTurn = true;
        pendingMaxOutputOverride = KODAX_ESCALATED_MAX_OUTPUT_TOKENS;
        events.onRetry?.(
          `Output budget reached, escalating to ${KODAX_ESCALATED_MAX_OUTPUT_TOKENS} tokens and retrying the same turn`,
          1,
          1,
        );
        continue;
      }

      let assistantContent = [...result.thinkingBlocks, ...result.textBlocks, ...visibleToolBlocks];
      // Guard: never push an assistant message with empty content.
      // This can happen when the model only emits invisible tool calls (e.g. emit_managed_protocol)
      // with no text or thinking. Providers like Kimi reject empty content (400 error).
      if (assistantContent.length === 0) {
        assistantContent = [{ type: 'text' as const, text: '...' }];
      }
      messages.push({ role: 'assistant', content: assistantContent });
      const completedTurnTokenSnapshot = createCompletedTurnTokenSnapshot(messages, result.usage);
      contextTokenSnapshot = completedTurnTokenSnapshot;
      // Turn committed to history. Clear per-turn escalation flag so the
      // next logical turn (normal continuation after tools, or L5 meta
      // recovery below) starts fresh and can escalate again if needed.
      hasEscalatedForCurrentLogicalTurn = false;

      // L5 continuation: escalated budget was still not enough, or no tools
      // were emitted and output was cut mid-text. Inject Claude Code's
      // recovery meta message instructing the model to resume mid-thought
      // and break remaining work into smaller pieces (so a too-large Write
      // becomes Write+Edit across turns). Capped at
      // KODAX_MAX_MAXTOKENS_RETRIES (3) to prevent infinite loops.
      // Skipped when there are completed tool_use blocks — those will
      // execute and the model will naturally continue next turn with the
      // tool_result, no explicit meta nudge needed.
      if (result.stopReason === 'max_tokens' && result.toolBlocks.length === 0) {
        maxTokensRetryCount++;
        if (maxTokensRetryCount <= KODAX_MAX_MAXTOKENS_RETRIES) {
          events.onTextDelta?.('\n\n[output token limit hit, continuing…]\n\n');
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
                'Pick up mid-thought if that is where the cut happened. ' +
                'Break remaining work into smaller pieces.',
            }],
            _synthetic: true,
          });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          continue;
        }
        // Retries exhausted — fall through to text-only response handling
        events.onRetry?.(`max_tokens truncation limit reached (${maxTokensRetryCount - 1}/${KODAX_MAX_MAXTOKENS_RETRIES})`, maxTokensRetryCount - 1, KODAX_MAX_MAXTOKENS_RETRIES);
      }

      // Fallback: auto-continue when end_turn fires but required managed protocol block is missing.
      // Skipped when protocol is optional (e.g. Scout with full tools — protocol only needed for escalation).
      if (
        !managedProtocolContinueAttempted
        && result.stopReason === 'end_turn'
        && result.toolBlocks.length === 0
        && lastText
        && options.context?.managedProtocolEmission?.enabled
        && !options.context.managedProtocolEmission.optional
      ) {
        const role = options.context.managedProtocolEmission.role;
        const blockName = getManagedBlockNameForRole(role);
        if (
          blockName
          && !hasManagedProtocolForRole(emittedManagedProtocolPayload, role)
          && !textContainsManagedBlock(lastText, blockName)
        ) {
          managedProtocolContinueAttempted = true;
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text: `Your response is complete but the required protocol was not emitted. Do NOT output any text — ONLY call the "${MANAGED_PROTOCOL_TOOL_NAME}" tool now, or append a \`\`\`${blockName}\`\`\` fenced block. No other output.`,
            }],
            _synthetic: true,
          });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          continue;
        }
      }

      if (result.toolBlocks.length === 0) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }

        if (
          effectiveReasoningPlan.mode === 'auto' &&
          autoFollowUpCount < autoFollowUpLimit &&
          (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0) &&
          !preAnswerJudgeConsumed &&
          isReviewFinalAnswerCandidate(prompt, effectiveReasoningPlan, lastText)
        ) {
          preAnswerJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: messages.length === 1,
            retryLabelPrefix: 'Auto',
            allowTaskReroute: !options.context?.disableAutoTaskReroute,
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
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
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
          messages.push({ role: 'user', content: retryPrompt, _synthetic: true });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          continue;
        } else {
          // 超过重试次数，过滤掉不完整的工具调用并添加错误结果
          events.onRetry?.(`Max retries exceeded for incomplete tool calls. Skipping: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          const incompleteIds = new Set<string>();
          for (const tc of result.toolBlocks) {
            const required = getRequiredToolParams(tc.name);
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
              await emitActiveExtensionEvent('tool:result', {
                id: tc.id,
                name: tc.name,
                content: errorMsg,
              });
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
      const editRecoveryMessages: string[] = [];

      // Issue 088: Check abort signal before entering tool execution phase.
      // Without this guard, tools spawned after Ctrl+C would still run to completion.
      // Use graceful cancellation (mark all tools as cancelled) instead of throwing,
      // so the downstream `hasCancellation` check handles exit uniformly.
      const abortedBeforeTools = options.abortSignal?.aborted === true;

      // Non-bash tools run in parallel; bash tools run sequentially (always parallel mode).
      if (abortedBeforeTools) {
        for (const tc of result.toolBlocks) {
          if (isVisibleToolName(tc.name)) {
            await emitActiveExtensionEvent('tool:result', {
              id: tc.id,
              name: tc.name,
              content: CANCELLED_TOOL_RESULT_MESSAGE,
            });
            events.onToolResult?.({ id: tc.id, name: tc.name, content: CANCELLED_TOOL_RESULT_MESSAGE });
            toolResults.push(createToolResultBlock(tc.id, CANCELLED_TOOL_RESULT_MESSAGE));
          }
        }
      } else {
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
                }, ctx, runtimeSessionState, getRuntimeActiveToolNames(
                  runtimeSessionState.activeTools,
                  options.context?.repoIntelligenceMode,
                  !!runtime,
                ), options.abortSignal),
                ctx,
              )
            ).content,
          }));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
          // Issue 088: Check abort signal before each sequential bash tool
          if (options.abortSignal?.aborted) {
            resultMap.set(tc.id, CANCELLED_TOOL_RESULT_MESSAGE);
            continue;
          }
          const content = (
            await applyToolResultGuardrail(
              tc.name,
              await executeToolCall(events, {
                id: tc.id,
                name: tc.name,
                input: tc.input as Record<string, unknown> | undefined,
                }, ctx, runtimeSessionState, getRuntimeActiveToolNames(
                  runtimeSessionState.activeTools,
                  options.context?.repoIntelligenceMode,
                  !!runtime,
                ), options.abortSignal),
              ctx,
            )
          ).content;
          resultMap.set(tc.id, content);
        }

        for (const tc of result.toolBlocks) {
          let content = resultMap.get(tc.id) ?? '[Error] No result';
          // Scope reflection: when mutation tracker crosses threshold, append once to a write tool result.
          if (
            ctx.mutationTracker
            && !ctx.mutationTracker.reflectionInjected
            && !isToolResultErrorContent(content)
            && isMutationTool(tc.name)
            && isMutationScopeSignificant(ctx.mutationTracker)
          ) {
            content += buildMutationScopeReflection(ctx.mutationTracker);
            ctx.mutationTracker.reflectionInjected = true;
          }
          updateToolOutcomeTracking(tc, content, runtimeSessionState, ctx);
          if (tc.name === 'edit' && isToolResultErrorContent(content)) {
            const recoveryMessage = await buildEditRecoveryUserMessage(tc, content, runtimeSessionState, ctx);
            if (recoveryMessage) {
              editRecoveryMessages.push(recoveryMessage);
            }
          }
          if (isVisibleToolName(tc.name)) {
            await emitActiveExtensionEvent('tool:result', {
              id: tc.id,
              name: tc.name,
              content,
            });
            events.onToolResult?.({ id: tc.id, name: tc.name, content });
            toolResults.push(createToolResultBlock(tc.id, content));
          }
        }
      }

      // Check if any tool was cancelled by user - 检查是否有工具被用户取消
      const hasCancellation = toolResults.some(r =>
        typeof r.content === 'string' && isCancelledToolResultContent(r.content)
      );

      if (toolResults.length === 0) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        break;
      }

      if (hasCancellation) {
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        // User cancelled - add results and exit loop - 用户取消，添加结果并退出循环
        messages.push({ role: 'user', content: toolResults });
        // Tool results are already appended, so emit the post-tool rebased snapshot here.
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, contextTokenSnapshot);
        }
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: 'Operation cancelled by user',
          hadToolCalls: true,
          signal: undefined,
        });
        events.onStreamEnd?.();
        await emitActiveExtensionEvent('stream:end', undefined);
        return finalizeManagedProtocolResult({
          success: true,
          lastText: 'Operation cancelled by user',
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          interrupted: !shouldYieldToQueuedFollowUp,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      if (editRecoveryMessages.length > 0) {
        messages.push({
          role: 'user',
          content: editRecoveryMessages.join('\n\n'),
          _synthetic: true,
        });
      }
      // Keep UI/context accounting aligned with the tool-result message we just appended.
      contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
      await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
        hadToolCalls: true,
        success: true,
      });
      if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        continue;
      }

      const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
      if (shouldYieldToQueuedFollowUp) {
        emitIterationEnd(iter + 1, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        return finalizeManagedProtocolResult({
          success: true,
          lastText,
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          limitReached: false,
        });
      }

      if (
        effectiveReasoningPlan.mode === 'auto' &&
        autoFollowUpCount < autoFollowUpLimit &&
        (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0) &&
        !postToolJudgeConsumed
      ) {
        const toolEvidence = summarizeToolEvidence(result.toolBlocks, toolResults);
        if (toolEvidence && hasStrongToolFailureEvidence(toolEvidence)) {
          postToolJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: false,
            retryLabelPrefix: 'Post-tool auto',
            toolEvidence,
            allowTaskReroute: !options.context?.disableAutoTaskReroute,
            persistSession: {
              sessionId,
              messages,
              title,
              runtimeSessionState,
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
      await saveSessionSnapshot(options, sessionId, {
        messages,
        title,
        runtimeSessionState,
      });

      // Notify UI of context usage after each iteration
      emitIterationEnd(iter + 1, contextTokenSnapshot);
      await emitActiveExtensionEvent('turn:end', {
        sessionId,
        iteration: iter + 1,
        lastText,
        hadToolCalls: true,
        signal: undefined,
      });
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
        runtimeSessionState,
      });
      contextTokenSnapshot = createEstimatedContextTokenSnapshot(cleanedMessages);

      // 检查是否为 AbortError（用户中断）
      // 参考 Gemini CLI: 静默处理中断，不报告为错误
      if (error.name === 'AbortError') {
        events.onStreamEnd?.();
        await emitActiveExtensionEvent('stream:end', undefined);

        // Issue 072 fix: 清理不完整的 tool_use 块
        // 当流式中断时，assistant 消息可能包含 tool_use 但没有对应的 tool_result
        // 这会导致下次请求时 API 报错 "tool_call_id not found"
        return finalizeManagedProtocolResult({
          success: true,  // 中断不算失败
          lastText,
          messages: cleanedMessages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          interrupted: true,
          errorMetadata: updatedErrorMetadata,
        });
      }

      await emitActiveExtensionEvent('error', { error });
      events.onError?.(error);
      return finalizeManagedProtocolResult({
        success: false,
        lastText,
        messages: cleanedMessages,  // ✅ Use cleaned messages to prevent error loop
        sessionId,
        routingDecision: currentRoutingDecision(),
        contextTokenSnapshot,
        errorMetadata: updatedErrorMetadata,
      });
    }
  }

  // 达到迭代上限 - 循环完成所有迭代没有提前退出
  // 如果代码执行到这里，说明循环正常结束（没有 COMPLETE、中断或错误）
  limitReached = true;

  // 最终保存
  await saveSessionSnapshot(options, sessionId, {
    messages,
    title,
    runtimeSessionState,
  });

  // 检查最终信号
  const [finalSignal, finalReason] = checkPromiseSignal(lastText);

  // 达到迭代上限 (循环正常结束但没有 COMPLETE 信号且没有提前退出)
  // 使用 limitReached 变量来准确判断
  return finalizeManagedProtocolResult({
    success: true,
    lastText,
    signal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    signalReason: finalReason,
    messages,
    sessionId,
    routingDecision: currentRoutingDecision(),
    contextTokenSnapshot,
    limitReached,
  });
  } finally {
    releaseRuntimeBinding?.();
    if (options.extensionRuntime && (options.extensionRuntime as KodaXExtensionRuntime) !== previousActiveRuntime) {
      setActiveExtensionRuntime(previousActiveRuntime);
    }
  }
}

export async function buildAutoRepoIntelligenceContext(
  options: KodaXOptions,
  reasoningPlan: ReasoningPlan,
  isNewSession: boolean,
  events?: KodaXEvents,
): Promise<string | undefined> {
  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  if (autoRepoMode === 'off') {
    return options.context?.repoIntelligenceContext;
  }

  const decision = reasoningPlan.decision;
  const includeRepoOverview =
    isNewSession
    || decision.primaryTask === 'plan'
    || decision.harnessProfile !== 'H0_DIRECT'
    || decision.complexity !== 'simple';
  const includeChangedScope =
    decision.primaryTask === 'review'
    || decision.primaryTask === 'bugfix'
    || decision.primaryTask === 'edit'
    || decision.primaryTask === 'refactor';

  if (!includeRepoOverview && !includeChangedScope) {
    return options.context?.repoIntelligenceContext;
  }

  try {
    const activeModuleTargetPath = options.context?.executionCwd ? '.' : undefined;
    const repoContext = {
      executionCwd: options.context?.executionCwd,
      gitRoot: options.context?.gitRoot ?? undefined,
    };
    const generatedContext = await buildRepoIntelligenceContext({
      executionCwd: options.context?.executionCwd,
      gitRoot: options.context?.gitRoot ?? undefined,
    }, {
      includeRepoOverview,
      includeChangedScope,
      refreshOverview: isNewSession,
      changedScope: 'all',
    });

    const includeActiveModule =
      decision.primaryTask === 'review'
      || decision.primaryTask === 'bugfix'
      || decision.primaryTask === 'edit'
      || decision.primaryTask === 'refactor';
    let moduleContext = '';
    let impactContext = '';
    let fallbackGuidance = '';
    let premiumContext = '';

    let moduleResult: Awaited<ReturnType<typeof getModuleContext>> | null = null;
    let impactResult: Awaited<ReturnType<typeof getImpactEstimate>> | null = null;

    if (includeActiveModule && autoRepoMode === 'premium-native') {
      const preturn = await getRepoPreturnBundle(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);
      if (preturn) {
        emitRepoIntelligenceTrace(events, options, 'preturn', preturn, preturn.summary);
        moduleResult = preturn.moduleContext ?? null;
        impactResult = preturn.impactEstimate ?? null;
        premiumContext = preturn.repoContext ?? '';
      }
    }

    if (includeActiveModule) {
      moduleResult = moduleResult ?? await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);

      if (moduleResult) {
        emitRepoIntelligenceTrace(
          events,
          options,
          'module',
          moduleResult,
          `module=${moduleResult.module.moduleId}`,
        );
        moduleContext = ['## Active Module Intelligence', renderModuleContext(moduleResult)].join('\n');
      }

      impactResult = impactResult ?? await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);

      if (impactResult) {
        emitRepoIntelligenceTrace(
          events,
          options,
          'impact',
          impactResult,
          `target=${impactResult.target.label}`,
        );
        impactContext = ['## Active Impact Intelligence', renderImpactEstimate(impactResult)].join('\n');
      }

      const lowConfidence =
        (moduleResult?.confidence ?? 1) < 0.72
        || (impactResult?.confidence ?? 1) < 0.72;
      if (lowConfidence || (!moduleResult && !impactResult)) {
        fallbackGuidance = [
          '## Repo Intelligence Guidance',
          '- Current repository intelligence is low-confidence for this area.',
          '- Validate critical edits with `module_context`, `symbol_context`, `grep`, and `read` before committing to a change.',
        ].join('\n');
      }
    }

    return [
      options.context?.repoIntelligenceContext,
      premiumContext,
      generatedContext,
      moduleContext,
      impactContext,
      fallbackGuidance,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
  } catch {
    return options.context?.repoIntelligenceContext;
  }
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
  const repoIntelligenceContext = await buildAutoRepoIntelligenceContext(
    options,
    reasoningPlan,
    isNewSession,
    options.events,
  );

  const effectiveOptions: KodaXOptions = {
    ...options,
    reasoningMode: reasoningPlan.mode,
    context: {
      ...options.context,
      executionCwd: resolveExecutionCwd(options.context),
      repoIntelligenceContext,
      providerPolicyHints: {
        ...options.context?.providerPolicyHints,
        ...buildProviderPolicyHintsForDecision(reasoningPlan.decision),
      },
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
    systemPrompt: options.context?.systemPromptOverride
      ?? await buildSystemPrompt(effectiveOptions, isNewSession),
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
// FEATURE_093 (v0.7.24): KodaXClient re-export removed from agent.ts to
// break the agent ↔ client cycle. Barrel `index.ts` imports KodaXClient
// directly from './client.js'.

// 导出工具函数
export { cleanupIncompleteToolCalls, validateAndFixToolHistory };
