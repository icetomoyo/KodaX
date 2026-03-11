/**
 * Permission Types
 *
 * 权限系统类型定义
 */

// ============== Permission Mode ==============

/**
 * Permission mode - 权限模式
 * - plan: Read-only planning, all modifications blocked - 只读规划，禁止所有修改操作
 * - default: All tools require confirmation - 全部需要确认
 * - accept-edits: File edits auto-approved, shell commands require confirmation - 文件自动，命令需确认
 * - auto-in-project: All tools auto-approved within project, outside requires confirmation - 项目内全自动，项目外需确认
 */
export type PermissionMode = 'plan' | 'default' | 'accept-edits' | 'auto-in-project';

// ============== Confirm Result ==============

/**
 * Confirmation result - 确认结果
 * - confirmed: Whether the user confirmed the action - 用户是否确认
 * - always: If true, remember this choice for future uses of this tool - 如果为 true，记住这个选择
 */
export interface ConfirmResult {
  confirmed: boolean;
  always?: boolean;
}

// ============== Tool Categories ==============

/** Modification tools that are blocked in plan mode - plan 模式下被阻止的修改工具 */
export const MODIFICATION_TOOLS = new Set(['write', 'edit', 'bash', 'undo']);

/** File modification tools (not commands) - 文件修改工具（不包括命令） */
export const FILE_MODIFICATION_TOOLS = new Set(['write', 'edit']);

/**
 * Bash commands that have write side-effects (blocked in plan mode)
 * 具有写副作用的 Bash 命令（plan 模式下被阻止）
 *
 * Note: This is a blacklist approach - only explicitly listed commands are blocked
 * All other bash commands (like git status, cat, ls) are allowed in plan mode
 */
export const BASH_WRITE_COMMANDS = new Set([
  // Package managers - 包管理器
  'npm install', 'npm i', 'npm uninstall', 'npm remove', 'npm update', 'npm ci',
  'yarn add', 'yarn remove', 'yarn upgrade',
  'pnpm add', 'pnpm remove', 'pnpm update',

  // Git write operations - Git 写操作
  'git clean', 'git reset', 'git checkout', 'git switch', 'git merge', 'git rebase',
  'git cherry-pick', 'git revert', 'git commit', 'git push', 'git pull',

  // File operations - 文件操作
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown',

  // Download/create - 下载/创建
  'curl', 'wget', 'dd', 'tar',

  // Process control - 进程控制
  'kill', 'pkill', 'killall',
]);

/**
 * Strict whitelist of bash commands considered safe for read-only exploration in plan mode.
 * Any bash command not matching these bases will require user confirmation.
 * 严格的白名单，包含在 plan 模式下被认为是安全的只读探讨 bash 命令。
 * 任何不匹配这些基命令的 bash 操作都将需要用户确认。
 * 
 * Note: Some base commands here (like 'npm', 'git') overlap with specific blocked 
 * operations in BASH_WRITE_COMMANDS (like 'npm install', 'git commit'). 
 * This is intentional: the base command is allowed for info/read via whitelist,
 * but the specific mutation parameters are caught by the blacklist.
 */
export const BASH_SAFE_READ_COMMANDS = new Set([
  // Basic shell inspection - 基础 shell 检查
  'ls', 'cat', 'pwd', 'echo', 'whoami', 'date', 'which', 'whereis', 'tree',

  // Search and find - 搜索与查找
  'grep', 'find', 'awk', 'sed', 'head', 'tail', 'less', 'more', 'wc',

  // Git operations (read-only) - Git 只读操作
  'git status', 'git diff', 'git log', 'git show', 'git branch', 
  'git remote', 'git ls-files', 'git rev-parse', 'git grep',

  // Language toolchains (version/info only) - 语言工具链信息/版本
  'node', 'npm', 'yarn', 'pnpm', 'tsc', 'python', 'pip', 'go', 'cargo', 'rustc'
]);

// ============== Permission Context ==============

/**
 * Permission context for tool execution - 工具执行的权限上下文
 */
export interface PermissionContext {
  /** Current permission mode - 当前权限模式 */
  permissionMode: PermissionMode;
  /** Tools that require confirmation - 需要确认的工具 */
  confirmTools: Set<string>;
  /** Git root directory - Git 根目录 */
  gitRoot?: string;
  /** Allowed tool patterns (e.g., ["Bash(npm install)", "Bash(git commit:*)"]) - 允许的工具模式 */
  alwaysAllowTools: string[];
  /** Callback for user confirmation - 用户确认回调 */
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  /** Callback to save a tool pattern to always-allow list - 保存工具模式到总是允许列表的回调 */
  saveAlwaysAllowTool?: (tool: string, input: Record<string, unknown>, allowAll?: boolean) => void;
  /** Callback to switch permission mode - 切换权限模式的回调 */
  switchPermissionMode?: (mode: PermissionMode) => void;
  /** Pre-execution hook - 执行前钩子 */
  beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Compute confirmTools set from permission mode - 根据权限模式计算 confirmTools
 *
 * | Mode             | confirmTools             |
 * |------------------|--------------------------|
 * | plan             | all modification tools   |
 * | default          | bash + write + edit      |
 * | accept-edits     | bash only                |
 * | auto-in-project  | empty (project-level guard applies) |
 */
export function computeConfirmTools(mode: PermissionMode): Set<string> {
  switch (mode) {
    case 'plan':
      return new Set(['bash', 'write', 'edit', 'undo']);
    case 'default':
      return new Set(['bash', 'write', 'edit']);
    case 'accept-edits':
      return new Set(['bash']);
    case 'auto-in-project':
      return new Set();
  }
}
