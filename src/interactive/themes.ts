/**
 * KodaX 主题系统
 *
 * 支持多种主题配色方案，提供一致的视觉体验
 */

import chalk from 'chalk';

/**
 * 主题颜色定义
 */
export interface ThemeColors {
  primary: string;             // 主色调
  secondary: string;           // 次要颜色
  accent: string;              // 强调色
  text: string;                // 文本颜色
  dim: string;                 // 暗淡文本
  success: string;             // 成功状态
  warning: string;             // 警告状态
  error: string;               // 错误状态
  info: string;                // 信息状态
}

/**
 * 主题符号定义
 */
export interface ThemeSymbols {
  prompt: string;              // 提示符
  success: string;             // 成功符号
  error: string;               // 错误符号
  warning: string;             // 警告符号
  info: string;                // 信息符号
  arrow: string;               // 箭头
  bullet: string;              // 项目符号
  check: string;               // 勾选
  cross: string;               // 叉号
  spinner: string[];           // Spinner 动画帧
}

/**
 * 完整主题定义
 */
export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
  symbols: ThemeSymbols;
  spinner: {
    frames: string[];
    interval: number;
  };
}

/**
 * 获取支持 Unicode 的符号
 */
function getUnicodeSymbols(): ThemeSymbols {
  return {
    prompt: '❯',
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
    arrow: '→',
    bullet: '•',
    check: '✔',
    cross: '✘',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  };
}

/**
 * 获取 ASCII 兼容的符号
 */
function getAsciiSymbols(): ThemeSymbols {
  return {
    prompt: '>',
    success: '[OK]',
    error: '[X]',
    warning: '[!]',
    info: '[i]',
    arrow: '->',
    bullet: '*',
    check: '[v]',
    cross: '[x]',
    spinner: ['|', '/', '-', '\\', '|', '/', '-', '\\'],
  };
}

/**
 * 检测终端是否支持 Unicode
 */
function supportsUnicode(): boolean {
  if (process.platform === 'win32') {
    const env = process.env;
    return env.WT_SESSION !== undefined ||
           env.TERM_PROGRAM === 'vscode' ||
           env.CI === 'true';
  }
  return true;
}

/**
 * 检测终端是否支持真彩色
 */
function supportsTrueColor(): boolean {
  const colorterm = process.env.COLORTERM ?? '';
  return colorterm === 'truecolor' || colorterm === '24bit';
}

/**
 * Dark 主题 (默认)
 */
const darkTheme: Theme = {
  name: 'dark',
  description: 'Dark theme with vibrant colors',
  colors: {
    primary: '#00D7FF',
    secondary: '#9D9D9D',
    accent: '#FF6B6B',
    text: '#FFFFFF',
    dim: '#6B6B6B',
    success: '#4CAF50',
    warning: '#FF9800',
    error: '#F44336',
    info: '#2196F3',
  },
  symbols: supportsUnicode() ? getUnicodeSymbols() : getAsciiSymbols(),
  spinner: {
    frames: supportsUnicode()
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      : ['|', '/', '-', '\\', '|', '/', '-', '\\'],
    interval: 80,
  },
};

/**
 * Light 主题
 */
const lightTheme: Theme = {
  name: 'light',
  description: 'Light theme for bright terminals',
  colors: {
    primary: '#0066CC',
    secondary: '#666666',
    accent: '#CC0000',
    text: '#000000',
    dim: '#999999',
    success: '#228B22',
    warning: '#CC7A00',
    error: '#CC0000',
    info: '#0066CC',
  },
  symbols: supportsUnicode() ? getUnicodeSymbols() : getAsciiSymbols(),
  spinner: {
    frames: supportsUnicode()
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      : ['|', '/', '-', '\\', '|', '/', '-', '\\'],
    interval: 80,
  },
};

/**
 * Minimal 主题 (无颜色)
 */
const minimalTheme: Theme = {
  name: 'minimal',
  description: 'Minimal theme without colors (for CI/limited terminals)',
  colors: {
    primary: '',
    secondary: '',
    accent: '',
    text: '',
    dim: '',
    success: '',
    warning: '',
    error: '',
    info: '',
  },
  symbols: getAsciiSymbols(),
  spinner: {
    frames: ['.', 'o', 'O', '0', 'O', 'o'],
    interval: 120,
  },
};

/**
 * 所有可用主题
 */
export const themes: Record<string, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  minimal: minimalTheme,
};

/**
 * 当前活动主题
 */
let currentTheme: Theme = darkTheme;

/**
 * 获取当前主题
 */
export function getCurrentTheme(): Theme {
  return currentTheme;
}

/**
 * 设置主题
 */
export function setTheme(name: string): boolean {
  const theme = themes[name];
  if (theme) {
    currentTheme = theme;
    return true;
  }
  return false;
}

/**
 * 获取主题名称列表
 */
export function getThemeNames(): string[] {
  return Object.keys(themes);
}

/**
 * 获取符号 (基于当前主题)
 */
export function getThemeSymbols(): ThemeSymbols {
  return currentTheme.symbols;
}

/**
 * 获取 Spinner 配置 (基于当前主题)
 */
export function getSpinnerConfig(): { frames: string[]; interval: number } {
  return currentTheme.spinner;
}

/**
 * 使用主题颜色格式化文本
 */
export function colorize(text: string, colorType: keyof ThemeColors): string {
  const color = currentTheme.colors[colorType];
  if (!color) return text;

  // 如果是真彩色终端，使用 hex 颜色
  if (supportsTrueColor() && color.startsWith('#')) {
    return chalk.hex(color)(text);
  }

  // 回退到命名颜色
  switch (colorType) {
    case 'primary':
      return chalk.cyan(text);
    case 'secondary':
      return chalk.gray(text);
    case 'accent':
      return chalk.magenta(text);
    case 'text':
      return chalk.white(text);
    case 'dim':
      return chalk.dim(text);
    case 'success':
      return chalk.green(text);
    case 'warning':
      return chalk.yellow(text);
    case 'error':
      return chalk.red(text);
    case 'info':
      return chalk.blue(text);
    default:
      return text;
  }
}

/**
 * 格式化成功消息
 */
export function formatSuccess(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.success} ${message}`, 'success');
}

/**
 * 格式化错误消息
 */
export function formatError(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.error} ${message}`, 'error');
}

/**
 * 格式化警告消息
 */
export function formatWarning(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.warning} ${message}`, 'warning');
}

/**
 * 格式化信息消息
 */
export function formatInfo(message: string): string {
  const symbols = getThemeSymbols();
  return colorize(`${symbols.info} ${message}`, 'info');
}

/**
 * 格式化提示符
 */
export function formatPrompt(mode: string, provider: string, flags: string[]): string {
  const symbols = getThemeSymbols();
  const modeColor = mode === 'ask' ? 'warning' : 'success';
  const flagStr = flags.length > 0 ? ` ${flags.join('')}` : '';

  return colorize(`kodax:${mode} (${provider})${flagStr}${symbols.prompt} `, modeColor);
}

/**
 * 根据终端环境自动选择主题
 */
export function autoSelectTheme(): void {
  // 无 TTY 时使用 minimal 主题
  if (!process.stdout.isTTY) {
    setTheme('minimal');
    return;
  }

  // Windows Terminal 或 VS Code 终端使用 dark 主题
  const env = process.env;
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM === 'vscode') {
    setTheme('dark');
    return;
  }

  // 检测背景色（如果可用）
  // 目前默认使用 dark 主题
  setTheme('dark');
}

// 初始化时自动选择主题
autoSelectTheme();
