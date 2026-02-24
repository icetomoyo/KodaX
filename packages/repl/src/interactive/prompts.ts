/**
 * KodaX 交互式提示组件
 *
 * 提供增强的确认提示、选项选择等 UI 组件
 */

import * as readline from 'readline';
import chalk from 'chalk';

/**
 * 确认选项定义
 */
export interface ConfirmOption {
  key: string;           // 按键
  label: string;         // 显示标签
  description: string;   // 描述
  value: string;         // 返回值
}

/**
 * 确认提示选项
 */
export interface ConfirmOptions {
  message: string;                           // 提示消息
  default?: string;                          // 默认值 (按 Enter 时使用)
  options?: ConfirmOption[];                 // 自定义选项
  showDescription?: boolean;                 // 是否显示描述 (默认 true)
}

/**
 * 默认 Yes/No 选项
 */
const DEFAULT_YES_NO_OPTIONS: ConfirmOption[] = [
  { key: 'y', label: 'Yes', description: '确认执行', value: 'yes' },
  { key: 'n', label: 'No', description: '取消操作', value: 'no' },
];

/**
 * 安全确认选项 (带 "always" 选项)
 */
const SAFETY_CONFIRM_OPTIONS: ConfirmOption[] = [
  { key: 'y', label: 'Yes', description: '本次允许', value: 'yes' },
  { key: 'n', label: 'No', description: '取消', value: 'no' },
  { key: 'a', label: 'Always', description: '始终允许此类操作', value: 'always' },
];

/**
 * 格式化选项显示
 */
function formatOptions(
  options: ConfirmOption[],
  showDescription: boolean = true
): string {
  return options.map(opt => {
    const keyPart = chalk.dim(`[${opt.key}]`);
    if (showDescription) {
      return `${keyPart} ${chalk.cyan(opt.label)} ${chalk.dim(`- ${opt.description}`)}`;
    }
    return `${keyPart} ${opt.label}`;
  }).join('  ');
}

/**
 * 获取终端宽度
 */
export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * 检测是否支持 ANSI 颜色
 */
export function supportsColor(): boolean {
  return process.stdout.isTTY && process.stdout.hasColors();
}

/**
 * 检测是否支持 Unicode
 */
export function supportsUnicode(): boolean {
  // Windows 默认使用 CP437/CP936，可能不支持某些 Unicode 字符
  const env = process.env;
  if (process.platform === 'win32') {
    // 检测是否在 Windows Terminal 或支持 Unicode 的终端中
    return env.WT_SESSION !== undefined || env.TERM_PROGRAM === 'vscode';
  }
  return true;
}

/**
 * 获取适配的符号
 */
export function getSymbols() {
  const unicode = supportsUnicode();
  return {
    success: unicode ? '✓' : '[OK]',
    error: unicode ? '✗' : '[X]',
    warning: unicode ? '⚠' : '[!]',
    info: unicode ? 'ℹ' : '[i]',
    arrow: unicode ? '→' : '->',
    bullet: unicode ? '•' : '*',
    check: unicode ? '✔' : '[v]',
    cross: unicode ? '✘' : '[x]',
  };
}

/**
 * 增强的确认提示
 *
 * @example
 * // 简单 Yes/No
 * const result = await confirmEnhanced({
 *   message: 'Continue?',
 *   default: 'y',
 * });
 *
 * @example
 * // 自定义选项
 * const result = await confirmEnhanced({
 *   message: 'How to proceed?',
 *   options: [
 *     { key: 'a', label: 'All', description: 'Apply to all', value: 'all' },
 *     { key: 's', label: 'Skip', description: 'Skip this', value: 'skip' },
 *   ],
 * });
 */
export async function confirmEnhanced(
  rl: readline.Interface,
  options: ConfirmOptions
): Promise<string> {
  const {
    message,
    default: defaultKey,
    options: customOptions,
    showDescription = true,
  } = options;

  const opts = customOptions ?? DEFAULT_YES_NO_OPTIONS;

  // 格式化选项文本
  const optionsText = formatOptions(opts, showDescription);

  // 打印消息
  console.log();
  console.log(chalk.cyan(`? ${message}`));

  // 根据终端宽度决定显示方式
  const width = getTerminalWidth();
  if (optionsText.length > width - 4) {
    // 选项太长，分行显示
    for (const opt of opts) {
      const keyPart = chalk.dim(`  [${opt.key}]`);
      console.log(`${keyPart} ${chalk.cyan(opt.label)}`);
      if (showDescription) {
        console.log(chalk.dim(`        ${opt.description}`));
      }
    }
  } else {
    // 单行显示
    console.log(chalk.dim(`  ${optionsText}`));
  }

  return new Promise((resolve) => {
    const defaultHint = defaultKey ? ` (${defaultKey})` : '';
    rl.question(chalk.dim(`  Choose${defaultHint}: `), (answer) => {
      const input = answer.trim().toLowerCase() || defaultKey || '';

      // 查找匹配的选项
      const matched = opts.find(
        opt => opt.key === input || opt.value === input || opt.label.toLowerCase() === input
      );

      if (matched) {
        resolve(matched.value);
      } else if (input === '') {
        // 无输入且无默认值，返回 'no'
        resolve('no');
      } else {
        // 无效输入，返回原始输入
        resolve(input);
      }
    });
  });
}

/**
 * 安全确认提示 (带 Always 选项)
 *
 * @returns 'yes' | 'no' | 'always'
 */
export async function confirmWithAlways(
  rl: readline.Interface,
  message: string,
  context?: string
): Promise<'yes' | 'no' | 'always'> {
  let fullMessage = message;
  if (context) {
    fullMessage = `${message}\n  ${chalk.dim(context)}`;
  }

  const result = await confirmEnhanced(rl, {
    message: fullMessage,
    default: 'n',
    options: SAFETY_CONFIRM_OPTIONS,
  });

  return result as 'yes' | 'no' | 'always';
}

/**
 * 工具执行确认提示
 */
export async function confirmToolExecution(
  rl: readline.Interface,
  tool: string,
  input: Record<string, unknown>,
  options?: {
    isOutsideProject?: boolean;
    reason?: string;
  }
): Promise<boolean> {
  const { isOutsideProject = false, reason } = options ?? {};
  const symbols = getSymbols();

  let message: string;
  let promptOptions: ConfirmOption[];

  if (isOutsideProject) {
    // 安全警告提示
    message = `${chalk.yellow(symbols.warning)} Safety Warning`;
    if (reason) {
      message += `\n  ${chalk.dim(reason)}`;
    }

    // 根据工具类型添加具体信息
    if (tool === 'write' || tool === 'edit') {
      message += `\n  ${chalk.dim(`File: ${input.path}`)}`;
    } else if (tool === 'bash') {
      const cmd = (input.command as string)?.slice(0, 50) ?? '';
      message += `\n  ${chalk.dim(`Command: ${cmd}${cmd.length >= 50 ? '...' : ''}`)}`;
    }

    promptOptions = [
      { key: 'y', label: 'Yes', description: '本次允许', value: 'yes' },
      { key: 'n', label: 'No', description: '取消', value: 'no' },
    ];
  } else {
    // 普通确认
    switch (tool) {
      case 'bash':
        message = `Execute bash command?`;
        const cmd = (input.command as string)?.slice(0, 60) ?? '';
        const suffix = cmd.length >= 60 ? '...' : '';
        message += `\n  ${chalk.dim(cmd + suffix)}`;
        break;
      case 'write':
        message = `Write to file?`;
        message += `\n  ${chalk.dim(`Path: ${input.path}`)}`;
        break;
      case 'edit':
        message = `Edit file?`;
        message += `\n  ${chalk.dim(`Path: ${input.path}`)}`;
        break;
      default:
        message = `Execute tool: ${tool}?`;
    }

    promptOptions = DEFAULT_YES_NO_OPTIONS;
  }

  const result = await confirmEnhanced(rl, {
    message,
    default: 'n',
    options: promptOptions,
  });

  return result === 'yes';
}

/**
 * 选择列表提示
 */
export async function selectFromList<T extends string>(
  rl: readline.Interface,
  message: string,
  items: Array<{ value: T; label: string; description?: string }>
): Promise<T> {
  const symbols = getSymbols();

  console.log();
  console.log(chalk.cyan(`? ${message}`));

  // 显示选项
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const num = chalk.dim(`${i + 1}.`.padStart(4));
    let line = `  ${num} ${item.label}`;
    if (item.description) {
      line += ` ${chalk.dim(`- ${item.description}`)}`;
    }
    console.log(line);
  }

  return new Promise((resolve) => {
    rl.question(chalk.dim(`  Select (1-${items.length}): `), (answer) => {
      const num = parseInt(answer.trim(), 10);
      if (num >= 1 && num <= items.length) {
        resolve(items[num - 1]!.value);
      } else {
        // 尝试匹配标签
        const matched = items.find(
          item => item.label.toLowerCase() === answer.trim().toLowerCase()
        );
        resolve(matched?.value ?? items[0]!.value);
      }
    });
  });
}

/**
 * 显示操作结果
 */
export function showResult(success: boolean, message: string): void {
  const symbols = getSymbols();
  if (success) {
    console.log(chalk.green(`  ${symbols.success} ${message}`));
  } else {
    console.log(chalk.red(`  ${symbols.error} ${message}`));
  }
}

/**
 * 显示信息消息
 */
export function showInfo(message: string): void {
  const symbols = getSymbols();
  console.log(chalk.blue(`  ${symbols.info} ${message}`));
}

/**
 * 显示警告消息
 */
export function showWarning(message: string): void {
  const symbols = getSymbols();
  console.log(chalk.yellow(`  ${symbols.warning} ${message}`));
}
