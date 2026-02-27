/**
 * Utils exports - Utils 导出
 *
 * Centralizes exports of all utility modules, simplifying import paths - 集中导出所有工具模块，简化导入路径
 * Includes modules extracted from InkREPL.tsx (Issue 016) - 包含从 InkREPL.tsx 提取的模块 (Issue 016)
 */

// Text buffer utilities
export { TextBuffer } from "./text-buffer.js";
export type { CursorPosition, TextBufferOptions } from "./text-buffer.js";

// Text processing utilities
export {
  LRUCache,
  getCodePointLength,
  getVisualWidth,
  getCharAtCodePoint,
  splitByCodePoints,
  truncateByVisualWidth,
  isWideChar,
  visualWidthCache,
  getVisualWidthCached,
} from "./textUtils.js";

// Terminal capabilities
export {
  detectTerminalCapabilities,
  supportsTrueColor,
  supports256Colors,
  supportsUnicode,
  supportsEmoji,
  getTerminalWidth,
  isScreenReader,
} from "./terminalCapabilities.js";
export type { TerminalCapabilities } from "./terminalCapabilities.js";

// Console capture utilities (Issue 040, 045)
export { ConsoleCapturer, withCapture, withCaptureSync } from "./console-capturer.js";

// Message processing utilities
export { extractTextContent, extractTitle, formatMessagePreview } from "./message-utils.js";

// Session storage utilities
export {
  MemorySessionStorage,
  createMemorySessionStorage,
  type SessionData,
  type SessionStorage,
} from "./session-storage.js";

// Shell execution utilities
export {
  executeShellCommand,
  isShellCommand,
  isShellCommandSuccess,
  processSpecialSyntax,
  type ShellExecutorConfig,
} from "./shell-executor.js";
