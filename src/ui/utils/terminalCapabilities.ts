/**
 * TerminalCapabilities - 终端能力检测
 *
 * 检测终端的各种能力：颜色支持、Unicode、Emoji等
 * 参考: Gemini CLI terminalCapabilities.ts
 */

export interface TerminalCapabilities {
  trueColor: boolean; // 24-bit 真彩色
  colors256: boolean; // 256 色
  unicode: boolean; // Unicode 支持
  emoji: boolean; // Emoji 支持
  tty: boolean; // 是否是 TTY
  columns: number; // 终端宽度
  screenReader: boolean; // 屏幕阅读器模式
}

/**
 * 检测终端是否支持真彩色 (24-bit color)
 */
export function supportsTrueColor(): boolean {
  const env = process.env;

  // COLORTERM=truecolor 是最可靠的指标
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return true;
  }

  // iTerm2
  if (env.TERM_PROGRAM === "iTerm.app") {
    return true;
  }

  // Windows Terminal
  if (env.WT_SESSION) {
    return true;
  }

  // Kitty terminal
  if (env.TERM === "xterm-kitty") {
    return true;
  }

  // GNOME Terminal, VS Code, etc.
  if (env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "gnome-terminal") {
    return true;
  }

  return false;
}

/**
 * 检测终端是否支持 256 色
 */
export function supports256Colors(): boolean {
  const env = process.env;

  // 如果支持真彩色，肯定支持 256 色
  if (supportsTrueColor()) {
    return true;
  }

  const term = env.TERM || "";

  // 检查 TERM 变量
  if (
    term.includes("256color") ||
    term === "xterm-256color" ||
    term === "screen-256color" ||
    term === "tmux-256color"
  ) {
    return true;
  }

  return false;
}

/**
 * 检测终端是否支持 Unicode
 */
export function supportsUnicode(): boolean {
  const env = process.env;

  // 检查 locale 设置
  const lcAll = env.LC_ALL || "";
  const lcCtype = env.LC_CTYPE || "";
  const lang = env.LANG || "";

  // 如果 locale 是 C 或 POSIX，通常不支持 Unicode
  if (lcAll === "C" || lcAll === "POSIX") {
    return false;
  }
  if (lcCtype === "C" || lcCtype === "POSIX") {
    return false;
  }
  if (lang === "C" || lang === "POSIX") {
    return false;
  }

  // 如果包含 UTF-8 或 utf8，支持 Unicode
  const localeStr = `${lcAll}|${lcCtype}|${lang}`.toLowerCase();
  if (localeStr.includes("utf-8") || localeStr.includes("utf8")) {
    return true;
  }

  // Windows Terminal 支持 Unicode
  if (env.WT_SESSION) {
    return true;
  }

  // 默认假设支持（大多数现代终端）
  return true;
}

/**
 * 检测终端是否支持 Emoji
 */
export function supportsEmoji(): boolean {
  const env = process.env;

  // iTerm2 支持 emoji
  if (env.TERM_PROGRAM === "iTerm.app") {
    return true;
  }

  // Windows Terminal 支持 emoji
  if (env.WT_SESSION) {
    return true;
  }

  // Kitty 支持 emoji
  if (env.TERM === "xterm-kitty") {
    return true;
  }

  // VS Code 终端
  if (env.TERM_PROGRAM === "vscode") {
    return true;
  }

  // Apple Terminal
  if (env.TERM_PROGRAM === "Apple_Terminal") {
    return true;
  }

  // GNOME Terminal
  if (env.TERM_PROGRAM === "gnome-terminal") {
    return true;
  }

  // 检测 COLORTERM 作为后备
  if (env.COLORTERM) {
    return true;
  }

  return false;
}

/**
 * 获取终端宽度
 */
export function getTerminalWidth(): number {
  // 默认宽度
  const DEFAULT_WIDTH = 80;

  // 从 stdout 获取
  if (process.stdout?.columns) {
    return process.stdout.columns;
  }

  // 从环境变量获取
  const columns = process.env.COLUMNS;
  if (columns) {
    const parsed = parseInt(columns, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_WIDTH;
}

/**
 * 检测是否处于屏幕阅读器模式
 */
export function isScreenReader(): boolean {
  const env = process.env;

  // NO_COLOR 表示用户偏好简单输出
  if (env.NO_COLOR) {
    return true;
  }

  // TERM=dumb 表示简单终端
  if (env.TERM === "dumb") {
    return true;
  }

  // CI 环境通常不是交互式的
  if (env.CI) {
    return true;
  }

  return false;
}

/**
 * 检测是否是 TTY
 */
function isTTY(): boolean {
  return process.stdout?.isTTY ?? false;
}

/**
 * 检测所有终端能力
 */
export function detectTerminalCapabilities(): TerminalCapabilities {
  return {
    trueColor: supportsTrueColor(),
    colors256: supports256Colors(),
    unicode: supportsUnicode(),
    emoji: supportsEmoji(),
    tty: isTTY(),
    columns: getTerminalWidth(),
    screenReader: isScreenReader(),
  };
}
