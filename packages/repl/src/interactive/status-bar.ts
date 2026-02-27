/**
 * KodaX 状态栏组件
 *
 * 在终端底部显示持久状态信息，包括会话 ID、模式、Provider、Token 使用量等
 */

import chalk from 'chalk';
import { getTerminalWidth, getSymbols, supportsUnicode } from './prompts.js';

/**
 * 状态栏状态
 */
export interface StatusBarState {
  sessionId: string;           // 简短会话 ID
  permissionMode: string;      // 当前权限模式 (PermissionMode)
  provider: string;            // Provider 名称
  model: string;               // 模型名称
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  currentTool?: string;        // 当前执行的工具
  projectInfo?: {
    name: string;
    completedFeatures: number;
    totalFeatures: number;
  };
  messageCount?: number;       // 消息数量
}

/**
 * ANSI 转义序列正则表达式（缓存避免重复编译）
 */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * ANSI 转义序列
 */
const ANSI = {
  // 光标控制
  SAVE_CURSOR: '\x1b[s',
  RESTORE_CURSOR: '\x1b[u',
  MOVE_TO_BOTTOM: '\x1b[999;1H',
  MOVE_TO_ROW: (row: number) => `\x1b[${row};1H`,
  CLEAR_LINE: '\x1b[2K',
  CLEAR_BELOW: '\x1b[J',

  // 颜色
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
  REVERSE: '\x1b[7m',

  // 滚动区域
  SET_SCROLL_REGION: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
};

/**
 * 状态栏类
 */
export class StatusBar {
  private state: StatusBarState;
  private visible = false;
  private linesUsed = 1;
  private lastRenderHeight = 0;

  constructor(initialState: StatusBarState) {
    this.state = initialState;
  }

  /**
   * 更新状态
   */
  update(updates: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...updates };
    if (this.visible) {
      this.render();
    }
  }

  /**
   * 显示状态栏
   */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.render();
  }

  /**
   * 隐藏状态栏
   */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.clear();
  }

  /**
   * 切换显示状态
   */
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * 获取状态栏占用的行数
   */
  getLinesUsed(): number {
    return this.linesUsed;
  }

  /**
   * 渲染状态栏
   */
  private render(): void {
    const width = getTerminalWidth();
    const symbols = getSymbols();

    // 构建状态栏内容
    const parts: string[] = [];

    // 会话 ID (简短)
    const shortId = this.state.sessionId.slice(0, 6);
    parts.push(chalk.dim(`#${shortId}`));

    // 权限模式
    const modeColor =
      this.state.permissionMode === 'plan'
        ? chalk.blue
        : this.state.permissionMode === 'accept-edits'
          ? chalk.cyan
          : this.state.permissionMode === 'auto-in-project'
            ? chalk.magenta
            : chalk.green; // default
    parts.push(modeColor(this.state.permissionMode));

    // Provider
    parts.push(chalk.cyan(`${this.state.provider}`));

    // Token 使用量
    if (this.state.tokenUsage) {
      const total = this.state.tokenUsage.total;
      const totalStr = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
      parts.push(chalk.dim(`${totalStr}t`));
    }

    // 当前工具
    if (this.state.currentTool) {
      parts.push(chalk.magenta(`${symbols.arrow} ${this.state.currentTool}`));
    }

    // 项目进度
    if (this.state.projectInfo) {
      const { completedFeatures, totalFeatures } = this.state.projectInfo;
      const percent = totalFeatures > 0 ? Math.round((completedFeatures / totalFeatures) * 100) : 0;
      parts.push(chalk.dim(`${completedFeatures}/${totalFeatures} [${percent}%]`));
    }

    // 消息数量
    if (this.state.messageCount !== undefined) {
      parts.push(chalk.dim(`${this.state.messageCount} msgs`));
    }

    // 组装状态栏
    const separator = chalk.dim(' | ');
    let content = parts.join(separator);

    // 截断过长的内容
    if (content.length > width - 2) {
      content = content.slice(0, width - 5) + chalk.dim('...');
    }

    // 渲染到终端底部
    this.renderToBottom(content);
  }

  /**
   * 渲染到终端底部
   */
  private renderToBottom(content: string): void {
    const width = getTerminalWidth();

    // 填充到终端宽度
    const paddedContent = content + ' '.repeat(Math.max(0, width - this.stripAnsi(content).length));

    // 使用 ANSI 序列保存光标位置并移动到底部
    process.stdout.write(
      ANSI.SAVE_CURSOR +
      ANSI.MOVE_TO_BOTTOM +
      ANSI.CLEAR_LINE +
      ANSI.REVERSE +
      paddedContent.slice(0, width) +
      ANSI.RESET +
      ANSI.RESTORE_CURSOR
    );
  }

  /**
   * 清除状态栏
   */
  private clear(): void {
    process.stdout.write(
      ANSI.SAVE_CURSOR +
      ANSI.MOVE_TO_BOTTOM +
      ANSI.CLEAR_LINE +
      ANSI.RESTORE_CURSOR
    );
  }

  /**
   * 移除 ANSI 转义序列
   */
  private stripAnsi(str: string): string {
    // 使用缓存的正则表达式，避免重复编译
    ANSI_REGEX.lastIndex = 0; // 重置 lastIndex 确保从头匹配
    return str.replace(ANSI_REGEX, '');
  }
}

/**
 * 创建简化的状态栏状态
 */
export function createStatusBarState(
  sessionId: string,
  permissionMode: string,
  provider: string,
  model: string
): StatusBarState {
  return {
    sessionId,
    permissionMode,
    provider,
    model,
  };
}

/**
 * 检测终端是否支持状态栏功能
 */
export function supportsStatusBar(): boolean {
  // 需要 TTY 和 ANSI 支持
  if (!process.stdout.isTTY) return false;

  // 检测终端类型
  const term = process.env.TERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';

  // 支持的终端
  const supportedTerminals = [
    'xterm', 'xterm-256color', 'screen', 'screen-256color',
    'tmux', 'tmux-256color', 'vt100', 'vt220',
  ];

  const supportedPrograms = [
    'iTerm.app', 'Terminal.app', 'Apple_Terminal',
    'vscode', 'Hyper', 'Alacritty', 'kitty', 'Windows Terminal',
  ];

  return (
    supportedTerminals.some(t => term.startsWith(t)) ||
    supportedPrograms.includes(termProgram) ||
    process.env.WT_SESSION !== undefined // Windows Terminal
  );
}

/**
 * 格式化 Token 数量
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  } else if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

/**
 * 创建进度条字符串
 */
export function createProgressBar(
  current: number,
  total: number,
  width: number = 20
): string {
  if (total === 0) return '░'.repeat(width);

  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const symbols = getSymbols();
  const filledChar = supportsUnicode() ? '█' : '#';
  const emptyChar = supportsUnicode() ? '░' : '-';

  return (
    chalk.green(filledChar.repeat(filled)) +
    chalk.dim(emptyChar.repeat(empty))
  );
}
