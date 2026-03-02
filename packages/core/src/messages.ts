/**
 * KodaX Messages
 *
 * 消息处理 - 重新导出 @kodax/agent 消息功能 + Coding 特定功能
 */

// ============== Re-export from @kodax/agent ==============

export { compactMessages } from '@kodax/agent';

// ============== Coding-specific: 工具调用检查 ==============

import type { KodaXToolUseBlock } from '@kodax/ai';
import { KODAX_TOOL_REQUIRED_PARAMS } from './constants.js';

/**
 * 检查工具调用是否完整
 * 返回不完整工具调用列表
 * 这是 Coding Agent 特定的功能，依赖具体的工具定义
 */
export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    const required = KODAX_TOOL_REQUIRED_PARAMS[tc.name] ?? [];
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === '') {
        incomplete.push(`${tc.name}: missing '${param}'`);
      }
    }
  }
  return incomplete;
}
