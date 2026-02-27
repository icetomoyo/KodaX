/**
 * KodaX Tool Registry
 *
 * 工具注册表 - 统一管理所有工具
 * Pure execution - no permission checks (handled by REPL layer)
 */

import { ToolHandler } from './types.js';
import { KodaXToolExecutionContext } from '../types.js';
import { KodaXToolDefinition } from '@kodax/ai';
import { KODAX_TOOL_REQUIRED_PARAMS } from '../constants.js';
import { toolRead } from './read.js';
import { toolWrite } from './write.js';
import { toolEdit } from './edit.js';
import { toolBash } from './bash.js';
import { toolGlob } from './glob.js';
import { toolGrep } from './grep.js';
import { toolUndo } from './undo.js';

// 工具注册表
const TOOL_REGISTRY = new Map<string, ToolHandler>();

export function registerTool(name: string, handler: ToolHandler): void {
  TOOL_REGISTRY.set(name, handler);
}

export function getTool(name: string): ToolHandler | undefined {
  return TOOL_REGISTRY.get(name);
}

export function listTools(): string[] {
  return Array.from(TOOL_REGISTRY.keys());
}

// 自动注册内置工具
registerTool('read', toolRead);
registerTool('write', toolWrite);
registerTool('edit', toolEdit);
registerTool('bash', toolBash);
registerTool('glob', toolGlob);
registerTool('grep', toolGrep);
registerTool('undo', toolUndo);

// 工具定义
export const KODAX_TOOLS: KodaXToolDefinition[] = [
  {
    name: 'read',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Perform exact string replacement in a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['command'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search for a pattern in files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern' },
        path: { type: 'string', description: 'File or directory to search' },
        ignore_case: { type: 'boolean', description: 'Case insensitive search' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'undo',
    description: 'Revert the last file modification.',
    input_schema: { type: 'object', properties: {} },
  },
];

/**
 * Execute a tool - pure execution without permission checks
 * 执行工具 - 纯执行，无权限检查
 *
 * Permission checks are handled by the REPL layer's executeWithPermission()
 * 权限检查由 REPL 层的 executeWithPermission() 处理
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext
): Promise<string> {
  // Validate required parameters
  const required = KODAX_TOOL_REQUIRED_PARAMS[name] ?? [];
  const missing = required.filter(p => input[p] === undefined || input[p] === null);
  if (missing.length > 0) {
    return `[Tool Error] ${name}: Missing required parameter(s): ${missing.join(', ')}`;
  }

  // Check if tool exists
  if (!KODAX_TOOL_REQUIRED_PARAMS.hasOwnProperty(name)) {
    return `[Tool Error] Unknown tool: ${name}. Available tools: ${Object.keys(KODAX_TOOL_REQUIRED_PARAMS).join(', ')}`;
  }

  // Get handler
  const handler = getTool(name);
  if (!handler) {
    return `[Tool Error] Unknown tool: ${name}`;
  }

  // Execute
  try {
    return await handler(input, ctx);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    // 提供更详细的错误信息
    if (errorMsg.includes('ENOENT')) {
      return `[Tool Error] ${name}: File or directory not found`;
    } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
      return `[Tool Error] ${name}: Permission denied`;
    } else if (errorMsg.includes('ENOSPC')) {
      return `[Tool Error] ${name}: No space left on device`;
    }
    return `[Tool Error] ${name}: ${errorMsg}`;
  }
}
