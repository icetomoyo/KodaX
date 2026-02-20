/**
 * Utils 导出
 */

export { TextBuffer } from "./text-buffer.js";
export type { CursorPosition, TextBufferOptions } from "./text-buffer.js";

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
