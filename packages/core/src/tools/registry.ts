/**
 * KodaX Tool Registry
 *
 * 工具注册表 - 统一管理所有工具
 */

import path from 'path';
import { ToolHandler } from './types.js';
import { KodaXToolExecutionContext, KodaXToolDefinition } from '../types.js';
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

// ============== 路径安全检查 ==============

/**
 * 检查路径是否在项目目录内
 * 用于 auto 模式下对项目外文件修改的安全检查
 */
function isPathInsideProject(targetPath: string, projectRoot: string): boolean {
  try {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(projectRoot);
    // 规范化路径比较（处理 Windows/Unix 差异）
    const normalizedTarget = resolvedTarget.toLowerCase();
    const normalizedRoot = resolvedRoot.toLowerCase();
    // 检查目标路径是否以项目根目录开头
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * 检测 bash 命令是否包含对项目外文件的危险操作
 * 危险操作包括：rm, mv, cp, rmdir, del, rd 等
 */
function isBashCommandDangerousOutsideProject(command: string, projectRoot: string): { dangerous: boolean; reason?: string } {
  // 危险命令列表（文件修改相关）
  const DANGEROUS_COMMANDS = [
    'rm ', 'rm -', 'rmdir', 'mv ', 'cp ', 'del ', 'rd ',
    'shred', 'wipe', 'chmod', 'chown',
    '>', '>>', '2>', // 重定向操作
  ];

  const normalizedCmd = command.toLowerCase();

  // 检查是否包含危险命令
  const hasDangerousCmd = DANGEROUS_COMMANDS.some(cmd => normalizedCmd.includes(cmd));
  if (!hasDangerousCmd) {
    return { dangerous: false };
  }

  // 提取命令中的绝对路径（Unix 和 Windows 格式）
  // Unix: /path/to/file
  // Windows: C:\path\to\file 或 C:/path/to/file
  const absPathPatterns = [
    /\/[^\s;|&<>(){}'"]+/g,  // Unix 绝对路径
    /[A-Za-z]:[\\/][^\s;|&<>(){}'"]+/g,  // Windows 绝对路径
  ];

  for (const pattern of absPathPatterns) {
    const matches = command.match(pattern);
    if (matches) {
      for (const match of matches) {
        // 跳过常见的安全路径（如 /dev/null, /tmp 等）
        if (match.startsWith('/dev/') || match.startsWith('/tmp/')) continue;

        if (!isPathInsideProject(match, projectRoot)) {
          return {
            dangerous: true,
            reason: `Command may modify file outside project: ${match}`
          };
        }
      }
    }
  }

  // 如果包含重定向且目标不在项目内
  if (normalizedCmd.includes('>') || normalizedCmd.includes('>>')) {
    // 提取重定向目标
    const redirectMatch = command.match(/[>]>\s*([^\s;|&]+)/g);
    if (redirectMatch) {
      for (const match of redirectMatch) {
        const targetPath = match.replace(/[>]>\s*/, '').trim();
        if (targetPath && !targetPath.startsWith('/') && !targetPath.match(/^[A-Za-z]:/)) {
          // 相对路径，视为安全（在当前目录下）
          continue;
        }
        if (targetPath && !isPathInsideProject(targetPath, projectRoot)) {
          return {
            dangerous: true,
            reason: `Redirect target outside project: ${targetPath}`
          };
        }
      }
    }
  }

  return { dangerous: false };
}

// 执行工具
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext
): Promise<string> {
  const required = KODAX_TOOL_REQUIRED_PARAMS[name] ?? [];
  const missing = required.filter(p => input[p] === undefined || input[p] === null);
  if (missing.length > 0) {
    return `[Tool Error] ${name}: Missing required parameter(s): ${missing.join(', ')}`;
  }

  // 未知工具检查
  if (!KODAX_TOOL_REQUIRED_PARAMS.hasOwnProperty(name)) {
    return `[Tool Error] Unknown tool: ${name}. Available tools: ${Object.keys(KODAX_TOOL_REQUIRED_PARAMS).join(', ')}`;
  }

  // Auto 模式下，项目外文件修改需要确认
  const MODIFICATION_TOOLS = new Set(['write', 'edit']);

  // write/edit: 检查目标文件路径
  if (ctx.auto && ctx.gitRoot && MODIFICATION_TOOLS.has(name)) {
    const targetPath = input.path as string;
    if (targetPath && !isPathInsideProject(targetPath, ctx.gitRoot)) {
      const confirmed = ctx.onConfirm ? await ctx.onConfirm(name, { ...input, _outsideProject: true }) : true;
      if (!confirmed) return '[Cancelled] Operation on file outside project directory was cancelled';
    }
  }

  // bash: 检查命令是否涉及项目外的危险操作
  if (ctx.auto && ctx.gitRoot && name === 'bash') {
    const command = input.command as string;
    if (command) {
      const dangerCheck = isBashCommandDangerousOutsideProject(command, ctx.gitRoot);
      if (dangerCheck.dangerous) {
        const confirmed = ctx.onConfirm ? await ctx.onConfirm(name, { ...input, _outsideProject: true, _reason: dangerCheck.reason }) : true;
        if (!confirmed) return `[Cancelled] ${dangerCheck.reason}`;
      }
    }
  }

  if (ctx.confirmTools.has(name) && !ctx.auto) {
    const confirmed = ctx.onConfirm ? await ctx.onConfirm(name, input) : true;
    if (!confirmed) return '[Cancelled] Operation cancelled by user';
  }

  const handler = getTool(name);
  if (!handler) {
    return `[Tool Error] Unknown tool: ${name}`;
  }

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
