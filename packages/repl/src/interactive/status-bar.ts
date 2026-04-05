/**
 * Readline status bar for the classic REPL.
 */

import chalk from 'chalk';
import { getTerminalWidth } from './prompts.js';
import { hasMainScreenRenderScrollRisk } from '../ui/utils/terminal-host-profile.js';

export interface StatusBarState {
  sessionId: string;
  permissionMode: string;
  reasoningMode?: string;
  parallel?: boolean;
  provider: string;
  model: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  currentTool?: string;
  projectInfo?: {
    name: string;
    completedFeatures: number;
    totalFeatures: number;
  };
  messageCount?: number;
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

const ANSI = {
  SAVE_CURSOR: '\x1b[s',
  RESTORE_CURSOR: '\x1b[u',
  MOVE_TO_BOTTOM: '\x1b[999;1H',
  CLEAR_LINE: '\x1b[2K',
  RESET: '\x1b[0m',
  REVERSE: '\x1b[7m',
};

function truncateAnsi(str: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) {
    return '';
  }

  let result = '';
  let visibleChars = 0;
  let index = 0;

  while (index < str.length && visibleChars < maxVisibleChars) {
    ANSI_REGEX.lastIndex = index;
    const match = ANSI_REGEX.exec(str);

    if (match && match.index === index) {
      result += match[0];
      index += match[0].length;
      continue;
    }

    result += str[index];
    visibleChars += 1;
    index += 1;
  }

  return result;
}

function stripAnsi(str: string): string {
  ANSI_REGEX.lastIndex = 0;
  return str.replace(ANSI_REGEX, '');
}

function formatExecutionMode(parallel = false): 'parallel' | 'sequential' {
  return parallel ? 'parallel' : 'sequential';
}

export function buildStatusBarContent(state: StatusBarState, width = getTerminalWidth()): string {
  const parts: string[] = [];
  const shortId = state.sessionId.slice(0, 6);

  parts.push(chalk.dim(`#${shortId}`));

  const modeColor =
    state.permissionMode === 'plan'
      ? chalk.blue
      : state.permissionMode === 'accept-edits'
        ? chalk.cyan
        : state.permissionMode === 'auto-in-project'
          ? chalk.magenta
          : chalk.green;

  parts.push(modeColor(state.permissionMode));

  if (state.reasoningMode) {
    parts.push(chalk.yellow(`reason:${state.reasoningMode}`));
  }

  parts.push(
    state.parallel
      ? chalk.green(`exec:${formatExecutionMode(state.parallel)}`)
      : chalk.dim(`exec:${formatExecutionMode(state.parallel)}`),
  );

  parts.push(chalk.cyan(state.provider));

  if (state.tokenUsage) {
    const total = state.tokenUsage.total;
    const totalStr = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
    parts.push(chalk.dim(`${totalStr}t`));
  }

  if (state.currentTool) {
    parts.push(chalk.magenta(`tool:${state.currentTool}`));
  }

  if (state.projectInfo) {
    const { completedFeatures, totalFeatures } = state.projectInfo;
    const percent = totalFeatures > 0
      ? Math.round((completedFeatures / totalFeatures) * 100)
      : 0;
    parts.push(chalk.dim(`${completedFeatures}/${totalFeatures} [${percent}%]`));
  }

  if (state.messageCount !== undefined) {
    parts.push(chalk.dim(`${state.messageCount} msgs`));
  }

  let content = parts.join(chalk.dim(' | '));
  const visibleWidth = width - 1;
  if (stripAnsi(content).length > visibleWidth) {
    content = `${truncateAnsi(content, Math.max(0, visibleWidth - 3))}...`;
  }

  return content;
}

export class StatusBar {
  private state: StatusBarState;
  private visible = false;

  constructor(initialState: StatusBarState) {
    this.state = initialState;
  }

  update(updates: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...updates };
    if (this.visible) {
      this.render();
    }
  }

  show(): void {
    if (this.visible) {
      return;
    }
    this.visible = true;
    this.render();
  }

  hide(): void {
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.clear();
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
      return;
    }
    this.show();
  }

  getLinesUsed(): number {
    return 1;
  }

  private render(): void {
    const width = getTerminalWidth();
    const content = buildStatusBarContent(this.state, width);
    const paddedContent = content + ' '.repeat(Math.max(0, width - stripAnsi(content).length));
    process.stdout.write(
      ANSI.SAVE_CURSOR +
      ANSI.MOVE_TO_BOTTOM +
      ANSI.CLEAR_LINE +
      ANSI.REVERSE +
      paddedContent +
      ANSI.RESET +
      ANSI.RESTORE_CURSOR,
    );
  }

  private clear(): void {
    process.stdout.write(
      ANSI.SAVE_CURSOR +
      ANSI.MOVE_TO_BOTTOM +
      ANSI.CLEAR_LINE +
      ANSI.RESTORE_CURSOR,
    );
  }
}

export function createStatusBarState(
  sessionId: string,
  permissionMode: string,
  provider: string,
  model: string,
  reasoningMode = 'off',
  parallel = false,
): StatusBarState {
  return {
    sessionId,
    permissionMode,
    reasoningMode,
    parallel,
    provider,
    model,
  };
}

export function supportsStatusBar(): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }

  if (hasMainScreenRenderScrollRisk()) {
    return false;
  }

  const term = process.env.TERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const supportedTerminals = [
    'xterm',
    'xterm-256color',
    'screen',
    'screen-256color',
    'tmux',
    'tmux-256color',
    'vt100',
    'vt220',
  ];
  const supportedPrograms = [
    'iTerm.app',
    'Terminal.app',
    'Apple_Terminal',
    'vscode',
    'Hyper',
    'Alacritty',
    'kitty',
    'Windows Terminal',
  ];

  return (
    supportedTerminals.some((value) => term.startsWith(value)) ||
    supportedPrograms.includes(termProgram) ||
    process.env.WT_SESSION !== undefined
  );
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

export function createProgressBar(
  current: number,
  total: number,
  width = 20,
): string {
  if (total === 0) {
    return '-'.repeat(width);
  }

  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return `${chalk.green('#'.repeat(filled))}${chalk.dim('-'.repeat(empty))}`;
}
